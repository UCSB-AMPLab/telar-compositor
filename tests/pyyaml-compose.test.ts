/**
 * The node tree `composePyYaml` (`app/lib/pyyaml.ts`) builds for a block: a
 * node written in flow style, or on the line after its key, composes to the
 * same tree as its block-style equivalent, which is what PyYAML's composer
 * gives both. Every tree written out below, and every block refused, is what
 * PyYAML 6.0.3's `yaml.compose` (SafeLoader) gives for the same text.
 *
 * @version v1.5.0-beta
 */

import { load } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composePyYaml, constructionFails, mappingValue, type PyYamlNode } from "~/lib/pyyaml";
import { safeLoadTitle } from "~/lib/yaml.server";

describe("composePyYaml", () => {
  it.each([
    ["a flow mapping root", "title: Acerca\nlocalized_for: about.md\n", "{title: Acerca, localized_for: about.md}\n"],
    ["an empty flow mapping root", "!!map {}\n", "{}\n"],
    ["a flow sequence root", "- a\n- b\n", "[a, b]\n"],
    ["an empty flow sequence root", "!!seq []\n", "[]\n"],
    ["a plain scalar root", "!!int 1\n", "1\n"],
    ["a quoted scalar root", "!!str x\n", "'x'\n"],
    ["a value on the next line", "title: yes\n", "title:\n  yes\n"],
    ["a flow value on the next line", "language: []\n", "language:\n  []\n"],
    ["a sequence entry", "[1, {a: 1}]\n", "- 1\n- {a: 1}\n"],
    ["an explicit merge key", "<<: {a: 1}\n", "? <<\n: {a: 1}\n"],
    ["a flow key with no value", "a:\nb: 1\n", "{a, b: 1}\n"],
    ["an explicit key with no value", "x:\ny: 1\n", "? x\ny: 1\n"],
    ["an explicit key with a comment before its value", "x: 1\n", "? x\n# c\n: 1\n"],
    ["a set", "!!set\na:\nb:\n", "!!set {a, b}\n"],
    ["a flow pair in a sequence", "- a: 1\n- b\n", "[a: 1, b]\n"],
    ["an explicit flow pair with no value", "- a:\n", "[? a]\n"],
  ])("composes %s as its equivalent", (_name, equivalent, written) => {
    expect(composePyYaml(written)).toEqual(composePyYaml(equivalent));
  });

  it("gives a block scalar root no children", () => {
    expect(composePyYaml("|\n  x\n")).toEqual({ kind: "scalar", tag: "tag:yaml.org,2002:str", text: "x\n", children: [] });
  });

  it("keeps a sequence whose one entry is an alias of itself", () => {
    expect(composePyYaml("&a [*a]\n")?.kind).toBe("sequence");
  });

  it("keeps a tag written on the line before its node", () => {
    expect(composePyYaml("!!str\n  1\n")).toEqual(composePyYaml("!!str 1\n"));
    expect(composePyYaml("a: !custom\n  [x]\n")).toEqual(composePyYaml("a: !custom [x]\n"));
  });
});

const T = "tag:yaml.org,2002:";
const scalar = (tag: string, text: string): PyYamlNode => ({ kind: "scalar", tag: tag.startsWith("!") ? tag : T + tag, text, children: [] });
const seq = (...children: PyYamlNode[]): PyYamlNode => ({ kind: "sequence", tag: `${T}seq`, text: "", children });
const map = (...children: PyYamlNode[]): PyYamlNode => ({ kind: "mapping", tag: `${T}map`, text: "", children });
const EMPTY = scalar("null", "");

