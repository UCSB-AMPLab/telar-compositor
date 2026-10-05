/**
 * @vitest-environment jsdom
 *
 * footnote-source.test.ts — the footnote source module on its own: which
 * definitions count (by where their marker is), which notes each conversion
 * can reuse, the shape and uniqueness of new labels against every `[^label]`
 * in the text, how the insertion target follows or drops on edits, and what
 * `insertFootnote` writes at the top level and in widget sections. Label
 * collisions are forced through the injectable random source.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import {
  reusableDefinitions,
  takenLabels,
  newFootnoteLabel,
  panelTarget,
  setPanelTarget,
  insertFootnote,
} from "~/components/ui/markdown-editor/footnoteSource";
import { notePreview } from "~/components/ui/markdown-editor/FootnotePopover";
import type { FootnoteScope } from "~/components/ui/markdown-editor/footnoteScopes";
import { footnoteScopeAt, parseDefinitions } from "~/components/ui/markdown-editor/footnoteSyntax";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const LETTERS = "abcdefghjkmnpqrstuvwxyz";
const LABEL_SHAPE = /^[abcdefghjkmnpqrstuvwxyz][abcdefghjkmnpqrstuvwxyz23456789]{3}$/;

/** A random source that draws exactly the given labels, in order. */
function drawing(...labels: string[]): () => number {
  const values = labels.flatMap((label) =>
    [...label].map((c, i) => {
      const alphabet = i === 0 ? LETTERS : ALPHABET;
      return (alphabet.indexOf(c) + 0.5) / alphabet.length;
    }),
  );
  let next = 0;
  return () => {
    if (next >= values.length) throw new Error("random source exhausted");
    return values[next++];
  };
}

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown(), panelTarget] });
}

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

function viewAt(doc: string, at: number): EditorView {
  const view = new EditorView({ state: stateOf(doc), parent: document.body });
  views.push(view);
  view.dispatch({ effects: setPanelTarget.of({ from: at, to: at }) });
  return view;
}

const TOP: FootnoteScope = { kind: "top", end: 0 };

function labels(defs: { label: string }[]): string[] {
  return defs.map((d) => d.label);
}

describe("parseDefinitions", () => {
  it("reads continuation lines, up to three leading spaces, and labels with spaces", () => {
    const doc = "Text.\n\n    [^four]: code\n\n[^ab2c]: First line\n    second line\n\n   [^with space]: Other";
    expect(parseDefinitions(stateOf(doc)).map((d) => [d.label, d.text])).toEqual([
      ["ab2c", "First line\nsecond line"],
      ["with space", "Other"],
    ]);
  });

  it("keeps a definition whose text holds code, and drops one whose marker is in code", () => {
    const doc = [
      "Text.",
      "",
      "[^a]: Uses `inline code` and <b>html</b>",
      "",
      "```",
      "[^fenced]: in a fence",
      "```",
    ].join("\n");
    expect(labels(parseDefinitions(stateOf(doc)))).toEqual(["a"]);
  });
});

describe("reusableDefinitions", () => {
  it("offers labels defined once, unless they hold a character that stops the reference working", () => {
    const doc = [
      "a[^d] b",
      "",
      "[^d]: One",
      "",
      "[^d]: Two",
      "",
      "[^u_1-x]: Underscore",
      "",
      "[^with space]: Spaced",
      "",
      "[^é]: Accent",
      "",
      "[^a.b]: Dotted",
      "",
      "[^a*b*c]: Emphasis",
      "",
      "[^x`y]: Backtick",
      "",
      "[^a<b]: Angle",
      "",
      "[^a&b]: Ampersand",
      "",
      "[^a\\b]: Backslash",
    ].join("\n");
    expect(labels(reusableDefinitions(stateOf(doc), TOP))).toEqual(["u_1-x", "with space", "é", "a.b", "a*b*c", "a<b", "a&b", "a\\b"]);
  });

  it("offers only the notes of the same conversion", () => {
    const doc = [
      "Top text.",
      ":::tabs",
      "## One",
      "Section text.",
      "",
      "[^sec]: In the section",
      "## Two",
      "Other section.",
      ":::",
      "",
      "[^top]: At the top",
    ].join("\n");
    const state = stateOf(doc);
    const inOne = footnoteScopeAt(state, doc.indexOf("Section text"))!;
    const inTwo = footnoteScopeAt(state, doc.indexOf("Other section"))!;
    const atTop = footnoteScopeAt(state, 3)!;
    expect(labels(reusableDefinitions(state, atTop))).toEqual(["top"]);
    expect(labels(reusableDefinitions(state, inOne))).toEqual(["sec"]);
    expect(labels(reusableDefinitions(state, inTwo))).toEqual([]);
  });
});

