/**
 * A glossary term inside the text of a link, as the framework's
 * `process_glossary_links` (scripts/telar/glossary.py, the framework
 * 9ec89c8f) publishes it: a link cannot hold a link, so the term is shown
 * as its display text or title, made literal, inside the kept link; and a
 * term inside `script`, `style`, `textarea` or other text-only content is
 * left as written. Each expectation is the framework's own output: the cases
 * of `tests/unit/test_glossary_links.py` and every input whose output the
 * last change moved, input to output.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it } from "vitest";
import { linkTextRegions, resolveGlossaryLinks } from "~/lib/glossary-links";

const LINK = '<a href="#" class="glossary-inline-link" data-term-id="iiif" data-term-url="/glossary/iiif/">IIIF</a>';
const TERMS = new Map([["iiif", "IIIF"], ["encomienda", "Encomienda System"]]);
const expand = (text: string) => text.replaceAll("{LINK}", LINK);
const glossaryPassOf = (text: string, terms: ReadonlyMap<string, string> = TERMS) => resolveGlossaryLinks(text, terms, "");

const PANEL_ANCHOR = ["<p><a href=\"b\">see [[iiif]]</a> [[iiif]]</p>", "<p><a href=\"b\">see IIIF</a> {LINK}</p>"] as const;

const PANEL_LITERAL = "<p><a href=\"b\">A *B* &lt;b&gt;</a></p>";

const RAW_ANCHOR: ReadonlyArray<readonly [string, string]> = [
  ["<a href=\"b\">see [[iiif]]</a> [[iiif]]", "<a href=\"b\">see IIIF</a> {LINK}"],
  ["<a title=\"> </a>\" href=\"b\">see [[iiif]]</a>", "<a title=\"> </a>\" href=\"b\">see IIIF</a>"],
  ["<a href=\"b\">see [[iiif]] and [[iiif]]", "<a href=\"b\">see IIIF and IIIF"],
];

const PANEL_ANCHORS: ReadonlyArray<readonly [string, string[]]> = [
  ["<p>x\n<a href=\"b\">y\nz</a> w</p>", ["y\nz"]],
  ["<A HREF=b>y</A>", ["y"]],
  ["x<y <a>z</a>", []],
  ["<a title=\"</a>\">y</a>", ["y"]],
  ["<!-- <a> -->y", []],
  ["<a>x<a>y</a>", ["x", "y"]],
  ["<a>x\ny", ["x\ny"]],
  ["<a/>y", ["y"]],
  ["<code><a>x</a></code><a>y</a>", ["y"]],
  ["<a-b>x</a-b>", []],
  ["&# &# <a>x</a>;", ["x"]],
  ["&#5a<a>x</a>;", ["x"]],
  ["&#x <a>y</a>", ["y"]],
  ['a &#60 <a>z</a> &amp; <a href="?a=1&b=2">w</a>', ["z", "w"]],
];

const PANEL_UNPARSED = ["x<y <a>[[iiif]]</a>", "x<y <a>{LINK}</a>"] as const;

const TEXT_ONLY = ["<script>const s=\"<a>[[iiif]]</a>\";</script>", "<style>/* [[iiif]] */</style>", "<SCRIPT>[[iiif]]</SCRIPT >", "<textarea>[[iiif]]</textarea>", "<script>[[iiif]]", "<div><script>[[iiif]]</script></div>", "x <script>[[iiif]]</script>"];

const AFTER_TEXT_ONLY: ReadonlyArray<readonly [string, string]> = [
  ["<script>x</script>\n\n<p>[[iiif]]</p>", "<script>x</script>\n\n<p>{LINK}</p>"],
];

