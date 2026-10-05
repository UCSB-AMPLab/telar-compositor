/**
 * A sheet the sync cannot read is refused, never read as a missing sheet.
 * The dashboard's check and apply and the objects page's check go
 * through their actions, so the refusal is checked as the page receives it:
 * `{ error: "sheet_unreadable", sheet }`, naming the file, with nothing
 * written. The sync and its parses run for real; GitHub, D1 and the
 * collaboration object are faked, and each read at GitHub answers from the
 * case's files by ref and path.
 *
 * A failed read of the base the check compares against refuses too, unless
 * the base commit does not exist, where the check is two-way.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileAtRef } from "~/lib/github.server";

const db = vi.hoisted(() => {
  const writes: string[] = [];
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "set", "values", "returning", "innerJoin", "leftJoin", "groupBy"]) {
      node[m] = () => chain();
    }
    return node;
  };
  const handle = {
    select: () => chain(),
    update: () => {
      writes.push("update");
      return chain();
    },
    insert: () => {
      writes.push("insert");
      return chain();
    },
    delete: () => {
      writes.push("delete");
      return chain();
    },
  };
  return { writes, handle };
});

/** The repository: file text by "<ref>:<path>", and the reads that fail. */
const repo = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  failing: new Set<string>(),
  commit: "exists" as "exists" | "missing" | "error",
}));

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => db.handle) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => {
  const at = async (_t: string, _o: string, _r: string, path: string, ref: string): Promise<FileAtRef> => {
    const key = `${ref}:${path}`;
    if (repo.failing.has(key)) return { status: "error" };
    const text = repo.files[key];
    return text === undefined ? { status: "absent" } : { status: "ok", content: text };
  };
  return {
    getRepoHead: vi.fn(async () => HEAD),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(at),
    getFileContent: vi.fn(async (t: string, o: string, r: string, path: string) => {
      const read = await at(t, o, r, path, HEAD);
      return read.status === "ok" ? read.content : null;
    }),
    commitExists: vi.fn(async () => repo.commit),
    // Unanswered: the story-file check does not conclude, which holds the head.
    getSubtreeOids: vi.fn(),
    listSubtreeEntries: vi.fn(),
    graphqlGitHub: vi.fn(),
    searchGitHubUsers: vi.fn(async () => []),
    githubHeaders: vi.fn(() => ({})),
  };
});
vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => []),
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1, github_repo_full_name: "owner/repo", head_sha: null, onboarding_completed: 1 },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/commit.server", () => ({ commitFilesToRepo: vi.fn(async () => undefined) }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => undefined) }));

import { action } from "~/routes/_app.dashboard";
import { action as objectsAction } from "~/routes/_app.objects";
import { resolveActiveProject } from "~/lib/membership.server";
import { commitExists, getFileAtRef } from "~/lib/github.server";
import { computeGlossarySyncDiff } from "~/lib/sync.server";
import { getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import { __clearStoryBlobCacheForTest } from "~/lib/story-files.server";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SHEETS = "telar-content/spreadsheets";

function buildRequest(url: string, fields: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    // The page showed project 1, the session's site in every case here.
    body: new URLSearchParams({ siteId: "1", ...fields }).toString(),
  });
}

function buildContext() {
  const doPaths: string[] = [];
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async (req: Request) => {
          doPaths.push(new URL(req.url).pathname);
          return new Response(JSON.stringify({ restored: 0, applied: {}, skipped: {} }), { status: 200 });
        }),
      })),
    },
  };
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
  return { context, doPaths };
}

async function check() {
  const { context } = buildContext();
  return action({
    request: buildRequest("https://compositor.telar.org/dashboard", { intent: "compute-full-sync-diff" }),
    context,
    params: {},
  } as never);
}

const NO_CHANGES = {
  objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
  stories: { accept: [], reject: [], insertNew: [] },
  config: { accept: [], reject: [] },
  glossary: { accept: [], reject: [], insertNew: [] },
  projectId: 1,
  baseSha: null,
  headSha: HEAD,
};

/** Every sheet the sync reads, at HEAD and at the base. */
function serveSite() {
  for (const ref of [HEAD, BASE]) {
    repo.files[`${ref}:${SHEETS}/objects.csv`] = "object_id,title\nobj-001,First\n";
    repo.files[`${ref}:${SHEETS}/project.csv`] = "order,story_id,title\n1,story-one,Story One\n";
    repo.files[`${ref}:${SHEETS}/glossary.csv`] = "term_id,title,definition\nenc,Encomienda,A grant\n";
    repo.files[`${ref}:_config.yml`] = "title: My Site\n";
  }
}

