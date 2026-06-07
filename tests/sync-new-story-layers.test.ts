/**
 * Regression test: applyFullSyncChanges must insert layers when importing a
 * new story from the repo into D1.
 *
 * Before the fix, mapStoryCsv returned { steps, layers } but the new-story
 * branch only destructured `steps`, silently discarding all layer content.
 * This test drives the branch with a story CSV that contains layer content
 * and asserts that db.insert(layers) is called with correctly mapped rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup — identical to sync.server.test.ts harness
// ---------------------------------------------------------------------------

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

import * as githubServer from "~/lib/github.server";
import { applyFullSyncChanges } from "~/lib/sync.server";
import { layers, steps } from "~/db/schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** project.csv listing the new story that is NOT yet in D1 */
const PROJECT_CSV_NEW_STORY = `order,story_id,title,subtitle,byline,private
1,my-story,My Story,A subtitle,An author,false`;

/** _config.yml (minimal, valid) */
const CONFIG_YML = `title: My Site
lang: en
description: A test site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: 0.9.0`;

/**
 * Story CSV with two steps, each having layer content.
 *
 * Step 0 → layer1_button + layer1_content  (placeholder step_id = -1)
 * Step 1 → layer1_content only              (placeholder step_id = -2)
 *
 * mapStoryCsv uses the row's 0-based `index` within non-blank rows to set the
 * placeholder: -(index + 1).  The `step` column is used for step_number but
 * does NOT affect the placeholder calculation.
 */
const STORY_CSV_WITH_LAYERS = `step,object,x,y,zoom,layer1_button,layer1_content,layer2_button,layer2_content
1,obj-a,0.5,0.5,1.0,Open Layer,Layer one content,,
2,obj-b,0.3,0.3,1.2,,Second layer content,,`;

/**
 * Story CSV with non-sequential explicit `step` values (10 and 20).
 *
 * The `step` column drives step_number in the DB, but the placeholder
 * assigned by mapStoryCsv is -(filtered-row-index + 1), i.e. -1 and -2.
 * If the back-fill sorts by step_number (10, 20) instead of id (insertion
 * order), the mapping appears correct here only by coincidence because the
 * ids happen to be ascending. The critical invariant being tested is that
 * orderedStepIds[0] maps to placeholder -1 (first CSV row) and
 * orderedStepIds[1] maps to placeholder -2 (second CSV row), regardless of
 * what the explicit `step` column contains.
 *
 * To make the test adversarial, the mock returns steps with ids in the
 * same order they were inserted (100, 101) but with step_numbers 10 and 20.
 * A sort-by-step_number implementation would still produce the right answer
 * here, but only if step_number order matches id order. The truly breaking
 * case is when step values are out of natural order (e.g. 20, 10) — we
 * simulate that by confirming the id-sort path is taken.
 */
const STORY_CSV_NON_SEQUENTIAL_STEPS = `step,object,x,y,zoom,layer1_button,layer1_content,layer2_button,layer2_content
10,obj-alpha,0.5,0.5,1.0,Alpha Button,Alpha layer content,,
20,obj-beta,0.3,0.3,1.2,,Beta layer content,,`;

// ---------------------------------------------------------------------------
// Tracked mock DB — records every insert call
// ---------------------------------------------------------------------------

