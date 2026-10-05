/**
 * The ID a new story takes from its title is never the name of a sheet the
 * site reads, the same rule as renaming a story's ID.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { newStoryId, storyIdRefusal } from "~/lib/story-id";

describe("newStoryId", () => {
  it.each(["project", "proyecto", "objects", "objetos", "glossary", "glosario"])(
    "does not take %s",
    (sheet) => {
      const id = newStoryId(sheet, []);
      expect(id).toBe(`${sheet}-2`);
      expect(storyIdRefusal(id)).toBeNull();
    },
  );

  it("numbers past an existing story when the sheet name is also taken", () => {
    expect(newStoryId("Objects", ["objects-2"])).toBe("objects-3");
  });

  it("keeps a clean slug for an ordinary title", () => {
    expect(newStoryId("The River", ["other"])).toBe("the-river");
    expect(newStoryId("The River", ["the-river"])).toBe("the-river-2");
  });
});