describe("parseDefinitions per conversion", () => {
  it("reads a section's definitions with that section's syntax", () => {
    const doc = [
      ":::tabs",
      "## One",
      "```",
      "[^inone]: in One's open fence",
      "## Two",
      "[^intwo]: after One's open fence",
      "",
      "```",
      "[^fenced]: in Two's own fence",
      "```",
      ":::",
    ].join("\n");
    expect(labels(parseDefinitions(stateOf(doc)))).toEqual(["intwo"]);
  });
});

describe("takenLabels", () => {
  it("counts labels inside code, nested in definitions, and in unclosed fences", () => {
    const doc = "`[^inline]`\n\n```\n[^fenced]\n```\n\n[^def]: with [^nested]\n\n:::tabs\n## A\n[^unclosed]";
    expect([...takenLabels(doc)].sort()).toEqual(["def", "fenced", "inline", "nested", "unclosed"]);
  });
});

describe("newFootnoteLabel", () => {
  it("draws four characters from the alphabet, starting with a letter", () => {
    for (let i = 0; i < 200; i++) {
      const label = newFootnoteLabel(new Set());
      expect(label).toMatch(LABEL_SHAPE);
      expect(`[^${label}]`).toMatch(/^\[\^[^\]\s]+\]$/);
    }
  });

  it("uses the extremes of the random source without leaving the alphabet", () => {
    expect(newFootnoteLabel(new Set(), () => 0)).toBe("aaaa");
    expect(newFootnoteLabel(new Set(), () => 0.999999)).toBe("z999");
  });

  it("draws again while the label is taken", () => {
    expect(newFootnoteLabel(new Set(["n7k2"]), drawing("n7k2", "p3q4"))).toBe("p3q4");
  });

  it("grows the label rather than loop when the source keeps repeating", () => {
    expect(newFootnoteLabel(new Set(["aaaa"]), () => 0)).toBe("aaaaa");
  });
});

describe("panelTarget", () => {
  it("maps across an edit elsewhere", () => {
    const view = viewAt("Alpha beta.", 5);
    view.dispatch({ changes: { from: 0, insert: "XY" } });
    expect(view.state.field(panelTarget)).toEqual({ from: 7, to: 7 });
    view.dispatch({ changes: { from: 9, to: 11 } });
    expect(view.state.field(panelTarget)).toEqual({ from: 7, to: 7 });
  });

  it.each([
    ["an insertion at the target", { from: 5, insert: "Z" }],
    ["a deletion across it", { from: 3, to: 7 }],
    ["a deletion ending at it", { from: 3, to: 5 }],
    ["a deletion starting at it", { from: 5, to: 7 }],
    ["a replacement ending at it", { from: 3, to: 5, insert: "ZZ" }],
  ])("drops on %s", (_what, changes) => {
    const view = viewAt("Alpha beta.", 5);
    view.dispatch({ changes });
    expect(view.state.field(panelTarget)).toBeNull();
  });
});

