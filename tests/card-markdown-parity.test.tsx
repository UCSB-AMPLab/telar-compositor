// @vitest-environment jsdom
/**
 * A layer panel against what the site publishes. The step card's answer is
 * compared in answer-preview-parity.test.ts.
 *
 * The `panels` of panel-rendering.json are written by
 * panel-rendering.py through the framework's layer path
 * (`_process_content_columns`). Each case compares the title, the panel's
 * own HTML with each widget standing as its marker on both sides, and each
 * widget's sections, entries, notes, captions and credits as `WidgetPreview`
 * draws them. Footnote anchors are the preview's own and are set aside;
 * panel-rendering.test.tsx checks that they are unique and reached. The
 * site's HTML is compared as a reader is shown it, after `fixImageUrls`;
 * that port is checked against the framework's own utils.js, run in this
 * jsdom, in a block that needs the framework checkout and fails without it
 * under `TELAR_PARITY_REQUIRED=1`.
 *
 * HTML is compared as parsed DOM with the whitespace between tags set
 * aside, so `<br />` and `<br>`, or `&#169;` and `©`, read alike.
 *
 * The glossary's entries carry the kinds the fixture records, and the
 * site's kinds are the framework's own list with their labels and icons,
 * so a glossary callout is compared with its kind's icon and label.
 *
 * Differences the preview accepts are recorded below as the exact output on
 * both sides. A new difference fails, and so does a recorded one that has
 * changed or gone away.
 *
 * The fixture is regenerated from the framework checkout by
 * `npm run parity:regenerate`, and checked against it by
 * `npm run parity:regenerate -- --check`. Run the check before merging
 * anything that touches rendering and whenever the framework moves; a
 * failure there means the site now publishes something the committed
 * fixture does not describe, and the preview has to follow before the
 * fixture is re-recorded. This file reads only the committed fixture, so it
 * runs in the ordinary suite without Python.
 *
 * @version v1.5.0-beta
 */
