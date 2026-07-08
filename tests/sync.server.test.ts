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
import type { FullSyncDiff, FullSyncEnv, SyncIngestPayload } from "~/lib/sync.server";

// A fake DO binding for applyFullSyncChanges: captures the /ingest-sync payload
// (the content half of the sync, now routed through the Y.Doc) and returns 200.
function fakeIngestEnv(capture?: (p: SyncIngestPayload) => void): FullSyncEnv {
  return {
    SESSION_SECRET: "test-secret",
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          if (capture) capture(JSON.parse(await req.text()) as SyncIngestPayload);
          return new Response(JSON.stringify({ applied: {}, skipped: {} }), { status: 200 });
        },
      }),
    },
  };
}

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
    const mockDb = createSequentialMockDb(Array(20).fill([]));

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    const result = await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv());

    expect(result.newHeadSha).toBe("newsha123");
  });

  it("routes an inserted story to the DO ingest payload (not a direct D1 write)", async () => {
    let captured: SyncIngestPayload | null = null;
    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: ["new-story"] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    expect(captured).not.toBeNull();
    expect(captured!.stories.insert.map((s) => s.storyId)).toContain("new-story");
  });

  it("does not carry a rejected story into the ingest payload (keep D1)", async () => {
    let captured: SyncIngestPayload | null = null;
    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: ["my-story"], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    expect(captured!.stories.update).toHaveLength(0);
  });

  it("carries an accepted config title into the ingest payload", async () => {
    let captured: SyncIngestPayload | null = null;

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_CHANGED_TITLE;
      return null;
    });

    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: ["title"], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    const entry = captured!.config.find((c) => c.key === "title");
    expect(entry?.value).toBe("Updated Site Title");
  });

  it("coerces an accepted collection_mode to a real boolean, not the string \"false\"", async () => {
    // A repo-side `collection_mode: false` must reach the payload as boolean
    // false — the raw scalar "false" is truthy.
    let captured: SyncIngestPayload | null = null;

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_BASE + "\ncollection_mode: false";
      return null;
    });

    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: ["collection_mode"], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    const entry = captured!.config.find((c) => c.key === "collection_mode");
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(false);
  });

  it("writes repo related_terms into the D1 update when a glossary change is accepted", async () => {
    // related_terms is a D1-only column (never in the Y.Doc) — it stays a direct
    // D1 write in the residue, even as title/definition route through the DO.
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

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv());

    const relatedUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && (u.set as Record<string, unknown>).related_terms === "mita|repartimiento"
    );
    expect(relatedUpdates.length).toBeGreaterThan(0);
  });

  it("inserts a new glossary term via the DO and writes its related_terms to D1", async () => {
    let captured: SyncIngestPayload | null = null;
    const updates: Array<{ table: unknown; set: unknown }> = [];

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
      onUpdate: (table, set) => {
        updates.push({ table, set });
      },
    });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: ["mita"] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    // The term itself is inserted through the DO ingest…
    expect(captured!.glossary.insert.map((t) => t.termId)).toContain("mita");
    // …and its D1-only related_terms lands as a direct write (residue part 2).
    const relatedUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && (u.set as Record<string, unknown>).related_terms === "enc|repartimiento"
    );
    expect(relatedUpdates.length).toBeGreaterThan(0);
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

  // The heal decision is now computed SERVER-SIDE inside the apply, from the
  // repo _config.yml vs the D1 project_config row — no caller-passed diff (the
  // L3 fix). D1's telar_version is supplied via the project_config select
  // (response index 1: objects select is 0, project_config select is 1).
  function versionDb(d1Version: string | null) {
    const updates: Array<{ table: unknown; set: unknown }> = [];
    const mockDb = createTrackedMockDb({
      responses: [[], [{ id: 1, project_id: projectId, telar_version: d1Version }], ...Array(18).fill([])],
      onUpdate: (table, set) => updates.push({ table, set }),
    });
    return { mockDb, updates };
  }

  function configWithVersion(v: string | null): string {
    const base = `title: My Site\ntelar_language: en\nbaseurl: /my-repo\nurl: https://mysite.github.io`;
    return v === null ? base : `${base}\ntelar:\n  version: ${v}`;
  }

  function mockConfig(v: string | null) {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return configWithVersion(v);
      return null;
    });
  }

  it("heals D1 telar_version when the repo is ahead (no optional parameter)", async () => {
    mockConfig("0.10.0");
    const { mockDb, updates } = versionDb("0.9.0");

    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb, fakeIngestEnv());

    const versionUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && (u.set as Record<string, unknown>).telar_version === "0.10.0",
    );
    expect(versionUpdates.length).toBeGreaterThan(0);
  });

  it("does NOT heal D1 telar_version when the repo is behind", async () => {
    mockConfig("0.8.0");
    const { mockDb, updates } = versionDb("0.9.0");

    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb, fakeIngestEnv());

    const wrongUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && "telar_version" in (u.set as Record<string, unknown>),
    );
    expect(wrongUpdates).toHaveLength(0);
  });

  it("does NOT heal D1 telar_version when the versions are equal", async () => {
    mockConfig("0.9.0");
    const { mockDb, updates } = versionDb("0.9.0");

    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb, fakeIngestEnv());

    const wrongUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && "telar_version" in (u.set as Record<string, unknown>),
    );
    expect(wrongUpdates).toHaveLength(0);
  });

  it("does NOT heal D1 telar_version when the repo config carries no version", async () => {
    mockConfig(null);
    const { mockDb, updates } = versionDb("0.9.0");

    await applyFullSyncChanges(projectId, baseChanges(), token, owner, repo, mockDb, fakeIngestEnv());

    const wrongUpdates = updates.filter(
      (u) => u.set !== null && typeof u.set === "object" && "telar_version" in (u.set as Record<string, unknown>),
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
      classification: "two-way",
      suppressedEditorOnly: 0,
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
    diff.config.changedFields.push({ key: "title", d1Value: "A", repoValue: "B", conflict: false });
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

// `image_available` must NEVER appear in SYNC_FIELDS: it is probe-derived
// compositor-internal state that is never published to objects.csv, so letting
// a GitHub round-trip write it back would wipe the live-image flag. `source_url`
// and `thumbnail` are DIFFERENT — they ARE published metadata columns and belong
// in SYNC_FIELDS so repo edits reconcile; the changed-field rule's repo-empty
// guard is what prevents an empty repo cell from clobbering an IIIF-enriched D1
// value (see the "does NOT flag ... when repo is empty" tests below).
describe("SYNC_FIELDS — internal-field guard", () => {
  it("does NOT include the probe-derived internal field image_available", () => {
    expect(SYNC_FIELDS as readonly string[]).not.toContain("image_available");
  });

  it.each(["source_url", "thumbnail", "alt_text", "extra_columns"] as const)(
    "DOES include the published round-trip field %j so repo edits reconcile",
    (field) => {
      expect(SYNC_FIELDS as readonly string[]).toContain(field);
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

// ---------------------------------------------------------------------------
// stories.show_sections reconciliation
//
// show_sections round-trips through project.csv (show_sections /
// mostrar_secciones) and the story hash, so a repo-side toggle must surface in
// the story diff and apply, or it would be silently reverted on next publish.
// ---------------------------------------------------------------------------

describe("computeFullSyncDiff — show_sections", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  const PROJECT_CSV_SHOW_SECTIONS_ON = `order,story_id,title,subtitle,byline,private,show_sections
1,my-story,My Story,A subtitle,An author,false,yes`;

  const PROJECT_CSV_SHOW_SECTIONS_OFF = `order,story_id,title,subtitle,byline,private,show_sections
1,my-story,My Story,A subtitle,An author,false,`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  function d1Story(showSections: boolean): MockStory & { show_sections: boolean } {
    return {
      id: 1, project_id: projectId, story_id: "my-story", title: "My Story",
      subtitle: "A subtitle", byline: "An author", order: 1, private: false,
      draft: false, updated_at: null, show_sections: showSections,
    };
  }

  it("flags showSections when repo turns it on and D1 has it off", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_SHOW_SECTIONS_ON;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });

    const d1Stories = [d1Story(false)];
    const mockDb = createSequentialMockDb([[], [], d1Stories, d1Stories, []]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    const changed = result.stories.changedStories.find((s) => s.story_id === "my-story");
    expect(changed).toBeDefined();
    expect(changed!.changedFields).toContain("showSections");
  });

  it("does NOT flag showSections when repo and D1 agree", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_SHOW_SECTIONS_OFF;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });

    const d1Stories = [d1Story(false)];
    const mockDb = createSequentialMockDb([[], [], d1Stories, d1Stories, []]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);

    const changed = result.stories.changedStories.find((s) => s.story_id === "my-story");
    expect(changed?.changedFields ?? []).not.toContain("showSections");
  });
});

describe("applyFullSyncChanges — show_sections", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  const PROJECT_CSV_ACCEPT = `order,story_id,title,subtitle,byline,private,show_sections
1,my-story,My Story,A subtitle,An author,false,yes
2,new-story,New Story,,Another author,false,yes`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ACCEPT;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      return null;
    });
  });

  it("carries showSections into the ingest payload when a story change is accepted", async () => {
    let captured: SyncIngestPayload | null = null;
    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: ["my-story"], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    const upd = captured!.stories.update.find((s) => s.storyId === "my-story");
    expect(upd?.showSections).toBe(true);
  });

  it("carries showSections into the ingest payload when inserting a new story", async () => {
    let captured: SyncIngestPayload | null = null;
    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: ["new-story"] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    const ins = captured!.stories.insert.find((s) => s.storyId === "new-story");
    expect(ins?.showSections).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Object alt_text / source_url / thumbnail / extra_columns
//
// All four are published objects.csv columns and part of the object entity
// hash, so a repo-side edit must reconcile in sync. extra_columns is compared
// semantically (parsed, keys-sorted), never by raw-JSON string order.
// ---------------------------------------------------------------------------

describe("computeSyncDiff — published object round-trip fields", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  // Multi-column CSV so parseTelarCsv keeps the data row. `extras` is an
  // optional trailing custom column captured into extra_columns.
  function roundTripObjectsCsv(overrides: {
    source_url?: string; thumbnail?: string; alt_text?: string; extras?: string;
  } = {}): string {
    const { source_url = "https://d1.example/manifest", thumbnail = "thumb.jpg", alt_text = "Same alt", extras } = overrides;
    if (extras !== undefined) {
      return [
        "object_id,title,creator,description,object_type,source_url,thumbnail,alt_text,accession_number",
        `obj-1,Woven Cloth,Jane Weaver,A textile,Textile,${source_url},${thumbnail},${alt_text},${extras}`,
      ].join("\n");
    }
    return [
      "object_id,title,creator,description,object_type,source_url,thumbnail,alt_text",
      `obj-1,Woven Cloth,Jane Weaver,A textile,Textile,${source_url},${thumbnail},${alt_text}`,
    ].join("\n");
  }

  function roundTripD1Object(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 1, project_id: projectId, object_id: "obj-1", title: "Woven Cloth",
      origin: "repo", featured: false, missing_from_repo: false,
      creator: "Jane Weaver", description: "A textile",
      source_url: "https://d1.example/manifest", period: null, year: null,
      object_type: "Textile", subjects: null, source: null, credit: null,
      thumbnail: "thumb.jpg", alt_text: "Same alt", dimensions: null,
      extra_columns: null, image_available: true, updated_at: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("flags alt_text when repo differs from D1", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(roundTripObjectsCsv({ alt_text: "Repo alt text" }));
    const mockDb = createSequentialMockDb([[roundTripD1Object({ alt_text: "D1 alt text" })], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields).toContain("alt_text");
    expect(changed?.repoValues.alt_text).toBe("Repo alt text");
    expect(changed?.d1Values.alt_text).toBe("D1 alt text");
  });

  it("flags source_url when repo differs from D1", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(roundTripObjectsCsv({ source_url: "https://repo.example/new" }));
    const mockDb = createSequentialMockDb([[roundTripD1Object({ source_url: "https://d1.example/manifest" })], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields).toContain("source_url");
    expect(changed?.repoValues.source_url).toBe("https://repo.example/new");
  });

  it("flags thumbnail when repo differs from D1", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(roundTripObjectsCsv({ thumbnail: "repo-thumb.jpg" }));
    const mockDb = createSequentialMockDb([[roundTripD1Object({ thumbnail: "d1-thumb.jpg" })], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields).toContain("thumbnail");
    expect(changed?.repoValues.thumbnail).toBe("repo-thumb.jpg");
  });

  it("does NOT flag source_url when repo cell is empty but D1 has a value (IIIF-wipe guard)", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(roundTripObjectsCsv({ source_url: "" }));
    const mockDb = createSequentialMockDb([[roundTripD1Object({ source_url: "https://d1.example/manifest" })], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("source_url");
  });

  it("does NOT flag alt_text from the import title-fallback when the repo cell is blank", async () => {
    // mapObjectsCsv fills a blank alt_text cell with the object's title — an
    // import-time accessibility fallback, not repo state. The diff compares the
    // RAW cell, so a blank repo cell against a blank D1 alt_text is no change;
    // flagging it would claim the repo holds the title when it holds nothing.
    vi.mocked(githubServer.getFileContent).mockResolvedValue(roundTripObjectsCsv({ alt_text: "" }));
    const mockDb = createSequentialMockDb([[roundTripD1Object({ alt_text: null })], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("alt_text");
  });

  it("still flags a genuine repo-side alt_text edit", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(roundTripObjectsCsv({ alt_text: "A handwoven textile in red" }));
    const mockDb = createSequentialMockDb([[roundTripD1Object({ alt_text: "Same alt" })], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields).toContain("alt_text");
    expect(changed?.repoValues.alt_text).toBe("A handwoven textile in red");
  });

  it("does NOT flag any round-trip field when repo and D1 match", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(roundTripObjectsCsv());
    const mockDb = createSequentialMockDb([[roundTripD1Object()], [], []]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    for (const f of ["alt_text", "source_url", "thumbnail", "extra_columns"]) {
      expect(changed?.changedFields ?? []).not.toContain(f);
    }
  });

  it("does NOT flag extra_columns when repo JSON keys are reordered but content is equal", async () => {
    // Repo custom column produces {"accession_number":"ACC-1"}; D1 stores the
    // same data. Add a second custom column so we can prove key-order
    // independence: CSV column order (a, then b) vs D1 stored order (b, then a).
    const csv = [
      "object_id,title,creator,description,object_type,source_url,thumbnail,alt_text,alpha,beta",
      "obj-1,Woven Cloth,Jane Weaver,A textile,Textile,https://d1.example/manifest,thumb.jpg,Same alt,x,y",
    ].join("\n");
    vi.mocked(githubServer.getFileContent).mockResolvedValue(csv);
    // D1 stores the same two keys in the OPPOSITE order.
    const mockDb = createSequentialMockDb([
      [roundTripD1Object({ extra_columns: JSON.stringify({ beta: "y", alpha: "x" }) })], [], [],
    ]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("extra_columns");
  });

  it("flags extra_columns when the custom-column content genuinely differs", async () => {
    const csv = [
      "object_id,title,creator,description,object_type,source_url,thumbnail,alt_text,accession_number",
      "obj-1,Woven Cloth,Jane Weaver,A textile,Textile,https://d1.example/manifest,thumb.jpg,Same alt,ACC-NEW",
    ].join("\n");
    vi.mocked(githubServer.getFileContent).mockResolvedValue(csv);
    const mockDb = createSequentialMockDb([
      [roundTripD1Object({ extra_columns: JSON.stringify({ accession_number: "ACC-OLD" }) })], [], [],
    ]);

    const result = await computeSyncDiff(projectId, token, owner, repo, mockDb);
    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields).toContain("extra_columns");
  });

  it("apply writes accepted alt_text/source_url/thumbnail/extra_columns into the D1 payload", async () => {
    const csv = [
      "object_id,title,creator,description,object_type,source_url,thumbnail,alt_text,accession_number",
      "obj-1,Woven Cloth,Jane Weaver,A textile,Textile,https://repo/new,repo-thumb.jpg,Repo alt,ACC-NEW",
    ].join("\n");
    vi.mocked(githubServer.getFileContent).mockResolvedValue(csv);

    let captured: Record<string, unknown> | null = null;
    const mockDb = createTrackedMockDb({
      responses: [[roundTripD1Object({ alt_text: "D1 alt", source_url: "https://d1/old", thumbnail: "d1-thumb.jpg", extra_columns: JSON.stringify({ accession_number: "ACC-OLD" }) })]],
      onUpdate: (_table, set) => { captured = set as Record<string, unknown>; },
    });

    await applySyncChanges(
      projectId,
      {
        newObjectIds: [],
        changedObjectIds: ["obj-1"],
        fieldChoices: { "obj-1": { alt_text: "repo", source_url: "repo", thumbnail: "repo", extra_columns: "repo" } },
        removedObjectIds: [],
        unregisteredObjectIds: [],
      },
      token, owner, repo, mockDb,
    );

    expect(captured).not.toBeNull();
    expect(captured!.alt_text).toBe("Repo alt");
    expect(captured!.source_url).toBe("https://repo/new");
    expect(captured!.thumbnail).toBe("repo-thumb.jpg");
    expect(JSON.parse(captured!.extra_columns as string)).toEqual({ accession_number: "ACC-NEW" });
  });
});

// ---------------------------------------------------------------------------
// Glossary title reconciliation
// ---------------------------------------------------------------------------

describe("computeGlossarySyncDiff — title changes", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => vi.clearAllMocks());

  it("detects a title-only change (definition and related_terms identical)", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") {
        return `term_id,title,definition,related_terms\nenc,"Encomienda (revised)","A labor system",`;
      }
      return null;
    });

    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system", related_terms: "", updated_at: null },
    ];
    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].term_id).toBe("enc");
    expect(result.changed[0].d1Title).toBe("Encomienda");
    expect(result.changed[0].repoTitle).toBe("Encomienda (revised)");
  });

  it("does NOT flag a term whose title, definition, and related_terms all match", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") {
        return `term_id,title,definition,related_terms\nenc,"Encomienda","A labor system",`;
      }
      return null;
    });
    const d1Terms = [
      { id: 1, project_id: projectId, term_id: "enc", title: "Encomienda", definition: "A labor system", related_terms: "", updated_at: null },
    ];
    const mockDb = createSequentialMockDb([d1Terms]);

    const result = await computeGlossarySyncDiff(projectId, token, owner, repo, mockDb);
    expect(result.changed).toHaveLength(0);
  });
});

