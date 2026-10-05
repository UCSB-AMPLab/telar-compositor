/**
 * @vitest-environment jsdom
 *
 * footnote-html-blocks.test.ts — the footnote button and raw HTML in a panel.
 * Python Markdown holds a block-level tag that starts a line as a raw block
 * running to its end tag, however many blank lines it spans, and to the end
 * of the text when nothing closes it; a tag carrying `markdown="1"` leaves
 * its content as Markdown. The named cases fix the button's behaviour; the
 * last block sweeps a generated corpus through the framework's own panel
 * conversion, so the editor and the build cannot part on which position
 * takes a footnote without this file saying so.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { lineStart, scanHtmlBlocks } from "~/components/ui/markdown-editor/htmlBlocks";
import {
  insertFootnote,
  panelTarget,
  reusableDefinitions,
  setPanelTarget,
} from "~/components/ui/markdown-editor/footnoteSource";
import { footnoteScopeAt } from "~/components/ui/markdown-editor/footnoteSyntax";
import {
  FRAMEWORK_PYTHON,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  describeWithRequiredFramework,
} from "./helpers/framework-checkout";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

/** A view over `marked` with the insertion point at its `|`. */
function htmlBlockView(marked: string): EditorView {
  const at = marked.indexOf("|");
  const doc = marked.slice(0, at) + marked.slice(at + 1);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown(), panelTarget] }),
    parent: document.body,
  });
  views.push(view);
  view.dispatch({ effects: setPanelTarget.of({ from: at, to: at }) });
  return view;
}

/** What the button writes at `|`, or null when it refuses. */
function inserted(marked: string, reuse?: string): string | null {
  const view = htmlBlockView(marked);
  const label = (() => {
    const values = [...("zed3")].map((c) => ("abcdefghjkmnpqrstuvwxyz23456789".indexOf(c) + 0.5) / 31);
    values[0] = ("abcdefghjkmnpqrstuvwxyz".indexOf("z") + 0.5) / 23;
    let next = 0;
    return () => values[next++ % values.length];
  })();
  return insertFootnote(view, "A note", reuse, label) ? view.state.doc.toString() : null;
}

