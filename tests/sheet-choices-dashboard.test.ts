/**
 * The column picker on the dashboard's sync and orphan restore: a
 * sheet whose colliding columns each hold values comes back as the groups to
 * choose in, the choice is committed to the repository at the head it was
 * read at, and the sync then runs on the repaired sheet. A head that moved
 * while the author chose voids the choice and asks again.
 *
 * The action, the parse and the repair run for real; GitHub, D1 and the
 * collaboration DO are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const repo = vi.hoisted(() => ({ head: "head-sha", files: {} as Record<string, string> }));

vi.mock("~/lib/db.server", () => {
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "set", "values", "returning", "innerJoin", "leftJoin", "groupBy"]) {
      node[m] = () => chain();
    }
    return node;
  };
  const handle = { select: () => chain(), update: () => chain(), insert: () => chain(), delete: () => chain() };
  return { getDb: vi.fn(() => handle) };
});
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => repo.head),
  getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
  getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string) => repo.files[path] ?? null),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, _ref: string, options?: { strict?: boolean }) => {
    if (!options?.strict || repo.files[path] === undefined) return { status: "absent" };
    return { status: "ok", content: repo.files[path] };
  }),
  listDirectoryEntries: vi.fn(async (_t: string, _o: string, _r: string, _c: string, dir: string) =>
    Object.keys(repo.files)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => ({ path, mode: "100644", type: "blob", sha: "x" })),
  ),
  searchGitHubUsers: vi.fn(async () => []),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => []),
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1, github_repo_full_name: "owner/repo", head_sha: null, onboarding_completed: 1 },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/import.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/import.server")>("~/lib/import.server");
  return { ...actual, scanRepoOrphanStoryIds: vi.fn(async () => ["story-one"]) };
});
vi.mock("~/lib/commit.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/commit.server")>("~/lib/commit.server");
  return { ...actual, commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "repaired-sha" })) };
});
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => undefined) }));

import { action } from "~/routes/_app.dashboard";
import { commitFilesToRepo } from "~/lib/commit.server";

const OBJECTS = "telar-content/spreadsheets/objects.csv";
const STORY = "telar-content/spreadsheets/story-one.csv";

function postToDashboard(fields: Record<string, string>) {
  const request = new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ siteId: "1", ...fields }).toString(),
  });
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ restored: 0 }), { status: 200 })) })),
    },
  };
  const context = { get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })), cloudflare: { env } };
  // biome-ignore lint/suspicious/noExplicitAny: the action's generated argument type
  return action({ request, context, params: {} } as any) as Promise<any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.head = "head-sha";
  repo.files = { [OBJECTS]: "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n" };
});

describe("the full sync offers the column picker", () => {
  it("returns the group to choose in, not the colliding-columns refusal", async () => {
    const answer = await postToDashboard({ intent: "compute-full-sync-diff" });
    expect(answer.error).toBe("needs_choices");
    expect(answer.intent).toBe("compute-full-sync-diff");
    expect(answer.groups).toEqual([
      {
        file: OBJECTS,
        sheet: "objects.csv",
        claim: "medium",
        positions: [2, 3],
        columns: [
          { position: 2, header: "medium", values: ["Oil"] },
          { position: 3, header: "object_type", values: ["Painting"] },
        ],
        needsChoice: false,
      },
    ]);
    expect(answer.notice).toBeNull();
  });

  it("commits the chosen column at the head it read, and the sync then runs", async () => {
    const asked = await postToDashboard({ intent: "compute-full-sync-diff" });
    const chosen = await postToDashboard({
      intent: "choose-columns",
      sheet_challenge: asked.challenge,
      sheet_choices: JSON.stringify([{ file: OBJECTS, positions: [2, 3], keep: 3 }]),
    });
    expect(chosen).toEqual({ ok: true, intent: "choose-columns" });
    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    expect(call[4]).toEqual([{ path: OBJECTS, content: "object_id,title,object_type\nobj-001,First,Painting\n", verbatim: true }]);
    expect(call[9]).toBe("head-sha");

    repo.head = "repaired-sha";
    repo.files[OBJECTS] = call[4][0].content;
    const synced = await postToDashboard({ intent: "compute-full-sync-diff" });
    expect(synced.ok).toBe(true);
  });

  it("asks again, committing nothing, when the head moved while the author chose", async () => {
    const asked = await postToDashboard({ intent: "compute-full-sync-diff" });
    repo.head = "moved-sha";
    const chosen = await postToDashboard({
      intent: "choose-columns",
      sheet_challenge: asked.challenge,
      sheet_choices: JSON.stringify([{ file: OBJECTS, positions: [2, 3], keep: 3 }]),
    });
    expect(chosen.error).toBe("needs_choices");
    expect(chosen.notice).toBe("sheets_changed");
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("asks again, committing nothing, when a sheet's bytes changed at the same head", async () => {
    const asked = await postToDashboard({ intent: "compute-full-sync-diff" });
    repo.files[OBJECTS] = "object_id,title,medium,object_type\nobj-001,First,Ink,Drawing\n";
    const chosen = await postToDashboard({
      intent: "choose-columns",
      sheet_challenge: asked.challenge,
      sheet_choices: JSON.stringify([{ file: OBJECTS, positions: [2, 3], keep: 3 }]),
    });
    expect(chosen.notice).toBe("sheets_changed");
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("refuses a challenge whose content was edited after signing", async () => {
    const asked = await postToDashboard({ intent: "compute-full-sync-diff" });
    // Moved into the content as a choice already made, it would be replayed
    // and committed without the author answering.
    const tampered = JSON.parse(asked.challenge);
    tampered.content.chosen = [{ file: OBJECTS, positions: [2, 3], keep: 3 }];
    tampered.content.pending = [];
    const chosen = await postToDashboard({ intent: "choose-columns", sheet_challenge: JSON.stringify(tampered), sheet_choices: "[]" });
    expect(chosen.error).toBe("needs_choices");
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("flags a group left without a choice and commits nothing", async () => {
    const asked = await postToDashboard({ intent: "compute-full-sync-diff" });
    const chosen = await postToDashboard({ intent: "choose-columns", sheet_challenge: asked.challenge, sheet_choices: "[]" });
    expect(chosen.notice).toBe("choice_needed");
    expect(chosen.groups[0].needsChoice).toBe(true);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });
});

describe("the orphan restore offers the column picker", () => {
  it("returns the story's group to choose in", async () => {
    repo.files = { [STORY]: "step,object,x,y,zoom,question,pregunta,answer\n1,obj-001,0.5,0.5,1,What?,¿Qué?,An answer\n" };
    const answer = await postToDashboard({ intent: "restore-orphan-drafts" });
    expect(answer.error).toBe("needs_choices");
    expect(answer.intent).toBe("restore-orphan-drafts");
    expect(answer.groups.map((g: { file: string; claim: string }) => [g.file, g.claim])).toEqual([[STORY, "question"]]);
    expect(answer.warnings).toEqual([]);
  });
});
