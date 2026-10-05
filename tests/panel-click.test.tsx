// @vitest-environment jsdom
/**
 * Where a click in a layer panel's rendered content opens the editor
 * (panel-click.ts): the renderer's changes mapped back to the source,
 * words typed once landing inside themselves, ambiguous text landing at its
 * block's start, widget spans with front matter and CRLF, widgets without a
 * box or a Markdown field landing at the fence, a carousel item after an
 * imageless one landing on its own source item, and the request found again
 * in a text that has changed since.
 *
 * Each click is made on the real rendering (`renderPanel`, the widgets drawn
 * by `WidgetPreview`), with the browser's caret-from-point answered by the
 * test with the node and offset the click stands on.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { editorText, renderPanel } from "~/lib/card-markdown";
import { rematch, requestFromClick, type OpeningRequest } from "~/lib/panel-click";
import { WidgetPreview } from "~/components/ui/markdown-editor/WidgetPreview";
import { parsePanel } from "~/components/ui/markdown-editor/panelSource";

const terms = new Map([["loom", "Big Loom"]]);
const glossary = { terms, baseUrl: "" };

afterEach(() => {
  cleanup();
  delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
});

/** The panel rendered into the page, its widgets drawn into their markers. */
function rendered(source: string) {
  const panel = renderPanel(source, { glossary, baseUrl: "", anchor: "t", unavailable: "as written" });
  const prose = document.createElement("div");
  prose.setAttribute("data-panel-prose", "");
  prose.innerHTML = panel.html;
  document.body.replaceChildren(prose);
  for (const slot of prose.querySelectorAll<HTMLElement>("[data-panel-widget]")) {
    const part = panel.widgets[Number(slot.dataset.panelWidget)];
    if (part.block) render(<WidgetPreview block={part.block} siteBaseUrl="https://site.example" />, { container: slot });
    else slot.appendChild(Object.assign(document.createElement("pre"), { textContent: part.source }));
  }
  return { prose, widgets: panel.widgets, callouts: panel.callouts };
}

/** The text node holding the `n`th occurrence of `word` in rendered order, and the word's offset in it. */
function find(prose: HTMLElement, word: string, n = 0): { node: Text; offset: number } {
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
  let seen = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    let at = node.data.indexOf(word);
    while (at !== -1) {
      if (seen === n) return { node, offset: at };
      seen += 1;
      at = node.data.indexOf(word, at + 1);
    }
  }
  throw new Error(`no ${word}`);
}