const R7: ReadonlyArray<readonly [string, string]> = [
  ['<div><script><a>[[iiif]]</script> [[iiif]]</div>\n\n', '<div><script><a>[[iiif]]</script> {LINK}</div>\n\n'],
  ['<div><style><a>[[iiif]]</STYLE > [[iiif]]</div>', '<div><style><a>[[iiif]]</STYLE > {LINK}</div>'],
  ['<div><textarea><a>[[iiif]]</textarea> [[iiif]]</div>', '<div><textarea><a>[[iiif]]</textarea> {LINK}</div>'],
  ['<div><script><a>[[iiif]] [[iiif]]</div>\n\n[[iiif]]', '<div><script><a>[[iiif]] [[iiif]]</div>\n\n[[iiif]]'],
  ['<script><a>[[iiif]]</script> [[iiif]]\n\n[[iiif]]', '<script><a>[[iiif]]</script> {LINK}\n\n{LINK}'],
  ['[[iiif]]\n\n<script><![CDATA[<span title="<a>">[[iiif]]\n\n<div>`<u>\n\n<script></style>\n<A HREF=b>--><a-b><a href="b">', '{LINK}\n\n<script><![CDATA[<span title="<a>">[[iiif]]\n\n<div>`<u>\n\n<script></style>\n<A HREF=b>--><a-b><a href="b">'],
  ['[[iiif]] \n\n<script><u>\n\n<div>[[iiif]]<!--<code><A HREF=b><?p ](u)\\<<A HREF=b>\n<div>', '{LINK} \n\n<script><u>\n\n<div>[[iiif]]<!--<code><A HREF=b><?p ](u)\\<<A HREF=b>\n<div>'],
  ['[[iiif]]\\<[\n\n<div><style><a[[iiif]]`[[iiif]]x<y <span>', '{LINK}\\<[\n\n<div><style><a[[iiif]]`[[iiif]]x<y <span>'],
  ['[[iiif]]\n\n<div>\n\n<script>>\n<div></style><!D <a><?p </A></a></u>[[iiif]]<!D ', '{LINK}\n\n<div>\n\n<script>>\n<div></style><!D <a><?p </A></a></u>[[iiif]]<!D '],
  ['[[iiif]]<code>[[iiif]]]]><?p [[iiif]]\n</div>\n\n<div><style>[[iiif]]', '{LINK}<code>{LINK}]]><?p {LINK}\n</div>\n\n<div><style>[[iiif]]'],
  ['[[iiif]]\n<div>\n\n<script>[[iiif]][<A HREF=b></script></code><![CDATA[<?p </u>>', '{LINK}\n<div>\n\n<script>[[iiif]][<A HREF=b></script></code><![CDATA[<?p </u>>'],
  ['[[iiif]]\n\n<div><style>\n</span></code>?>](u)[[iiif]]<![CDATA[', '{LINK}\n\n<div><style>\n</span></code>?>](u)[[iiif]]<![CDATA['],
  ['[[iiif]]<a>[[[iiif]]</code><a href="b"></u>-->\n\n<div><style><a>[[iiif]]', '{LINK}<a>[IIIF</code><a href="b"></u>-->\n\n<div><style><a>[[iiif]]'],
  ['[[iiif]]\n\n<script><a><!D <A HREF=b>[[iiif]]</a \n\n\n<a-b>`\n</div><code>', '{LINK}\n\n<script><a><!D <A HREF=b>[[iiif]]</a \n\n\n<a-b>`\n</div><code>'],
  ['[[iiif]][\n\n<script>\n</div>x<y ]]>[[iiif]]-->', '{LINK}[\n\n<script>\n</div>x<y ]]>[[iiif]]-->'],
  ['[[iiif]]\n\n<div><a</code>\n\n<script>?>x<y </a-b></a-b></style>[[iiif]]', '{LINK}\n\n<div><a</code>\n\n<script>?>x<y </a-b></a-b></style>[[iiif]]'],
  ['[[iiif]]<span><a-b>[[iiif]]<a-b>\n<div><a href="b"><span title="<a>">\n<div>\n\n\n<div><style>[[iiif]]<a/><a/>', '{LINK}<span><a-b>{LINK}<a-b>\n<div><a href="b"><span title="<a>">\n<div>\n\n\n<div><style>[[iiif]]<a/><a/>'],
  ['[[iiif]]<a/>\n\n<div><style><span><u>\\<[[iiif]]<code><![CDATA[<a/>--></script>]]>\n</div></script>', '{LINK}<a/>\n\n<div><style><span><u>\\<[[iiif]]<code><![CDATA[<a/>--></script>]]>\n</div></script>'],
  ['[[iiif]]\n</u><span><u>\n\n<script>><a/>\\< <span>\n</div></a -->[[iiif]]', '{LINK}\n</u><span><u>\n\n<script>><a/>\\< <span>\n</div></a -->[[iiif]]'],
  ['[[iiif]]\n\n<script>[[iiif]]<span title="<a>">](u)', '{LINK}\n\n<script>[[iiif]]<span title="<a>">](u)'],
  ['[[iiif]][[iiif]]<a-b>\n\n<script></span>[[[iiif]]</code><![CDATA[<?p <?p </a></code><u>', '{LINK}{LINK}<a-b>\n\n<script></span>[[[iiif]]</code><![CDATA[<?p <?p </a></code><u>'],
  ['[[iiif]]\n\n<div><style><a/><a/>[[iiif]]</u><u><![CDATA[\n\n<div>x<y \n\n<script><a[[iiif]]', '{LINK}\n\n<div><style><a/><a/>[[iiif]]</u><u><![CDATA[\n\n<div>x<y \n\n<script><a[[iiif]]'],
  ['[[iiif]]<a href="b"><span>\n\n<script></span>><u><a<code><span title="<a>"></code>[[iiif]][<a/>', '{LINK}<a href="b"><span>\n\n<script></span>><u><a<code><span title="<a>"></code>[[iiif]][<a/>'],
  ['[[iiif]]</a><code>\n\n<script></u>\n\n[[iiif]]\n</div><span title="<a>"><A HREF=b>', '{LINK}</a><code>\n\n<script></u>\n\n[[iiif]]\n</div><span title="<a>"><A HREF=b>'],
  ['[[iiif]]<?p [<a</a>x<y \n\n<div><style>\n[[iiif]][[iiif]]<a><a<a href="b">', '{LINK}<?p [<a</a>x<y \n\n<div><style>\n[[iiif]][[iiif]]<a><a<a href="b">'],
  ['[[iiif]]>\n\n<script>[[iiif]][[iiif]]', '{LINK}>\n\n<script>[[iiif]][[iiif]]'],
  ['[[iiif]]<a href="b"><a href="b">\n\n<div><style>\n</div><!--\n\n<div>[[iiif]]<a href="b"><a/>', '{LINK}<a href="b"><a href="b">\n\n<div><style>\n</div><!--\n\n<div>[[iiif]]<a href="b"><a/>'],
  ['[[iiif]]<!D \n\n<div><style><a-b></style></a-b></script>\n\n<script></u>\n\n<div>[[iiif]][[iiif]]]]>[', '{LINK}<!D \n\n<div><style><a-b></style></a-b></script>\n\n<script></u>\n\n<div>[[iiif]][[iiif]]]]>['],
  ['[[iiif]]</script>\n\n<div><style><a-b>x<y \n</div>]]>--><!--]]>[[iiif]]', '{LINK}</script>\n\n<div><style><a-b>x<y \n</div>]]>--><!--]]>[[iiif]]'],
  ['[[iiif]]\n<div></u>\n<div></A>`><u>\n\n<div><style></a>\n\n<div>[[iiif]]', '{LINK}\n<div></u>\n<div></A>`><u>\n\n<div><style></a>\n\n<div>[[iiif]]'],
  ['[[iiif]]\n\n<script>\\<<code>><span><span></a><u><u>\n<div>[[iiif]]', '{LINK}\n\n<script>\\<<code>><span><span></a><u><u>\n<div>[[iiif]]'],
  ['[[iiif]][[iiif]]</span>\n\n<script>\n<div><a>[[iiif]]?>\\<><![CDATA[\n<div></u>>\n\n<script>', '{LINK}{LINK}</span>\n\n<script>\n<div><a>[[iiif]]?>\\<><![CDATA[\n<div></u>>\n\n<script>'],
  ['[[iiif]]</A>[[iiif]]\n\n<script></a>\n</div>[[iiif]]', '{LINK}</A>{LINK}\n\n<script></a>\n</div>[[iiif]]'],
  ['[[iiif]] -->?>\\<></A>\n\n<div><style><span>[[iiif]][[iiif]]</a-b>', '{LINK} -->?>\\<></A>\n\n<div><style><span>[[iiif]][[iiif]]</a-b>'],
  ['[[iiif]]<u> [[iiif]]\n\n<script>\\<</span>\n\n<script><a href="b"></a-b>[[iiif]]?><!--<a', '{LINK}<u> {LINK}\n\n<script>\\<</span>\n\n<script><a href="b"></a-b>[[iiif]]?><!--<a'],
  ['[[iiif]]</script>[[iiif]]<a/><!D \n\n<div>\n\n<div><style>x<y <a></a>[[iiif]]](u)<a/>x<y \n\n<div>', '{LINK}</script>{LINK}<a/><!D \n\n<div>\n\n<div><style>x<y <a></a>[[iiif]]](u)<a/>x<y \n\n<div>'],
  ['[[iiif]]<a-b></A>\n<div>\n\n<script>\n</div>\n\n<div><style><span><!D [[iiif]]', '{LINK}<a-b></A>\n<div>\n\n<script>\n</div>\n\n<div><style><span><!D [[iiif]]'],
  ['[[iiif]]</a-b>\n\n<script><a/>[[iiif]]\n</div>--><![CDATA[](u)\n\n<div><style><!--\n\n<script>', '{LINK}</a-b>\n\n<script><a/>[[iiif]]\n</div>--><![CDATA[](u)\n\n<div><style><!--\n\n<script>'],
  ['[[iiif]]\n\n<div>[[iiif]]<?p [[iiif]]\n\n<div><style>](u)>[[iiif]]\n\n<div><style><a/><span title="<a>">]]></a <span title="<a>">', '{LINK}\n\n<div>{LINK}<?p {LINK}\n\n<div><style>](u)>[[iiif]]\n\n<div><style><a/><span title="<a>">]]></a <span title="<a>">'],
  ['<div><script>[[iiif]]</script></div>', '<div><script>[[iiif]]</script></div>'],
  ['<script>const s="<a>[[iiif]]</a>";</script>', '<script>const s="<a>[[iiif]]</a>";</script>'],
  ['<style>/* [[iiif]] */</style>', '<style>/* [[iiif]] */</style>'],
  ['<SCRIPT>[[iiif]]</SCRIPT >', '<SCRIPT>[[iiif]]</SCRIPT >'],
  ['<textarea>[[iiif]]</textarea>', '<textarea>[[iiif]]</textarea>'],
  ['<script>[[iiif]]', '<script>[[iiif]]'],
];