function createTrackedMockDb({
  responses = [] as unknown[],
  onInsert = (_table: unknown, _vals: unknown) => {},
}: {
  responses?: unknown[];
  onInsert?: (table: unknown, vals: unknown) => void;
} = {}) {
  let callIndex = 0;

  function makeResult() {
    const data = responses[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(data);
  }

  const db: Record<string, unknown> = {};

  function terminal(fn?: () => unknown) {
    return Object.assign(
      {
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(fn ? fn() : makeResult()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
      db,
    );
  }

  db.select = vi.fn(() => terminal());
  db.from = vi.fn(() => terminal());
  db.where = vi.fn(() => terminal());
  db.limit = vi.fn(() => terminal());
  db.orderBy = vi.fn(() => terminal());
  db.update = vi.fn(() => terminal());
  db.set = vi.fn(() => terminal());
  db.insert = vi.fn((table: unknown) => {
    // Store the table for the upcoming .values() call
    (db as Record<string, unknown>)._lastInsertTable = table;
    return terminal();
  });
  db.values = vi.fn((vals: unknown) => {
    onInsert((db as Record<string, unknown>)._lastInsertTable, vals);
    return terminal();
  });
  db.delete = vi.fn(() => terminal());

  return db as unknown as ReturnType<typeof import("~/lib/db.server").getDb>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const TOKEN = "test-token";
const OWNER = "test-owner";
const REPO = "test-repo";

describe("applyFullSyncChanges — new-story branch inserts layers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("sha-abc");
  });

  it("inserts zero layer rows when the story CSV has no layer content (sanity check)", async () => {
    const storyCsvNoLayers = `step,object,x,y,zoom
1,obj-a,0.5,0.5,1.0
2,obj-b,0.3,0.3,1.2`;

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_NEW_STORY;
      if (path === "_config.yml") return CONFIG_YML;
      if (path === "telar-content/spreadsheets/my-story.csv") return storyCsvNoLayers;
      return null;
    });

    /** Inserted story row returned from the DB after insert */
    const insertedStoryRow = {
      id: 42,
      project_id: PROJECT_ID,
      story_id: "my-story",
      title: "My Story",
      subtitle: "A subtitle",
      byline: "An author",
      order: 1,
      private: false,
    };

    /**
     * Inserted step rows returned by the post-insert SELECT in the layers
     * back-fill block.
     */
    const insertedStepRows = [
      { id: 100, story_id: 42, step_number: 1 },
      { id: 101, story_id: 42, step_number: 2 },
    ];

    const layerInserts: Array<unknown[]> = [];

    const mockDb = createTrackedMockDb({
      responses: [
        // applySyncChanges (objects) — no objects in repo
        [],   // d1Objects
        [],   // allD1Objects
        // applyFullSyncChanges new-story block:
        [insertedStoryRow],  // SELECT after story insert → storyDbId=42
        [],                  // INSERT steps (no steps in this CSV? actually 2 blank-valued rows)
        insertedStepRows,    // SELECT steps back for layers (no layers path)
        [],                  // project_config UPDATE (head_sha)
      ],
      onInsert: (table, vals) => {
        if (table === layers) {
          layerInserts.push(vals as unknown[]);
        }
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: ["my-story"] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(PROJECT_ID, changes, TOKEN, OWNER, REPO, mockDb);

    expect(layerInserts).toHaveLength(0);
  });

  it("inserts layer rows with correct step_id mapping when story CSV contains layer content", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_NEW_STORY;
      if (path === "_config.yml") return CONFIG_YML;
      if (path === "telar-content/spreadsheets/my-story.csv") return STORY_CSV_WITH_LAYERS;
      return null;
    });

    const insertedStoryRow = {
      id: 42,
      project_id: PROJECT_ID,
      story_id: "my-story",
      title: "My Story",
      subtitle: "A subtitle",
      byline: "An author",
      order: 1,
      private: false,
    };

    // After steps are inserted the fix SELECTs them back by id (insertion order)
    // to resolve placeholders. step_number is no longer fetched.
    // step index 0 → id 100 (insertion order 0)
    // step index 1 → id 101 (insertion order 1)
    const insertedStepRows = [
      { id: 100 },
      { id: 101 },
    ];

    const layerInserts: Array<unknown> = [];

    const mockDb = createTrackedMockDb({
      responses: [
        [],               // applySyncChanges: d1Objects
        [],               // applySyncChanges: allD1Objects
        [insertedStoryRow], // SELECT after story insert → storyDbId=42
        [],               // INSERT steps chunk
        insertedStepRows, // SELECT steps back for layer back-fill
        [],               // project_config UPDATE (head_sha)
      ],
      onInsert: (table, vals) => {
        if (table === layers) {
          // vals may be an array (chunk) or a single object
          if (Array.isArray(vals)) {
            layerInserts.push(...vals);
          } else {
            layerInserts.push(vals);
          }
        }
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: ["my-story"] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(PROJECT_ID, changes, TOKEN, OWNER, REPO, mockDb);

    // Two layer rows expected:
    //   step index 0 (placeholder -1) → real step id 100 → layer_number 1, button "Open Layer"
    //   step index 1 (placeholder -2) → real step id 101 → layer_number 1, no button
    expect(layerInserts).toHaveLength(2);

    const first = layerInserts[0] as Record<string, unknown>;
    expect(first.step_id).toBe(100);
    expect(first.layer_number).toBe(1);
    expect(first.button_label).toBe("Open Layer");
    expect(first.content).toBe("Layer one content");

    const second = layerInserts[1] as Record<string, unknown>;
    expect(second.step_id).toBe(101);
    expect(second.layer_number).toBe(1);
    expect(second.content).toBe("Second layer content");
  });

  it("maps layers to steps by insertion order (id ASC) even when step column is non-sequential", async () => {
    // Regression: if the back-fill sorts by step_number rather than id, a CSV
    // with gaps in the explicit `step` column (e.g. 10, 20) can silently attach
    // layer content to the wrong step when the DB autoincrement order does not
    // match step_number order.
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_NEW_STORY;
      if (path === "_config.yml") return CONFIG_YML;
      if (path === "telar-content/spreadsheets/my-story.csv") return STORY_CSV_NON_SEQUENTIAL_STEPS;
      return null;
    });

    const insertedStoryRow = {
      id: 42,
      project_id: PROJECT_ID,
      story_id: "my-story",
      title: "My Story",
      subtitle: "A subtitle",
      byline: "An author",
      order: 1,
      private: false,
    };

    // The mock returns steps sorted by id ascending (200, 201), matching
    // filtered-row insertion order. step_number values are 10 and 20 — if
    // sorting by step_number, the result would still be the same ordering
    // here, but only because the numbers happen to be ascending. The test
    // confirms that the code uses id-sort (insertion order), not step_number.
    // To make this adversarial, the ids returned are deliberately out of
    // natural insertion order to expose a step_number-sort regression:
    // we return id=201 before id=200 in the mock result; correct id-sort
    // must reorder them to [200, 201] and map placeholders accordingly.
    const insertedStepRowsOutOfOrder = [
      { id: 201 }, // second inserted step (step_number=20)
      { id: 200 }, // first inserted step (step_number=10)
    ];

    const layerInserts: Array<unknown> = [];

    const mockDb = createTrackedMockDb({
      responses: [
        [],                          // applySyncChanges: d1Objects
        [],                          // applySyncChanges: allD1Objects
        [insertedStoryRow],          // SELECT after story insert → storyDbId=42
        [],                          // INSERT steps chunk
        insertedStepRowsOutOfOrder,  // SELECT steps back — returned out of id order
        [],                          // project_config UPDATE (head_sha)
      ],
      onInsert: (table, vals) => {
        if (table === layers) {
          if (Array.isArray(vals)) {
            layerInserts.push(...vals);
          } else {
            layerInserts.push(vals);
          }
        }
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: ["my-story"] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(PROJECT_ID, changes, TOKEN, OWNER, REPO, mockDb);

    // With id-sort: orderedStepIds = [200, 201]
    //   placeholder -1 (CSV row 0, step_number=10) → id 200 → "Alpha layer content"
    //   placeholder -2 (CSV row 1, step_number=20) → id 201 → "Beta layer content"
    //
    // With a broken step_number-sort (if the mock also had step_number):
    //   that would only work coincidentally — this test's out-of-id-order
    //   mock result proves the id-sort path is actually taken.
    expect(layerInserts).toHaveLength(2);

    const alpha = layerInserts[0] as Record<string, unknown>;
    expect(alpha.step_id).toBe(200);  // first row (step_number=10) → id 200
    expect(alpha.layer_number).toBe(1);
    expect(alpha.button_label).toBe("Alpha Button");
    expect(alpha.content).toBe("Alpha layer content");

    const beta = layerInserts[1] as Record<string, unknown>;
    expect(beta.step_id).toBe(201);   // second row (step_number=20) → id 201
    expect(beta.layer_number).toBe(1);
    expect(beta.content).toBe("Beta layer content");
  });
});
