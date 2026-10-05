/**
 * `restore-orphan-drafts` reads every file it restores from strictly, at the
 * head it resolves: a story sheet, a layer file or the ignore list
 * that fails to read refuses the restore with `sheet_unreadable`, naming the
 * file, and nothing reaches the document. A missing story sheet is skipped,
 * and a missing ignore list is an empty one. `ignore-orphans` reads the list
 * the same way before it rewrites it. The orphan scan and the parses
 * run for real; GitHub, D1 and the collaboration object are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileAtRef } from "~/lib/github.server";

const HEAD = "c".repeat(40);
const SHEETS = "telar-content/spreadsheets";
const TEXTS = "telar-content/texts/stories";

const repo = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  failing: new Set<string>(),
  /** Sheets listed at HEAD that no read finds, as a file gone between the two. */
  listedOnly: [] as string[],
  /** The branch's head, which a commit must expect. */
  current: "",
}));

const dbMock = {
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
};

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => dbMock) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => HEAD),
  // The pinned scan lists telar-content/spreadsheets alone.
  getRepoTree: vi.fn(),
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "tree", oid: "sheets-oid" }) })),
  listSubtreeEntries: vi.fn(async () => ({
    files: new Map(
      [
        ...Object.keys(repo.files)
          .filter((key) => key.startsWith(`${HEAD}:${SHEETS}/`))
          .map((key) => key.slice(`${HEAD}:${SHEETS}/`.length)),
        ...repo.listedOnly,
      ].map((name) => [name, `blob-${name}`]),
    ),
    dirs: new Set(),
  })),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string): Promise<FileAtRef> => {
    const key = `${ref}:${path}`;
    if (repo.failing.has(key)) return { status: "error" };
    const text = repo.files[key];
    return text === undefined ? { status: "absent" } : { status: "ok", content: text };
  }),
  // Every read of the restore is strict and pinned; this answers nothing.
  getFileContent: vi.fn(async () => null),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1, user_id: 7, github_repo_full_name: "owner/repo", onboarding_completed: 1 },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeFullSyncDiff: vi.fn(),
  applyFullSyncChanges: vi.fn(),
  StoryContentNotApplied: class {},
  SyncBaseStale: class {},
}));
vi.mock("~/lib/internal-marker.server", () => ({ makeInternalMarkerHeaders: vi.fn(async () => ({})) }));
// A commit lands only while the branch is at the head it expects; with none
// given it commits at whatever the branch holds, as commitFilesToRepo reads
// the head itself.
vi.mock("~/lib/commit.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/commit.server")>();
  return {
    ...actual,
    commitFilesToRepo: vi.fn(async (...args: unknown[]) => {
      const expected = (args[9] as string | undefined) ?? repo.current;
      if (expected !== repo.current) throw new actual.StaleHeadError(`Expected HEAD ${expected}`);
      for (const file of args[4] as Array<{ path: string; content: string }>) {
        repo.files[`${repo.current}:${file.path}`] = file.content;
      }
      return { newHeadSha: "after-commit" };
    }),
  };
});

import { action } from "~/routes/_app.dashboard";
import { getFileAtRef, getSubtreeOids, getRepoHead, listSubtreeEntries } from "~/lib/github.server";
import { commitFilesToRepo } from "~/lib/commit.server";

function request(): Request {
  return new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "restore-orphan-drafts", siteId: "1" }).toString(),
  });
}

/** The context, with a collaboration object that records what it is sent. */
function context() {
  const sent: string[] = [];
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async (req: Request) => {
          sent.push(await req.text());
          return new Response(JSON.stringify({ restored: 1 }), { status: 200 });
        }),
      })),
    },
  };
  const ctx = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
  return { ctx, sent };
}

async function restore() {
  const { ctx, sent } = context();
  const result = await action({ request: request(), context: ctx, params: {} } as never);
  return { result, sent };
}

const STORY_CSV = "step,object,question,answer,layer1_button,layer1_content\n1,obj-001,Q,A,More,panel.md\n";

beforeEach(() => {
  vi.clearAllMocks();
  repo.files = {
    [`${HEAD}:${SHEETS}/project.csv`]: "order,story_id,title\n",
    [`${HEAD}:${SHEETS}/story-one.csv`]: STORY_CSV,
    [`${HEAD}:${TEXTS}/panel.md`]: "---\ntitle: Panel\n---\n\nThe panel's text.",
  };
  repo.failing.clear();
  repo.listedOnly = [];
  repo.current = HEAD;
});