/** A click `into` characters into the `n`th rendered `word`: the offset the editor opens at. */
function clickOn(source: string, word: string, into: number, n = 0): OpeningRequest {
  const { prose, widgets, callouts } = rendered(source);
  const { node, offset } = find(prose, word, n);
  (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint = () => ({ offsetNode: node, offset: offset + into });
  return requestFromClick(node.parentElement!, { x: 1, y: 1 }, { value: source, widgets, callouts, prose, terms });
}

describe("the renderer's changes, mapped back", () => {
  it.each([
    ["entities", "Caf&eacute; au lait with &amp; more.", "lait", 2],
    ["escaped punctuation", "A \\*star\\* and \\_target\\_ here.", "target", 3],
    ["whitespace and line breaks", "Line   one\nline two\n\n  target  words", "target", 1],
    ["a glossary title", "The [[loom]] weaves the target.", "target", 4],
    ["a glossary display text", "The [[loom|frame]] holds a target.", "target", 2],
    ["a link's address left out", "See [the text](https://target.example) for the target.", "target", 5],
    ["emphasis", "Some **bold** and _italic_ target.", "target", 1],
    ["a caption", "![alt](a.jpg)\ncaption: A caption target\n\nNext.", "target", 3],
    ["list markers", "1. first item\n2. second target", "target", 2],
    ["a footnote reference and its note", "Note here[^n] then target.\n\n[^n]: The note text.", "target", 2],
  ])("%s", (_what, source, word, into) => {
    const request = clickOn(source, word, into);
    expect(request.offset).toBe(editorText(source).lastIndexOf(word) + into);
  });

  it("carries the spaces and punctuation after the last letter", () => {
    const source = "Hello, world.";
    const request = clickOn(source, ", ", 2);
    expect(request.offset).toBe(source.indexOf("world"));
  });
});

describe("words typed once land inside themselves", () => {
  function random(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }
  const MARKUP = [(w: string) => `**${w}**`, (w: string) => `_${w}_`, (w: string) => `[${w}](https://x.example/${w}z)`, (w: string) => `\`${w}\``, (w: string) => w];

  it.each(Array.from({ length: 25 }, (_, i) => i + 1))("seed %i", (seed) => {
    const next = random(seed);
    // Each word starts with a letter no other word has, so it is typed once.
    const words = Array.from({ length: 12 }, (_, i) => `${"BCDFGHJKLMNP"[i]}${"aeiouy".slice(0, 2 + Math.floor(next() * 4))}`);
    const paragraphs: string[] = [];
    let line: string[] = [];
    for (const word of words) {
      line.push(MARKUP[Math.floor(next() * MARKUP.length)](word));
      if (next() < 0.3) {
        paragraphs.push(line.join(" "));
        line = [];
      }
    }
    paragraphs.push(line.join(" "));
    const source = paragraphs.filter(Boolean).join(next() < 0.5 ? "\n\n" : "\n");
    const word = words[Math.floor(next() * words.length)];
    const into = 1 + Math.floor(next() * (word.length - 1));
    const request = clickOn(source, word, into);
    // The word as written, not inside a link's address.
    const at = source.search(new RegExp(`(?<!/)${word}(?!z)`));
    expect(request.offset, `${source} | ${word} ${into}`).toBe(at + into);
  });
});

describe("text that fixes no place", () => {
  it("ambiguous text lands at its block's start", () => {
    const source = "Echo.\n\nX Echo.";
    const request = clickOn(source, "Echo", 2, 0);
    expect(request.offset).toBe(0);
  });

  it("a figure lands at the start of its source", () => {
    const source = "Intro text.\n\n![a](/a.jpg)\n\nAfter.";
    const { prose, widgets } = rendered(source);
    const img = prose.querySelector("img")!;
    const request = requestFromClick(img, { x: 1, y: 1 }, { value: source, widgets, prose, terms });
    expect(request.offset).toBe(source.indexOf("![a]"));
  });

  it("a formula lands at the start of its block's source", () => {
    const source = "Intro text.\n\nFormula $x$ here.";
    const { prose, widgets } = rendered(source);
    const paragraph = prose.querySelectorAll("p")[1];
    const katex = document.createElement("span");
    katex.className = "katex";
    katex.textContent = "x";
    paragraph.appendChild(katex);
    const request = requestFromClick(katex, { x: 1, y: 1 }, { value: source, widgets, prose, terms });
    expect(request.offset).toBe(source.indexOf("Formula"));
  });
});

describe("a block's own start", () => {
  it("a caret before a paragraph's first letter, after prose and a widget, lands at that paragraph", () => {
    const source = "Intro words.\n\n:::tabs\n## A\nx\n:::\n\nNext paragraph.";
    const request = clickOn(source, "Next", 0);
    expect(request.offset).toBe(source.indexOf("Next"));
  });

  it("a caret before the first paragraph after a widget that opens the panel lands at that paragraph", () => {
    const source = ":::tabs\n## A\nx\n:::\n\nNext paragraph.";
    const request = clickOn(source, "Next", 0);
    expect(request.offset).toBe(source.indexOf("Next"));
  });

  it("an image that opens the panel lands at the content's start, not at the first text", () => {
    const source = "![a](/a.jpg)\n\nAfter.";
    const { prose, widgets } = rendered(source);
    const request = requestFromClick(prose.querySelector("img")!, { x: 1, y: 1 }, { value: source, widgets, prose, terms });
    expect(request.offset).toBe(0);
  });
});

describe("a block after a widget", () => {
  it("a formula lands at its own block's start, past the widget before it", () => {
    const source = "Intro text.\n\n:::tabs\n## A\nx\n:::\n\nAfter $x$ here.";
    const { prose, widgets } = rendered(source);
    const paragraph = [...prose.querySelectorAll("p")].find((p) => p.textContent?.startsWith("After"))!;
    const katex = document.createElement("span");
    katex.className = "katex";
    katex.textContent = "x";
    paragraph.appendChild(katex);
    const request = requestFromClick(katex, { x: 1, y: 1 }, { value: source, widgets, prose, terms });
    expect(request.offset).toBe(source.indexOf("After"));
  });
});

describe("widgets", () => {
  it("records each widget's span in the editor's text, past front matter, with CRLF line endings", () => {
    const source = "---\r\ntitle: T\r\n---\r\n\r\n  Text.\r\n\r\n:::accordion\r\n## One\r\nA.\r\n:::\r\n";
    const text = editorText(source);
    const [part] = renderPanel(source, { glossary, baseUrl: "", anchor: "t", unavailable: "x" }).widgets;
    expect(text.slice(part.span.from, part.span.to)).toBe(":::accordion\n## One\nA.\n:::");
  });

  it("a click in a section opens its box with the section's text", () => {
    const source = "Intro.\n\n:::accordion\n## One\nFirst.\n\n## Two\nSecond.\n:::";
    const request = clickOn(source, "Two", 0);
    expect(request.widget).toEqual({
      kind: "accordion",
      fence: source.indexOf(":::"),
      source: source.slice(source.indexOf(":::")),
      section: { index: 1, source: "## Two\nSecond.", field: "body" },
    });
  });

  it("a carousel item after an imageless one lands on its own source item, at its caption", () => {
    const source = ":::carousel\ncaption: no image\n---\nimage: https://i.example/a.jpg\ncaption: A\n---\nimage: https://i.example/b.jpg\ncaption: Bee\n:::";
    const { prose, widgets } = rendered(source);
    const second = prose.querySelectorAll(".carousel-item")[1];
    const request = requestFromClick(second, { x: 1, y: 1 }, { value: source, widgets, prose, terms });
    expect(request.widget!.section).toEqual({ index: 2, source: "\nimage: https://i.example/b.jpg\ncaption: Bee", field: "caption" });
  });

  it.each([
    ["a widget without a box", "Before :::tabs\n## A\nx\n:::", "x"],
    ["a widget the framework does not know", ":::timeline\n## 1900\nA year.\n:::", "1900"],
    ["an item with no Markdown field", ":::carousel\nimage: https://i.example/a.jpg\n:::", null],
  ])("%s lands at the fence", (_what, source, word) => {
    const { prose, widgets } = rendered(source);
    const slot = prose.querySelector("[data-panel-widget]")!;
    const target = word ? find(prose, word).node.parentElement! : (slot.querySelector(".carousel-item") ?? slot);
    const request = requestFromClick(target, { x: 1, y: 1 }, { value: source, widgets, prose, terms });
    expect(request.offset).toBe(source.indexOf(":::"));
    expect(request.widget!.section).toBeNull();
  });
});

describe("glossary callouts", () => {
  const source = "Intro.\n\n:::glossary\nentry: missing\n:::\n\n:::glossary\nentry: loom\nalign: left\n:::\n\nThe weave holds.";

  it("a click on a callout lands at its own fence, an unknown entry's marker before it counting for none", () => {
    expect(clickOn(source, "Big Loom", 2).offset).toBe(source.indexOf(":::glossary\nentry: loom"));
  });

  it.each([
    ["alone", "", 29],
    ["after a paragraph", "Before.\n\n", 38],
  ])("a click at the start of the paragraph after a callout lands on it, %s", (_what, lead, offset) => {
    expect(clickOn(`${lead}:::glossary\nentry: loom\n:::\n\nAfter.`, "After.", 0).offset).toBe(offset);
  });
});

describe("the request against a changed text", () => {
  const ACCORDION = ":::accordion\n## One\nFirst.\n\n## Two\nSecond.\n:::";
  const request = (text: string, offset: number, widget?: OpeningRequest["widget"]): OpeningRequest => ({ id: 1, text, offset, widget });
  const sectionTwo = (text: string) => {
    const block = parsePanel(EditorState.create({ doc: text, extensions: [markdown()] })).widgets[0];
    return { kind: "accordion", fence: block.from, source: block.source, section: { index: 1, source: block.sections[1].source, field: "body" } };
  };

  it("is used as it is when the text is the same", () => {
    expect(rematch(request("Alpha beta.", 6), "Alpha beta.")).toEqual({ offset: 6, widget: undefined });
  });

  it("finds the text's place again after a draft or a remote edit before it", () => {
    const before = "Alpha beta gamma.";
    const after = "New words. Alpha beta gamma.";
    expect(rematch(request(before, 6), after).offset).toBe(after.indexOf("beta"));
  });

  it("finds the widget again where it moved", () => {
    const before = `Intro.\n\n${ACCORDION}`;
    const after = `Longer intro.\n\n${ACCORDION}`;
    const found = rematch(request(before, before.indexOf(":::"), sectionTwo(before)), after);
    expect(found.widget!.fence).toBe(after.indexOf(":::"));
    expect(found.widget!.section!.index).toBe(1);
  });

  it.each([
    ["a widget replaced by another of the same kind at the same place", ":::accordion\n## Other\nText.\n:::"],
    ["a section inserted before the clicked one", ":::accordion\n## Zero\nNew.\n\n## One\nFirst.\n\n## Two\nSecond.\n:::"],
    ["a second widget with the same source", `${ACCORDION}\n\n${ACCORDION}`],
  ])("falls back to the start for %s", (_what, after) => {
    const found = rematch(request(ACCORDION, 0, sectionTwo(ACCORDION)), after);
    expect(found).toEqual({ offset: 0 });
  });

  it("falls back to the start for text found twice", () => {
    expect(rematch(request("Alpha.", 3), "Alpha. Alpha.").offset).toBe(0);
  });

  it("is computed on CRLF content in the editor's own line endings", () => {
    const source = "One line.\r\nTwo target.";
    const clicked = clickOn(source, "target", 2);
    expect(clicked.text).toBe("One line.\nTwo target.");
    expect(clicked.offset).toBe("One line.\nTwo ".length + 2);
  });
});
