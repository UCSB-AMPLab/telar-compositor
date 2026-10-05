/**
 * The publish action deletes a renamed story's old layer files in the commit
 * that writes it under its new ID: with the prior publish's snapshot
 * naming `blank_template` and D1 holding the story as `fluidity`, the commit's
 * deletions are the old step CSV and the layer files that CSV names at the
 * head the publish is built on, and the story is then recorded at its own
 * path (`source_path`). The harness is publish-landed-bookkeeping's,
 * cut to what reaches the commit.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const RECORDED = "0123456789abcdef0123456789abcdef01234567";
const OLD_CSV = [
  "step,object,x,y,zoom,question,answer,layer1_button,layer1_content",
  "1,bell,0.5,0.5,1,Q,A,More,blank_template-intro.md",
].join("\n") + "\n";

/** Every `set` payload of a D1 update the action made. */
const { setPayloads } = vi.hoisted(() => ({ setPayloads: [] as Record<string, unknown>[] }));
/** The prior publish's snapshot the project row holds: null before the first Compositor publish. */
const projectState = vi.hoisted(() => ({ snapshot: null as string | null }));
/**
 * The stories D1 holds, the files the publish writes, and the spreadsheets and
 * texts folders at the head; reset to one story renamed `blank_template` ->
 * `fluidity` in `beforeEach`.
 */
const repoState = vi.hoisted(() => ({
  stories: [] as Array<{ id: number; story_id: string; draft: boolean; source_path: string | null }>,
  written: [] as Array<{ path: string; content: string }>,
  sheets: [] as string[],
  texts: [] as string[],
  heads: {} as Record<string, string>,
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: (columns?: Record<string, unknown>) => {
      const chain: Record<string, unknown> = {};
      const rows = columns && "source_path" in columns ? repoState.stories : [];
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.orderBy = function (this: unknown) { return this; };
      chain.limit = () => Promise.resolve(rows);
      return chain;
    },
    update: () => ({ set: (payload: Record<string, unknown>) => ({ where: async () => { setPayloads.push(payload); } }) }),
    batch: async (queries: Promise<unknown>[]) => Promise.all(queries),
  })),
}));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })) })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      installation_id: 55,
      publish_snapshot: projectState.snapshot,
      head_sha: RECORDED,
    },
    userRole: "convenor",
  })),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })) }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));

const { getFileAtRef } = vi.hoisted(() => ({
  getFileAtRef: vi.fn(async (..._args: unknown[]): Promise<{ status: "ok"; content: string } | { status: "absent" }> =>
    ({ status: "absent" })),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(async () => RECORDED),
    getFileAtRef,
    // The spreadsheets folder at the head: the old CSV only.
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: (_ref: string, dir: string) => ({ kind: "tree", oid: dir }) })),
    listSubtreeEntries: vi.fn(async (_t: string, _o: string, _r: string, oid: string) => ({
      files: new Map((oid.endsWith("texts/stories") ? repoState.texts : repoState.sheets).map((n) => [n, `blob-${n}`])),
      dirs: new Set(),
    })),
    checkRepoAvailability: vi.fn(async () => ({ availability: "available", canonicalFullName: "owner/repo" })),
  };
});
vi.mock("~/lib/upgrade.server", () => ({ healMissingFrameworkFiles: vi.fn(async () => []) }));

const { commitFilesToRepo } = vi.hoisted(() => ({
  commitFilesToRepo: vi.fn(async (..._args: unknown[]) => ({ newHeadSha: "new-sha" })),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    buildPublishFileSet: vi.fn(async () => repoState.written),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => true),
  newFreezeOperationId: () => "op-publish",
}));

import { action } from "~/routes/_app.publish";

function publishRenamedStory() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  form.set("siteId", "7");
  const snapshotFetch = vi.fn(async () => new Response("OK", { status: 200 }));
  return action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: {
      get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
      cloudflare: {
        env: {
          DB: {},
          SESSION_SECRET: "s",
          ENCRYPTION_KEY: "k",
          COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: snapshotFetch })) },
        },
      },
    },
    params: {},
  } as unknown as Parameters<typeof action>[0]) as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  setPayloads.length = 0;
  projectState.snapshot = JSON.stringify({ story_ids: ["blank_template"], all_story_ids: ["blank_template"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  repoState.stories = [{ id: 1, story_id: "fluidity", draft: false, source_path: "telar-content/spreadsheets/blank_template.csv" }];
  repoState.written = [{ path: "telar-content/spreadsheets/fluidity.csv", content: "step\n" }];
  repoState.sheets = ["blank_template.csv"];
  repoState.texts = ["blank_template-intro.md"];
  repoState.heads = { "telar-content/spreadsheets/blank_template.csv": OLD_CSV };
  getFileAtRef.mockImplementation(async (...args: unknown[]) => {
    const content = repoState.heads[args[3] as string];
    return content === undefined ? { status: "absent" as const } : { status: "ok" as const, content };
  });
});

describe("publishing a story whose ID changed", () => {
  it("deletes the old step CSV and the layer files it names, in the same commit", async () => {
    const res = await publishRenamedStory();

    expect(res).toMatchObject({ ok: true, intent: "publish" });
    const deletions = commitFilesToRepo.mock.calls[0][7] as string[];
    expect(deletions).toEqual([
      "telar-content/spreadsheets/blank_template.csv",
      "telar-content/texts/stories/blank_template-intro.md",
    ]);
    // The story is recorded at its own path once the commit has landed.
    expect(setPayloads).toContainEqual({ source_path: "telar-content/spreadsheets/fluidity.csv" });
    expect(getFileAtRef).toHaveBeenCalledWith(
      "install-token", "owner", "repo", "telar-content/spreadsheets/blank_template.csv", RECORDED, { strict: true },
    );
  });

  it("deletes them from the story's own record when no publish has recorded a snapshot", async () => {
    projectState.snapshot = null;

    const res = await publishRenamedStory();

    expect(res).toMatchObject({ ok: true, intent: "publish" });
    expect(commitFilesToRepo.mock.calls[0][7]).toEqual([
      "telar-content/spreadsheets/blank_template.csv",
      "telar-content/texts/stories/blank_template-intro.md",
    ]);
  });
});

describe("a chain of renamed stories whose second story records no file", () => {
  // A: blank_template -> fluidity; B: fluidity -> river, its record NULL. B's
  // layer file is named only by fluidity.csv at the head, which A overwrites.
  it("deletes the layer files the overwritten file names and no written CSV does", async () => {
    repoState.stories = [
      { id: 1, story_id: "fluidity", draft: false, source_path: "telar-content/spreadsheets/blank_template.csv" },
      { id: 2, story_id: "river", draft: false, source_path: null },
    ];
    repoState.written = [
      { path: "telar-content/spreadsheets/fluidity.csv", content: "step\n" },
      { path: "telar-content/spreadsheets/river.csv", content: "step\n" },
    ];
    repoState.sheets = ["blank_template.csv", "fluidity.csv"];
    repoState.texts = ["blank_template-intro.md", "fluidity-intro.md"];
    repoState.heads["telar-content/spreadsheets/fluidity.csv"] = "step,object,layer1_content\n1,bell,fluidity-intro.md\n";

    const res = await publishRenamedStory();

    expect(res).toMatchObject({ ok: true, intent: "publish" });
    expect([...(commitFilesToRepo.mock.calls[0][7] as string[])].sort()).toEqual([
      "telar-content/spreadsheets/blank_template.csv",
      "telar-content/texts/stories/blank_template-intro.md",
      "telar-content/texts/stories/fluidity-intro.md",
    ]);
  });
});