describe("composePyYaml, block sequence entries with nothing in them", () => {
  it.each([
    ["an entry alone", "- \n", seq(EMPTY)],
    ["an entry with no space", "-\n", seq(EMPTY)],
    ["two entries", "-\n-\n", seq(EMPTY, EMPTY)],
    ["an entry before another", "a:\n  -\n  - x\n", map(scalar("str", "a"), seq(EMPTY, scalar("str", "x")))],
    ["an entry after another", "-\n  - x\n-\n", seq(seq(scalar("str", "x")), EMPTY)],
    ["an entry with a comment", "- # c\n- x\n", seq(EMPTY, scalar("str", "x"))],
    ["an entry whose comment holds a dash", "- # - c\n- x\n", seq(EMPTY, scalar("str", "x"))],
    ["an entry value after a comment holding a dash", "- # a - b\n  x\n", seq(scalar("str", "x"))],
    ["an entry value after a comment line holding a dash", "-\n  # a - b\n  x\n", seq(scalar("str", "x"))],
    ["a nested entry value after a comment holding a dash", "- - # - \n    x\n", seq(seq(scalar("str", "x")))],
    ["a nested sequence after a comment holding a dash", "- # - \n  - x\n", seq(seq(scalar("str", "x")))],
    ["an empty entry after a comment holding a dash", "tags:\n  - # one - two\n    x\n  -\n", map(scalar("str", "tags"), seq(scalar("str", "x"), EMPTY))],
    ["a mapping entry after a comment holding a dash", "list:\n  - # first - item\n    a: 1\n", map(scalar("str", "list"), seq(map(scalar("str", "a"), scalar("int", "1"))))],
    [
      "a page's authors after a comment holding a dash",
      "title: Hola\nlocalized_for: about\nlanguage: es\nauthors:\n  - # principal - lead\n    name: X\n",
      map(
        scalar("str", "title"), scalar("str", "Hola"),
        scalar("str", "localized_for"), scalar("str", "about"),
        scalar("str", "language"), scalar("str", "es"),
        scalar("str", "authors"), seq(map(scalar("str", "name"), scalar("str", "X"))),
      ),
    ],
    ["an entry before a key", "a:\n  -\nb: 1\n", map(scalar("str", "a"), seq(EMPTY), scalar("str", "b"), scalar("int", "1"))],
    ["a nested entry before an outer one", "- -\n- x\n", seq(seq(EMPTY), scalar("str", "x"))],
    ["a nested entry before an inner one", "- -\n  - y\n- x\n", seq(seq(EMPTY, scalar("str", "y")), scalar("str", "x"))],
  ])("records %s", (_name, written, tree) => {
    expect(composePyYaml(written)).toEqual(tree);
  });
});

describe("composePyYaml, an explicit tag with nothing under it", () => {
  it.each([
    ["a value", "a: !!str\n", map(scalar("str", "a"), scalar("str", ""))],
    ["a value on the next line", "a:\n  !!str\n", map(scalar("str", "a"), scalar("str", ""))],
    ["an entry", "- !!str\n- x\n", seq(scalar("str", ""), scalar("str", "x"))],
    ["a root", "!!str\n", scalar("str", "")],
    ["a local tag", "a: !foo\n", map(scalar("str", "a"), scalar("!foo", ""))],
    ["an anchor alone", "a: &x\nb: *x\n", map(scalar("str", "a"), EMPTY, scalar("str", "b"), EMPTY)],
    ["the bare tag", "a: !\n", map(scalar("str", "a"), EMPTY)],
  ])("keeps the tag on %s", (_name, written, tree) => {
    expect(composePyYaml(written)).toEqual(tree);
  });
});

