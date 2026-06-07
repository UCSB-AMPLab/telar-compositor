/**
 * This file tests the /start loader (app/routes/_app.start.tsx) — the
 * Atelier front door's active-project resolution + per-step workflow-map
 * COUNT derivation.
 *
 * Covered behaviour:
 *   - Per-step COUNT derivation runs as independent count(*) queries via
 *     Promise.all: objects total + a single NOT EXISTS "unused" subquery,
 *     story total + story drafts (draft=true), terms, pages — never a
 *     5-term compound SELECT (D1 cap).
 *   - The Publish "N to ship" count is NOT recomputed here (the loader does
 *     not run the five-type unpublished spectrum); it is consumed from the
 *     _app shell loader's unpublishedCount by the page.
 *   - A zero-project user redirects to /onboarding (never /objects or
 *     /dashboard — no redirect loop).
 *   - The populated/empty state flag (empty = no objects, stories, pages).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must precede the loader import)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  resolveActiveProjectMock: vi.fn(),
  getRecentActivityMock: vi.fn(),
  getUserProjectsWithStatsMock: vi.fn(),
  scanRepoOrphanStoryIdsMock: vi.fn(),
  decryptMock: vi.fn(),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: mocks.resolveActiveProjectMock,
  getUserProjectsWithStats: mocks.getUserProjectsWithStatsMock,
}));

vi.mock("~/lib/activity.server", () => ({
  getRecentActivity: mocks.getRecentActivityMock,
}));

vi.mock("~/lib/import.server", () => ({
  scanRepoOrphanStoryIds: mocks.scanRepoOrphanStoryIdsMock,
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: mocks.decryptMock,
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
  })),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

// A spy-able query recorder. Each db.select(...) call records the chain so a
// test can assert how many independent count(*) queries ran and what their
// WHERE clauses contained (NOT EXISTS / draft filter). The result returned
// for each query is taken in order from `queryResults`.
const dbState = vi.hoisted(() => ({
  selectCalls: [] as Array<{ projection: unknown; sqlText: string }>,
  // Ordered results consumed by each terminal `.where()`/`.limit()` resolution.
  queue: [] as Array<unknown>,
}));

// Cycle-safe recursive collector: walks a Drizzle condition/sql object and
// concatenates every string value + column `name` it finds (raw SQL fragments
// live as `.value` strings on chunks; column refs carry a `.name`). Defined at
// hoist scope (vi.mock factories are hoisted above imports).
function collectSqlText(node: unknown, seen = new Set<unknown>(), depth = 0): string {
  if (node == null || depth > 8) return "";
  if (typeof node === "string") return node + " ";
  if (typeof node !== "object") return "";
  if (seen.has(node)) return "";
  seen.add(node);
  let out = "";
  const obj = node as Record<string, unknown>;
  if (typeof obj.value === "string") out += obj.value + " ";
  if (typeof obj.name === "string") out += obj.name + " ";
  for (const key of Object.keys(obj)) {
    if (key === "table" || key === "decoder" || key === "encoder") continue;
    out += collectSqlText(obj[key], seen, depth + 1);
  }
  return out;
}

vi.mock("~/lib/db.server", () => {
  // Build a chainable, thenable query builder that records the SQL text of its
  // where() clause and resolves to the next queued result.
  function makeBuilder(projection: unknown) {
    let recorded = { projection, sqlText: "" };
    const builder: Record<string, unknown> = {};
    const resolveNext = () =>
      dbState.queue.length > 0 ? dbState.queue.shift() : [];
    builder.from = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn((clause: unknown) => {
      // Drizzle condition/sql objects are class instances with a `queryChunks`
      // array holding the raw SQL string fragments + column refs. Walk it
      // (cycle-safe) collecting every string value + column name so tests can
      // grep for "NOT EXISTS" or the "draft" column filter.
      recorded.sqlText = collectSqlText(clause);
      dbState.selectCalls.push(recorded);
      // Return a thenable that also exposes .limit() for the config query.
      const result = resolveNext();
      const thenable = {
        limit: vi.fn(() => Promise.resolve(result)),
        then: (onF: (v: unknown) => unknown) => Promise.resolve(result).then(onF),
      };
      return thenable;
    });
    builder.limit = vi.fn(() => Promise.resolve(resolveNext()));
    return builder;
  }

  return {
    getDb: vi.fn(() => ({
      select: vi.fn((projection: unknown) => makeBuilder(projection)),
    })),
  };
});

import { loader } from "../app/routes/_app.start";
import { userContext as userContextStub } from "~/middleware/auth.server";

function makeContext(opts: { userId: number | null }) {
  const env = {
    DB: {} as unknown,
    SESSION_SECRET: "test-secret",
    ENCRYPTION_KEY: "test-key",
  };
  return {
    get: (key: unknown) => {
      if (key !== userContextStub) return undefined;
      if (opts.userId === null) return null;
      return {
        id: opts.userId,
        github_id: 1,
        github_login: "tester",
        github_name: "Tester",
        github_email: null,
        encrypted_access_token: "encrypted",
        created_at: null,
      };
    },
    cloudflare: { env },
  };
}

function makeRequest(): Request {
  return new Request("https://example.workers.dev/start", { method: "GET" });
}

type LoaderData = {
  project: { id: number; github_repo_full_name: string };
  userRole: "convenor" | "collaborator";
  counts: {
    configured: boolean;
    objects: number;
    objectsUnused: number;
    stories: number;
    storyDrafts: number;
    terms: number;
    pages: number;
  };
  convenorName: string;
  collaboratorCount: number;
  state: "populated" | "empty";
};

const callLoader = (ctx: unknown) =>
  (loader as unknown as (a: unknown) => Promise<LoaderData>)({
    request: makeRequest(),
    context: ctx,
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectCalls = [];
  dbState.queue = [];
  // Safe defaults for the new reads — individual tests override as needed.
  mocks.getRecentActivityMock.mockResolvedValue([]);
  mocks.getUserProjectsWithStatsMock.mockResolvedValue([]);
  mocks.scanRepoOrphanStoryIdsMock.mockResolvedValue([]);
  mocks.decryptMock.mockResolvedValue("decrypted-token");
});

/**
 * Queue the seven loader queries' results in loader order:
 *   1 objects count, 2 objects-unused, 3 stories count, 4 story drafts,
 *   5 terms, 6 pages, 7 project_config row, 8 member rows.
 */