describe("applyFullSyncChanges — glossary title", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
  });

  it("carries the repo title into the ingest payload when a glossary change is accepted", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      if (path === "telar-content/spreadsheets/glossary.csv") {
        return `term_id,title,definition,related_terms\nenc,"Encomienda (revised)","A labor system",`;
      }
      return null;
    });

    let captured: SyncIngestPayload | null = null;
    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: ["enc"], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    const upd = captured!.glossary.update.find((t) => t.termId === "enc");
    expect(upd?.title).toBe("Encomienda (revised)");
  });
});

// ---------------------------------------------------------------------------
// telar_theme (project_config.theme) reconciliation
// ---------------------------------------------------------------------------

describe("computeFullSyncDiff — telar_theme", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  const CONFIG_WITH_THEME = (theme: string) => `title: My Site
telar_language: en
telar_theme: "${theme}"
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
telar:
  version: 0.9.0`;

  it("detects a repo-side telar_theme change (key surfaces as 'theme')", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_WITH_THEME("dark");
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", theme: "light" },
    ];
    const mockDb = createSequentialMockDb([[], [], d1Stories, d1Stories, d1Config]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);
    const themeChange = result.config.changedFields.find((f) => f.key === "theme");
    expect(themeChange).toBeDefined();
    expect(themeChange!.repoValue).toBe("dark");
    expect(themeChange!.d1Value).toBe("light");
  });

  it("does NOT flag theme when repo and D1 agree", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_WITH_THEME("light");
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", theme: "light" },
    ];
    const mockDb = createSequentialMockDb([[], [], d1Stories, d1Stories, d1Config]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);
    expect(result.config.changedFields.find((f) => f.key === "theme")).toBeUndefined();
  });
});