/** Trees are what PyYAML 6.0.3 `yaml.compose` (SafeLoader) gives each text, written with `\n`. */
const BLOCK_SCALAR_PROPERTY_CASES: Array<[string, string, PyYamlNode]> = [
  ["a tag on the line before", "a: !!null\n  |\n    x\n", map(scalar("str", "a"), scalar("null", "x\n"))],
  ["a tag on the line before a folded scalar", "a: !!null\n  >\n    x\n", map(scalar("str", "a"), scalar("null", "x\n"))],
  ["a str tag on the line before", "a: !!str\n  |\n    x\n", map(scalar("str", "a"), scalar("str", "x\n"))],
  ["a local tag on the line before", "a: !foo\n  |\n    x\n", map(scalar("str", "a"), scalar("!foo", "x\n"))],
  ["a verbatim tag on the line before", "a: !<tag:yaml.org,2002:null>\n  |\n    x\n", map(scalar("str", "a"), scalar("null", "x\n"))],
  ["the bare tag on the line before", "a: !\n  |\n    12\n", map(scalar("str", "a"), scalar("int", "12\n"))],
  ["a tag and an anchor on the line before", "a: &x !!null\n  |\n    y\n", map(scalar("str", "a"), scalar("null", "y\n"))],
  ["an anchor and a tag on the line before", "a: !!null &x\n  |\n    y\n", map(scalar("str", "a"), scalar("null", "y\n"))],
  ["a tag on the line before and an anchor on the line after", "a: !!null\n  &x |\n    y\n", map(scalar("str", "a"), scalar("null", "y\n"))],
  ["a tag followed by a comment", "a: !!null # c\n  |\n    x\n", map(scalar("str", "a"), scalar("null", "x\n"))],
  ["a tag followed by a comment line", "a: !!null\n  # c\n  |\n    x\n", map(scalar("str", "a"), scalar("null", "x\n"))],
  ["a tag on the line before, with a chomping indicator", "a: !!null\n  |-\n    x\n", map(scalar("str", "a"), scalar("null", "x"))],
  ["a tag in a nested mapping", "b:\n  a: !!null\n    |\n      x\n", map(scalar("str", "b"), map(scalar("str", "a"), scalar("null", "x\n")))],
  ["a tag on a sequence entry", "- !!null\n  |\n    x\n", seq(scalar("null", "x\n"))],
  ["a tag on a root", "!!null\n|\n  x\n", scalar("null", "x\n")],
  ["a page's localized_for", "title: T\nlocalized_for: !!null\n  |\n    about.md\n", map(scalar("str", "title"), scalar("str", "T"), scalar("str", "localized_for"), scalar("null", "about.md\n"))],
  ["an anchor on the line before, aliased", "a: &x\n  |\n    y\nb: *x\n", map(scalar("str", "a"), scalar("str", "y\n"), scalar("str", "b"), scalar("str", "y\n"))],
  ["a tag and an anchor on the line before, aliased", "a: &x !!null\n  |\n    y\nb: *x\n", map(scalar("str", "a"), scalar("null", "y\n"), scalar("str", "b"), scalar("null", "y\n"))],
  ["a tag on the line before, with no final line break", "a: !!str\n  |\n    x", map(scalar("str", "a"), scalar("str", "x"))],
  ["a tag and a comment, with no final line break", "a: !!str # c\n  |\n    x", map(scalar("str", "a"), scalar("str", "x"))],
  ["a tag on the same line, with no final line break", "a: !!str |\n    x", map(scalar("str", "a"), scalar("str", "x"))],
];

describe("composePyYaml, properties written before the line break of a block scalar", () => {
  // PyYAML reads `\r\n` and a bare `\r` as line breaks and gives a block scalar's text `\n` for either.
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("composes each case written with %s line breaks as PyYAML does", (_style, br) => {
    for (const [name, written, tree] of BLOCK_SCALAR_PROPERTY_CASES) {
      expect(composePyYaml(written.replace(/\n/g, br)), name).toEqual(tree);
    }
  });

  it("composes a tag on the line before as a tag on the same line", () => {
    expect(composePyYaml("a: !!null\n  |\n    x\n")).toEqual(composePyYaml("a: !!null |\n    x\n"));
  });

  it("refuses a local tag on the line before a block scalar, as it does on the same line", () => {
    expect(constructionFails(composePyYaml("a: !foo\n  |\n    x\n")!)).toBe(true);
    expect(constructionFails(composePyYaml("a: !foo |\n    x\n")!)).toBe(true);
  });

  it("refuses two tags on one block scalar", () => {
    expect(composePyYaml("a: !!str\n  !!null |\n    x\n")).toBeNull();
  });
});

