/**
 * Unit tests for extended sync.server.ts full sync functions.
 *
 * Tests computeFullSyncDiff and applyFullSyncChanges for stories,
 * steps, and config — beyond the existing objects-only sync.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup
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
import {
  computeFullSyncDiff,
  applyFullSyncChanges,
  computeSyncDiff,
  applySyncChanges,
  computeGlossarySyncDiff,
  extractTelarVersion,
  extractConfigFields,
  hasDivergentChanges,
  SYNC_FIELDS,
} from "~/lib/sync.server";
import type { FullSyncDiff } from "~/lib/sync.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_CSV_ONE_STORY = `order,story_id,title,subtitle,byline,private
1,my-story,My Story,A subtitle,An author,false`;

const PROJECT_CSV_TWO_STORIES = `order,story_id,title,subtitle,byline,private
1,my-story,My Story,A subtitle,An author,false
2,new-story,New Story,,Another author,false`;

const PROJECT_CSV_CHANGED_TITLE = `order,story_id,title,subtitle,byline,private
1,my-story,Updated Story Title,A subtitle,An author,false`;

const CONFIG_YML_BASE = `title: My Site
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: 0.9.0`;

const CONFIG_YML_CHANGED_TITLE = `title: Updated Site Title
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: 0.9.0`;

// ---------------------------------------------------------------------------
// Mock DB types
// ---------------------------------------------------------------------------

type MockStory = {
  id: number;
  project_id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  order: number;
  private: boolean;
  draft: boolean;
  updated_at: string | null;
};

type MockConfig = {
  id: number;
  project_id: number;
  title: string | null;
  lang: string | null;
  baseurl: string | null;
  url: string | null;
  description: string | null;
  author: string | null;
  email: string | null;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Mock DB factory — sequence-based
//
// Each "query" in the sequence corresponds to one awaited DB operation.
// The mock is designed so that any terminal in the chain (from, where,
// values) can be awaited — it resolves with responses[callIndex++].
//
// Drizzle query patterns used in sync.server.ts:
//   await db.select().from(T)           — terminal: from (no where)
//   await db.select().from(T).where()   — terminal: where
//   await db.insert(T).values()         — terminal: values
//   await db.update(T).set().where()    — terminal: where (after set)
//   await db.delete(T).where()          — terminal: where
//
// We make the chain thenable at every node, so whichever is the last
// awaited call advances the counter.
// ---------------------------------------------------------------------------

function createSequentialMockDb(responses: unknown[]) {
  let callIndex = 0;

  function makeResult() {
    const data = responses[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(data);
  }

  // A "lazy thenable" that both chains (returns db) and resolves (then/catch/finally).
  // Every chained method that can be a terminal calls makeResult() lazily.
  const db: Record<string, unknown> = {};

  // Terminal-capable chain builder: calling this as a function AND awaiting it both work.
  function terminal(fn?: () => unknown) {
    return Object.assign(
      // Make it a thenable so `await chain.from(...)` works
      {
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(fn ? fn() : makeResult()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
      // Also return db so further chaining works
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
  db.insert = vi.fn(() => terminal());
  db.values = vi.fn(() => terminal());
  db.delete = vi.fn(() => terminal());

  return db as unknown as ReturnType<typeof import("~/lib/db.server").getDb>;
}

// ---------------------------------------------------------------------------
// Tracked mock DB for apply tests
// ---------------------------------------------------------------------------

function createTrackedMockDb({
  responses = [] as unknown[],
  onInsert = (_table: unknown, _vals: unknown) => {},
  onUpdate = (_table: unknown, _set: unknown) => {},
}: {
  responses?: unknown[];
  onInsert?: (table: unknown, vals: unknown) => void;
  onUpdate?: (table: unknown, set: unknown) => void;
} = {}) {
  let callIndex = 0;
  let currentInsertTable: unknown = null;
  let currentUpdateTable: unknown = null;
  let pendingSet: unknown = null;

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
  db.where = vi.fn(() => terminal(() => {
    if (pendingSet !== null) {
      onUpdate(currentUpdateTable, pendingSet);
      pendingSet = null;
    }
    return makeResult();
  }));
  db.limit = vi.fn(() => terminal());
  db.orderBy = vi.fn(() => terminal());
  db.update = vi.fn((table: unknown) => {
    currentUpdateTable = table;
    return terminal();
  });
  db.set = vi.fn((vals: unknown) => {
    pendingSet = vals;
    return terminal();
  });
  db.insert = vi.fn((table: unknown) => {
    currentInsertTable = table;
    return terminal();
  });
  db.values = vi.fn((vals: unknown) => {
    onInsert(currentInsertTable, vals);
    return terminal();
  });
  db.delete = vi.fn(() => terminal());

  return db as unknown as ReturnType<typeof import("~/lib/db.server").getDb>;
}

// ---------------------------------------------------------------------------
// computeFullSyncDiff — stories diff
// ---------------------------------------------------------------------------

describe("computeFullSyncDiff — stories", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("detects a new story in repo that is not in D1 — appears in stories.newStories", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_TWO_STORIES;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];

    // Sequence: objects, steps, stories(titleMap), stories(fullSync), project_config
    const mockDb = createSequentialMockDb([
      [],          // objects
      [],          // steps
      d1Stories,   // stories for storyTitleMap
      d1Stories,   // stories for full sync
      [],          // project_config
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.stories.newStories).toHaveLength(1);
    expect(result.stories.newStories[0].story_id).toBe("new-story");
  });

  it("detects a modified story (title differs between repo and D1) — appears in stories.changedStories", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_CHANGED_TITLE;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,  // computeSyncDiff internal queries
      d1Stories,           // stories for full sync
      [],                  // project_config
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.stories.changedStories).toHaveLength(1);
    expect(result.stories.changedStories[0].story_id).toBe("my-story");
    expect(result.stories.changedStories[0].changedFields).toContain("title");
  });

  it("detects a story in D1 that is no longer in repo — appears in stories.missingStories", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return `order,story_id,title,subtitle,byline,private\n2,new-story,New Story,,Another author,false`;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: null, byline: null, order: 1, private: false, draft: false, updated_at: null },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      [],
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.stories.missingStories).toHaveLength(1);
    expect(result.stories.missingStories[0].story_id).toBe("my-story");
  });
});

// ---------------------------------------------------------------------------
// computeFullSyncDiff — config diff
// ---------------------------------------------------------------------------

describe("computeFullSyncDiff — config", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("detects config field change (repo title differs from D1 title) — appears in config.changedFields", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_CHANGED_TITLE;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];

    const d1Config: MockConfig[] = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com" },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.changedFields.length).toBeGreaterThan(0);
    const titleChange = result.config.changedFields.find((f) => f.key === "title");
    expect(titleChange).toBeDefined();
    expect(titleChange!.repoValue).toBe("Updated Site Title");
    expect(titleChange!.d1Value).toBe("My Site");
  });

  // Regression: extractConfigFields used to match a literal `^lang:`
  // line, but real _config.yml files (and buildConfigManagedFields' write side)
  // key this field "telar_language". A repo-side language edit never surfaced
  // in the sync diff. Real fixtures/config always use "telar_language", never "lang".
  it("detects a repo-side telar_language change and surfaces it in config.changedFields", async () => {
    const CONFIG_YML_CHANGED_LANGUAGE = `title: My Site
telar_language: es
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: 0.9.0`;

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_CHANGED_LANGUAGE;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];

    const d1Config: MockConfig[] = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com" },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    const langChange = result.config.changedFields.find((f) => f.key === "lang");
    expect(langChange).toBeDefined();
    expect(langChange!.repoValue).toBe("es");
    expect(langChange!.d1Value).toBe("en");
  });

  // Regression: publish's buildConfigManagedFields unconditionally
  // rewrites logo/story_key/collection_mode from D1 on every publish, but
  // sync's managed set omitted all three, so direct repo edits to them never
  // surfaced in a diff before being silently clobbered on the next publish.
  it("detects repo-side logo/story_key/collection_mode changes and surfaces them in config.changedFields", async () => {
    const CONFIG_YML_CHANGED_MANAGED_EXTRAS = `title: My Site
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
logo: /assets/new-logo.png
story_key: new-story-key
collection_mode: true
telar:
  version: 0.9.0`;

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_CHANGED_MANAGED_EXTRAS;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];

    const d1Config: MockConfig[] = [
      {
        id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io",
        description: "A great site", author: "Test User", email: "test@example.com",
        logo: "/assets/old-logo.png", story_key: "old-story-key", collection_mode: "false",
      },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.changedFields.find((f) => f.key === "logo")?.repoValue).toBe("/assets/new-logo.png");
    expect(result.config.changedFields.find((f) => f.key === "story_key")?.repoValue).toBe("new-story-key");
    expect(result.config.changedFields.find((f) => f.key === "collection_mode")?.repoValue).toBe("true");
  });

  // Regression — collection_mode boolean/string mismatch: project_config.collection_mode
  // is a real D1 boolean column (schema.ts, mode: "boolean"), so drizzle returns a JS
  // boolean, not the string the test above hand-mocks. Repo _config.yml stores
  // collection_mode as the bare scalar "true"/"false", which parseYamlScalar always
  // returns as a string. Before normalizing, "true" !== true always mismatched, so an
  // unchanged collection_mode false-positived as a diff on every check.
  it("normalizes collection_mode boolean vs string: unchanged does not diff, a genuine change still does", async () => {
    const CONFIG_YML_COLLECTION_MODE_ON = `title: My Site
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
collection_mode: true
telar:
  version: 0.9.0`;

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_COLLECTION_MODE_ON;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];

    // Unchanged: D1 stores collection_mode as a real boolean `true`, matching the
    // repo's "true" — must NOT surface as a diff.
    const d1ConfigUnchanged: MockConfig[] = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", collection_mode: true },
    ];

    const mockDbUnchanged = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1ConfigUnchanged,
    ]);

    const unchangedResult = await computeFullSyncDiff(projectId, token, owner, repo, mockDbUnchanged);
    expect(unchangedResult.config.changedFields.find((f) => f.key === "collection_mode")).toBeUndefined();

    // Genuine change: D1 boolean `false` vs repo "true" — must still surface.
    const d1ConfigChanged: MockConfig[] = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", collection_mode: false },
    ];

    const mockDbChanged = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1ConfigChanged,
    ]);

    const changedResult = await computeFullSyncDiff(projectId, token, owner, repo, mockDbChanged);
    const collectionModeChange = changedResult.config.changedFields.find((f) => f.key === "collection_mode");
    expect(collectionModeChange).toBeDefined();
    expect(collectionModeChange!.repoValue).toBe("true");
    expect(collectionModeChange!.d1Value).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// applyFullSyncChanges
// ---------------------------------------------------------------------------

describe("applyFullSyncChanges", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_TWO_STORIES;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      if (path === "telar-content/spreadsheets/new-story.csv") return `step,object,x,y,zoom\n1,my-object,0.5,0.5,1.0`;
      return null;
    });
  });

  it("updates head_sha to current repo HEAD after sync", async () => {
    // applySyncChanges internal: objects, tree, objects again, d1Objects for flagging
    // applyFullSyncChanges: project.csv (re-fetch), stories.insert (none), projects.update
    // Provide plenty of empty responses
    const mockDb = createSequentialMockDb(Array(20).fill([]));

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    const result = await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb);

    expect(result.newHeadSha).toBe("newsha123");
  });

  it("inserts new stories into D1 stories table when insertNew contains story_id", async () => {
    const inserted: Array<{ table: unknown; values: unknown }> = [];

    const newStoryRow = { id: 99, project_id: projectId, story_id: "new-story", title: "New Story", subtitle: null, byline: "Another author", order: 2, private: false, draft: false, updated_at: null };

    const mockDb = createTrackedMockDb({
      responses: [
        // applySyncChanges: objects CSV fetch happens via getFileContent (mocked)
        // applySyncChanges internal DB calls:
        [],   // d1Objects for applySyncChanges
        [],   // allD1Objects loop  (may not be a query)
        // applyFullSyncChanges:
        [newStoryRow], // select new story after insert to get ID
        [],   // steps insert
        [],   // projects.update (head_sha)
      ],
      onInsert: (table, vals) => {
        inserted.push({ table, values: vals });
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: ["new-story"] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb);

    expect(inserted.length).toBeGreaterThan(0);
  });

  it("does not update D1 story title when story_id is in reject list (keep D1)", async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];

    // Response for all where() calls
    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: ["my-story"], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb);

    // No update with "Updated Story Title" — D1 value preserved
    const wrongUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && (u.set as Record<string, unknown>).title === "Updated Story Title"
    );
    expect(wrongUpdates).toHaveLength(0);
  });

  it("applies accepted config changes to project_config — updates title in D1", async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_CHANGED_TITLE;
      return null;
    });

    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: ["title"], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb);

    // Should have at least one update with title = "Updated Site Title"
    const titleUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && (u.set as Record<string, unknown>).title === "Updated Site Title"
    );
    expect(titleUpdates.length).toBeGreaterThan(0);
  });

  it("writes repo related_terms into the D1 update when a glossary change is accepted", async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_TWO_STORIES;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      if (path === "telar-content/spreadsheets/glossary.csv") {
        return `term_id,title,definition,related_terms\nenc,"Encomienda","A labor system","mita|repartimiento"`;
      }
      return null;
    });

    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: ["enc"], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb);

    const relatedUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && (u.set as Record<string, unknown>).related_terms === "mita|repartimiento"
    );
    expect(relatedUpdates.length).toBeGreaterThan(0);
  });

  it("inserts a new glossary term with its related_terms", async () => {
    const inserted: Array<{ table: unknown; values: unknown }> = [];

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_TWO_STORIES;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      if (path === "telar-content/spreadsheets/glossary.csv") {
        return `term_id,title,definition,related_terms\nmita,"Mita","Mandatory service","enc|repartimiento"`;
      }
      return null;
    });

    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onInsert: (table, vals) => {
        inserted.push({ table, values: vals });
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: ["mita"] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb);

    const relatedInserts = inserted.filter(
      (i) => i.values !== null && typeof i.values === "object" && (i.values as Record<string, unknown>).related_terms === "enc|repartimiento"
    );
    expect(relatedInserts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getRepoHead export from github.server
// ---------------------------------------------------------------------------

describe("getRepoHead", () => {
  it("is exported as a function from github.server", async () => {
    const mod = await import("~/lib/github.server");
    expect(typeof mod.getRepoHead).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// FullSyncDiff structure
// ---------------------------------------------------------------------------

describe("FullSyncDiff return structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getFileContent).mockResolvedValue(null);
  });

  it("computeFullSyncDiff result has objects, stories, and config keys with correct shapes", async () => {
    const mockDb = createSequentialMockDb(Array(10).fill([]));

    const result = await computeFullSyncDiff(1, "t", "o", "r", mockDb);

    expect(result).toHaveProperty("objects");
    expect(result).toHaveProperty("stories");
    expect(result).toHaveProperty("config");
    expect(result.stories).toHaveProperty("newStories");
    expect(result.stories).toHaveProperty("changedStories");
    expect(result.stories).toHaveProperty("missingStories");
    expect(result.config).toHaveProperty("changedFields");
    expect(result).toHaveProperty("hasConflicts");
  });
});

// ---------------------------------------------------------------------------
// glossary sync diff
// ---------------------------------------------------------------------------

const GLOSSARY_CSV_ONE_TERM = `term_id,title,definition,related_terms
enc,"Encomienda","A labor system used in colonial Spanish America",`;

const GLOSSARY_CSV_TWO_TERMS = `term_id,title,definition,related_terms
enc,"Encomienda","A labor system used in colonial Spanish America",
mita,"Mita","Mandatory public service system","enc|repartimiento"`;

const GLOSSARY_CSV_CHANGED_DEF = `term_id,title,definition,related_terms
enc,"Encomienda","Updated definition for encomienda",`;

// Definition identical to D1; only related_terms differs (repo adds links).
const GLOSSARY_CSV_CHANGED_RELATED = `term_id,title,definition,related_terms
enc,"Encomienda","A labor system used in colonial Spanish America","mita|repartimiento"`;

// Spanish headers (términos_relacionados → related_terms via parseTelarCsv).
const GLOSSARY_CSV_SPANISH_HEADERS = `term_id,title,definition,términos_relacionados
enc,"Encomienda","A labor system used in colonial Spanish America","mita"`;

describe("glossary sync diff", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects added glossary terms from repo (term in repo but not in D1)", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return GLOSSARY_CSV_TWO_TERMS;
      return null;
    });

    // D1 has only one term
    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system used in colonial Spanish America", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.added).toHaveLength(1);
    expect(result.added[0].term_id).toBe("mita");
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it("detects removed glossary terms (term in D1 but not in repo)", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return GLOSSARY_CSV_ONE_TERM;
      return null;
    });

    // D1 has two terms
    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system used in colonial Spanish America", updated_at: null },
      { id: 2, project_id: projectId, term_id: "mita", title: "Mita", definition: "Mandatory public service system", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].term_id).toBe("mita");
    expect(result.added).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it("detects changed glossary term definitions", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return GLOSSARY_CSV_CHANGED_DEF;
      return null;
    });

    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system used in colonial Spanish America", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].term_id).toBe("enc");
    expect(result.changed[0].repoDefinition).toBe("Updated definition for encomienda");
    expect(result.changed[0].d1Definition).toBe("A labor system used in colonial Spanish America");
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("handles empty glossary CSV — all D1 terms appear as removed", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return null;
      return null;
    });

    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    // No repo CSV → no repo terms → all D1 terms are "removed"
    expect(result.removed).toHaveLength(1);
    expect(result.added).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it("detects changed related_terms when definition is identical", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return GLOSSARY_CSV_CHANGED_RELATED;
      return null;
    });

    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system used in colonial Spanish America", related_terms: "", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].term_id).toBe("enc");
    expect(result.changed[0].d1RelatedTerms).toBe("");
    expect(result.changed[0].repoRelatedTerms).toBe("mita|repartimiento");
    // Definition unchanged on both sides
    expect(result.changed[0].d1Definition).toBe("A labor system used in colonial Spanish America");
    expect(result.changed[0].repoDefinition).toBe("A labor system used in colonial Spanish America");
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("still detects changed definition when related_terms is identical (regression)", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return GLOSSARY_CSV_CHANGED_DEF;
      return null;
    });

    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system used in colonial Spanish America", related_terms: "", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].term_id).toBe("enc");
    expect(result.changed[0].repoDefinition).toBe("Updated definition for encomienda");
    expect(result.changed[0].d1Definition).toBe("A labor system used in colonial Spanish America");
    // related_terms identical on both sides
    expect(result.changed[0].d1RelatedTerms).toBe("");
    expect(result.changed[0].repoRelatedTerms).toBe("");
  });

  it("carries related_terms on added glossary terms", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return GLOSSARY_CSV_TWO_TERMS;
      return null;
    });

    // D1 has only "enc"; "mita" (with related_terms) is the added term.
    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system used in colonial Spanish America", related_terms: "", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.added).toHaveLength(1);
    expect(result.added[0].term_id).toBe("mita");
    expect(result.added[0].related_terms).toBe("enc|repartimiento");
  });

  it("reads related_terms from Spanish CSV headers (términos_relacionados)", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return GLOSSARY_CSV_SPANISH_HEADERS;
      return null;
    });

    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system used in colonial Spanish America", related_terms: "", updated_at: null },
    ];

    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].repoRelatedTerms).toBe("mita");
  });
});

// ---------------------------------------------------------------------------
// computeSyncDiff — origin-aware missing object classification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// extractTelarVersion — unit tests
// ---------------------------------------------------------------------------

describe("extractTelarVersion", () => {
  it("reads quoted version", () => {
    const y = 'telar:\n  version: "1.2.0"\n  release_date: "2026-01-01"\n';
    expect(extractTelarVersion(y)).toBe("1.2.0");
  });

  it("reads unquoted version", () => {
    const y = "telar:\n  version: 1.2.0\n";
    expect(extractTelarVersion(y)).toBe("1.2.0");
  });

  it("reads single-quoted version", () => {
    const y = "telar:\n  version: '1.2.0'\n";
    expect(extractTelarVersion(y)).toBe("1.2.0");
  });

  it("tolerates trailing comment", () => {
    const y = 'telar:\n  version: "1.2.0" # latest\n';
    expect(extractTelarVersion(y)).toBe("1.2.0");
  });

  it("reads a v-prefixed version string", () => {
    const y = 'telar:\n  version: "v0.9.0"\n';
    expect(extractTelarVersion(y)).toBe("v0.9.0");
  });

  it("returns null when telar: block absent", () => {
    const y = "title: my site\nbaseurl: /x\n";
    expect(extractTelarVersion(y)).toBeNull();
  });

  it("returns null when telar: block has no version key", () => {
    const y = 'telar:\n  release_date: "2026-01-01"\n';
    expect(extractTelarVersion(y)).toBeNull();
  });

  it("stops at next top-level key", () => {
    const y = 'telar:\n  version: "1.2.0"\nother:\n  version: "9.9.9"\n';
    expect(extractTelarVersion(y)).toBe("1.2.0");
  });

  it("first match wins when the telar: block is re-entered", () => {
    // Tolerates invalid YAML that declares telar: twice — first match wins
    const y = 'telar:\n  version: "1.2.0"\nother: x\ntelar:\n  version: "9.9.9"\n';
    expect(extractTelarVersion(y)).toBe("1.2.0");
  });

  it("returns null on empty input", () => {
    expect(extractTelarVersion("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeFullSyncDiff — versionChange
// ---------------------------------------------------------------------------

const CONFIG_YML_REPO_NEWER = `title: My Site
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: "0.10.0"`;

const CONFIG_YML_REPO_OLDER = `title: My Site
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: "0.8.0"`;

const CONFIG_YML_NO_TELAR_VERSION = `title: My Site
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io`;

describe("computeFullSyncDiff — versionChange", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("sets direction=ahead when repo version newer than d1", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_REPO_NEWER;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", telar_version: "0.9.0" },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.versionChange).not.toBeNull();
    expect(result.config.versionChange!.direction).toBe("ahead");
    expect(result.config.versionChange!.repoVersion).toBe("0.10.0");
    expect(result.config.versionChange!.d1Version).toBe("0.9.0");
  });

  it("sets direction=behind when repo version older than d1", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_REPO_OLDER;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", telar_version: "0.9.0" },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.versionChange).not.toBeNull();
    expect(result.config.versionChange!.direction).toBe("behind");
    expect(result.config.versionChange!.repoVersion).toBe("0.8.0");
    expect(result.config.versionChange!.d1Version).toBe("0.9.0");
  });

  it("returns null versionChange when versions equal", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_BASE; // version 0.9.0
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", telar_version: "0.9.0" },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.versionChange).toBeNull();
  });

  it("sets direction=ahead when d1 telar_version is null", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_BASE; // repo: 0.9.0
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    // d1 has no telar_version yet
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", telar_version: null },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.versionChange).not.toBeNull();
    expect(result.config.versionChange!.direction).toBe("ahead");
    expect(result.config.versionChange!.repoVersion).toBe("0.9.0");
    expect(result.config.versionChange!.d1Version).toBeNull();
  });

  it("returns null versionChange when repo version absent", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_NO_TELAR_VERSION;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", telar_version: "0.9.0" },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.versionChange).toBeNull();
  });

  it("returns null versionChange when both repo and d1 versions are absent", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_NO_TELAR_VERSION;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", telar_version: null },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.config.versionChange).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyFullSyncChanges — versionChange D1 healing
// ---------------------------------------------------------------------------

describe("applyFullSyncChanges — versionChange D1 healing", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });
  });

  function baseChanges() {
    return {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };
  }

  function makeDiff(versionChange: FullSyncDiff["config"]["versionChange"]): FullSyncDiff {
    return {
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
      stories: { newStories: [], changedStories: [], missingStories: [] },
      config: { changedFields: [], versionChange },
      glossary: { added: [], removed: [], changed: [] },
      hasConflicts: false,
    };
  }

  it("updates D1 telar_version when direction=ahead", async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];
    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    const diff = makeDiff({ direction: "ahead", repoVersion: "0.10.0", d1Version: "0.9.0" });
    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb, diff);

    const versionUpdates = updates.filter(
      (u) =>
        u.set !== null &&
        typeof u.set === "object" &&
        (u.set as Record<string, unknown>).telar_version === "0.10.0",
    );
    expect(versionUpdates.length).toBeGreaterThan(0);
  });

  it("does NOT update D1 telar_version when direction=behind", async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];
    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    const diff = makeDiff({ direction: "behind", repoVersion: "0.8.0", d1Version: "0.9.0" });
    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb, diff);

    // D1 must not receive any telar_version write (user decides).
    const wrongUpdates = updates.filter(
      (u) =>
        u.set !== null &&
        typeof u.set === "object" &&
        "telar_version" in (u.set as Record<string, unknown>),
    );
    expect(wrongUpdates).toHaveLength(0);
  });

  it("does NOT update D1 telar_version when versionChange=null", async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];
    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    const diff = makeDiff(null);
    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb, diff);

    const wrongUpdates = updates.filter(
      (u) =>
        u.set !== null &&
        typeof u.set === "object" &&
        "telar_version" in (u.set as Record<string, unknown>),
    );
    expect(wrongUpdates).toHaveLength(0);
  });

  it("does NOT update D1 telar_version when diff is omitted (backward-compatible callers)", async () => {
    const updates: Array<{ table: unknown; set: unknown }> = [];
    const mockDb = createTrackedMockDb({
      responses: Array(20).fill([]),
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb);

    const wrongUpdates = updates.filter(
      (u) =>
        u.set !== null &&
        typeof u.set === "object" &&
        "telar_version" in (u.set as Record<string, unknown>),
    );
    expect(wrongUpdates).toHaveLength(0);
  });
});

describe("computeSyncDiff — origin-aware missing object classification", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    // Repo CSV is empty — no objects in repo
    vi.mocked(githubServer.getFileContent).mockResolvedValue("");
  });

  it("compositor-origin object NOT in repo CSV is excluded from missingObjects", async () => {
    // D1 has an object with origin='compositor' that is not in the repo CSV
    const d1Objects = [
      {
        id: 1, project_id: projectId, object_id: "ext-iiif-object",
        title: "External IIIF Object", origin: "compositor",
        featured: false, missing_from_repo: false,
        creator: null, description: null, source_url: "https://example.com/manifest.json",
        period: null, year: null, object_type: null, subjects: null,
        source: null, credit: null, thumbnail: null,
        image_available: true, updated_at: null,
      },
    ];

    // computeSyncDiff queries: d1Objects, steps, story titles
    const mockDb = createSequentialMockDb([d1Objects, [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);

    // Compositor-origin object must NOT appear in missingObjects
    expect(result.missingObjects).toHaveLength(0);
  });

  it("repo-origin object NOT in repo CSV IS included in missingObjects", async () => {
    // D1 has an object with origin='repo' (default) that is not in the repo CSV
    const d1Objects = [
      {
        id: 2, project_id: projectId, object_id: "repo-object",
        title: "Repo Object", origin: "repo",
        featured: false, missing_from_repo: false,
        creator: null, description: null, source_url: null,
        period: null, year: null, object_type: null, subjects: null,
        source: null, credit: null, thumbnail: null,
        image_available: false, updated_at: null,
      },
    ];

    const mockDb = createSequentialMockDb([d1Objects, [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);

    // Repo-origin object missing from CSV MUST appear in missingObjects
    expect(result.missingObjects).toHaveLength(1);
    expect(result.missingObjects[0].object_id).toBe("repo-object");
  });
});

// ---------------------------------------------------------------------------
// hasDivergentChanges — sync-divergence banner gate used in _app.tsx
// ---------------------------------------------------------------------------

describe("hasDivergentChanges", () => {
  function emptyDiff(): FullSyncDiff {
    return {
      objects: {
        newObjects: [],
        changedObjects: [],
        missingObjects: [],
        unregisteredFiles: [],
      },
      stories: {
        newStories: [],
        changedStories: [],
        missingStories: [],
      },
      config: {
        changedFields: [],
        versionChange: null,
      },
      glossary: {
        added: [],
        removed: [],
        changed: [],
      },
      hasConflicts: false,
    };
  }

  it("returns false for an empty diff (churn-only commit)", () => {
    expect(hasDivergentChanges(emptyDiff())).toBe(false);
  });

  it("detects new objects", () => {
    const diff = emptyDiff();
    diff.objects.newObjects.push({
      object_id: "x", title: "X", creator: null, description: null,
      source_url: null, period: null, year: null, object_type: null,
      subjects: null, source: null, credit: null, thumbnail: null,
      alt_text: null, page: null, featured: false, hasImage: false,
    } as never);
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("detects changed objects", () => {
    const diff = emptyDiff();
    diff.objects.changedObjects.push({ object_id: "x" } as never);
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("detects missing objects and unregistered files", () => {
    const d1 = emptyDiff();
    d1.objects.missingObjects.push({ object_id: "x" } as never);
    const d2 = emptyDiff();
    d2.objects.unregisteredFiles.push({ object_id: "y", filename: "y.jpg" });
    expect(hasDivergentChanges(d1)).toBe(true);
    expect(hasDivergentChanges(d2)).toBe(true);
  });

  it("detects story additions, changes, and removals", () => {
    for (const key of ["newStories", "changedStories", "missingStories"] as const) {
      const diff = emptyDiff();
      (diff.stories[key] as unknown[]).push({ story_id: "s" });
      expect(hasDivergentChanges(diff)).toBe(true);
    }
  });

  it("detects config field changes", () => {
    const diff = emptyDiff();
    diff.config.changedFields.push({ key: "title", d1Value: "A", repoValue: "B" });
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("detects versionChange (behind path that should re-trigger toast)", () => {
    const diff = emptyDiff();
    diff.config.versionChange = {
      direction: "behind",
      repoVersion: "1.0.0",
      d1Version: "1.2.0",
    };
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("detects versionChange (ahead path — external upgrade)", () => {
    const diff = emptyDiff();
    diff.config.versionChange = {
      direction: "ahead",
      repoVersion: "1.2.0",
      d1Version: "1.1.0",
    };
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("detects glossary additions, changes, and removals", () => {
    for (const key of ["added", "removed", "changed"] as const) {
      const diff = emptyDiff();
      (diff.glossary[key] as unknown[]).push({ term_id: "t" });
      expect(hasDivergentChanges(diff)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SYNC_FIELDS guard — IIIF-wipe-on-sync regression pin
// ---------------------------------------------------------------------------
//
// Sync compares only repo-authored object metadata. The compositor-managed
// ---------------------------------------------------------------------------
// computeSyncDiff — dimensions reconciliation
//
// `dimensions` is a first-class nullable metadata field that must reconcile
// like creator/source/etc. A repo-side edit to an object's dimensions must be
// flagged in changedFields so it isn't reverted on the next publish.
// ---------------------------------------------------------------------------

describe("computeSyncDiff — dimensions reconciliation", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  // Realistic multi-column objects.csv so parseTelarCsv keeps the data row
  // (a sparse row risks the bilingual-header heuristic). Header uses canonical
  // English names; `dimensions` maps to itself.
  function objectsCsv(dimensions: string): string {
    return [
      "object_id,title,creator,description,object_type,dimensions,source,credit",
      `obj-1,Woven Cloth,Jane Weaver,A handwoven textile,Textile,${dimensions},Museum Collection,Photo by J. Weaver`,
    ].join("\n");
  }

  function d1Object(dimensions: string | null) {
    return {
      id: 1,
      project_id: projectId,
      object_id: "obj-1",
      title: "Woven Cloth",
      origin: "repo",
      featured: false,
      missing_from_repo: false,
      creator: "Jane Weaver",
      description: "A handwoven textile",
      source_url: null,
      period: null,
      year: null,
      object_type: "Textile",
      subjects: null,
      source: "Museum Collection",
      credit: "Photo by J. Weaver",
      thumbnail: null,
      dimensions,
      image_available: true,
      updated_at: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("flags dimensions in changedFields when repo differs from D1, with both values", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(objectsCsv("24 x 30 cm"));
    // computeSyncDiff queries: d1Objects, stepRefs, storyRows
    const mockDb = createSequentialMockDb([[d1Object("10 x 10 cm")], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.changedObjects).toHaveLength(1);
    const changed = result.changedObjects[0];
    expect(changed.object_id).toBe("obj-1");
    expect(changed.changedFields).toContain("dimensions");
    expect(changed.d1Values.dimensions).toBe("10 x 10 cm");
    expect(changed.repoValues.dimensions).toBe("24 x 30 cm");
  });

  it("does NOT flag dimensions when repo and D1 match", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(objectsCsv("10 x 10 cm"));
    const mockDb = createSequentialMockDb([[d1Object("10 x 10 cm")], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);

    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("dimensions");
  });

  it("does NOT flag dimensions when repo is empty but D1 has a value", async () => {
    // Empty repo dimensions cell — matches the "repo empty isn't a conflict" rule
    vi.mocked(githubServer.getFileContent).mockResolvedValue(objectsCsv(""));
    const mockDb = createSequentialMockDb([[d1Object("10 x 10 cm")], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);

    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("dimensions");
  });

  it("apply with dimensions choice 'repo' writes the repo value into the D1 update payload", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(objectsCsv("24 x 30 cm"));

    let captured: Record<string, unknown> | null = null;
    // applySyncChanges queries: d1Objects (then update via .set/.where)
    const mockDb = createTrackedMockDb({
      responses: [[d1Object("10 x 10 cm")]],
      onUpdate: (_table, set) => {
        captured = set as Record<string, unknown>;
      },
    });

    await applySyncChanges(
      projectId,
      {
        newObjectIds: [],
        changedObjectIds: ["obj-1"],
        fieldChoices: { "obj-1": { dimensions: "repo" } },
        removedObjectIds: [],
        unregisteredObjectIds: [],
      },
      token,
      owner,
      repo,
      mockDb,
    );

    expect(captured).not.toBeNull();
    expect(captured!.dimensions).toBe("24 x 30 cm");
  });
});

// ---------------------------------------------------------------------------
// New-object sync carries dimensions + extra_columns
//
// An object brand-new to D1 (present in repo CSV, absent from D1) is pulled in
// via the sync new-object path (PendingObject → client → D1 insert). Both the
// first-class `dimensions` field and the `extra_columns` custom-column blob
// must travel on the PendingObject so they survive the round-trip. Also pin
// that computeSyncDiff's newObjects entry carries `dimensions`.
// ---------------------------------------------------------------------------

describe("sync new-object path carries dimensions + extra_columns", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  // objects.csv with a brand-new object that has `dimensions` AND a custom
  // column (`accession_number`) so mapObjectsCsv populates extra_columns.
  const NEW_OBJECT_CSV = [
    "object_id,title,creator,description,object_type,dimensions,source,credit,accession_number",
    "new-obj,Carved Mask,Ana Talla,A wooden mask,Sculpture,40 x 20 cm,Museum Collection,Photo by A. Talla,ACC-2026-001",
  ].join("\n");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getFileContent).mockResolvedValue(NEW_OBJECT_CSV);
  });

  it("applySyncChanges returns a pendingObject carrying dimensions and extra_columns", async () => {
    // D1 has no objects → repo's new-obj is brand-new.
    // applySyncChanges queries: d1Objects (empty)
    const mockDb = createTrackedMockDb({ responses: [[]] });

    const result = await applySyncChanges(
      projectId,
      {
        newObjectIds: ["new-obj"],
        changedObjectIds: [],
        fieldChoices: {},
        removedObjectIds: [],
        unregisteredObjectIds: [],
      },
      token,
      owner,
      repo,
      mockDb,
    );

    expect(result.pendingObjects).toHaveLength(1);
    const pending = result.pendingObjects[0];
    expect(pending.object_id).toBe("new-obj");
    expect(pending.dimensions).toBe("40 x 20 cm");

    // extra_columns is the canonical JSON passthrough blob for custom columns.
    const extra = pending.extra_columns;
    expect(extra).toBeTruthy();
    expect(JSON.parse(extra as string)).toEqual({ accession_number: "ACC-2026-001" });
  });

  it("computeSyncDiff newObjects entry carries dimensions", async () => {
    // computeSyncDiff queries: d1Objects (empty), stepRefs, storyRows
    const mockDb = createSequentialMockDb([[], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);

    expect(result.newObjects).toHaveLength(1);
    const newObj = result.newObjects[0];
    expect(newObj.object_id).toBe("new-obj");
    expect(newObj.dimensions).toBe("40 x 20 cm");
  });
});

// IIIF fields (source_url, thumbnail, image_available) must NEVER appear in
// SYNC_FIELDS — including them would let a GitHub round-trip overwrite the
// uploaded-object image state with the repo's (empty) values, wiping IIIF
// images on sync. This guard asserts their ABSENCE so a future edit to the
// field set can't silently re-introduce the wipe.

describe("SYNC_FIELDS — IIIF-wipe guard", () => {
  it.each(["source_url", "thumbnail", "image_available"] as const)(
    "does NOT include the compositor-managed IIIF field %j",
    (field) => {
      expect(SYNC_FIELDS as readonly string[]).not.toContain(field);
    },
  );
});

// ---------------------------------------------------------------------------
// extractConfigFields — quoted-scalar parser
// ---------------------------------------------------------------------------

describe("extractConfigFields", () => {
  it("parses a double-quoted HTML value with single-quoted attributes (the demo case)", () => {
    const yaml = `title: My Site\ndescription: "Telar (a 'loom') — <a href='https://x.org'>Telar</a> by us."\nauthor: Jane`;
    const out = extractConfigFields(yaml);
    expect(out.description).toBe("Telar (a 'loom') — <a href='https://x.org'>Telar</a> by us.");
    expect(out.title).toBe("My Site");
    expect(out.author).toBe("Jane");
  });

  it("un-escapes double-quote and backslash escapes (inverse of yamlQuote)", () => {
    const yaml = `description: "say \\"hi\\" and a path C:\\\\x"`;
    const out = extractConfigFields(yaml);
    expect(out.description).toBe('say "hi" and a path C:\\x');
  });

  it("parses a single-quoted value with YAML doubled-quote escaping", () => {
    const yaml = `description: 'it''s fine'`;
    const out = extractConfigFields(yaml);
    expect(out.description).toBe("it's fine");
  });

  it("parses a bare scalar and strips a trailing comment", () => {
    const yaml = `description: plain text  # a note`;
    const out = extractConfigFields(yaml);
    expect(out.description).toBe("plain text");
  });

  it("returns null for an absent key", () => {
    const out = extractConfigFields(`title: only`);
    expect(out.description).toBeNull();
  });
});