describe("applyFullSyncChanges — telar_theme", () => {
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
      if (path === "_config.yml") return `title: My Site\ntelar_theme: "dark"\n`;
      return null;
    });
  });

  it("carries the accepted theme into the ingest payload", async () => {
    let captured: SyncIngestPayload | null = null;
    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: ["theme"], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    const entry = captured!.config.find((c) => c.key === "theme");
    expect(entry?.value).toBe("dark");
  });
});

// ---------------------------------------------------------------------------
// story_key location asymmetry (protected.key vs top-level)
//
// Publish writes the key under `protected:` → `  key:` (top-level story_key
// only as a fallback). The sync reader must read protected.key first and let it
// win, so a config whose only copy is nested round-trips with no phantom diff.
// ---------------------------------------------------------------------------

describe("extractConfigFields — story_key nested-block reader", () => {
  it("reads a nested protected.key (the normal publish shape)", () => {
    const yaml = `title: My Site\nprotected:\n  key: abc123\ntelar:\n  version: 0.9.0`;
    expect(extractConfigFields(yaml).story_key).toBe("abc123");
  });

  it("parses a quoted nested value exactly (inverse of yamlQuote)", () => {
    const yaml = `title: My Site\nprotected:\n  key: "abc 123"\n`;
    expect(extractConfigFields(yaml).story_key).toBe("abc 123");
  });

  it("lets protected.key win when a top-level story_key also exists", () => {
    const yaml = `story_key: top-level\ntitle: My Site\nprotected:\n  key: nested-wins\n`;
    expect(extractConfigFields(yaml).story_key).toBe("nested-wins");
  });

  it("falls back to a top-level story_key when no protected block exists", () => {
    const yaml = `title: My Site\nstory_key: only-top-level\n`;
    expect(extractConfigFields(yaml).story_key).toBe("only-top-level");
  });

  it("returns null when neither location has a key", () => {
    expect(extractConfigFields(`title: My Site\n`).story_key).toBeNull();
  });
});

