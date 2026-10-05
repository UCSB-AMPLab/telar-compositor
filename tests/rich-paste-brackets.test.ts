/**
 * Pasted HTML written into Markdown: brackets in its text, link text and
 * image alt text as entities, never Turndown's backslashes, and link and
 * image addresses percent-encoded rather than backslash-escaped. The forms
 * are the ones authorText.ts states.
 *
 * @version v1.5.0-beta
 */
import { afterEach, describe, it, expect } from "vitest";
import { _resetTurndownForTests, getTurndown } from "~/components/ui/markdown-editor/richPaste";

afterEach(() => _resetTurndownForTests());

async function paste(html: string): Promise<string> {
  return (await getTurndown()).turndown(html);
}

describe("pasted HTML with brackets", () => {
  it("writes an image's alt text escaped, a balanced pair left as it is", async () => {
    expect(await paste('<img src="https://example.org/a.jpg" alt="Loom [Telar]">')).toBe("![Loom [Telar]](https://example.org/a.jpg)");
    expect(await paste('<img src="a.jpg" alt="[Marco de un telar kogui]">')).toBe("![&#91;Marco de un telar kogui&#93;](a.jpg)");
    expect(await paste('<img src="a.jpg" alt="A [b [c]] ]">')).toBe("![A &#91;b &#91;c&#93;&#93; &#93;](a.jpg)");
  });

  it("keeps an image's title and drops an image with no address, as Turndown does", async () => {
    expect(await paste('<img src="a.jpg" alt="A" title="T">')).toBe('![A](a.jpg "T")');
    expect(await paste('<img alt="A">')).toBe("");
  });

  it("writes brackets in text and link text as entities, not backslashes", async () => {
    const md = await paste('<p>See [1] and <a href="https://example.org/">[[loom]] ]</a>.</p>');
    expect(md).toBe("See &#91;1&#93; and [&#91;&#91;loom&#93;&#93; &#93;](https://example.org/).");
    expect(md).not.toContain("\\");
  });

  it("still escapes the rest of Markdown as Turndown does", async () => {
    expect(await paste("<p>a *b* _c_ `d` \\e</p>")).toBe("a \\*b\\* \\_c\\_ \\`d\\` \\\\e");
  });

  it("percent-encodes parentheses and whitespace in addresses", async () => {
    expect(await paste('<a href="https://example.org/wiki/Loom_(weaving)">x</a>')).toBe(
      "[x](https://example.org/wiki/Loom_%28weaving%29)",
    );
    expect(await paste('<img src="https://example.org/my map (1).jpg" alt="m">')).toBe(
      "![m](https://example.org/my%20map%20%281%29.jpg)",
    );
  });

  it("keeps a link's title, its quotes escaped as Turndown escapes them", async () => {
    expect(await paste('<a href="https://example.org/" title="a &quot;b&quot;">x</a>')).toBe(
      '[x](https://example.org/ "a \\"b\\"")',
    );
  });
});
