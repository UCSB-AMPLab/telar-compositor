/**
 * The titles the published story intro lists under "Sections", by the
 * framework's own test (`_layouts/story.html`: `obj == "" and s.question`)
 * over the rows publish writes: every written step whose `object` cell, as
 * the build leaves it, is exactly empty, with its question, empty included.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { introSectionTitles } from "~/lib/intro-toc";
import type { StepContent } from "~/lib/story-rows";

function step(over: Partial<StepContent>): StepContent {
  return { kind: "media", object_id: null, question: null, answer: null, layers: [], ...over };
}

const OBJECTS = [{ object_id: "map" }];

describe("the intro's section list", () => {
  it("lists section cards, whatever object they store, in order", () => {
    const steps = [
      step({ kind: "section", question: "Sound and Movement" }),
      step({ object_id: "map", question: "Notice the head" }),
      step({ kind: "section", object_id: "map", question: "Back to the Engraving" }),
    ];
    expect(introSectionTitles(steps, OBJECTS)).toEqual(["Sound and Movement", "Back to the Engraving"]);
  });

  it("lists a media step with no object, as publish writes its cell empty", () => {
    const steps = [step({ object_id: null, question: "A text-only step" }), step({ object_id: "", question: "Another" })];
    expect(introSectionTitles(steps, OBJECTS)).toEqual(["A text-only step", "Another"]);
  });

  it("lists an objectless step with no question as an empty entry, since Liquid holds an empty string true", () => {
    expect(introSectionTitles([step({ kind: "section", question: "" }), step({ kind: "section", question: null })], OBJECTS)).toEqual(["", ""]);
  });

  it("does not list a cell of spaces, which the build leaves as it is", () => {
    expect(introSectionTitles([step({ object_id: "  ", question: "Spaces" })], OBJECTS)).toEqual([]);
  });

  it("does not list a step publish does not write", () => {
    expect(introSectionTitles([step({ object_id: null, question: null, answer: null })], OBJECTS)).toEqual([]);
  });

  it("does not list a step naming an object, found or not", () => {
    const steps = [step({ object_id: "MAP", question: "Case" }), step({ object_id: "missing", question: "Missing" })];
    expect(introSectionTitles(steps, OBJECTS)).toEqual([]);
  });
});
