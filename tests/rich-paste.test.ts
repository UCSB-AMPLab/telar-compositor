/**
 * rich-paste.test.ts — Unit tests for Word and Google Docs paste sanitisation rules.
 *
 * Tests the Turndown rules in richPaste.ts by calling getTurndown() directly.
 * Turndown uses its bundled @mixmark-io/domino DOM parser so no browser environment needed.
 */

import { describe, it, expect } from "vitest";
import { getTurndown } from "~/components/ui/markdown-editor/richPaste";

describe("richPaste Turndown rules", () => {
  describe("Word artefacts", () => {
    it("strips <o:p></o:p> inside a paragraph — produces empty string", async () => {
      const td = await getTurndown();
      const result = td.turndown("<p><o:p></o:p></p>");
      expect(result.trim()).toBe("");
    });

    it("strips MsoNormal paragraph containing only <o:p></o:p>", async () => {
      const td = await getTurndown();
      const result = td.turndown('<p class="MsoNormal"><o:p></o:p></p>');
      expect(result.trim()).toBe("");
    });

    it("strips mso-* styled span wrapper, preserving text content", async () => {
      const td = await getTurndown();
      const result = td.turndown('<span style="mso-bidi-font-family:Calibri">text</span>');
      expect(result.trim()).toBe("text");
    });

    it("strips empty MsoNormal paragraph with no text content", async () => {
      const td = await getTurndown();
      const result = td.turndown('<p class="MsoNormal">   </p>');
      expect(result.trim()).toBe("");
    });
  });

  describe("Google Docs artefacts", () => {
    it("strips Google Docs outer bold wrapper (font-weight:normal) without bold markers", async () => {
      const td = await getTurndown();
      const result = td.turndown(
        '<b id="docs-internal-guid-abc" style="font-weight:normal;">content</b>'
      );
      expect(result.trim()).toBe("content");
      expect(result).not.toContain("**");
    });

    it("converts font-weight:700 span to bold markdown", async () => {
      const td = await getTurndown();
      const result = td.turndown('<span style="font-weight:700">bold text</span>');
      expect(result.trim()).toBe("**bold text**");
    });

    it("converts font-style:italic span to italic markdown", async () => {
      const td = await getTurndown();
      const result = td.turndown('<span style="font-style:italic">italic text</span>');
      expect(result.trim()).toBe("*italic text*");
    });

    it("strips empty span — produces empty string", async () => {
      const td = await getTurndown();
      const result = td.turndown("<span></span>");
      expect(result.trim()).toBe("");
    });

    it("strips whitespace-only span — produces empty string", async () => {
      const td = await getTurndown();
      const result = td.turndown("<span>   </span>");
      expect(result.trim()).toBe("");
    });
  });

  describe("Smart quote and dash normalisation", () => {
    it("normalises left/right double curly quotes to straight quotes", () => {
      // Smart quote post-processing is applied in the paste handler, not via Turndown rules.
      // We test the regex logic directly here.
      const input = "\u201Chello\u201D";
      const result = input
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013/g, " \u2013 ")
        .replace(/\u2014/g, " \u2014 ")
        .replace(/ {2,}/g, " ");
      expect(result).toBe('"hello"');
    });

    it("normalises left/right single curly quotes to straight apostrophes", () => {
      const input = "\u2018it\u2019s\u2019";
      const result = input
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013/g, " \u2013 ")
        .replace(/\u2014/g, " \u2014 ")
        .replace(/ {2,}/g, " ");
      expect(result).toBe("'it's'");
    });

    it("normalises em-dash to spaced em-dash", () => {
      const input = "text\u2014text";
      const result = input
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013/g, " \u2013 ")
        .replace(/\u2014/g, " \u2014 ")
        .replace(/ {2,}/g, " ");
      expect(result).toBe("text \u2014 text");
    });

    it("normalises en-dash to spaced en-dash", () => {
      const input = "text\u2013text";
      const result = input
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013/g, " \u2013 ")
        .replace(/\u2014/g, " \u2014 ")
        .replace(/ {2,}/g, " ");
      expect(result).toBe("text \u2013 text");
    });

    it("collapses double spaces created by already-spaced em-dashes", () => {
      const input = "text \u2014 text";
      const result = input
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013/g, " \u2013 ")
        .replace(/\u2014/g, " \u2014 ")
        .replace(/ {2,}/g, " ");
      expect(result).toBe("text \u2014 text");
    });
  });

  describe("Video iframe preservation", () => {
    it("preserves YouTube iframe as raw HTML", async () => {
      const td = await getTurndown();
      const result = td.turndown(
        '<iframe src="https://www.youtube.com/embed/abc"></iframe>'
      );
      expect(result).toContain('<iframe src="https://www.youtube.com/embed/abc">');
    });

    it("preserves Vimeo iframe as raw HTML", async () => {
      const td = await getTurndown();
      const result = td.turndown(
        '<iframe src="https://player.vimeo.com/video/123456"></iframe>'
      );
      expect(result).toContain('<iframe src="https://player.vimeo.com/video/123456">');
    });
  });

  describe("Word script and conditional comment stripping", () => {
    it("strips <!--[if gte mso]> conditional comment blocks from HTML", async () => {
      const td = await getTurndown();
      const html = `<p>Hello</p><!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]--><p>World</p>`;
      // stripWordArtefacts is applied before Turndown in the paste handler;
      // simulate it here by applying the same regex
      const cleaned = html
        .replace(/<!--\[if[^]*?<!\[endif\]-->/gi, "")
        .replace(/<\?xml[^?]*\?>/gi, "")
        .replace(/<\/?\w+:[^>]*>/gi, "");
      const result = td.turndown(cleaned);
      expect(result).toContain("Hello");
      expect(result).toContain("World");
      expect(result).not.toContain("OfficeDocumentSettings");
    });

    it("strips Word msoCommentShow script blocks", async () => {
      const td = await getTurndown();
      const html = `<p>Content</p><script>function msoCommentShow(anchor_id, com_id) { /* Word VBA */ }</script><p>More</p>`;
      // script tags are handled by td.remove(["script",...])
      const result = td.turndown(html);
      expect(result).toContain("Content");
      expect(result).toContain("More");
      expect(result).not.toContain("msoCommentShow");
      expect(result).not.toContain("function");
    });

    it("strips <style> blocks from Word paste", async () => {
      const td = await getTurndown();
      const html = `<style>p.MsoNormal { font-family: Calibri; }</style><p>Text</p>`;
      const result = td.turndown(html);
      expect(result.trim()).toBe("Text");
      expect(result).not.toContain("MsoNormal");
      expect(result).not.toContain("Calibri");
    });

    it("strips <?xml?> processing instructions", async () => {
      const html = `<?xml version="1.0" encoding="UTF-8"?><p>Text</p>`;
      const cleaned = html
        .replace(/<!--\[if[^]*?<!\[endif\]-->/gi, "")
        .replace(/<\?xml[^?]*\?>/gi, "")
        .replace(/<\/?\w+:[^>]*>/gi, "");
      expect(cleaned).not.toContain("<?xml");
      expect(cleaned).toContain("<p>Text</p>");
    });
  });

  describe("Mixed content", () => {
    it("converts Word HTML with smart quotes, bold spans, and <o:p> to clean markdown", async () => {
      const td = await getTurndown();
      const html = `
        <p class="MsoNormal">
          <span style="mso-bidi-font-family:Calibri">Regular text</span>
          <o:p></o:p>
        </p>
        <p>
          <span style="font-weight:700">\u201CBold quote\u201D</span>
        </p>
      `;
      let result = td.turndown(html);
      // Apply smart quote normalisation
      result = result
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013/g, " \u2013 ")
        .replace(/\u2014/g, " \u2014 ")
        .replace(/ {2,}/g, " ");
      expect(result).toContain("Regular text");
      expect(result).toContain("**");
      expect(result).toContain('"Bold quote"');
      expect(result).not.toContain("mso-");
      expect(result).not.toContain("<o:p>");
      expect(result).not.toContain("\u201C");
      expect(result).not.toContain("\u201D");
    });
  });
});