describe("restore-orphan-drafts reads strictly", () => {
  it("restores the story with its layer text, every read at the head it resolved", async () => {
    const { result, sent } = await restore();
    expect(result).toMatchObject({ ok: true, intent: "restore-orphan-drafts", restored: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("The panel's text.");
    expect(vi.mocked(getSubtreeOids)).toHaveBeenCalledWith("user-token", "owner", "repo", [HEAD], [SHEETS]);
    for (const call of vi.mocked(getFileAtRef).mock.calls) {
      expect(call[4]).toBe(HEAD);
      expect(call[5]).toEqual({ strict: true });
    }
  });

  it("refuses a story sheet that fails to read, naming it, and restores nothing", async () => {
    repo.failing.add(`${HEAD}:${SHEETS}/story-one.csv`);
    const { result, sent } = await restore();
    expect(result).toEqual({
      ok: false,
      intent: "restore-orphan-drafts",
      error: "sheet_unreadable",
      sheet: "story-one.csv",
      warnings: [],
    });
    expect(sent).toEqual([]);
  });

  it("refuses a layer file that fails to read, naming it, and restores nothing", async () => {
    repo.failing.add(`${HEAD}:${TEXTS}/panel.md`);
    const { result, sent } = await restore();
    expect(result).toEqual({
      ok: false,
      intent: "restore-orphan-drafts",
      error: "file_unreadable",
      file: `${TEXTS}/panel.md`,
      warnings: [],
    });
    expect(sent).toEqual([]);
  });

  it("skips a story sheet that is missing at the read", async () => {
    repo.listedOnly = ["story-one.csv"];
    delete repo.files[`${HEAD}:${SHEETS}/story-one.csv`];
    const { result, sent } = await restore();
    expect(result).toEqual({ ok: true, intent: "restore-orphan-drafts", restored: 0, warnings: [] });
    expect(sent).toEqual([]);
  });

  it("refuses an ignore list that fails to read, and restores nothing", async () => {
    repo.failing.add(`${HEAD}:.compositor-ignored`);
    const { result, sent } = await restore();
    expect(result).toEqual({ ok: false, intent: "restore-orphan-drafts", error: "ignore_list_unreadable", warnings: [] });
    expect(sent).toEqual([]);
  });

  it("answers restore_failed, restoring nothing, when the spreadsheets listing is incomplete", async () => {
    vi.mocked(listSubtreeEntries).mockResolvedValueOnce(null);
    const { result, sent } = await restore();
    expect(result).toMatchObject({ ok: false, intent: "restore-orphan-drafts", error: "restore_failed" });
    expect(sent).toEqual([]);
  });

  it("keeps an ignored story out of the restore", async () => {
    repo.files[`${HEAD}:.compositor-ignored`] = "story-one\n";
    const { result, sent } = await restore();
    expect(result).toMatchObject({ ok: true, restored: 0 });
    expect(sent).toEqual([]);
  });
});

// ignore-orphans rewrites the ignore list, so it reads the list strictly at
// the head it resolves: read as empty, a failed read would commit a list
// holding only the new ids and drop the author's entries.
describe("ignore-orphans reads the ignore list strictly", () => {
  function ignoreRequest(): Request {
    return new Request("https://compositor.telar.org/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "ignore-orphans", siteId: "1" }).toString(),
    });
  }

  async function ignore() {
    const { ctx } = context();
    return action({ request: ignoreRequest(), context: ctx, params: {} } as never);
  }

  const committed = () => vi.mocked(commitFilesToRepo).mock.calls.map((call) => call[4]);

  it("refuses a failed read of the list and commits nothing", async () => {
    repo.files[`${HEAD}:.compositor-ignored`] = "story-kept\n";
    repo.failing.add(`${HEAD}:.compositor-ignored`);
    expect(await ignore()).toEqual({ ok: false, intent: "ignore-orphans", error: "ignore_list_unreadable" });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("keeps the existing entries and appends the new ids", async () => {
    repo.files[`${HEAD}:.compositor-ignored`] = "story-kept\n";
    expect(await ignore()).toEqual({ ok: true, intent: "ignore-orphans", ignored: 1 });
    expect(committed()).toEqual([[{ path: ".compositor-ignored", content: "story-kept\nstory-one\n" }]]);
    for (const call of vi.mocked(getFileAtRef).mock.calls) {
      expect(call[4]).toBe(HEAD);
      expect(call[5]).toEqual({ strict: true });
    }
  });

  it("answers ignore_failed, committing nothing, when the spreadsheets listing is incomplete", async () => {
    vi.mocked(listSubtreeEntries).mockResolvedValueOnce(null);
    expect(await ignore()).toMatchObject({ ok: false, intent: "ignore-orphans", error: "ignore_failed" });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("commits at the head it read, expecting it", async () => {
    await ignore();
    expect(vi.mocked(commitFilesToRepo).mock.calls[0][9]).toBe(HEAD);
  });

  it("refuses when the branch moved between the read and the commit, and the newer list survives", async () => {
    const NEWER = "d".repeat(40);
    repo.files[`${HEAD}:.compositor-ignored`] = "story-kept\n";
    // Another writer commits a newer list after the head is resolved.
    vi.mocked(getRepoHead).mockImplementationOnce(async () => {
      repo.current = NEWER;
      repo.files[`${NEWER}:.compositor-ignored`] = "story-kept\nstory-newer\n";
      return HEAD;
    });
    const result = await ignore();
    expect(result).toMatchObject({ ok: false, intent: "ignore-orphans", error: "ignore_failed" });
    expect(repo.files[`${NEWER}:.compositor-ignored`]).toBe("story-kept\nstory-newer\n");
  });

  it("reads a missing list as empty", async () => {
    expect(await ignore()).toEqual({ ok: true, intent: "ignore-orphans", ignored: 1 });
    const [[file]] = committed() as Array<Array<{ content: string }>>;
    expect(file.content.endsWith("story-one\n")).toBe(true);
  });
});