describe("computeFullSyncDiff — story_key nested round-trip", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  const CONFIG_NESTED_KEY = `title: My Site
telar_language: en
description: A great site
author: Test User
email: test@example.com
baseurl: /my-repo
url: https://mysite.github.io
protected:
  key: "secret-key-123"
telar:
  version: 0.9.0`;

  it("produces NO story_key diff when the nested key equals the D1 value", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_NESTED_KEY;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", story_key: "secret-key-123" },
    ];
    const mockDb = createSequentialMockDb([[], [], d1Stories, d1Stories, d1Config]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);
    expect(result.config.changedFields.find((f) => f.key === "story_key")).toBeUndefined();
  });

  it("surfaces a story_key diff when the nested key differs from D1", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV_ONE_STORY;
      if (path === "_config.yml") return CONFIG_NESTED_KEY;
      return null;
    });

    const d1Stories: MockStory[] = [
      { id: 1, project_id: projectId, story_id: "my-story", title: "My Story", subtitle: "A subtitle", byline: "An author", order: 1, private: false, draft: false, updated_at: null },
    ];
    const d1Config = [
      { id: 1, project_id: projectId, title: "My Site", lang: "en", baseurl: "/my-repo", url: "https://mysite.github.io", description: "A great site", author: "Test User", email: "test@example.com", story_key: "old-key" },
    ];
    const mockDb = createSequentialMockDb([[], [], d1Stories, d1Stories, d1Config]);

    const result = await computeFullSyncDiff(projectId, token, owner, repo, mockDb);
    const change = result.config.changedFields.find((f) => f.key === "story_key");
    expect(change).toBeDefined();
    expect(change!.repoValue).toBe("secret-key-123");
    expect(change!.d1Value).toBe("old-key");
  });
});