describe("scanHtmlBlocks", () => {
  const ranges = (text: string) => scanHtmlBlocks(text).map(({ from, to, unclosed }) => [from, to, !!unclosed]);

  it("runs a block to its end tag across blank lines", () => {
    const text = "<div>\n\nx\n\n</div>\n\nHi";
    expect(ranges(text)).toEqual([[0, text.indexOf("</div>") + 6, false]]);
  });

  it("runs an unclosed block to the end of the text", () => {
    expect(ranges("Hi\n\n<div>\n\nmore")).toEqual([[4, 15, true]]);
  });

  it("reads only the tags of a markdown container as raw", () => {
    expect(ranges('<div markdown="1">\nHi\n</div>')).toEqual([
      [0, 18, false],
      [22, 28, false],
    ]);
  });

  it("reads a plain block inside a container as raw, and a container inside a plain block as raw", () => {
    expect(ranges('<div markdown="1">\n<div>\nHi\n</div>\n</div>')).toContainEqual([19, 34, false]);
    expect(ranges('<div>\n<div markdown="1">\nHi\n</div>\n</div>')).toEqual([[0, 41, false]]);
  });

  it("does not open a block on a tag indented four columns, or one that is not block-level", () => {
    expect(ranges("Hi\n\n    <div>\nHi")).toEqual([]);
    expect(ranges("<span>x</span>\n\nHi")).toEqual([]);
  });

  it("keeps the text of nested unclosed containers as Markdown, since the build closes them at the end", () => {
    expect(ranges('<div markdown="1">\nA\n\n<div markdown="1">\nB').map((r) => r[2])).toEqual([false, false]);
  });

  it("marks the content of a span container, which takes references but no definitions", () => {
    const zones = (t: string) => scanHtmlBlocks(t).filter((r) => r.span).map((r) => [r.from, r.to, !!r.unclosed]);
    expect(zones('<div markdown="span">Hi</div>')).toEqual([[21, 23, false]]);
    expect(zones('<div markdown="span">\n<div markdown="1">\nHi')).toEqual([
      [21, 43, true],
      [40, 43, true],
    ]);
    expect(zones('<div markdown="1">\nHi\n</div>')).toEqual([]);
    expect(zones('<div markdown="block">\n<div markdown="span">\nHi\n</div>\n</div>')).toHaveLength(1);
  });

  it("reads a plain block or markdown=\"0\" inside a span container as raw", () => {
    const text = '<div markdown="span">\n<div markdown="0">\nHi\n</div>\n</div>';
    expect(scanHtmlBlocks(text).some((r) => !r.span && !r.tag && r.from === text.indexOf('<div markdown="0">'))).toBe(true);
  });

  it("strips the text first, so a first tag indented four columns starts a line", () => {
    expect(ranges("    <div>\nHi")).toEqual([[4, 12, true]]);
  });

  it("does not read a tag inside a fence or a formula", () => {
    expect(ranges("```\n<div>\n```\n\nHi")).toEqual([]);
    expect(ranges("$$\n<div>\n$$\n\nHi")).toEqual([]);
  });

  it.each([
    ["a comment", "<div>\n<!-- </div> -->\n\nHi", "unclosed"],
    ["a processing instruction", "<div>\n<?php </div> ?>\n\nHi", "unclosed"],
    ["a CDATA section", "<div>\n<![CDATA[ </div> ]]>\n\nHi", "unclosed"],
    ["a declaration", "<div>\n<!DOCTYPE </div>>\n\nHi", "unclosed"],
    ["a comment holding an opening tag", "<!-- <div> -->\n\nHi", [[0, 14, false]]],
  ])("skips the text of %s when it matches tags", (_what, text, expected) => {
    expect(ranges(text)).toEqual(expected === "unclosed" ? [[0, text.length, true]] : expected);
  });

  it.each([
    ["a comment", "<!--x-->"],
    ["a processing instruction", "<?x?>"],
    ["a CDATA section", "<![CDATA[x]]>"],
    ["a declaration", "<!DOCTYPE x>"],
  ])("reads a tag after %s beside a container's tag as text, since the skipped markup is data", (_what, skipped) => {
    const text = `<div markdown="1">${skipped}<div>\nHi\n</div>\n</div>`;
    const inner = text.indexOf("<div>");
    expect(ranges(text).some((r) => r[0] === inner)).toBe(false);
    const after = `<div markdown="1">\n${skipped}<div>\nHi\n</div>\n</div>`;
    expect(ranges(after).some((r) => r[0] === after.indexOf("<div>"))).toBe(false);
  });

  it("does not take a fence whose language holds a character only JavaScript calls a letter", () => {
    expect(ranges("```\u088f\n<div>\n```\n\nHi")).toEqual([[5, 18, true]]);
    expect(ranges("```\u088e\n<div>\n```\n\nHi")).toEqual([]);
  });

  it("ends script text at its own end tag, not at a longer name", () => {
    const text = '<script>\nconst s="</scripture><script>";\n</script>\n\nHi';
    expect(ranges(text)).toEqual([[0, text.indexOf("\n\nHi"), false]]);
    const style = '<style>\n.a::after{content:"</styled><style>"}\n</style>\n\nHi';
    expect(ranges(style)).toEqual([[0, style.indexOf("\n\nHi"), false]]);
  });

  it("reads a script's text as data, so an end tag in it closes nothing", () => {
    const text = "<div>\n<script>\n</div>\n</script>\n\nHi";
    expect(ranges(text)).toEqual([[0, text.length, true]]);
  });

  it("keeps a closing tag inside a script from ending the block", () => {
    const text = "<script>\nvar a='</div>';\n</script>\n\nHi";
    expect(ranges(text)).toEqual([[0, text.indexOf("\n\nHi"), false]]);
  });
});

