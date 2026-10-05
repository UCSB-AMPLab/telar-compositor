/**
 * The rule a new story ID is held to when an author changes it: the
 * characters the framework accepts in project.csv, no other story's ID, and
 * none of the sheet names the site reads as something other than a story.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { storyIdProblem } from "~/lib/story-id";

describe("storyIdProblem", () => {
  const others = ["the-river", "maps"];

  it("accepts lowercase letters, numbers, hyphens and underscores", () => {
    expect(storyIdProblem("fluidity_of-process2", "blank_template", others)).toBeNull();
    expect(storyIdProblem("-lead", "blank_template", others)).toBeNull();
  });

  it("refuses anything the framework skips the row for", () => {
    for (const bad of ["", "Upper", "with space", "dot.ted", "slash/x", "../up", "acentó", "a#b"]) {
      expect(storyIdProblem(bad, "blank_template", others)).toEqual({ code: "invalid" });
    }
  });

  it("refuses another story's ID, and treats the story's own as no change", () => {
    expect(storyIdProblem("maps", "blank_template", others)).toEqual({ code: "taken" });
    expect(storyIdProblem("blank_template", "blank_template", ["blank_template", ...others])).toEqual({ code: "unchanged" });
  });

  it("refuses the names of the sheets the site reads as its project, objects and glossary", () => {
    for (const sheet of ["project", "proyecto", "objects", "objetos", "glossary", "glosario"]) {
      expect(storyIdProblem(sheet, "blank_template", others)).toEqual({ code: "reserved" });
    }
  });
});
