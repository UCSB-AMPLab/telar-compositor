// @vitest-environment jsdom
/**
 * A closed widget box, and a note in the panel's note list, rendered as the
 * framework publishes them. The fixture is written by panel-rendering.py
 * through the framework's own panel pipeline; each case compares the
 * content of every section, entry, caption and credit, and of each note,
 * before KaTeX runs, since the site typesets at runtime too.
 *
 * Anchors are left out of the comparison: the preview names its own, and
 * asserts only that they are unique and that every link reaches one.
 *
 * A formula found inside another publishes as the author wrote it, on the
 * site and in the preview alike.
 *
 * The fixture is regenerated from the framework checkout by
 * `npm run parity:regenerate`, and checked against it by
 * `npm run parity:regenerate -- --check`, which needs the checkout's Python
 * and so never runs in this suite. Run the check before merging anything that
 * touches rendering and whenever the framework moves. A failure means the
 * site now publishes something the committed fixture does not describe: the
 * preview follows the site, and the fixture is re-recorded with that change.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { parsePanel } from "~/components/ui/markdown-editor/panelSource";
import { WidgetPreview } from "~/components/ui/markdown-editor/WidgetPreview";
import { panelMarkdown } from "~/components/ui/markdown-editor/panelPreview";
import { readNotes } from "~/components/ui/markdown-editor/footnoteSyntax";
import { panelMathDelimiters } from "~/components/ui/markdown-editor/panelMath";
import renderMathInElement from "katex/contrib/auto-render";
import fixture from "./fixtures/panel-rendering.json";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const CONTENT = [".accordion-body", ".tab-pane-content", ".telar-bib-entry", ".caption-text", ".caption-credit", ".accordion-button", ".nav-link"];
const ANCHORS = ["id", "href", "title"];

/** An element's content with anchors and the whitespace between tags set aside. */
function normalised(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const node of copy.querySelectorAll("*")) for (const name of ANCHORS) node.removeAttribute(name);
  return copy.innerHTML
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

function contentOf(doc: Document): Record<string, string[]> {
  return Object.fromEntries(
    CONTENT.map((selector) => [selector, [...doc.querySelectorAll(selector)].map(normalised)]),
  );
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const widgetCases = fixture.cases.filter((c) => c.source.startsWith(":::"));

const noteCases = fixture.cases.filter((c) => !c.source.startsWith(":::"));

describe(`closed widgets against framework ${fixture.framework_commit.slice(0, 8)}`, () => {
  for (const c of widgetCases) it(c.name, () => {
    const state = EditorState.create({ doc: c.source, extensions: [markdown()] });
    const block = parsePanel(state).widgets[0];
    const preview = parse(renderToStaticMarkup(<WidgetPreview block={block} siteBaseUrl="https://site.example" />));
    expect(contentOf(preview)).toEqual(contentOf(parse(c.html)));
  });
});

describe(`notes against framework ${fixture.framework_commit.slice(0, 8)}`, () => {
  it.each(noteCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const state = EditorState.create({ doc: c.source, extensions: [markdown()] });
    const notes = readNotes(state).notes.map((n) => {
      const doc = parse(panelMarkdown(n.text));
      return normalised(doc.body);
    });
    const site = [...parse(c.html).querySelectorAll("div.footnote li")].map((li) => {
      li.querySelector("a.footnote-backref")?.remove();
      return normalised(li).replace(/&nbsp;<\/p>$/, "</p>");
    });
    expect(notes).toEqual(site);
  });
});

/** Each content element after KaTeX has typeset it, as the site does at runtime. */
function typeset(doc: Document): string[] {
  return CONTENT.flatMap((selector) =>
    [...doc.querySelectorAll(selector)].map((element) => {
      renderMathInElement(element as HTMLElement, { delimiters: panelMathDelimiters, throwOnError: false, trust: false });
      return normalised(element);
    }),
  );
}

describe(`formulas typeset against framework ${fixture.framework_commit.slice(0, 8)}`, () => {
  for (const c of widgetCases) it(c.name, async () => {
    await import("katex/contrib/mhchem");
    const state = EditorState.create({ doc: c.source, extensions: [markdown()] });
    const block = parsePanel(state).widgets[0];
    const preview = parse(renderToStaticMarkup(<WidgetPreview block={block} siteBaseUrl="https://site.example" />));
    expect(typeset(preview)).toEqual(typeset(parse(c.html)));
  });
});

/** The cases whose published output has notes, which the anchor checks need. */
const noteWidgetCases = widgetCases.filter((c) => c.html.includes('class="footnote-ref"'));

describe("preview anchors", () => {
  it.each(noteWidgetCases.map((c) => [c.name, c] as const))("are unique and every note link reaches one: %s", (_name, c) => {
    const state = EditorState.create({ doc: c.source, extensions: [markdown()] });
    const block = parsePanel(state).widgets[0];
    const markup = renderToStaticMarkup(
      <>
        <WidgetPreview block={block} siteBaseUrl="https://site.example" />
        <WidgetPreview block={block} siteBaseUrl="https://site.example" />
      </>,
    );
    const doc = parse(markup);
    // Without notes both checks below would hold of nothing.
    expect(doc.querySelectorAll("a.footnote-ref").length).toBeGreaterThan(0);
    expect(doc.querySelectorAll("div.footnote li").length).toBeGreaterThan(0);
    const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const links = [...doc.querySelectorAll("a.footnote-ref, a.footnote-backref[href]")].map((a) => a.getAttribute("href")!.slice(1));
    for (const target of links) expect(ids).toContain(target);
  });
});
