/**
 * The escapes the Compositor applies to an author's text when it writes that
 * text into Markdown syntax (app/components/ui/markdown-editor/authorText.ts).
 * What the site makes of each form is measured in author-text-parity.test.ts
 * and in the panel and answer oracles.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { marked } from "marked";
import { resolveGlossaryLinks } from "~/lib/glossary-links";
import { htmlUnescape } from "~/lib/html-unescape";
import { describeWithPython, runPython } from "./helpers/framework-checkout";
import {
  decodeWrittenEntities,
  encodeUrlForMarkdown,
  escapeBracketsForMarkdown,
  escapeEveryBracket,
  escapeGlossaryDisplay,
  glossaryReference,
} from "~/components/ui/markdown-editor/authorText";

describe("escapeBracketsForMarkdown", () => {
  it.each([
    ["no brackets", "Marco de un telar", "Marco de un telar"],
    ["empty", "", ""],
    ["a balanced pair, one level", "Loom [Telar]", "Loom [Telar]"],
    ["two pairs side by side", "[a] and [b]", "[a] and [b]"],
    ["a lone opening bracket", "Loom [Telar", "Loom &#91;Telar"],
    ["a lone closing bracket", "Loom Telar]", "Loom Telar&#93;"],
    ["a closing bracket before its opening one", "a ] b [ c", "a &#93; b &#91; c"],
    ["a pair two levels deep", "A [b [c]] d", "A &#91;b &#91;c&#93;&#93; d"],
    ["glossary syntax", "[[loom]]", "&#91;&#91;loom&#93;&#93;"],
    ["glossary syntax inside text", "see [[loom|looms]] here", "see &#91;&#91;loom|looms&#93;&#93; here"],
    ["a pair that is the whole text", "[Marco de un telar kogui]", "&#91;Marco de un telar kogui&#93;"],
    ["a pair with a pipe that is the whole text", "[a|b]", "&#91;a|b&#93;"],
    ["a pair inside an unmatched bracket", "a [b [c]", "a &#91;b [c]"],
    ["a pair beside an unmatched closing bracket", "[a ] b]", "[a ] b&#93;"],
  ])("%s", (_name, text, written) => {
    expect(escapeBracketsForMarkdown(text)).toBe(written);
  });

  it("leaves entities already written as they are, so escaping twice changes nothing", () => {
    for (const text of ["Loom &#91;Telar&#93;", "&#91;&#91;loom&#93;&#93;", "a &amp; b &#124; c"]) {
      expect(escapeBracketsForMarkdown(text)).toBe(text);
    }
    for (const text of ["A [b [c]] d", "[x]", "a ] [b] [", "[[loom]]"]) {
      const once = escapeBracketsForMarkdown(text);
      expect(escapeBracketsForMarkdown(once)).toBe(once);
    }
  });

  it("never writes a backslash", () => {
    const slashes = (s: string) => s.split("\\").length - 1;
    for (const text of ["[", "]", "[[a]]", "a [b [c]] d", "\\[x"]) {
      for (const source of ["text", "markdown"] as const) {
        expect(slashes(escapeBracketsForMarkdown(text, source))).toBe(slashes(text));
      }
    }
  });

  it("counts a backslash-escaped bracket in plain text, where a backslash is only a character", () => {
    expect(escapeBracketsForMarkdown("a\\[b")).toBe("a\\&#91;b");
  });

  it("leaves a backslash-escaped bracket in the author's Markdown alone and uncounted", () => {
    expect(escapeBracketsForMarkdown("a \\[b", "markdown")).toBe("a \\[b");
    expect(escapeBracketsForMarkdown("a \\[b\\] c", "markdown")).toBe("a \\[b\\] c");
    expect(escapeBracketsForMarkdown("[a \\] b]", "markdown")).toBe("&#91;a \\] b&#93;");
    expect(escapeBracketsForMarkdown("a \\\\[b", "markdown")).toBe("a \\\\&#91;b");
  });
});

describe("escapeEveryBracket", () => {
  it("writes every bracket as an entity and nothing else", () => {
    expect(escapeEveryBracket("[1] a [b](c) [[d]] |")).toBe("&#91;1&#93; a &#91;b&#93;(c) &#91;&#91;d&#93;&#93; |");
  });
});

describe("escapeGlossaryDisplay and glossaryReference", () => {
  it("writes the characters that end a display text as entities, and leaves an opening bracket", () => {
    expect(escapeGlossaryDisplay("a ] b | c [d")).toBe("a &#93; b &#124; c [d");
    expect(escapeGlossaryDisplay("plain")).toBe("plain");
  });

  it("builds a reference with and without a display text", () => {
    expect(glossaryReference("loom")).toBe("[[loom]]");
    expect(glossaryReference("loom", "   ")).toBe("[[loom]]");
    expect(glossaryReference("loom", " the loom ")).toBe("[[loom|the loom]]");
    expect(glossaryReference("loom", "a [b] | c")).toBe("[[loom|a [b&#93; &#124; c]]");
  });
});

describe("encodeUrlForMarkdown", () => {
  it.each([
    ["an address with nothing to encode", "https://example.org/a.jpg?x=1&y=%20", "https://example.org/a.jpg?x=1&y=%20"],
    ["parentheses", "https://example.org/wiki/Loom_(weaving)", "https://example.org/wiki/Loom_%28weaving%29"],
    ["spaces and other whitespace", "maps/my map.jpg\t ", "maps/my%20map.jpg%09%C2%A0"],
    ["brackets, which do not end an address", "https://example.org/[a]", "https://example.org/[a]"],
  ])("%s", (_name, url, written) => {
    expect(encodeUrlForMarkdown(url)).toBe(written);
  });
});

describe("decodeWrittenEntities", () => {
  it("decodes the three entities the escapes write, and no other", () => {
    expect(decodeWrittenEntities("a &#91;b&#93; &#124; c")).toBe("a [b] | c");
    expect(decodeWrittenEntities("&amp; &lsqb; &#x5B; &#091; &#124")).toBe("&amp; &lsqb; &#x5B; &#091; &#124");
  });

  it("reads back what each escape wrote as the author's text", () => {
    for (const text of ["Loom [Telar", "A [b [c]] d", "[[loom]]", "[whole]"]) {
      expect(decodeWrittenEntities(escapeBracketsForMarkdown(text))).toBe(text);
    }
    expect(decodeWrittenEntities(escapeGlossaryDisplay("a ] b | c"))).toBe("a ] b | c");
  });
});

describe("the glossary previews", () => {
  const terms = new Map([["loom", "Loom"]]);

  it("do not link glossary syntax written as entities, on the Markdown string or on a definition's HTML", () => {
    const escaped = escapeBracketsForMarkdown("[[loom]]");
    expect(resolveGlossaryLinks(escaped, terms, "")).toBe(escaped);
    const definition = marked.parse(`See ${escaped}.`, { async: false, gfm: true }) as string;
    expect(resolveGlossaryLinks(definition, terms, "")).not.toContain("glossary-inline-link");
    expect(resolveGlossaryLinks("[[loom]]", terms, "")).toContain("glossary-inline-link");
  });
});

describe("the glossary preview's link text and tags, as framework 508e4c03 writes them", () => {
  const terms = new Map([["loom", "Loom &amp; weft"]]);

  it("decodes a display text, an unknown term and a title before escaping them", () => {
    expect(resolveGlossaryLinks(glossaryReference("loom", "a ] b | c"), terms, "")).toContain(">a ] b | c</a>");
    expect(resolveGlossaryLinks("[[loom]]", terms, "")).toContain(">Loom &amp; weft</a>");
    expect(resolveGlossaryLinks("[[m&#93;x]]", terms, "")).toContain("⚠️ [[m]x]]</span>");
  });

  it("leaves a reference inside a tag as written", () => {
    expect(resolveGlossaryLinks('<img alt="[[loom]]"> [[loom]]', terms, "")).toMatch(/^<img alt="\[\[loom\]\]"> <a /);
  });
});

describeWithPython("htmlUnescape against Python's html.unescape, without a document", () => {
  const inputs = [
    "&#91;&#93;&#124;&#x5B;&#X5d;&#091;", "&amp;&lt;&gt;&quot;&apos;&nbsp;", "&lsqb;&rsqb;&vert;&VerticalLine;",
    "&#0;&#13;&#128;&#150;&#159;&#1;&#11;&#127;&#xD800;&#x110000;&#xFFFE;&#x1FFFF;&#65;&#x1F600;",
    "a & b &; &#; &#x; plain",
    // Names an object inherits are not entity names.
    "&constructor; &toString; &hasOwnProperty; &__proto__;",
  ];

  it.each(inputs)("%s", (input) => {
    const python = runPython("import html\nprint(json.dumps(html.unescape(sys.stdin.read())))", input);
    expect(htmlUnescape(input)).toBe(python);
  });
});
