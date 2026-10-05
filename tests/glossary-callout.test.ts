// @vitest-environment jsdom
/**
 * A glossary callout's block as `parse_glossary_widget` reads it, and what
 * the preview draws for it where the parity fixture cannot reach: the side
 * folded as the framework folds it and no further, and a callout drawn
 * before the site's kinds have arrived. The published markup itself is
 * compared with the framework's in card-markdown-parity.test.tsx.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { glossaryCalloutHtml, parseGlossaryCallout } from "~/lib/glossary-callout";
import { NO_GLOSSARY_KINDS } from "~/lib/glossary-kinds";

const element = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement;
};

describe("parseGlossaryCallout", () => {
  it.each([
    ["no side", "entry: loom", "right"],
    ["left", "entry: loom\nalign: left", "left"],
    ["izquierda, in capitals and with an accent", "entry: loom\nalign: IzquiérDA", "left"],
    ["derecha", "entry: loom\nalign: derecha", "right"],
    ["a side that is neither", "entry: loom\nalign: centre", "right"],
    ["a side with a hyphen the framework does not fold", "entry: loom\nalign: left-", "right"],
    ["a commented line", "entry: loom\n# align: left", "right"],
  ])("reads %s", (_what, body, align) => {
    expect(parseGlossaryCallout(body)).toEqual({ entry: "loom", align });
  });

  it("takes the last of a repeated key, each line and value stripped", () => {
    expect(parseGlossaryCallout("  entry:  first \n\tentry:  loom  \nalign:  left ")).toEqual({ entry: "loom", align: "left" });
  });

  it("reads a block without an entry as an empty one", () => {
    expect(parseGlossaryCallout("align: left").entry).toBe("");
  });
});

describe("glossaryCalloutHtml before the site's kinds arrive", () => {
  const glossary = { terms: new Map([["loom", "Loom"]]), baseUrl: "/telar" };

  it.each([
    ["no kinds at all", glossary],
    ["the empty list", { ...glossary, kinds: NO_GLOSSARY_KINDS, entryKinds: new Map([["loom", "source"]]) }],
  ])("draws the default kind with the exclamation mark and no label, for %s", (_what, context) => {
    const { html, linked } = glossaryCalloutHtml({ entry: "LOOM", align: "left" }, context);
    const a = element(html);
    expect(linked).toBe(true);
    expect(a.dataset.termId).toBe("loom");
    expect(a.dataset.termUrl).toBe("/telar/glossary/loom/");
    expect(a.dataset.glossaryKind).toBe("term");
    expect(a.classList.contains("glossary-callout--left")).toBe(true);
    expect(a.querySelectorAll(".glossary-callout-icon circle")).toHaveLength(2);
    expect(a.querySelector(".glossary-callout-kind")!.textContent).toBe("");
  });
});
