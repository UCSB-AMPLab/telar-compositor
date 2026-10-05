// @vitest-environment jsdom
/**
 * What each writer of author text into Markdown syntax produces, run through
 * the framework's own two paths, and what the site then publishes: the
 * panel path (`_process_content_columns`: widgets, `process_images`, Python
 * Markdown, the glossary pass) and the answer path (`render_answer`: the same
 * conversion and glossary pass, made prose and held to the budget).
 * The writers are the editor commands, the glossary button's
 * `glossaryReference` and the paste conversion; their output is taken as
 * they write it, not rebuilt here.
 *
 * Each published alt text, link text and glossary display text must read as
 * the author's text, and each image's address must be resolved under the
 * site's objects folder.
 *
 * Needs the framework checkout with its .venv; skipped visibly without the
 * checkout, and failed under TELAR_PARITY_REQUIRED=1.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { insertImage, insertLink } from "~/components/ui/markdown-editor/commands";
import { glossaryReference } from "~/components/ui/markdown-editor/authorText";
import { _resetTurndownForTests, getTurndown } from "~/components/ui/markdown-editor/richPaste";
import { FRAMEWORK_SCRIPTS_DIR, FRAMEWORK_TIMEOUT_MS, describeWithRequiredFramework } from "./helpers/framework-checkout";

const FRAMEWORK = resolve(FRAMEWORK_SCRIPTS_DIR, "..");
const PYTHON = join(FRAMEWORK, ".venv", "bin", "python3");

/** Alt text typed into the Image dialog, or an object's alt text or title. */
const ALTS = ["Loom [Telar]", "[Marco de un telar kogui]", "Loom [Telar", "Telar] loom", "A [b [c]] d", "x & y < \" q", "a\\[b"];
/** Image addresses as the author gives them. */
const PATHS = ["a.jpg", "maps/my map (1).jpg"];
/** Selections turned into link text: the text as selected, and what the site shows for it. */
const SELECTIONS: Array<[string, string]> = [
  ["Loom [Telar]", "Loom [Telar]"],
  ["Loom [Telar", "Loom [Telar"],
  ["Telar] loom", "Telar] loom"],
  ["A [b [c]] d", "A [b [c]] d"],
  ["[[loom]]", "[[loom]]"],
  ["[whole]", "[whole]"],
  ["a \\[b", "a [b"],
];
const URL = "https://example.org/wiki/Loom_(weaving) two";
/** Display texts in the glossary button, `]` and `|` among them, written as entities. */
const DISPLAYS = ["the loom", "a [b c", "[Telar", "a ] b", "a | b", "x & y"];

function written(run: (view: EditorView) => void): string {
  const view = new EditorView({ doc: "", parent: document.body });
  run(view);
  const doc = view.state.doc.toString();
  view.destroy();
  return doc;
}

const DRIVER = `
import json, sys
import pandas as pd
sys.path.insert(0, "scripts")
from telar.processors.stories import _process_content_columns, render_answer
from telar.widgets import site_base_url
glossary = {"loom": "Loom"}
sources = json.loads(sys.stdin.read())
steps = [str(i + 1) for i in range(len(sources))]
panel = _process_content_columns(pd.DataFrame({"step": steps, "layer1_content": sources}), glossary, [], [])
print(json.dumps({"base_url": site_base_url(), "panel": list(panel["layer1_text"]),
                  "answer": [render_answer(source, glossary, []).html for source in sources]}))
`;

interface Published {
  baseUrl: string;
  panel: string[];
  answer: string[];
}