describe("a term in the text of a link", () => {
  it("in a panel's anchor", () => {
    expect(glossaryPassOf(PANEL_ANCHOR[0])).toBe(expand(PANEL_ANCHOR[1]));
  });

  it("in a panel, the title is escaped for HTML only", () => {
    expect(glossaryPassOf('<p><a href="b">[[iiif]]</a></p>', new Map([["iiif", "A *B* <b>"]]))).toBe(PANEL_LITERAL);
  });
});

describe("a term in a raw anchor", () => {
  it.each(RAW_ANCHOR)("%j -> %j", (text, expected) => {
    expect(glossaryPassOf(text)).toBe(expand(expected));
  });

  it.each(PANEL_ANCHORS)("a panel's anchors in %j, as the framework reads them, each & a space", (text, anchors) => {
    expect(linkTextRegions(text).map(([start, end]) => text.slice(start, end))).toEqual(anchors);
  });

  it("in a panel, a term after a tag the tokenizer reads otherwise is linked", () => {
    expect(glossaryPassOf(PANEL_UNPARSED[0])).toBe(expand(PANEL_UNPARSED[1]));
  });
});

// Not from the framework's tests: each is `process_glossary_links` at
// the framework 9ec89c8f, on a reading rule the cases above leave open.
const TOKENIZER_RULES: ReadonlyArray<readonly [string, string, string]> = [
  ["a malformed character reference hides no anchor after it", "&#5a<a>[[iiif]]</a> [[iiif]]", "&#5a<a>IIIF</a> {LINK}"],
  ["a closed reference does not", "&#5<a>[[iiif]]</a>", "&#5<a>IIIF</a>"],
  ["an entity name does not", "&ab<a>[[iiif]]</a>", "&ab<a>IIIF</a>"],
  ["nothing after plaintext is a tag", "<plaintext><a>[[iiif]]</a>", "<plaintext><a>{LINK}</a>"],
  ["</> is nothing", "</><a>[[iiif]]</a> [[iiif]]", "</><a>IIIF</a> {LINK}"],
  ["a start tag never closed swallows the rest", '<b title="x <a>[[iiif]]</a>', '<b title="x <a>{LINK}</a>'],
];