function withBase(base: string | null) {
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 1, github_repo_full_name: "owner/repo", head_sha: base, onboarding_completed: 1 },
    userRole: "convenor",
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.writes.length = 0;
  repo.files = {};
  repo.failing.clear();
  repo.commit = "exists";
  withBase(null);
  serveSite();
});

describe("the check refuses a sheet it cannot read at HEAD", () => {
  it.each([
    [`${SHEETS}/project.csv`, "project.csv"],
    [`${SHEETS}/glossary.csv`, "glossary.csv"],
    [`${SHEETS}/objects.csv`, "objects.csv"],
  ])("%s", async (path, sheet) => {
    repo.failing.add(`${HEAD}:${path}`);
    expect(await check()).toEqual({ ok: false, intent: "compute-full-sync-diff", error: "sheet_unreadable", sheet });
    expect(db.writes).toEqual([]);
  });

  it("_config.yml, named as a file", async () => {
    repo.failing.add(`${HEAD}:_config.yml`);
    expect(await check()).toEqual({
      ok: false,
      intent: "compute-full-sync-diff",
      error: "file_unreadable",
      file: "_config.yml",
    });
  });

  it("reads a missing sheet as no rows", async () => {
    delete repo.files[`${HEAD}:${SHEETS}/glossary.csv`];
    expect(await check()).toMatchObject({ ok: true, intent: "compute-full-sync-diff" });
  });

  it("the objects page's check refuses objects.csv the same way", async () => {
    repo.failing.add(`${HEAD}:${SHEETS}/objects.csv`);
    const { context } = buildContext();
    const result = await objectsAction({
      request: buildRequest("https://compositor.telar.org/objects", { intent: "compute-sync-diff" }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ ok: false, intent: "compute-sync-diff", error: "sheet_unreadable", sheet: "objects.csv" });
  });
});

describe("the new-story warning pass", () => {
  it("contributes nothing for a step sheet it cannot read, and the check answers", async () => {
    // story-one is new on GitHub (D1 holds no stories), so its step sheet is
    // read for warnings only.
    repo.failing.add(`${HEAD}:${SHEETS}/story-one.csv`);
    const result = (await check()) as { ok: boolean; diff?: { warnings?: unknown[]; stories: { newStories: unknown[] } } };
    expect(result.ok).toBe(true);
    expect(result.diff?.stories.newStories).toHaveLength(1);
    expect(result.diff?.warnings).toEqual([]);
  });
});

describe("the apply refuses a sheet it cannot read, and ingests nothing", () => {
  // The glossary is read only for an accepted term.
  const ACCEPTS_TERM = { ...NO_CHANGES, glossary: { accept: ["enc"], reject: [], insertNew: [], fieldChoices: { enc: { title: "repo" } } } };

  it.each([
    [`${SHEETS}/objects.csv`, { error: "sheet_unreadable", sheet: "objects.csv" }, NO_CHANGES],
    [`${SHEETS}/project.csv`, { error: "sheet_unreadable", sheet: "project.csv" }, NO_CHANGES],
    ["_config.yml", { error: "file_unreadable", file: "_config.yml" }, NO_CHANGES],
    [`${SHEETS}/glossary.csv`, { error: "sheet_unreadable", sheet: "glossary.csv" }, ACCEPTS_TERM],
  ])("%s", async (path, refusal, changes) => {
    repo.failing.add(`${HEAD}:${path}`);
    const { context, doPaths } = buildContext();
    const result = await action({
      request: buildRequest("https://compositor.telar.org/dashboard", {
        intent: "apply-full-sync",
        changes: JSON.stringify(changes),
      }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ ok: false, intent: "apply-full-sync", ...refusal });
    expect(doPaths).not.toContain("/ingest-sync");
    expect(db.writes).toEqual([]);
  });
});

describe("the apply refuses a story file it cannot read, and ingests nothing", () => {
  const TEXTS = "telar-content/texts/stories";
  const LAYER_PATH = `${TEXTS}/story-one/panel.md`;

  // The story subtrees at HEAD, answered as sync-accept-content answers them.
  function serveStoryTrees(trees: Record<string, Record<string, string>>) {
    vi.mocked(getSubtreeOids).mockResolvedValue({
      ok: true,
      at: (commit: string, path: string) =>
        commit === HEAD && trees[path] ? { kind: "tree", oid: path } : { kind: "absent" },
    } as never);
    vi.mocked(listSubtreeEntries).mockImplementation(async (_t, _o, _r, oid: string) => ({
      files: new Map(Object.entries(trees[oid] ?? {})),
      dirs: new Set(["story-one"]),
    }));
  }

  it("an accepted story's layer file answers file_unreadable, naming its path", async () => {
    __clearStoryBlobCacheForTest();
    repo.files[`${HEAD}:${SHEETS}/story-one.csv`] =
      "step,object,question,answer,layer1_button,layer1_content\n1,obj-001,Q,A,More,story-one/panel.md\n";
    repo.files[`${HEAD}:${LAYER_PATH}`] = '---\ntitle: "Panel"\n---\n\nThe panel.';
    repo.failing.add(`${HEAD}:${LAYER_PATH}`);
    serveStoryTrees({
      [SHEETS]: { "story-one.csv": "csv-blob-tel464" },
      [TEXTS]: { "story-one/panel.md": "panel-blob-tel464" },
    });
    const accepting = {
      ...NO_CHANGES,
      storyContentChecked: true,
      stories: { accept: [], reject: [], insertNew: [], acceptContent: ["story-one"], contentExpected: { "story-one": "h" } },
    };
    const { context, doPaths } = buildContext();
    const result = await action({
      request: buildRequest("https://compositor.telar.org/dashboard", {
        intent: "apply-full-sync",
        changes: JSON.stringify(accepting),
      }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ ok: false, intent: "apply-full-sync", error: "file_unreadable", file: LAYER_PATH });
    expect(doPaths).not.toContain("/ingest-sync");
    expect(db.writes).toEqual([]);
  });
});

describe("the glossary diff without a head", () => {
  it("reads the glossary strictly at the head it resolves, and refuses a failed read", async () => {
    repo.failing.add(`${HEAD}:${SHEETS}/glossary.csv`);
    await expect(computeGlossarySyncDiff(1, "t", "owner", "repo", db.handle as never)).rejects.toMatchObject({
      name: "SheetUnreadableError",
      path: `${SHEETS}/glossary.csv`,
    });
  });
});

describe("a failed read of the base", () => {
  it("refuses when the base commit exists, naming the file", async () => {
    withBase(BASE);
    repo.failing.add(`${BASE}:${SHEETS}/project.csv`);
    expect(await check()).toEqual({
      ok: false,
      intent: "compute-full-sync-diff",
      error: "sheet_unreadable",
      sheet: "project.csv",
    });
    expect(vi.mocked(commitExists)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitExists)).toHaveBeenCalledWith("user-token", "owner", "repo", BASE);
  });

  it("refuses when the lookup of the base commit fails too", async () => {
    withBase(BASE);
    repo.commit = "error";
    repo.failing.add(`${BASE}:_config.yml`);
    expect(await check()).toMatchObject({ ok: false, error: "file_unreadable", file: "_config.yml" });
  });

  it("looks the commit up once for several failed reads", async () => {
    withBase(BASE);
    repo.failing.add(`${BASE}:${SHEETS}/objects.csv`);
    repo.failing.add(`${BASE}:${SHEETS}/glossary.csv`);
    expect(await check()).toMatchObject({ ok: false, error: "sheet_unreadable", sheet: "objects.csv" });
    expect(vi.mocked(commitExists)).toHaveBeenCalledTimes(1);
  });

  it("is two-way when the base commit does not exist", async () => {
    withBase(BASE);
    repo.commit = "missing";
    repo.failing.add(`${BASE}:${SHEETS}/project.csv`);
    const result = (await check()) as { ok: boolean; diff?: { classification: string } };
    expect(result.ok).toBe(true);
    expect(result.diff?.classification).toBe("two-way");
  });

  // A loose read accepts a body whose length disagrees with the file's size, so
  // a truncated base sheet would read as an empty one.
  it("reads every base file strictly", async () => {
    withBase(BASE);
    await check();
    const baseReads = vi.mocked(getFileAtRef).mock.calls.filter((c) => c[4] === BASE);
    expect(baseReads).toHaveLength(4);
    for (const call of baseReads) expect(call[5]).toEqual({ strict: true });
  });

  it("drops a base sheet's byte-order mark, as a HEAD read does", async () => {
    withBase(BASE);
    repo.files[`${BASE}:${SHEETS}/glossary.csv`] = "\uFEFFterm_id,title,definition\nenc,Encomienda,A grant\n";
    const result = (await check()) as { ok: boolean; diff?: { classification: string; glossary: { removed: unknown[]; added: unknown[] } } };
    expect(result.diff?.classification).toBe("three-way");
    expect(result.diff?.glossary.removed).toEqual([]);
    expect(result.diff?.glossary.added).toEqual([]);
  });

  it("does not look the commit up when every base read answers", async () => {
    withBase(BASE);
    const result = (await check()) as { ok: boolean; diff?: { classification: string } };
    expect(result.diff?.classification).toBe("three-way");
    expect(vi.mocked(commitExists)).not.toHaveBeenCalled();
  });
});