describe("composePyYaml, blocks PyYAML's composer refuses", () => {
  it.each([
    ["an anchor named twice in a sequence", "- &a [x]\n- &a [*a]\n"],
    ["an anchor named twice in a mapping", "a: &x 1\nb: &x 2\n"],
    ["an anchor before an alias on the next line", "b: &b x\na: &a\n  *b\n"],
    ["an anchor before an alias in an entry", "b: &b 1\nc:\n  - &a\n    *b\n"],
    ["the bare tag before an alias on the next line", "b: &b [x]\na: !\n  *b\n"],
    ["a tab after an empty entry's indicator", "-\t\n- x\n"],
    ["a tab after an entry's indicator", "- \tx\n"],
    ["a tab after an entry's indicator and 63 spaces", `-${" ".repeat(63)}\tx\n`],
    ["a tab after an anchor on a key's line", "&a\tk: v\n"],
    ["an alias before its anchored key", "b: *r\n&r a: 1\n"],
    ["an anchored alias key", "&r *x: 1\n"],
  ])("refuses %s", (_name, written) => {
    expect(composePyYaml(written)).toBeNull();
  });

  it("composes an alias on the next line with no properties", () => {
    expect(composePyYaml("b: &b x\na:\n  *b\n")).toEqual(map(scalar("str", "b"), scalar("str", "x"), scalar("str", "a"), scalar("str", "x")));
  });
});

describe("composePyYaml, properties on the first key of a block mapping", () => {
  it.each([
    ["an anchored key", "&r a: 1\nb: *r\n", map(scalar("str", "a"), scalar("int", "1"), scalar("str", "b"), scalar("str", "a"))],
    ["a tagged merge key", "!!merge <<: {a: 1}\n", map(scalar("merge", "<<"), map(scalar("str", "a"), scalar("int", "1")))],
    ["a tagged key in a nested mapping", "x:\n  !!str a: 1\n  b: 2\n", map(scalar("str", "x"), map(scalar("str", "a"), scalar("int", "1"), scalar("str", "b"), scalar("int", "2")))],
    ["an anchored key in an entry", "- &r a: 1\n", seq(map(scalar("str", "a"), scalar("int", "1")))],
    ["a local tag on a key", "!foo a: 1\n", map(scalar("!foo", "a"), scalar("int", "1"))],
    ["an anchored key with an anchored value", "&r a: &v 1\nb: *v\n", map(scalar("str", "a"), scalar("int", "1"), scalar("str", "b"), scalar("int", "1"))],
    ["an anchored flow key", "&r [a]: 1\n", map(seq(scalar("str", "a")), scalar("int", "1"))],
    ["an anchored key with a quoted value over two lines", "&r a: \"x\n  y\"\nb: 2\n", map(scalar("str", "a"), scalar("str", "x y"), scalar("str", "b"), scalar("int", "2"))],
  ])("gives the properties to %s", (_name, written, tree) => {
    expect(composePyYaml(written)).toEqual(tree);
  });

  it("leaves a line inside a block scalar as written", () => {
    expect(composePyYaml("&s b: 2\na: |\n  &r a: 1\n")).toEqual(map(scalar("str", "b"), scalar("int", "2"), scalar("str", "a"), scalar("str", "&r a: 1\n")));
  });

  it.each([
    ["an anchor named on two keys", "&r a: 1\n&r b: 1\n"],
    ["an anchor before an alias key", "x: &x k\n&r *x : 1\n"],
    ["an anchor before a sequence entry", "&r - a: 1\n"],
    ["an anchor before an explicit key", "&r ? a: 1\n"],
    ["two anchors on one node over two lines", "&a\n  &b [x]\n"],
  ])("refuses %s", (_name, written) => {
    expect(composePyYaml(written)).toBeNull();
  });
});

