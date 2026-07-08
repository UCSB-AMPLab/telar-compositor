/**
 * story-slug-scheme.test.ts — pins the pretty-slug scheme the Stories list uses
 * when creating a story.
 *
 * `handleCreateStory` in `app/routes/_app.stories.tsx` derives a story_id by
 * composing `slugify(title) || "story"` with `makeUniqueSlug(base, existingIds)`.
 * The route module itself can't be imported under vitest (server-only deps in
 * its import graph), so these tests pin the exact composition against the two
 * pure helpers the route calls. They guard the accepted product decision that a
 * story keeps a clean, suffix-free URL until a real collision forces a numeric
 * suffix — replacing the old scheme that stamped a permanent 4-char suffix on
 * every story_id.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect } from "vitest";
import { slugify } from "~/lib/slugify";
import { makeUniqueSlug } from "~/lib/slug";

/** Mirror of the story_id derivation inside handleCreateStory. */
function storyIdFor(title: string, existing: string[]): string {
  const existingIds = new Set(existing.filter(Boolean));
  const baseSlug = slugify(title) || "story";
  return makeUniqueSlug(baseSlug, existingIds).slug;
}

describe("story creation slug scheme", () => {
  it("uses the clean slug when it does not collide", () => {
    expect(storyIdFor("The River", [])).toBe("the-river");
    // Unrelated existing ids don't force a suffix.
    expect(storyIdFor("The River", ["another-story", "notes"])).toBe("the-river");
    // No permanent timestamp/4-char suffix like the old `-a1b2` scheme.
    expect(storyIdFor("The River", [])).not.toMatch(/-[a-z0-9]{4}$/);
  });

  it("appends a numeric suffix only on an actual collision", () => {
    expect(storyIdFor("The River", ["the-river"])).toBe("the-river-2");
    expect(storyIdFor("The River", ["the-river", "the-river-2"])).toBe(
      "the-river-3",
    );
    // The probe walks past gaps to the first free numbered slot.
    expect(storyIdFor("The River", ["the-river", "the-river-3"])).toBe(
      "the-river-2",
    );
  });

  it("falls back to a 'story' base for an empty or whitespace title", () => {
    expect(storyIdFor("", [])).toBe("story");
    expect(storyIdFor("   ", [])).toBe("story");
    // The fallback base still dedupes against the live set.
    expect(storyIdFor("", ["story"])).toBe("story-2");
  });
});
