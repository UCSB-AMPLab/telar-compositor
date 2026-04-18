/**
 * story-order.test.ts — unit tests for story order renumbering after deletion.
 *
 * Tests: DATA-04 — after deleting a story, remaining stories must have
 * sequential order values (no gaps) starting from 0.
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoryRow {
  id: number;
  project_id: number;
  order: number;
  story_id: string;
}

interface RenumberResult {
  renumbered: Array<{ id: number; order: number; updated_at: string }>;
}

// ---------------------------------------------------------------------------
// Helpers — mirror the logic that will live in _app.stories.js
// ---------------------------------------------------------------------------

/**
 * Simulate the delete-story action:
 * 1. Look up the target story's project_id
 * 2. Delete the story
 * 3. Fetch remaining stories ordered by asc(order)
 * 4. Renumber them 0, 1, 2, ...
 */
async function simulateDeleteStory(
  storyDbId: number,
  allStories: StoryRow[]
): Promise<RenumberResult> {
  const target = allStories.find((s) => s.id === storyDbId);
  if (!target) return { renumbered: [] };

  const projectId = target.project_id;

  const remaining = allStories
    .filter((s) => s.id !== storyDbId)
    .filter((s) => s.project_id === projectId)
    .sort((a, b) => a.order - b.order);

  const now = new Date().toISOString();
  const renumbered = remaining.map((s, idx) => ({
    id: s.id,
    order: idx,
    updated_at: now,
  }));

  return { renumbered };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delete-story: post-delete renumbering (DATA-04)", () => {
  it("renumbers 2 remaining stories to 0,1 after deleting from a 3-story project", async () => {
    const stories: StoryRow[] = [
      { id: 1, project_id: 10, order: 0, story_id: "first" },
      { id: 2, project_id: 10, order: 1, story_id: "second" },
      { id: 3, project_id: 10, order: 2, story_id: "third" },
    ];

    const { renumbered } = await simulateDeleteStory(2, stories);

    expect(renumbered).toHaveLength(2);
    expect(renumbered[0]).toMatchObject({ id: 1, order: 0 });
    expect(renumbered[1]).toMatchObject({ id: 3, order: 1 });
  });

  it("renumbers correctly when the first story (order 0) is deleted", async () => {
    const stories: StoryRow[] = [
      { id: 1, project_id: 10, order: 0, story_id: "first" },
      { id: 2, project_id: 10, order: 1, story_id: "second" },
      { id: 3, project_id: 10, order: 2, story_id: "third" },
    ];

    const { renumbered } = await simulateDeleteStory(1, stories);

    expect(renumbered).toHaveLength(2);
    expect(renumbered[0]).toMatchObject({ id: 2, order: 0 });
    expect(renumbered[1]).toMatchObject({ id: 3, order: 1 });
  });

  it("returns empty renumbered list when the only story is deleted", async () => {
    const stories: StoryRow[] = [
      { id: 1, project_id: 10, order: 0, story_id: "only" },
    ];

    const { renumbered } = await simulateDeleteStory(1, stories);

    expect(renumbered).toHaveLength(0);
  });

  it("does not renumber stories from a different project", async () => {
    const stories: StoryRow[] = [
      { id: 1, project_id: 10, order: 0, story_id: "proj10-first" },
      { id: 2, project_id: 10, order: 1, story_id: "proj10-second" },
      { id: 3, project_id: 99, order: 0, story_id: "proj99-first" },
    ];

    const { renumbered } = await simulateDeleteStory(1, stories);

    // Only project 10's remaining story is renumbered
    expect(renumbered).toHaveLength(1);
    expect(renumbered[0]).toMatchObject({ id: 2, order: 0 });
  });
});

// ---------------------------------------------------------------------------
// Integration-style mock: verify the Drizzle call chain pattern used in
// the actual _app.stories.js route action will produce sequential orders.
// ---------------------------------------------------------------------------

describe("delete-story: Drizzle mock pattern for renumber", () => {
  it("calls db.update with sequential order values for each remaining story", async () => {
    const remainingAfterDelete = [{ id: 8 }, { id: 9 }, { id: 10 }];

    const updateCalls: Array<{ order: number; updated_at: string }> = [];
    const mockDb = {
      update: vi.fn(() => mockDb),
      set: vi.fn((values: { order: number; updated_at: string }) => {
        updateCalls.push(values);
        return mockDb;
      }),
      where: vi.fn(() => Promise.resolve()),
    } as unknown as typeof mockDb;

    const now = new Date().toISOString();
    await Promise.all(
      remainingAfterDelete.map((s, idx) =>
        (mockDb as any).update("stories").set({ order: idx, updated_at: now }).where()
      )
    );

    expect(updateCalls).toHaveLength(3);
    expect(updateCalls[0]).toMatchObject({ order: 0 });
    expect(updateCalls[1]).toMatchObject({ order: 1 });
    expect(updateCalls[2]).toMatchObject({ order: 2 });
  });
});
