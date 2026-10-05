/**
 * footnote-scopes.test.ts — which conversion a footnote reference joins and
 * where one cannot go. Positions are written into each fixture as `|`.
 *
 * The widget structure mirrors the framework's `process_widgets`
 * (scripts/telar/widgets.py): each accordion or tabs section is its own
 * conversion, each bibliography entry is too (framework 1.8.0 converts
 * entries with `extra`), carousel text takes no footnotes, and an unclosed
 * fence is ordinary top-level text.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { footnoteScopeAt } from "~/components/ui/markdown-editor/footnoteSyntax";

function scopeOf(marked: string) {
  const pos = marked.indexOf("|");
  const doc = marked.slice(0, pos) + marked.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [markdown()] });
  return { scope: footnoteScopeAt(state, pos), doc };
}

const TABS = ":::tabs\n## One\nFirst text.\n\n## Two\nSecond text.\n:::";

describe("footnoteScopeAt: refused positions", () => {
  it.each([
    ["inline code", "Text `co|de` more."],
    ["a fenced code block", "Text.\n\n```\nco|de\n```"],
    ["the start of a fenced code block's line", "Text.\n\n|```\ncode\n```"],
    ["the end of a fenced code block's closing line", "Text.\n\n```\ncode\n```|\n\nMore."],
    ["an indented code block", "Text.\n\n    co|de\n\nMore."],
    ["after one backslash", "Text \\|more."],
    ["after three backslashes", "Text \\\\\\|more."],
    ["a link's text", "See [the ar|chive](https://example.org) now."],
    ["a link's URL", "See [the archive](https://exam|ple.org) now."],
    ["a reference-style link", "See [the ar|chive][ref] now.\n\n[ref]: https://example.org"],
    ["a link reference definition", "See [a][ref].\n\n[ref]: https://exam|ple.org"],
    ["an autolink", "See <https://exam|ple.org> now."],
    ["an image's alt text", "See ![a pic|ture](p.jpg) now."],
    ["a carousel", ":::carousel\nimage: a.jpg\ncaption: A cap|tion\n:::"],
    ["the blank line between bibliography entries", ":::bibliography\nFirst.\n|\nSecond.\n:::"],
    ["an unknown widget", ":::gallery\nSome te|xt\n:::"],
    ["a widget's opening fence line", ":::ta|bs\n## One\nText\n:::"],
    ["the end of a widget's opening fence line", ":::tabs|\n## One\nText\n:::"],
    ["a widget's closing fence line", ":::tabs\n## One\nText\n|:::"],
    ["a section heading line", ":::tabs\n## O|ne\nText\n:::"],
    ["the end of a section heading line", ":::tabs\n## One|\nText\n:::"],
    ["a widget body before its first heading", ":::accordion\nLo|st text\n## One\nText\n:::"],
    ["code fenced within its own section", ":::tabs\n## One\n```\n## Two\n```\nText|\n```\n:::"],
    ["a definition's line start", "Text[^a].\n\n|[^a]: Note"],
    ["a definition's indentation", "Text[^a].\n\n |  [^a]: Note"],
    ["a definition's label", "Text[^a].\n\n[^a|b]: Note"],
    ["a definition's marker before the colon", "Text[^ab].\n\n[^ab]|: Note"],
  ])("refuses %s", (_what, marked) => {
    expect(scopeOf(marked).scope).toBeNull();
  });
});

describe("footnoteScopeAt: accepted positions", () => {
  it("places top-level text in the top scope, ending at the document's end", () => {
    const { scope, doc } = scopeOf("Alpha| beta.");
    expect(scope).toEqual({ kind: "top", end: doc.length });
  });

  it("accepts the edges of inline code and links, and after two backslashes", () => {
    expect(scopeOf("Text `code`| more.").scope?.kind).toBe("top");
    expect(scopeOf("Text |`code` more.").scope?.kind).toBe("top");
    expect(scopeOf("See [a](https://x.org)| now.").scope?.kind).toBe("top");
    expect(scopeOf("Text \\\\|more.").scope?.kind).toBe("top");
  });

  it("gives each tabs or accordion section its own scope, ending before the next heading or the fence", () => {
    const first = scopeOf(TABS.replace("First", "Fi|rst"));
    const second = scopeOf(TABS.replace("Second", "Sec|ond"));
    expect(first.scope).toEqual({ kind: "section", from: 15, end: first.doc.indexOf("\n## Two") });
    expect(second.scope).toEqual({ kind: "section", from: first.doc.indexOf("Second"), end: second.doc.lastIndexOf("\n:::") });
    const accordion = scopeOf(TABS.replace("tabs", "Accordion").replace("First", "Fi|rst"));
    expect(accordion.scope?.kind).toBe("section");
  });

  it("gives each bibliography entry its own scope, marked as an entry", () => {
    const doc = ":::bibliography\nFirst entry.\n\nSecond entry.\n:::";
    const first = scopeOf(doc.replace("First", "Fi|rst"));
    const second = scopeOf(doc.replace("Second", "Sec|ond"));
    expect(first.scope).toEqual({ kind: "section", from: 16, end: 28, entry: true });
    expect(second.scope).toEqual({ kind: "section", from: 30, end: second.doc.lastIndexOf("\n:::"), entry: true });
  });

  it("puts text straight after a closing fence, or below it, in the top scope", () => {
    expect(scopeOf(`${TABS}|\n\nAfter.`).scope?.kind).toBe("top");
    expect(scopeOf(`${TABS}\n\nAf|ter.`).scope?.kind).toBe("top");
  });

  it("treats an unclosed fence as top-level text", () => {
    const { scope, doc } = scopeOf(":::tabs\n## One\nText th|at never closes");
    expect(scope).toEqual({ kind: "top", end: doc.length });
  });

  it("reads each section with its own syntax: a fence left open in one does not reach the next", () => {
    const doc = ":::tabs\n## One\n```\nCode\n## Two\nProse| here\n:::\n\nAfter| text.";
    const first = doc.indexOf("|");
    const second = doc.lastIndexOf("|") - 1;
    const clean = doc.replaceAll("|", "");
    const state = EditorState.create({ doc: clean, extensions: [markdown()] });
    expect(footnoteScopeAt(state, first)?.kind).toBe("section");
    expect(footnoteScopeAt(state, second)?.kind).toBe("top");
  });

  it("accepts the text of an existing footnote definition", () => {
    expect(scopeOf("Text[^ab].\n\n[^ab]:| Note").scope?.kind).toBe("top");
    expect(scopeOf("Text[^a].\n\n[^a]: Note| text").scope?.kind).toBe("top");
    expect(scopeOf("Text[^a].\n\n[^a]: Word|").scope?.kind).toBe("top");
  });
});

describe("footnoteScopeAt: the Markdown after a widget", () => {
  it("reads a code block straight after a widget as code", () => {
    const doc = [":::tabs", "## One", "Text", ":::", "```", "[^fake]: code", "```", "", "After"].join("\n");
    const state = EditorState.create({ doc, extensions: [markdown()] });
    expect(footnoteScopeAt(state, doc.indexOf(": code") + 4)).toBeNull();
    expect(footnoteScopeAt(state, doc.length)?.kind).toBe("top");
  });
});
