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
  computeGlossarySyncDiff,
  extractTelarVersion,
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

// ---------------------------------------------------------------------------
// glossary sync diff
// ---------------------------------------------------------------------------

const GLOSSARY_CSV_ONE_TERM = `term_id,title,definition
enc,"Encomienda","A labor system used in colonial Spanish America"`;

const GLOSSARY_CSV_TWO_TERMS = `term_id,title,definition
enc,"Encomienda","A labor system used in colonial Spanish America"
mita,"Mita","Mandatory public service system"`;

const GLOSSARY_CSV_CHANGED_DEF = `term_id,title,definition
enc,"Encomienda","Updated definition for encomienda"`;

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
});

// ---------------------------------------------------------------------------
// computeSyncDiff — origin-aware missing object classification (DATA-03)
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
lang: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: "0.10.0"`;

const CONFIG_YML_REPO_OLDER = `title: My Site
lang: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: "0.8.0"`;

const CONFIG_YML_NO_TELAR_VERSION = `title: My Site
lang: en
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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb, null);

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
