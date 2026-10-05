// @vitest-environment jsdom
/**
 * Quotes, dashes and ellipses in the panel preview against Python Markdown's
 * `smarty` extension, as the framework loads it (`MARKDOWN_EXTENSIONS`,
 * scripts/telar/latex.py). Each text goes through the framework's Python
 * once, with `extra`, `nl2br` and `smarty`, and through `panelMarkdown`; the
 * two are compared as parsed DOM, so `&ldquo;` and “ read alike.
 *
 * A text that must not change, and one that must, are also asserted here
 * without the framework, so the behaviour is held when no checkout is there.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { panelMarkdown } from "~/components/ui/markdown-editor/panelPreview";
import { smartTypography } from "~/components/ui/markdown-editor/smartTypography";
import { describeWithRequiredFramework, frameworkCheckoutPresent, FRAMEWORK_SCRIPTS_DIR, FRAMEWORK_TIMEOUT_MS } from "./helpers/framework-checkout";

describe("smartTypography", () => {
  it.each([
    ['He said "hi" and \'bye\'.', "He said &ldquo;hi&rdquo; and &lsquo;bye&rsquo;."],
    ["It's the '80s -- or --- so.", "It&rsquo;s the &rsquo;80s &ndash; or &mdash; so."],
    ["Wait... what....", "Wait&hellip; what...."],
    ["\"'Quoted' words\" end", "&ldquo;&lsquo;Quoted&rsquo; words&rdquo; end"],
    ["Ça \"été\" fini", "Ça &ldquo;été&rdquo; fini"],
    ["a----b and ..... c", "a----b and ..... c"],
  ])("%j", (text, smart) => {
    expect(smartTypography(text)).toBe(smart);
  });

  it("leaves code, raw HTML and an escaped quote as typed", () => {
    const html = panelMarkdown('`"a"` <span title="x">"b"</span> \\"c\\"');
    expect(html).toContain('<code>"a"</code>');
    expect(html).toContain('<span title="x">“b”</span>');
    expect(html).toContain('"c"');
  });

  it("reaches a footnote's text", () => {
    expect(panelMarkdown('A[^1]\n\n[^1]: A "note" -- here.', "p")).toContain("A “note” – here.");
  });
});

const CORPUS = [
  '\\"esc\\" and "x"',
  'a <b>"x"</b> c',
  '*a*"b"',
  'He said, "\'Quoted\' words in a larger quote."',
  'don\\\'t "x"',
  '&quot;a&quot; and "b"',
  '<a href="u">"x"</a>',
  'He said "hello" to her.',
  "She said 'hello' to him.",
  "It's a dog's life, isn't it?",
  "The '80s and the '90s",
  'A "quote" with a \'nested\' one',
  '"\'Nested\' first" then plain',
  "'\"Nested\" first' then plain",
  '"Quoted" at the start',
  "At the end \"quoted\"",
  "(\"in parentheses\") and ('single')",
  '"...", he said',
  "'.' alone",
  'Dash -- here and --- there and ---- not',
  'Ellipsis ... here and .... not',
  '--"opening after a dash"',
  "a *\"em\"* b and **'strong'** c",
  '*"starts an em"* and then "more"',
  '[a "link"](https://example.org/x) and "after"',
  '# A "heading" -- here',
  '- a "list" item\n- it\'s another',
  '> a "quoted" block',
  'A line "one\nand" line two',
  'Text with `"code"` and "text"',
  'Entity &amp; and "quote" &copy; \'x\'',
  'He said "I\'m here" and \'we\'re\'',
  '5\'10" tall and 12" long',
  'rock \'n\' roll',
  '"Quote"-- dash',
  'x "y"... z',
  'Math $x$ and "quoted $$a<b$$" more',
  '"Ça va", dit-elle. L\'été',
  '"" empty and \'\' empty',
  'a " alone and a \' alone',
  '"one" "two" "three"',
  "'one' 'two' 'three'",
  '| a | b |\n|---|---|\n| "x" | \'y\' |',
];

describeWithRequiredFramework("smarty against the framework's Python Markdown", () => {
  const normalised = (html: string) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.normalize();
    return template.innerHTML.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  };

  const framework = (): string[] => {
    const script = [
      "import json, sys, markdown",
      "texts = json.loads(sys.stdin.read())",
      "print(json.dumps([markdown.markdown(t, extensions=['extra', 'nl2br', 'smarty']) for t in texts]))",
    ].join("\n");
    const python = join(FRAMEWORK_SCRIPTS_DIR, "..", ".venv", "bin", "python3");
    const out = execFileSync(python, ["-c", script], {
      input: JSON.stringify(CORPUS),
      encoding: "utf-8",
      timeout: FRAMEWORK_TIMEOUT_MS,
    });
    return JSON.parse(out) as string[];
  };

  const site = frameworkCheckoutPresent ? framework() : [];

  it.each(CORPUS.map((text, i) => [text, i] as const))("%j", (text, i) => {
    expect(normalised(panelMarkdown(text))).toBe(normalised(site[i]));
  });
});