function queueCounts(opts: {
  objects: number;
  objectsUnused: number;
  stories: number;
  storyDrafts: number;
  terms: number;
  pages: number;
  config?: { title: string | null; theme: string | null; google_sheets_enabled?: boolean } | null;
  members?: Array<{ role: string; githubName: string | null; githubLogin: string }>;
}) {
  dbState.queue.push([{ n: opts.objects }]);
  dbState.queue.push([{ n: opts.objectsUnused }]);
  dbState.queue.push([{ n: opts.stories }]);
  dbState.queue.push([{ n: opts.storyDrafts }]);
  dbState.queue.push([{ n: opts.terms }]);
  dbState.queue.push([{ n: opts.pages }]);
  dbState.queue.push(opts.config ? [opts.config] : []);
  dbState.queue.push(
    opts.members ?? [
      { role: "convenor", githubName: "Alice", githubLogin: "alice" },
    ],
  );
}

describe("/start loader — per-step counts + state", () => {
  it("derives objects 'N · U unused' via a single NOT EXISTS subquery", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 10, objectsUnused: 3, stories: 2, storyDrafts: 1, terms: 4, pages: 5, config: { title: "Site", theme: "default" } });

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.counts.objects).toBe(10);
    expect(data.counts.objectsUnused).toBe(3);
    // Exactly one of the recorded queries carries a NOT EXISTS subquery.
    const notExistsQueries = dbState.selectCalls.filter((c) =>
      c.sqlText.includes("NOT EXISTS"),
    );
    expect(notExistsQueries).toHaveLength(1);
  });

  it("does NOT recompute the Publish 'N to ship' five-type spectrum in this loader", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 1, objectsUnused: 0, stories: 1, storyDrafts: 0, terms: 0, pages: 1, config: { title: "Site", theme: "default" } });

    const data = await callLoader(makeContext({ userId: 7 }));

    // The loader does not expose a recomputed unpublishedCount — the page reads
    // it from the _app shell. No `gt(updated_at, last_published_at)` query runs:
    // none of the recorded WHERE clauses reference last_published_at.
    const publishSpectrumQueries = dbState.selectCalls.filter((c) =>
      c.sqlText.includes("last_published_at"),
    );
    expect(publishSpectrumQueries).toHaveLength(0);
    expect((data as unknown as { unpublishedCount?: number }).unpublishedCount).toBeUndefined();
  });

  it("returns story drafts, term and page counts as independent count(*) queries", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 8, objectsUnused: 2, stories: 6, storyDrafts: 2, terms: 9, pages: 3, config: { title: "Site", theme: "default" } });

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.counts.stories).toBe(6);
    expect(data.counts.storyDrafts).toBe(2);
    expect(data.counts.terms).toBe(9);
    expect(data.counts.pages).toBe(3);
    // The story-drafts query carries the draft=true filter (a second, separate
    // count(*) from the stories total).
    const draftQueries = dbState.selectCalls.filter((c) =>
      c.sqlText.includes("draft"),
    );
    expect(draftQueries.length).toBeGreaterThanOrEqual(1);
  });

  it("flags state='empty' when objects, stories and pages are all zero", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 0, objectsUnused: 0, stories: 0, storyDrafts: 0, terms: 0, pages: 0, config: null });

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.state).toBe("empty");
    expect(data.counts.configured).toBe(false);
  });

  it("flags state='populated' and configured=true when content + config exist", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 5, objectsUnused: 1, stories: 3, storyDrafts: 0, terms: 2, pages: 1, config: { title: "My Site", theme: "default" } });

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.state).toBe("populated");
    expect(data.counts.configured).toBe(true);
  });

  it("derives convenorName + collaboratorCount from member rows", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "collaborator",
    });
    queueCounts({
      objects: 5,
      objectsUnused: 1,
      stories: 3,
      storyDrafts: 0,
      terms: 2,
      pages: 1,
      config: { title: "My Site", theme: "default" },
      members: [
        { role: "convenor", githubName: "Alice", githubLogin: "alice" },
        { role: "collaborator", githubName: "Bob", githubLogin: "bob" },
        { role: "collaborator", githubName: "Cara", githubLogin: "cara" },
      ],
    });

    const data = await callLoader(makeContext({ userId: 7 }));

    expect(data.convenorName).toBe("Alice");
    expect(data.collaboratorCount).toBe(2);
    expect(data.userRole).toBe("collaborator");
  });

  it("redirects a zero-project user to /onboarding (no /dashboard or /objects loop)", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue(null);

    let res: Response | null = null;
    try {
      const out = await (loader as unknown as (a: unknown) => unknown)({
        request: makeRequest(),
        context: makeContext({ userId: 7 }),
      });
      if (out instanceof Response) res = out;
    } catch (thrown) {
      if (thrown instanceof Response) res = thrown;
      else throw thrown;
    }
    expect(res).not.toBeNull();
    expect(res!.headers.get("Location")).toBe("/onboarding");
  });
});

