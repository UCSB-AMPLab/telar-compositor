// tests/html-commands.test.ts
import { describe, it, expect } from "vitest";
import { wrapHtmlTransform, htmlLinkTransform } from "~/components/ui/html-commands";

describe("wrapHtmlTransform", () => {
  it("wraps a selection in <strong> and keeps the inner text selected", () => {
    const r = wrapHtmlTransform("a bold b", 2, 6, "strong"); // selects "bold"
    expect(r.insert).toBe("<strong>bold</strong>");
    expect(r.doc(r)).toBe("a <strong>bold</strong> b");
    expect("a <strong>bold</strong> b".slice(r.selectionFrom, r.selectionTo)).toBe("bold");
  });

  it("wraps an empty selection and places the caret between the tags", () => {
    const r = wrapHtmlTransform("ab", 1, 1, "em");
    expect(r.insert).toBe("<em></em>");
    expect("a<em></em>b".slice(r.selectionFrom, r.selectionTo)).toBe("");
    expect(r.selectionFrom).toBe(1 + "<em>".length);
  });

  it("toggles OFF when the selection itself includes the tags", () => {
    const doc = "a <strong>bold</strong> b";
    const from = doc.indexOf("<strong>");
    const to = from + "<strong>bold</strong>".length;
    const r = wrapHtmlTransform(doc, from, to, "strong");
    expect(r.doc(r)).toBe("a bold b");
    expect("a bold b".slice(r.selectionFrom, r.selectionTo)).toBe("bold");
  });

  it("toggles OFF when the tags immediately surround the selection (2nd click)", () => {
    const doc = "a <strong>bold</strong> b";
    const innerFrom = doc.indexOf("bold");
    const innerTo = innerFrom + "bold".length;
    const r = wrapHtmlTransform(doc, innerFrom, innerTo, "strong");
    expect(r.doc(r)).toBe("a bold b");
    expect("a bold b".slice(r.selectionFrom, r.selectionTo)).toBe("bold");
  });

  it("does not toggle off a DIFFERENT tag (em inside strong stays wrapped)", () => {
    const doc = "a <strong>bold</strong> b";
    const innerFrom = doc.indexOf("bold");
    const innerTo = innerFrom + "bold".length;
    const r = wrapHtmlTransform(doc, innerFrom, innerTo, "em");
    expect(r.insert).toBe("<em>bold</em>");
  });
});

describe("htmlLinkTransform", () => {
  it("wraps the selected text in an anchor with the given href", () => {
    const r = htmlLinkTransform("see here now", 4, 8, "https://x.org"); // selects "here"
    expect(r.insert).toBe('<a href="https://x.org">here</a>');
  });

  it("uses the url as link text when the selection is empty", () => {
    const r = htmlLinkTransform("", 0, 0, "https://x.org");
    expect(r.insert).toBe('<a href="https://x.org">https://x.org</a>');
  });

  it("escapes double quotes in the href", () => {
    const r = htmlLinkTransform("x", 0, 1, 'https://x.org/?q="a"');
    expect(r.insert).toContain('href="https://x.org/?q=&quot;a&quot;"');
  });

  it("honours an explicit snapshot text over the (possibly stale/collapsed) doc slice", () => {
    // Simulates the popover case: the live selection has collapsed (from===to)
    // but the text captured when the popover opened is "here".
    const r = htmlLinkTransform("see here now", 1, 1, "https://x.org", "here");
    expect(r.insert).toBe('<a href="https://x.org">here</a>');
  });

  it("falls back to the url when the explicit text is empty", () => {
    const r = htmlLinkTransform("abc", 1, 1, "https://x.org", "");
    expect(r.insert).toBe('<a href="https://x.org">https://x.org</a>');
  });
});