function publish(sources: string[]): Published {
  const out = execFileSync(PYTHON, ["-c", DRIVER], {
    cwd: FRAMEWORK,
    input: JSON.stringify(sources),
    encoding: "utf-8",
    timeout: FRAMEWORK_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const result = JSON.parse(out.trim().split("\n").at(-1) as string);
  return { baseUrl: result.base_url, panel: result.panel, answer: result.answer };
}

const dom = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
};

describeWithRequiredFramework("author text the Compositor writes, as the framework publishes it", () => {
  const images = ALTS.flatMap((alt) => PATHS.map((path) => ({ alt, path, source: written((v) => insertImage(v, path, alt)) })));
  const links = SELECTIONS.map(([selected, shown]) => ({
    selected,
    shown,
    source: written((v) => {
      v.dispatch({ changes: { from: 0, insert: selected }, selection: { anchor: 0, head: selected.length } });
      insertLink(v, URL);
    }),
  }));
  const addressAsText = written((v) => insertLink(v, "https://example.org/[a"));
  const displays = DISPLAYS.map((display) => glossaryReference("loom", display));
  const PASTED =
    '<p>See <a href="https://example.org/wiki/Loom_(weaving)">Loom [Telar]</a> and [1] and [[loom]].</p>' +
    '<p><img src="maps/my map.jpg" alt="[Marco de un telar kogui]"></p>';
  let pasted = "";
  let sources: string[] = [];
  let site: Published = { baseUrl: "", panel: [], answer: [] };

  beforeAll(async () => {
    pasted = (await getTurndown()).turndown(PASTED);
    sources = [...images.map((i) => i.source), ...links.map((l) => l.source), addressAsText, ...displays, pasted];
    site = publish(sources);
  }, FRAMEWORK_TIMEOUT_MS);
  afterAll(() => _resetTurndownForTests());

  const panelOf = (source: string) => dom(site.panel[sources.indexOf(source)]);
  const answerOf = (source: string) => dom(site.answer[sources.indexOf(source)]);

  it("ran every source through both paths", () => {
    expect(site.panel).toHaveLength(sources.length);
    expect(site.answer).toHaveLength(sources.length);
  });

  it.each(images.map((i) => [`${JSON.stringify(i.alt)} at ${JSON.stringify(i.path)}`, i] as const))(
    "an image's alt text is the author's and its address resolved: %s",
    (_name, { alt, path, source }) => {
      const img = panelOf(source).querySelector("figure.telar-image-figure > img")!;
      expect(img, source).toBeTruthy();
      expect(img.getAttribute("alt")).toBe(alt);
      const objects = `${site.baseUrl}/telar-content/objects/`;
      expect(img.getAttribute("src")!.startsWith(objects)).toBe(true);
      expect(decodeURIComponent(img.getAttribute("src")!.slice(objects.length))).toBe(path);
    },
  );

  it.each(links.map((l) => [JSON.stringify(l.selected), l] as const))(
    "a link's text reads as the selection did, on both paths: %s",
    (_name, { shown, source }) => {
      for (const published of [panelOf(source), answerOf(source)]) {
        const anchors = published.querySelectorAll("a");
        expect(anchors, source).toHaveLength(1);
        expect(anchors[0].textContent).toBe(shown);
        expect(decodeURI(anchors[0].getAttribute("href")!)).toBe(URL);
      }
    },
  );

  it("a link with no selection shows its address as its text", () => {
    for (const published of [panelOf(addressAsText), answerOf(addressAsText)]) {
      expect(published.querySelector("a")!.textContent).toBe("https://example.org/[a");
    }
  });

  it.each(DISPLAYS)("a glossary display text is published as typed: %s", (display) => {
    const source = glossaryReference("loom", display);
    for (const published of [panelOf(source), answerOf(source)]) {
      const link = published.querySelector("a.glossary-inline-link")!;
      expect(link.getAttribute("data-term-id")).toBe("loom");
      expect(link.textContent).toBe(display);
    }
  });

  it("pasted text, link text and alt text read as they did in the pasted page", () => {
    const published = panelOf(pasted);
    const img = published.querySelector("figure.telar-image-figure > img")!;
    expect(img.getAttribute("alt")).toBe("[Marco de un telar kogui]");
    expect(decodeURIComponent(img.getAttribute("src")!)).toBe(`${site.baseUrl}/telar-content/objects/maps/my map.jpg`);
    for (const page of [published, answerOf(pasted)]) {
      const link = page.querySelector("a:not(.glossary-inline-link)")!;
      expect(link.textContent).toBe("Loom [Telar]");
      expect(decodeURI(link.getAttribute("href")!)).toBe("https://example.org/wiki/Loom_(weaving)");
      expect(page.querySelector("p")!.textContent).toBe("See Loom [Telar] and [1] and [[loom]].");
      expect(page.querySelector(".glossary-inline-link, .glossary-link-error")).toBeNull();
    }
  });
});