import { beforeAll, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fixImageUrls, renderPanel } from "~/lib/card-markdown";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  describeWithRequiredFramework,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
} from "./helpers/framework-checkout";
import { jsdomPrelude } from "./helpers/framework-jsdom";
import { resolveGlossaryLinks } from "~/lib/glossary-links";
import type { GlossaryKinds } from "~/lib/glossary-kinds";
import { previewSanitise } from "~/lib/preview-sanitise";
import { WidgetPreview } from "~/components/ui/markdown-editor/WidgetPreview";
import answerFixture from "./fixtures/answer-preview.json";
import panelFixture from "./fixtures/panel-rendering.json";
import footnoteFixture from "./fixtures/footnote-numbering.json";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function fragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function normalised(root: DocumentFragment): string {
  const holder = document.createElement("div");
  holder.appendChild(root.cloneNode(true));
  return holder.innerHTML.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

/**
 * What the panel preview does not reproduce. Python Markdown does not let a
 * list interrupt a paragraph, so lines starting `- ` straight after text
 * stay in the paragraph as line breaks; CommonMark, and `marked`, start a
 * list.
 *
 * `marked` reads link text holding brackets one level deep, Python Markdown
 * deeper, so an image whose alt text nests two levels is text in the
 * preview and an image on the site. The Compositor writes such alt text
 * with entities (authorText.ts), which both read alike. A link whose text
 * holds a glossary reference nests two levels too, so it is text in the
 * preview and a link on the site; the glossary pass then links the
 * reference in the preview and shows it as its title on the site.
 *
 * The sanitiser removes a `textarea` with its content, which the glossary
 * pass leaves as written, and `marked` reads a line opening with one as an
 * HTML block, so the text after it is not a paragraph; the term after it is
 * linked in both.
 */
const ACCEPTED_PANELS: Record<string, { preview: string; site: string }> = {
  "an image whose alt text nests brackets two deep": {
    preview:
      '<p>![a <a href="#" class="glossary-inline-link" data-term-id="IIIF" data-term-url="/telar/glossary/iiif/">International Image Interoperability Framework</a> b](b.jpg)</p>',
    site: '<p><img alt="a [[IIIF]] b" src="b.jpg"></p>',
  },
  "lists without a blank line": {
    preview: "<p>Intro line</p><ul><li>one</li><li>two</li></ul><p>After.</p><ol><li>first</li><li>second</li></ol>",
    site: "<p>Intro line<br> - one<br> - two</p><p>After.</p><ol><li>first</li><li>second</li></ol>",
  },
  "a glossary reference in a link's text": {
    preview:
      '<p>[see <a href="#" class="glossary-inline-link" data-term-id="IIIF" data-term-url="/telar/glossary/iiif/">International Image Interoperability Framework</a>](https://example.org/a), <span class="glossary-link-error" data-term-id="[loom">⚠️ [[[loom]]</span>](https://example.org/b) and <a href="#" class="glossary-inline-link" data-term-id="IIIF" data-term-url="/telar/glossary/iiif/">this</a>.</p>',
    site: '<p><a href="https://example.org/a">see International Image Interoperability Framework</a>, <a href="https://example.org/b">Loom</a> and <a href="#" class="glossary-inline-link" data-term-id="IIIF" data-term-url="/telar/glossary/iiif/">this</a>.</p>',
  },
  "a glossary reference in text-only content": {
    preview: 'and <a href="#" class="glossary-inline-link" data-term-id="loom" data-term-url="/telar/glossary/loom/">Loom</a><div><a href="#" class="glossary-inline-link" data-term-id="loom" data-term-url="/telar/glossary/loom/">Loom</a></div>',
    site: '<textarea>[[iiif]]</textarea><p>and <a href="#" class="glossary-inline-link" data-term-id="loom" data-term-url="/telar/glossary/loom/">Loom</a></p><div><textarea>&lt;a&gt;[[iiif]]</textarea><a href="#" class="glossary-inline-link" data-term-id="loom" data-term-url="/telar/glossary/loom/">Loom</a></div>',
  },
};

/**
 * Footnote anchors are each side's own and are set aside; a style is
 * compared as the browser reads it, since the sanitiser rewrites its spacing.
 */
function withoutAnchors(root: DocumentFragment | HTMLElement): void {
  for (const element of root.querySelectorAll("[id]")) element.removeAttribute("id");
  for (const element of root.querySelectorAll<HTMLElement>("[style]")) element.setAttribute("style", element.style.cssText);
  for (const link of root.querySelectorAll("a.footnote-ref, a.footnote-backref")) {
    link.removeAttribute("href");
    link.removeAttribute("title");
  }
}

const WIDGET_ROOTS = ".telar-widget, .telar-widget-bibliography";
const WIDGET_CONTENT = [".accordion-body", ".tab-pane-content", ".telar-bib-entry", ".caption-text", ".caption-credit", ".accordion-button", ".nav-link"];

/** The site's panel with each widget replaced by the preview's marker for it. */
function siteTopLevel(markup: string): { top: string; widgets: Element[] } {
  const root = fragment(markup);
  const widgets = [...root.querySelectorAll(WIDGET_ROOTS)].filter((w) => !w.parentElement?.closest(WIDGET_ROOTS));
  widgets.forEach((widget, n) => {
    const marker = document.createElement("div");
    marker.dataset.panelWidget = String(n);
    widget.replaceWith(marker);
  });
  withoutAnchors(root);
  return { top: normalised(root), widgets };
}

function content(element: DocumentFragment | HTMLElement): string[] {
  return WIDGET_CONTENT.flatMap((selector) =>
    [...element.querySelectorAll(selector)].map((part) => {
      const copy = part.cloneNode(true) as HTMLElement;
      withoutAnchors(copy);
      return copy.innerHTML.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
    }),
  );
}

/** The site's kinds as the framework recorded them, each named by its id alone. */
const fixtureKinds: GlossaryKinds = (() => {
  const options = panelFixture.kinds.map((k) => ({ id: k.id, label: k.label, aliases: [k.id], ...(k.icon ? { icon: k.icon } : {}) }));
  return { available: true, options, defaultId: panelFixture.default_kind, core: options.filter((o) => o.icon), site: [] };
})();
const panelGlossary = {
  terms: new Map(Object.entries(panelFixture.glossary)),
  baseUrl: panelFixture.base_url,
  kinds: fixtureKinds,
  entryKinds: new Map(Object.entries(panelFixture.glossary_kinds)),
};
const links = (html: string) => resolveGlossaryLinks(html, panelGlossary.terms, panelGlossary.baseUrl);
const panelCases = panelFixture.panels.map((c) => [c.name, c] as const);
const render = (source: string) =>
  renderPanel(source, { glossary: panelGlossary, baseUrl: panelFixture.base_url, anchor: "p", unavailable: "as written" });

/**
 * The panel as a reader is shown it: the build's HTML after the site's
 * `fixImageUrls`. The port stands in for the framework's function here; the
 * block below proves the two agree on every case.
 */
const readerHtml = (html: string) => fixImageUrls(html, panelFixture.base_url);

describe(`panels against framework ${panelFixture.framework_commit.slice(0, 8)}, Markdown ${panelFixture.markdown_version}`, () => {
  it.each(panelCases)("title: %s", (_name, c) => {
    expect(render(c.source).title).toBe(c.title);
  });

  it.each(panelCases)("HTML: %s", (name, c) => {
    const preview = fragment(render(c.source).html);
    withoutAnchors(preview);
    const accepted = ACCEPTED_PANELS[name];
    if (!accepted) {
      expect(normalised(preview)).toBe(siteTopLevel(readerHtml(c.html)).top);
      return;
    }
    expect(normalised(preview)).toBe(accepted.preview);
    expect(siteTopLevel(readerHtml(c.html)).top).toBe(accepted.site);
  });

  it.each(panelCases)("widgets: %s", (_name, c) => {
    const rendered = render(c.source);
    const site = siteTopLevel(readerHtml(c.html)).widgets;
    expect(rendered.widgets.length).toBe(site.length);
    rendered.widgets.forEach((part, n) => {
      const markup = renderToStaticMarkup(<WidgetPreview block={part.block!} siteBaseUrl="https://site.example" links={links} />);
      expect(content(fragment(markup))).toEqual(content(site[n] as HTMLElement));
    });
  });

  it("records no difference for a panel the corpus no longer holds", () => {
    const names = new Set(panelFixture.panels.map((c) => c.name));
    expect(Object.keys(ACCEPTED_PANELS).filter((name) => !names.has(name))).toEqual([]);
  });
});

describe("the rendering fixtures", () => {
  it("were recorded against one framework commit", () => {
    const commits = new Set([answerFixture, panelFixture, footnoteFixture].map((f) => f.framework_commit));
    expect(commits.size).toBe(1);
  });
});

/**
 * The framework's own `fixImageUrls`, run in a jsdom document by a node
 * subprocess, as the other framework-driving tests run its browser modules.
 * One run answers every input, in order.
 */
function frameworkFixImageUrls(inputs: Array<{ html: string; base: string }>): string[] {
  const utils = `file://${join(FRAMEWORK_SCRIPTS_DIR, "..", "assets", "js", "telar-story", "utils.js")}`;
  const script = [
    ...jsdomPrelude(),
    `const { fixImageUrls } = await import(${JSON.stringify(utils)});`,
    "const inputs = JSON.parse(process.argv[1]);",
    "console.log(JSON.stringify(inputs.map(({ html, base }) => fixImageUrls(html, base))));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(inputs)], {
    encoding: "utf-8",
    timeout: FRAMEWORK_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string) as string[];
}

describeWithRequiredFramework("fixImageUrls against the framework's assets/js/telar-story/utils.js", () => {
  const withImages = panelFixture.panels.filter((c) => c.html.includes("<img"));
  const inputs = withImages.flatMap((c) => [panelFixture.base_url, ""].map((base) => ({ html: c.html, base })));
  let framework: string[] = [];
  beforeAll(() => {
    framework = frameworkFixImageUrls(inputs);
  }, FRAMEWORK_TIMEOUT_MS);

  it("has panels with root-relative images to measure", () => {
    expect(withImages.some((c) => /<img src="\/[^/]/.test(c.html))).toBe(true);
    expect(framework).toHaveLength(inputs.length);
  });

  it("the port writes what the framework's function writes", () => {
    expect(inputs.map(({ html, base }) => fixImageUrls(html, base))).toEqual(framework);
  });

  it.each(withImages.map((c, i) => [c.name, c, i] as const))("the preview shows what a reader sees: %s", (_name, c, i) => {
    const preview = fragment(render(c.source).html);
    withoutAnchors(preview);
    const accepted = ACCEPTED_PANELS[c.name];
    expect(normalised(preview)).toBe(accepted ? accepted.preview : siteTopLevel(framework[i * 2]).top);
  });
});

describe("the framework's own data-term-url values", () => {
  const urls = [...answerFixture.cases, ...panelFixture.panels]
    .flatMap((c) => [...c.html.matchAll(/data-term-url="([^"]*)"/g)].map((m) => m[1]));

  it("are in the fixtures to measure", () => {
    expect(urls.length).toBeGreaterThan(10);
  });

  it.each([...new Set(urls)])("pass the preview sanitiser unchanged: %s", (url) => {
    const html = `<a href="#" class="glossary-inline-link" data-term-id="t" data-term-url="${url}">t</a>`;
    const a = fragment(html).querySelector("a")!;
    const kept = fragment(previewSanitise(html)).querySelector("a")!;
    expect(kept.getAttribute("data-term-url")).toBe(a.getAttribute("data-term-url"));
  });
});