describe("the button beside raw HTML", () => {
  it("writes the definition before an unclosed block that follows, where the build reads it", () => {
    expect(inserted("Hi|\n\n<div>\n\nmore")).toBe("Hi[^zed3]\n\n[^zed3]: A note\n\n<div>\n\nmore");
  });

  it("writes the definition before the closed block whose line holds an unclosed one", () => {
    expect(inserted("Hi|\n\n<div>\nx\n</div> tail <div>\nrest")).toBe(
      "Hi[^zed3]\n\n[^zed3]: A note\n\n<div>\nx\n</div> tail <div>\nrest",
    );
  });

  it("keeps a definition inside an unclosed markdown container", () => {
    expect(inserted('<div markdown="1">\nHi|')).toBe('<div markdown="1">\nHi[^zed3]\n\n[^zed3]: A note');
  });

  it("refuses the text of an unclosed plain block, which the build shows as written", () => {
    expect(inserted("<div>\n\nHi|\n\nmore")).toBeNull();
  });

  it("refuses the text of a closed block that spans blank lines", () => {
    expect(inserted("<div>\n\nHi|\n\nmore\n</div>")).toBeNull();
  });

  it("accepts the text of a markdown container", () => {
    expect(inserted('<div markdown="1">\nHi|\n</div>')).toBe(
      '<div markdown="1">\nHi[^zed3]\n</div>\n\n[^zed3]: A note',
    );
  });

  it("refuses the position in front of a container's tag, which a reference would take off its line", () => {
    expect(inserted('|<div markdown="1">\nHi\n</div>')).toBeNull();
  });

  it("offers a note defined inside a markdown container, and none defined in a plain block", () => {
    const inside = htmlBlockView('<div markdown="1">\nHi|\n\n[^ab2c]: Kept\n</div>');
    expect(reusableDefinitions(inside.state, { kind: "top", end: 0 }).map((d) => d.label)).toEqual(["ab2c"]);
    const plain = htmlBlockView("<div>\nHi|\n\n[^ab2c]: Lost\n</div>");
    expect(reusableDefinitions(plain.state, { kind: "top", end: 0 }).map((d) => d.label)).toEqual([]);
  });

  it("offers no note defined inside a span container, where the build reads it as text", () => {
    const span = htmlBlockView('Hi|\n\n<div markdown="span">\n[^ab2c]: Text\n</div>');
    expect(reusableDefinitions(span.state, { kind: "top", end: 0 }).map((d) => d.label)).toEqual([]);
    const block = htmlBlockView('Hi|\n\n<div markdown="block">\n[^ab2c]: Text\n</div>');
    expect(reusableDefinitions(block.state, { kind: "top", end: 0 }).map((d) => d.label)).toEqual(["ab2c"]);
  });

  it("writes the definition before an unclosed span container that holds the reference", () => {
    expect(inserted('<div markdown="span">\n<div markdown="1">\nHi|')).toBe(
      '[^zed3]: A note\n\n<div markdown="span">\n<div markdown="1">\nHi[^zed3]',
    );
    const view = htmlBlockView('<div markdown="span">\n<div markdown="1">\nHi|');
    insertFootnote(view, "A note", undefined, () => 0.5);
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf("]", view.state.doc.toString().lastIndexOf("Hi")) + 1);
    expect(inserted('Hi|\n\n<div markdown="span">\n<div markdown="1">\nB')).toBe(
      'Hi[^zed3]\n\n[^zed3]: A note\n\n<div markdown="span">\n<div markdown="1">\nB',
    );
  });

  it("writes the definition above a span container that follows leading blank lines", () => {
    expect(inserted('\n\n<div markdown="span">\nHi|')).toBe('\n\n[^zed3]: A note\n\n<div markdown="span">\nHi[^zed3]');
    expect(inserted('\n<div markdown="span">\nHi|')).toBe('\n\n[^zed3]: A note\n\n<div markdown="span">\nHi[^zed3]');
  }, 5000);

  it("writes the definition above the tag of a span container whose tag runs over several lines", () => {
    expect(inserted('Hi|\n\n<div\nmarkdown="span">\nB')).toBe(
      'Hi[^zed3]\n\n[^zed3]: A note\n\n<div\nmarkdown="span">\nB',
    );
    const text = 'Hi\n\n<div\nmarkdown="span">\nB';
    const zone = scanHtmlBlocks(text).find((r) => r.span)!;
    expect(zone.from).toBeGreaterThan(text.indexOf("\n", text.indexOf("<div")));
  }, 5000);

  it("keeps a container's offsets when the text begins with blank lines", () => {
    const ranges = scanHtmlBlocks('\n\n<div markdown="span">\nHi');
    expect(ranges.find((r) => r.tag)!.from).toBe(2);
    expect(ranges.find((r) => r.span)!.from).toBe(23);
  });

  it("finds a line's start, which lastIndexOf alone gets wrong at offset 0", () => {
    expect(lineStart("\nab", 0)).toBe(0);
    expect(lineStart("\nab", 2)).toBe(1);
    expect(lineStart("a\nb", 2)).toBe(2);
  });

  it("places the definition of a bibliography entry on the line before an unclosed block", () => {
    const view = htmlBlockView(":::bibliography\nFirst|.\n<div>\nnever closed\n:::");
    expect(footnoteScopeAt(view.state, view.state.field(panelTarget)!.from)?.kind).toBe("section");
    expect(insertFootnote(view, "A note", undefined, () => 0.5)).toBe(true);
    expect(view.state.doc.toString()).toMatch(/^:::bibliography\nFirst\[\^\w+\]\.\n\[\^\w+\]: A note\n<div>\nnever closed\n:::$/);
  });
});