describe("insertFootnote", () => {
  it("adds the reference at the target and the definition at the end", () => {
    const view = viewAt("Alpha beta.", 5);
    expect(insertFootnote(view, " A note\nsecond ", undefined, drawing("n7k2"))).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "Alpha[^n7k2] beta.\n\n[^n7k2]: A note\n    second",
    );
    expect(view.state.selection.main.head).toBe(12);
    expect(view.state.field(panelTarget)).toBeNull();
  });

  it.each([
    ["no newline", "Alpha", "Alpha[^n7k2]\n\n[^n7k2]: Note"],
    ["one newline", "Alpha\n", "Alpha\n[^n7k2]\n\n[^n7k2]: Note"],
    ["two newlines", "Alpha\n\n", "Alpha\n\n[^n7k2]\n\n[^n7k2]: Note"],
    ["nothing", "", "[^n7k2]\n\n[^n7k2]: Note"],
  ])("inserts at the end of a text ending with %s", (_what, doc, expected) => {
    const view = viewAt(doc, doc.length);
    insertFootnote(view, "Note", undefined, drawing("n7k2"));
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("leaves one blank line before the definition when the text ends with newlines", () => {
    for (const ending of ["", "\n", "\n\n"]) {
      const view = viewAt(`Alpha.${ending}`, 5);
      insertFootnote(view, "Note", undefined, drawing("n7k2"));
      expect(view.state.doc.toString()).toBe("Alpha[^n7k2].\n\n[^n7k2]: Note");
    }
  });

  it("reuses a note by adding only the reference", () => {
    const view = viewAt("Alpha beta.\n\n[^ab2c]: First", 5);
    expect(insertFootnote(view, "", "ab2c")).toBe(true);
    expect(view.state.doc.toString()).toBe("Alpha[^ab2c] beta.\n\n[^ab2c]: First");
  });

  it("never draws a label taken by a definition or a reference", () => {
    const view = viewAt("Alpha[^p3q4] beta.\n\n[^n7k2]: First", 5);
    insertFootnote(view, "Second", undefined, drawing("n7k2", "p3q4", "r5s6"));
    expect(view.state.doc.toString()).toBe(
      "Alpha[^r5s6][^p3q4] beta.\n\n[^n7k2]: First\n\n[^r5s6]: Second",
    );
  });

  it("never draws a label that appears only inside code or nested in a definition", () => {
    const view = viewAt("Alpha.\n\n```\n[^n7k2]\n```\n\n[^a]: See [^p3q4]", 5);
    insertFootnote(view, "Note", undefined, drawing("n7k2", "p3q4", "r5s6"));
    expect(view.state.doc.toString()).toBe(
      "Alpha[^r5s6].\n\n```\n[^n7k2]\n```\n\n[^a]: See [^p3q4]\n\n[^r5s6]: Note",
    );
  });

  it("puts the definition at the end of a middle section, before the next heading", () => {
    const doc = ":::tabs\n## One\nFirst text.\n\n## Two\nSecond text.\n:::";
    const view = viewAt(doc, doc.indexOf(" text."));
    insertFootnote(view, "Note", undefined, drawing("n7k2"));
    expect(view.state.doc.toString()).toBe(
      ":::tabs\n## One\nFirst[^n7k2] text.\n\n[^n7k2]: Note\n\n## Two\nSecond text.\n:::",
    );
  });

  it("puts the definition at the end of the last section, before the closing fence", () => {
    const doc = "Intro.\n\n:::accordion\n## One\nFirst text.\n## Two\nSecond text.\n:::\n\nAfter.";
    const view = viewAt(doc, doc.indexOf(" text.", doc.indexOf("Second")));
    insertFootnote(view, "Note", undefined, drawing("n7k2"));
    expect(view.state.doc.toString()).toBe(
      "Intro.\n\n:::accordion\n## One\nFirst text.\n## Two\nSecond[^n7k2] text.\n\n[^n7k2]: Note\n:::\n\nAfter.",
    );
  });

  it("puts a top-level definition after a closing fence that ends the document", () => {
    const doc = "Intro.\n\n:::tabs\n## One\nText.\n:::";
    const view = viewAt(doc, 5);
    insertFootnote(view, "Note", undefined, drawing("n7k2"));
    expect(view.state.doc.toString()).toBe(
      "Intro[^n7k2].\n\n:::tabs\n## One\nText.\n:::\n\n[^n7k2]: Note",
    );
  });

  it("treats text in an unclosed fence as top-level", () => {
    const doc = ":::tabs\n## One\nText";
    const view = viewAt(doc, doc.length);
    insertFootnote(view, "Note", undefined, drawing("n7k2"));
    expect(view.state.doc.toString()).toBe(":::tabs\n## One\nText[^n7k2]\n\n[^n7k2]: Note");
  });

  it("reuses only a note of the same conversion", () => {
    const doc = ":::tabs\n## One\nFirst.\n\n[^sec]: Section note\n:::\n\nTop.\n\n[^top]: Top note";
    const inSection = doc.indexOf(".");
    const atTop = doc.indexOf("Top.") + 3;
    expect(insertFootnote(viewAt(doc, inSection), "", "top")).toBe(false);
    expect(insertFootnote(viewAt(doc, atTop), "", "sec")).toBe(false);
    const view = viewAt(doc, inSection);
    expect(insertFootnote(view, "", "sec")).toBe(true);
    expect(view.state.doc.toString()).toBe(doc.replace("First.", "First[^sec]."));
  });

  it.each([
    ["inline code", "Text `co|de` more."],
    ["a link", "See [the ar|chive](https://example.org)."],
    ["a carousel", ":::carousel\nimage: a.jpg\ncaption: A cap|tion\n:::"],
    ["a heading line", ":::tabs\n## O|ne\nText\n:::"],
  ])("refuses a target inside %s", (_what, marked) => {
    const at = marked.indexOf("|");
    const doc = marked.replace("|", "");
    const view = viewAt(doc, at);
    expect(insertFootnote(view, "Note")).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("refuses without a target, with an empty note, or with an unknown reuse", () => {
    const noTarget = viewAt("Alpha.", 5);
    noTarget.dispatch({ effects: setPanelTarget.of(null) });
    expect(insertFootnote(noTarget, "Note")).toBe(false);
    expect(insertFootnote(viewAt("Alpha.", 5), "  ")).toBe(false);
    expect(insertFootnote(viewAt("Alpha.\n\n[^a]: x\n\n[^a]: y", 5), "", "a")).toBe(false);
    expect(insertFootnote(viewAt("Alpha.", 5), "", "missing")).toBe(false);
  });
});

describe("notePreview", () => {
  it("flattens whitespace and truncates long notes", () => {
    expect(notePreview("  One\n  two  ")).toBe("One two");
    const preview = notePreview("word ".repeat(40));
    expect(preview.length).toBeLessThanOrEqual(60);
    expect(preview.endsWith("…")).toBe(true);
  });
});
