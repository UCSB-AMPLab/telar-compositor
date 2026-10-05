// @vitest-environment node
/**
 * The step card's answer renders where there is no DOM, as the editor route
 * renders it on the server and the publish check reads it on the Worker.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { answerHtml } from "~/lib/card-markdown";

const NO_GLOSSARY = { terms: new Map(), baseUrl: "" };

describe("the answer without a DOM", () => {
  it("renders an answer holding a pipe, a code span and entities", () => {
    expect(typeof document).toBe("undefined");
    expect(answerHtml("a | `b` &amp; &#124; c", NO_GLOSSARY)).toBe("<p>a | <code>b</code> &amp; | c</p>\n");
  });

  it("writes a formula back escaped once, as text", () => {
    expect(answerHtml("$$a<b$$ and $$c &lt; d$$ and $$e & f$$", NO_GLOSSARY)).toBe(
      "<p>$$a&lt;b$$ and $$c &lt; d$$ and $$e &amp; f$$</p>\n",
    );
  });
});