/** The cases of the framework's tests/unit/test_unclosed_containers.py (UNCLOSED). */
const FRAMEWORK_UNCLOSED: Record<string, string> = {
  "issue case": '<div markdown="1">\nA\n\n<div markdown="1">\nB',
  "one level": '<div markdown="1">\nA',
  "three levels same name": '<div markdown="1">\nA\n\n<div markdown="1">\nB\n\n<div markdown="1">\nC',
  "differently named": '<div markdown="1">\nA\n\n<section markdown="1">\nB',
  "named, then same name again": '<div markdown="1">\nA\n\n<section markdown="1">\nB\n\n<div markdown="1">\nC',
  "closed inner, unclosed outer": '<div markdown="1">\nA\n\n<div markdown="1">\nB\n</div>\n\nC',
  "fenced code after the opening": '<div markdown="1">\nA\n\n```\n<div markdown="1">\n```\n\nB',
  "span-level container": '<p markdown="1">hi *x*',
};

/** Generated documents: a prefix, the paragraph holding `|`, and a suffix. */
const PREFIXES = [
  "",
  "<div>x</div>\n\n",
  "<div>\n\nx\n\n</div>\n\n",
  '<div markdown="1">\nA\n</div>\n\n',
  '<div markdown="1">\n\nA\n\n</div>\n\n',
  "<div>\n\nnever closed\n\n",
  '<div markdown="1">\nA\n\n',
  "<div>\n<div markdown=\"1\">\nA\n</div>\n</div>\n\n",
  "<p>inline</p>\n\n",
  "<hr>\n\n",
  "<pre>\ncode\n</pre>\n\n",
  "   <div>\ncode\n</div>\n\n",
  "    <div>\nindented code\n\n",
  "```\n<div>\n```\n\n",
  "<span>x</span>\n\n",
  "<div>x</div> tail <div>\n\n",
  "<script>\nvar a = '</div>';\n</script>\n\n",
  "<div>\n<script>\n</div>\n</script>\n\n",
  "$$\n<div>\n$$\n\n",
  "<div>\n<!-- </div> -->\n\n",
  "<!-- <div> -->\n\n",
  "<div>\n<?php </div> ?>\n\n",
  "<div>\n<![CDATA[ </div> ]]>\n\n",
  "<div>\n<!DOCTYPE </div>>\n\n",
  "```\u088f\n<div>\n```\n\n",
  '<script>\nconst s="</scripture><script>";\n</script>\n\n',
  '<style>\n.a::after{content:"</styled><style>"}\n</style>\n\n',
];
const SUFFIXES = [
  "",
  "\n\n<div>\n\nmore",
  "\n\n<div>x</div>",
  '\n\n<div markdown="1">\nB\n\nC\n</div>',
  '\n\n<div markdown="1">\nB',
  "\n\n<div>\nB\n\nC\n</div>\n\nafter",
  "\n\n```\n<div>\n```",
];
const MIDDLES = ["Hi|", "Hi| there"];

