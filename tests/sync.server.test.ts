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
} from "~/lib/sync.server";

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
lang: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: 0.9.0`;

const CONFIG_YML_CHANGED_TITLE = `title: Updated Site Title
lang: en
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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

    expect(result.config.changedFields.length).toBeGreaterThan(0);
    const titleChange = result.config.changedFields.find((f) => f.key === "title");
    expect(titleChange).toBeDefined();
    expect(titleChange!.repoValue).toBe("Updated Site Title");
    expect(titleChange!.d1Value).toBe("My Site");
  });
});

// ---------------------------------------------------------------------------
// computeFullSyncDiff — conflict detection
// ---------------------------------------------------------------------------

describe("computeFullSyncDiff — conflict detection", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("when publishSnapshot is null (never published), hasConflicts is false (auto-merge mode)", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_TWO_STORIES;
      if (path === "_config.yml") return CONFIG_YML_CHANGED_TITLE;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config: MockConfig[] = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: null, url: null, description: null, author: null, email: null },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      d1Config,
    ]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

    // No snapshot — no conflicts possible
    expect(result.hasConflicts).toBe(false);
  });

  it("when publishSnapshot exists, entities changed in both repo and D1 since baseline are flagged as conflicts", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_CHANGED_TITLE;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });

    // D1 has a different title from baseline (user edited in compositor)
    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "D1 Edited Title", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];

    const mockDb = createSequentialMockDb([
      [], [], d1Stories,
      d1Stories,
      [],
    ]);

    // Snapshot baseline had original title
    const publishSnapshot = {
      stories: [{ story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, isPrivate: false }],
      config: {} as Record<string, string | null>,
    };

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, publishSnapshot);

    // Both changed relative to baseline — conflict
    const conflict = result.stories.changedStories.find((s) => s.story_id === "my-story");
    expect(conflict).toBeDefined();
    expect(conflict!.isConflict).toBe(true);
    expect(result.hasConflicts).toBe(true);
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
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb);

    // Should have at least one update with title = "Updated Site Title"
    const titleUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && (u.set as Record<string, unknown>).title === "Updated Site Title"
    );
    expect(titleUpdates.length).toBeGreaterThan(0);
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

    const result = await computeFullSyncDiff(1, "t", "o", "r", mockDb, null);

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