describe("composePyYaml, a node that contains an alias of itself", () => {
  it("records a sequence holding itself", () => {
    const root = composePyYaml("&a [*a]\n")!;
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toBe(root);
  });

  it("records a mapping holding itself, anchored on the line before", () => {
    const root = composePyYaml("&a\nk: *a\n")!;
    expect(root.kind).toBe("mapping");
    expect(root.children[1]).toBe(root);
  });

  it("records a flow sequence anchored on the line before", () => {
    const root = composePyYaml("&a\n  [*a]\n")!;
    expect(root.kind).toBe("sequence");
    expect(root.children[0]).toBe(root);
  });

  it("constructs a mapping that merges itself", () => {
    const root = composePyYaml("&a\n<<: *a\nt: 1\n")!;
    expect(root.children[1]).toBe(root);
    expect(constructionFails(root)).toBe(false);
  });

  it("searches a mapping that merges itself twice once", () => {
    const root = composePyYaml("&a\n<<: [*a, *a]\nt: 1\n")!;
    expect(mappingValue(root, "t")?.text).toBe("1");
    expect(mappingValue(root, "missing")).toBeUndefined();
  });
});

describe("js-yaml's listener state", () => {
  it("carries the anchor map moved anchors are declared in", () => {
    const seen: unknown[] = [];
    load("a: &x 1\n", { listener: (event, state) => void (event === "open" && seen.push((state as unknown as { anchorMap?: unknown }).anchorMap)) });
    expect(seen.length).toBeGreaterThan(0);
    for (const anchorMap of seen) expect(anchorMap).toBeTypeOf("object");
  });
});

describe("composePyYaml, a filled block that does not read", () => {
  afterEach(() => {
    vi.doUnmock("js-yaml");
    vi.resetModules();
  });

  it("keeps the first reading's tree", async () => {
    vi.resetModules();
    vi.doMock("js-yaml", async (original) => {
      const actual = await original<typeof import("js-yaml")>();
      const refuseFilled: typeof actual.load = (text, options) => {
        if (text.includes("- ~")) throw new actual.YAMLException("filled text refused");
        return actual.load(text, options);
      };
      return { ...actual, load: refuseFilled, default: { ...actual, load: refuseFilled } };
    });
    const { composePyYaml: compose } = await import("~/lib/pyyaml");
    expect(compose("-\n- x\n")).toEqual(seq(scalar("str", "x")));
  });
});

describe("safeLoadTitle", () => {
  it("reads `title: !!str` as the empty string", () => {
    expect(safeLoadTitle("title: !!str\n")).toEqual({ loads: true, title: { isString: true, text: "" } });
  });

  it("reads the title of a block whose first key is anchored", () => {
    expect(safeLoadTitle("&t title: Hello\n")).toEqual({ loads: true, title: { isString: true, text: "Hello" } });
  });

  it("reads the title of a block that contains itself", () => {
    expect(safeLoadTitle("&a\ntitle: Hello\nself: *a\n<<: *a\n")).toEqual({ loads: true, title: { isString: true, text: "Hello" } });
  });

  it("reads the title of a flow mapping", () => {
    expect(safeLoadTitle("{title: Hello}\n")).toEqual({ loads: true, title: { isString: true, text: "Hello" } });
  });

  it("pairs each key with its own value where a key has none", () => {
    expect(safeLoadTitle("{title, draft: x}\n")).toEqual({ loads: true, title: { isString: false, text: "" } });
    expect(safeLoadTitle("{draft, title: Hello}\n")).toEqual({ loads: true, title: { isString: true, text: "Hello" } });
  });

  it("reads a title on the next line as PyYAML types it", () => {
    expect(safeLoadTitle("title:\n  yes\n")).toEqual({ loads: true, title: { isString: false, text: "yes" } });
  });
});
