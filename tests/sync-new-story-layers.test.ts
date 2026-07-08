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
import { resolveFullSyncPayload } from "~/lib/sync.server";

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

// New-story import now resolves into an ingest payload whose story insert
// carries steps/layers by step_index (the DO threads layers onto their parent
// step and the snapshot assigns real step ids). These tests pin the resolution
// layer: the layer bodies/buttons land on the payload under the right
// step_index. The old direct-D1 step-id backfill moved into the DO snapshot and
// is covered by the DO-probe suite.
describe("resolveFullSyncPayload — new-story insert carries layers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("sha-abc");
  });

  const changes = {
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
    stories: { accept: [], reject: [], insertNew: ["my-story"] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
  };

  it("emits no layers when the story CSV has no layer content (sanity check)", async () => {
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

    const mockDb = createTrackedMockDb({ responses: [[], []] });
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, changes, TOKEN, OWNER, REPO, mockDb);

    const ins = payload.stories.insert.find((s) => s.storyId === "my-story");
    expect(ins?.layers ?? []).toHaveLength(0);
    expect(ins?.steps ?? []).toHaveLength(2);
  });

  it("emits layers with correct step_index mapping when the story CSV has layer content", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_NEW_STORY;
      if (path === "_config.yml") return CONFIG_YML;
      if (path === "telar-content/spreadsheets/my-story.csv") return STORY_CSV_WITH_LAYERS;
      return null;
    });

    const mockDb = createTrackedMockDb({ responses: [[], []] });
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, changes, TOKEN, OWNER, REPO, mockDb);

    const ins = payload.stories.insert.find((s) => s.storyId === "my-story");
    expect(ins?.layers).toHaveLength(2);

    const first = ins!.layers[0];
    expect(first.step_index).toBe(0);
    expect(first.layer_number).toBe(1);
    expect(first.button_label).toBe("Open Layer");
    expect(first.content).toBe("Layer one content");

    const second = ins!.layers[1];
    expect(second.step_index).toBe(1);
    expect(second.layer_number).toBe(1);
    expect(second.content).toBe("Second layer content");
  });

  it("assigns step_index by filtered-row order even when the step column is non-sequential", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_NEW_STORY;
      if (path === "_config.yml") return CONFIG_YML;
      if (path === "telar-content/spreadsheets/my-story.csv") return STORY_CSV_NON_SEQUENTIAL_STEPS;
      return null;
    });

    const mockDb = createTrackedMockDb({ responses: [[], []] });
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, changes, TOKEN, OWNER, REPO, mockDb);

    const ins = payload.stories.insert.find((s) => s.storyId === "my-story");
    expect(ins?.layers).toHaveLength(2);

    const alpha = ins!.layers[0];
    expect(alpha.step_index).toBe(0); // first CSV row (step_number=10)
    expect(alpha.button_label).toBe("Alpha Button");
    expect(alpha.content).toBe("Alpha layer content");

    const beta = ins!.layers[1];
    expect(beta.step_index).toBe(1); // second CSV row (step_number=20)
    expect(beta.content).toBe("Beta layer content");
  });
});