// ---------------------------------------------------------------------------
// Activity, orphan-scan gating, other projects
// ---------------------------------------------------------------------------

type Plan04LoaderData = LoaderData & {
  activity: unknown[];
  orphanStoryIds: string[];
  otherProjects: unknown[];
};

const callPlan04Loader = (ctx: unknown) =>
  (loader as unknown as (a: unknown) => Promise<Plan04LoaderData>)({
    request: makeRequest(),
    context: ctx,
  });

describe("/start loader — activity + orphan gating + other projects", () => {
  it("calls getRecentActivity project-scoped with limit 5 and returns its rows", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 42, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 5, objectsUnused: 1, stories: 3, storyDrafts: 0, terms: 2, pages: 1, config: { title: "Site", theme: "default" } });
    const activityRows = [
      { id: 1, verb: "edited", entity_type: "story", entity_id: "s1", entity_label: "A story", created_at: "2024-06-02T00:00:00Z", actor_user_id: 7, actor_github_id: 1, actor_github_login: "alice", actor_github_name: "Alice" },
    ];
    mocks.getRecentActivityMock.mockResolvedValue(activityRows);

    const data = await callPlan04Loader(makeContext({ userId: 7 }));

    expect(mocks.getRecentActivityMock).toHaveBeenCalledTimes(1);
    const [, projectIdArg, limitArg] = mocks.getRecentActivityMock.mock.calls[0];
    expect(projectIdArg).toBe(42);
    expect(limitArg).toBe(5);
    expect(data.activity).toEqual(activityRows);
  });

  it("returns getUserProjectsWithStats output as otherProjects (user-scoped)", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 5, objectsUnused: 1, stories: 3, storyDrafts: 0, terms: 2, pages: 1, config: { title: "Site", theme: "default" } });
    const projectsList = [
      { id: 1, github_repo_full_name: "alice/site", last_published_at: null, head_sha: "a", published_sha: "a", last_edited_at: "2024-06-02T00:00:00Z" },
      { id: 2, github_repo_full_name: "alice/other", last_published_at: "2024-05-01T00:00:00Z", head_sha: "b", published_sha: "c", last_edited_at: "2024-06-01T00:00:00Z" },
    ];
    mocks.getUserProjectsWithStatsMock.mockResolvedValue(projectsList);

    const data = await callPlan04Loader(makeContext({ userId: 7 }));

    expect(mocks.getUserProjectsWithStatsMock).toHaveBeenCalledTimes(1);
    const [, userIdArg] = mocks.getUserProjectsWithStatsMock.mock.calls[0];
    expect(userIdArg).toBe(7);
    expect(data.otherProjects).toEqual(projectsList);
  });

  it("scans for orphans only for a convenor on a populated, non-Sheets project", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 5, objectsUnused: 1, stories: 3, storyDrafts: 0, terms: 2, pages: 1, config: { title: "Site", theme: "default", google_sheets_enabled: false } });
    // The orphan block runs one db.select({ story_id }) before scanRepoOrphanStoryIds —
    // queue a story_id rowset for it.
    dbState.queue.push([{ story_id: "s1" }, { story_id: "s2" }]);
    mocks.scanRepoOrphanStoryIdsMock.mockResolvedValue(["orphan-a", "orphan-b"]);

    const data = await callPlan04Loader(makeContext({ userId: 7 }));

    expect(mocks.scanRepoOrphanStoryIdsMock).toHaveBeenCalledTimes(1);
    expect(data.orphanStoryIds).toEqual(["orphan-a", "orphan-b"]);
  });

  it("does NOT scan for orphans for a collaborator (orphanStoryIds stays [])", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "collaborator",
    });
    queueCounts({ objects: 5, objectsUnused: 1, stories: 3, storyDrafts: 0, terms: 2, pages: 1, config: { title: "Site", theme: "default", google_sheets_enabled: false } });

    const data = await callPlan04Loader(makeContext({ userId: 7 }));

    expect(mocks.scanRepoOrphanStoryIdsMock).not.toHaveBeenCalled();
    expect(data.orphanStoryIds).toEqual([]);
  });

  it("does NOT scan for orphans in the empty state (orphanStoryIds stays [])", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 0, objectsUnused: 0, stories: 0, storyDrafts: 0, terms: 0, pages: 0, config: null });

    const data = await callPlan04Loader(makeContext({ userId: 7 }));

    expect(mocks.scanRepoOrphanStoryIdsMock).not.toHaveBeenCalled();
    expect(data.orphanStoryIds).toEqual([]);
  });

  it("does NOT scan for orphans on a Sheets-backed project (orphanStoryIds stays [])", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 5, objectsUnused: 1, stories: 3, storyDrafts: 0, terms: 2, pages: 1, config: { title: "Site", theme: "default", google_sheets_enabled: true } });

    const data = await callPlan04Loader(makeContext({ userId: 7 }));

    expect(mocks.scanRepoOrphanStoryIdsMock).not.toHaveBeenCalled();
    expect(data.orphanStoryIds).toEqual([]);
  });

  it("fails open to [] when the orphan scan throws", async () => {
    mocks.resolveActiveProjectMock.mockResolvedValue({
      project: { id: 1, github_repo_full_name: "alice/site", created_at: "2024-06-01T00:00:00Z" },
      userRole: "convenor",
    });
    queueCounts({ objects: 5, objectsUnused: 1, stories: 3, storyDrafts: 0, terms: 2, pages: 1, config: { title: "Site", theme: "default", google_sheets_enabled: false } });
    dbState.queue.push([{ story_id: "s1" }]);
    mocks.scanRepoOrphanStoryIdsMock.mockRejectedValue(new Error("GitHub unreachable"));

    const data = await callPlan04Loader(makeContext({ userId: 7 }));

    expect(data.orphanStoryIds).toEqual([]);
  });
});