// ---------------------------------------------------------------------------
// Layer file-reference resolution in the full-sync insertNew path
//
// A story synced in from the repo carries `layerN_content` cells that may be
// FILENAMES (compositor publish stores the filename; the body lives in
// telar-content/texts/stories/*.md). The insertNew path must resolve those to
// file contents before mapping, or the new story lands with literal filenames
// as its panel bodies. Inline cells pass through untouched; a missing file
// degrades to the literal cell.
// ---------------------------------------------------------------------------

describe("applyFullSyncChanges — insertNew layer file references", () => {
  const projectId = 1;
  const token = "test-token";
  const owner = "test-owner";
  const repo = "test-repo";

  const PROJECT_CSV = `order,story_id,title,subtitle,byline,private
1,my-story,My Story,,,false
2,new-story,New Story,,,false`;

  // Row 1: layer1_content is a .md filename (resolves), layer2_content is inline.
  // Row 2: layer1_content is a .md filename whose file is missing (degrades).
  const NEW_STORY_CSV = `step,object,x,y,zoom,layer1_button,layer1_content,layer2_button,layer2_content
1,obj-a,0.5,0.5,1.0,Panel,new-story-panel.md,More,Just inline text
2,obj-b,0.5,0.5,1.0,Miss,missing.md,,`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return PROJECT_CSV;
      if (path === "_config.yml") return CONFIG_YML_BASE;
      if (path === "telar-content/spreadsheets/new-story.csv") return NEW_STORY_CSV;
      if (path === "telar-content/texts/stories/new-story-panel.md") return "# Fetched panel body";
      if (path === "telar-content/texts/stories/missing.md") return null;
      return null;
    });
  });

  it("resolves .md filename cells to file contents, leaves inline untouched, degrades missing to literal", async () => {
    let captured: SyncIngestPayload | null = null;
    const mockDb = createTrackedMockDb({ responses: Array(20).fill([]) });

    const changes = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: ["new-story"] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: [] },
    };

    await applyFullSyncChanges(projectId, changes, token, owner, repo, mockDb, fakeIngestEnv((p) => { captured = p; }));

    // Layer bodies resolve inside resolveFullSyncPayload and ride the story
    // insert's layers[] (the DO then persists them via the snapshot).
    const ins = captured!.stories.insert.find((s) => s.storyId === "new-story");
    const layerContents = (ins?.layers ?? []).map((l) => String(l.content));

    expect(layerContents).toContain("# Fetched panel body"); // .md resolved
    expect(layerContents).toContain("Just inline text");     // inline untouched
    expect(layerContents).toContain("missing.md");           // missing degrades to literal
  });
});