function corpus(): string[] {
  const docs: string[] = [];
  for (const prefix of PREFIXES)
    for (const middle of MIDDLES) for (const suffix of SUFFIXES) docs.push(prefix + middle + suffix);
  docs.push('<div markdown="1">|\nHi\n</div>', '<div markdown="1">\nHi\n</div>|');
  docs.push('<div markdown="1">\nHi|\n</div>', '<div markdown="1">\nHi|\n\nB\n</div>\n\nafter');
  docs.push('<div markdown="1">\n<div>\nHi|\n</div>\n</div>', '<div>\n<div markdown="1">\nHi|\n</div>\n</div>');
  docs.push('<div markdown="1">\n<div markdown="1">\nHi|\n</div>\n</div>', '<div markdown="span">Hi|</div>');
  for (const skipped of ["<!--x-->", "<?x?>", "<![CDATA[x]]>", "<!DOCTYPE x>"]) {
    docs.push(
      `<div markdown="1">${skipped}<div>\nHi|\n</div>\n</div>`,
      `<div markdown="1">${skipped}<div markdown="1">\nHi|\n</div>\n</div>`,
      `<div markdown="1">\n${skipped}<div markdown="1">\nHi|\n</div>\n</div>`,
      `<div markdown="1">${skipped}\nHi|\n</div>`,
      `<div markdown="1">${skipped}Hi|</div>`,
      `<div markdown="1">\n${skipped}\n<div>\nHi|\n</div>\n</div>`,
    );
  }
  for (const [_name, text] of Object.entries(FRAMEWORK_UNCLOSED)) {
    docs.push(`${text}\n\nHi|`, `Hi|\n\n${text}`, `${text}\nHi|`);
    docs.push(`${text}\n\nHi|\n\nmore`.replace("Hi|", "Hi|"));
  }
  for (const outer of ["span", "block", "1", "0", ""]) {
    for (const inner of ["span", "block", "1", "0", "", "none"]) {
      const openContainer = (value: string) => (value === "none" ? "<div>" : value === "" ? "<div markdown>" : `<div markdown="${value}">`);
      const close = "\n</div>";
      docs.push(
        `${openContainer(outer)}\n${openContainer(inner)}\nHi|`,
        `${openContainer(outer)}\n${openContainer(inner)}\nHi|${close}${close}`,
        `${openContainer(outer)}\n${openContainer(inner)}\nHi${close}\nHi|${close}`,
        `${openContainer(outer)}\n${openContainer(inner)}\nHi${close}\nHi|`,
        `${openContainer(outer)}Hi|</div>`,
        `Hi|\n\n${openContainer(outer)}\n${openContainer(inner)}\nB`,
      );
    }
  }
  docs.push(
    '<div\nmarkdown="span">\nHi|',
    'Hi|\n\n<div\nmarkdown="span">\nB',
    '\n\n<div markdown="span">\nHi|',
    '\n<div markdown="span">\n<div markdown="block">\nHi|',
    '<div markdown="span">\n<div markdown="block">\nHi|',
  );
  docs.push("<div>\n\nHi|\n\nmore", "<div>\n\nHi|\n\nmore\n</div>", "<pre>\nHi|\n</pre>");
  return docs;
}

/** Whether the framework publishes a footnote for each document: a reference, its note, and the note's text. */
function publishes(docs: string[]): boolean[] {
  const script = [
    "import sys, json",
    "sys.path.insert(0, 'scripts')",
    "from telar.markdown import process_inline_content",
    "out = []",
    "for doc in json.load(sys.stdin):",
    "    html = process_inline_content(doc)['content']",
    "    out.append('footnote-ref' in html and 'footnote-backref' in html and 'A note' in html)",
    "print(json.dumps(out))",
  ].join("\n");
  const stdout = execFileSync(FRAMEWORK_PYTHON, ["-c", script], {
    cwd: dirname(FRAMEWORK_SCRIPTS_DIR),
    input: JSON.stringify(docs),
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
  // The framework may print warnings before the result, which is the last line.
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describeWithRequiredFramework("the button against the framework's panel conversion", () => {
  it(
    "writes a footnote the build publishes wherever it accepts, and refuses where the build shows the reference as written",
    () => {
      const docs = corpus();
      const plain = (marked: string) => marked.replace("|", "");
      const edited = docs.map((marked) => inserted(marked));
      const naive = docs.map((marked) => {
        const at = marked.indexOf("|");
        return `${marked.slice(0, at)}[^zed3]${marked.slice(at + 1)}\n\n[^zed3]: A note`;
      });
      const acceptedDocs = edited.filter((d): d is string => d !== null);
      const acceptedWork = publishes(acceptedDocs);
      const naiveWork = publishes(naive);
      const top = docs.map((marked) => {
        const at = marked.indexOf("|");
        // Above everything, after any leading whitespace: the build strips the text first.
        const withRef = `${marked.slice(0, at)}[^zed3]${marked.slice(at + 1)}`;
        const lead = /^\s*/.exec(withRef)![0];
        return `${lead}[^zed3]: A note\n\n${withRef.slice(lead.length)}`;
      });
      const topWork = publishes(top);
      const wrongAccepts: string[] = [];
      const wrongRefusals: string[] = [];
      let accepted = 0;
      docs.forEach((marked, i) => {
        if (edited[i] === null) {
          if (naiveWork[i] || topWork[i]) wrongRefusals.push(JSON.stringify(plain(marked)) + ` at ${marked.indexOf("|")}`);
        } else if (!acceptedWork[accepted++]) {
          wrongAccepts.push(JSON.stringify(edited[i]));
        }
      });
      expect(wrongAccepts).toEqual([]);
      expect(wrongRefusals).toEqual([]);
      expect(docs.length).toBeGreaterThan(200);
      expect(acceptedDocs.length).toBeGreaterThan(docs.length / 3);
      expect(acceptedDocs.length).toBeLessThan(docs.length);
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});
