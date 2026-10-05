// @vitest-environment node
/**
 * Named references without a document, as a server render meets them: decoded
 * as Python's `html.unescape` decodes them once html-unescape.server.ts has
 * installed its decoder. Expected values were read from
 * `python3 -c "import html; print(repr(html.unescape(...)))"`.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it } from "vitest";
import "~/lib/html-unescape.server";
import { htmlUnescape } from "~/lib/html-unescape";
import { measureAnswer, LINE_CHARS } from "~/lib/answer-budget";
import { renderAnswer } from "~/lib/answer-preview";
import fixture from "./fixtures/answer-preview.json";

describe("htmlUnescape without a document", () => {
  it("has no document", () => {
    expect(typeof document).toBe("undefined");
  });

  it("decodes names outside the short table", () => {
    expect(htmlUnescape("it&rsquo;s&hellip;")).toBe("it’s…");
    expect(htmlUnescape("&ldquo;a&rdquo; &mdash; b")).toBe("“a” — b");
  });

  it("leaves an unknown name as written", () => {
    expect(htmlUnescape("&zzzz;")).toBe("&zzzz;");
  });

  it("reads a legacy name by longest prefix, as Python does", () => {
    expect(htmlUnescape("&notaname;")).toBe("¬aname;");
    expect(htmlUnescape("&copy 1")).toBe("© 1");
    expect(htmlUnescape("&amp")).toBe("&");
  });
});

describe("answers measured without a document", () => {
  it("counts &rsquo; as one character", () => {
    const html = `<p>${Array(130).fill("it&rsquo;s").join(" ")}</p>`;
    expect(measureAnswer(html).lines).toBe(Math.ceil((130 * 4 + 129) / LINE_CHARS));
    expect(measureAnswer(html).lines).toBe(13);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("measure: %s", (_name, c) => {
    const glossary = { terms: new Map(Object.entries(fixture.glossary)), baseUrl: fixture.base_url };
    expect(renderAnswer(c.source, glossary).measure).toEqual(c.measure);
  });
});