describe("the tokenizer's reading rules", () => {
  it.each(TOKENIZER_RULES)("%s", (_, text, expected) => {
    expect(glossaryPassOf(text)).toBe(expand(expected));
  });
});

describe("a term in text-only content", () => {
  it.each(TEXT_ONLY)("%j is left as written", (text) => {
    expect(glossaryPassOf(text)).toBe(text);
  });

  it.each(AFTER_TEXT_ONLY)("a term after the element is linked: %j", (text, expected) => {
    expect(glossaryPassOf(text)).toBe(expand(expected));
  });
});

describe("every input whose output the last change moved", () => {
  it.each(R7)("%j -> %j", (text, expected) => {
    expect(glossaryPassOf(text)).toBe(expand(expected));
  });
});

describe("many terms in anchors and unclosed tags are read in linear time", () => {
  const bounded = (text: string) => {
    const started = performance.now();
    glossaryPassOf(text);
    return performance.now() - started;
  };

  it.each(['<a href="b">x [[iiif]]</a> ', '<a href="b">x </a>[[iiif]] ', '<a href="b">x [[iiif]] ', "<!-- <a> --> [[iiif]] "])(
    "%j, many times over",
    (unit) => {
      expect(bounded(unit.repeat(20000))).toBeLessThan(2000);
    },
  );

  it.each(['<a "', '<a title="x ', '<b "', "<a '", '<a href="b', "x<y ", "<script>x [[iiif]] ", "<style>x</style>[[iiif]] "])(
    "%j, many times over and never closed",
    (unit) => {
      expect(bounded(unit.repeat(20000) + " [[iiif]]")).toBeLessThan(2000);
    },
  );
});
