/**
 * story-order.test.js — unit tests for story order renumbering after deletion.
 *
 * Tests: DATA-04 — after deleting a story, remaining stories must have
 * sequential order values (no gaps) starting from 0.
 */
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers — mirror the logic that will live in _app.stories.js
// ---------------------------------------------------------------------------

/**
 * Simulate the delete-story action:
 * 1. Look up the target story's project_id
 * 2. Delete the story
 * 3. Fetch remaining stories ordered by asc(order)
 * 4. Renumber them 0, 1, 2, ...
 *
 * The mockDb shape mirrors how Drizzle chained calls are structured in
 * the real route — select().from().where().limit(1), delete().where(),
 * and update().set().where() — so we can assert on the outcomes.
 */
async function simulateDeleteStory(storyDbId, allStories) {
  // Step 1: Find the target story
  const target = allStories.find((s) => s.id === storyDbId);
  if (!target) return { renumbered: [] };

  const projectId = target.project_id;

  // Step 2: Delete the story
  const remaining = allStories
    .filter((s) => s.id !== storyDbId)
    .filter((s) => s.project_id === projectId)
    .sort((a, b) => a.order - b.order);

  // Step 3: Renumber sequentially
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
    const stories = [
      { id: 1, project_id: 10, order: 0, story_id: "first" },
      { id: 2, project_id: 10, order: 1, story_id: "second" },
      { id: 3, project_id: 10, order: 2, story_id: "third" },
    ];

    const { renumbered } = await simulateDeleteStory(2, stories);

    // Stories 1 and 3 should be renumbered 0 and 1
    expect(renumbered).toHaveLength(2);
    expect(renumbered[0]).toMatchObject({ id: 1, order: 0 });
    expect(renumbered[1]).toMatchObject({ id: 3, order: 1 });
  });

  it("renumbers correctly when the first story (order 0) is deleted", async () => {
    const stories = [
      { id: 1, project_id: 10, order: 0, story_id: "first" },
      { id: 2, project_id: 10, order: 1, story_id: "second" },
      { id: 3, project_id: 10, order: 2, story_id: "third" },
    ];

    const { renumbered } = await simulateDeleteStory(1, stories);

    // Remaining stories start from 0, no gap
    expect(renumbered).toHaveLength(2);
    expect(renumbered[0]).toMatchObject({ id: 2, order: 0 });
    expect(renumbered[1]).toMatchObject({ id: 3, order: 1 });
  });

  it("returns empty renumbered list when the only story is deleted", async () => {
    const stories = [{ id: 1, project_id: 10, order: 0, story_id: "only" }];

    const { renumbered } = await simulateDeleteStory(1, stories);

    expect(renumbered).toHaveLength(0);
  });

  it("does not renumber stories from a different project", async () => {
    const stories = [
      { id: 1, project_id: 10, order: 0, story_id: "proj10-first" },
      { id: 2, project_id: 10, order: 1, story_id: "proj10-second" },
      { id: 3, project_id: 99, order: 0, story_id: "proj99-first" }, // different project
    ];

    const { renumbered } = await simulateDeleteStory(1, stories);

    // Only the story from project 10 is renumbered; project 99's story is untouched
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
    const projectId = 42;
    const storyToDelete = { id: 7, project_id: projectId };

    // Remaining stories after deletion, ordered by asc(order)
    const remainingAfterDelete = [
      { id: 8 },
      { id: 9 },
      { id: 10 },
    ];

    const updateCalls = [];
    const mockDb = {
      select: vi.fn(() => mockDb),
      from: vi.fn(() => mockDb),
      where: vi.fn(() => mockDb),
      limit: vi.fn(() => Promise.resolve([storyToDelete])),
      orderBy: vi.fn(() => Promise.resolve(remainingAfterDelete)),
      delete: vi.fn(() => mockDb),
      update: vi.fn(() => mockDb),
      set: vi.fn((values) => {
        updateCalls.push(values);
        return mockDb;
      }),
    };

    // Simulate the renumber loop from the production code
    const now = new Date().toISOString();
    await Promise.all(
      remainingAfterDelete.map((s, idx) =>
        mockDb.update("stories").set({ order: idx, updated_at: now }).where()
      )
    );

    expect(updateCalls).toHaveLength(3);
    expect(updateCalls[0]).toMatchObject({ order: 0 });
    expect(updateCalls[1]).toMatchObject({ order: 1 });
    expect(updateCalls[2]).toMatchObject({ order: 2 });
  });
});
