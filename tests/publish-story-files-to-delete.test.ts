/**
 * A publish after a story was deleted before any publish: the
 * Compositor's record of the CSV it read (`story_files_to_delete_json`) names
 * it, with the story's layer files, for deletion while the file at the head is
 * still the blob read; a changed file stays, a story D1 holds stays, a story
 * made here owes nothing, and the record is cleared once the commit lands.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { guardedOnHead, readableHeadWrite } from "./helpers/head-write";


const state = vi.hoisted(() => ({
  stories: [] as Array<{ story_id: string; title: string; draft: boolean; private: boolean; source_path: string | null }>,
  owed: null as string | null,
  snapshot: null as string | null,
  projectWrites: [] as Record<string, unknown>[],
  row: { head_sha: null as string | null },
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", async () => {
  const { projects } = await import("~/db/schema");
  return {
    getDb: vi.fn(() => ({
      select: (columns?: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {};
        // The stories read with their recorded file, the publish's own with the row id.
        const rows = columns && "story_id" in columns && (!("id" in columns) || "source_path" in columns) ? state.stories : [];
        chain.from = () => chain;
        chain.innerJoin = () => chain;
        chain.where = () => Object.assign(Promise.resolve(rows), chain);
        chain.orderBy = function (this: unknown) { return this; };
        chain.limit = () => Promise.resolve(rows);
        return chain;
      },
      update: (table: unknown) => ({
        set: (payload: Record<string, unknown>) => {
          if (table === projects) {
            state.projectWrites.push(readableHeadWrite(payload));
            const head = guardedOnHead(payload.head_sha);
            // Each CASE is judged against the row before the write, as SQLite does.
            const before = state.row.head_sha;
            if (head && before === head.head) state.row.head_sha = head.value as string;
          }
          return { where: async () => undefined };
        },
      }),
      batch: async (queries: Promise<unknown>[]) => Promise.all(queries),
    })),
  };
});

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      installation_id: 55,
      publish_snapshot: state.snapshot,
      page_files_json: null,
      story_files_to_delete_json: state.owed,
      head_sha: "0123456789abcdef0123456789abcdef01234567",
    },
    userRole: "convenor",
  })),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));

const RECORDED = "0123456789abcdef0123456789abcdef01234567";

const { getRepoHead, getFileAtRef } = vi.hoisted(() => ({
  getRepoHead: vi.fn(async () => "0123456789abcdef0123456789abcdef01234567"),
  getFileAtRef: vi.fn(async () => ({ status: "ok" as const, content: "title: \"x\"\n" })),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead, getFileAtRef };
});
vi.mock("~/lib/upgrade.server", () => ({ healMissingFrameworkFiles: vi.fn(async () => []) }));

const { commitFilesToRepo, StaleHeadError } = vi.hoisted(() => {
  class StaleHeadError extends Error {}
  return { commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })), StaleHeadError };
});
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError,
}));
const { buildPublishFileSet } = vi.hoisted(() => ({
  buildPublishFileSet: vi.fn(async (_params?: { glossaryReadFrom?: { path?: string } }) => [] as Array<{ path: string }>),
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => true),
  newFreezeOperationId: () => "op-publish",
}));

import { action } from "~/routes/_app.publish";
import { gitBlobSha } from "~/lib/story-files.server";

function publishRecordContext() {
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: {
          idFromName: vi.fn(() => "do-id"),
          get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("OK", { status: 200 })) })),
        },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function publishWithRecord() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  form.set("siteId", "7");
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: publishRecordContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as Record<string, unknown>;
}


const SHEETS = "telar-content/spreadsheets";
const CSV = "step,object\n1,bell\n";
const GONE = `${SHEETS}/gone.csv`;

const { layerFiles, fileOnGithub } = vi.hoisted(() => ({
  layerFiles: vi.fn(async (_s: unknown, left: readonly string[]) => left.map((p) => p.replace(/\.csv$/, "-layer.md"))),
  fileOnGithub: { content: "" },
}));
vi.mock("~/lib/story-left-files.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  deletedStoryLayerFiles: layerFiles,
}));

async function recordedFor(content: string): Promise<string> {
  return JSON.stringify([{ path: GONE, sha: await gitBlobSha(content) }]);
}

function committedDeletions(): string[] {
  return ((commitFilesToRepo.mock.calls[0] as unknown[])[7] as string[] | undefined) ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.stories = [];
  state.owed = null;
  state.snapshot = null;
  state.projectWrites.length = 0;
  state.row.head_sha = RECORDED;
  fileOnGithub.content = CSV;
  getRepoHead.mockResolvedValue(RECORDED);
  getFileAtRef.mockImplementation((async (_t: string, _o: string, _r: string, path: string) =>
    path === GONE ? { status: "ok" as const, content: fileOnGithub.content } : { status: "ok" as const, content: "title: \"x\"\n" }) as never);
  buildPublishFileSet.mockResolvedValue([]);
});

describe("the first publish after a story was deleted", () => {
  it("deletes the story's CSV and its layer files while the file is the blob read", async () => {
    state.owed = await recordedFor(CSV);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(committedDeletions()).toEqual([GONE, `${SHEETS}/gone-layer.md`]);
  });

  it("owes nothing for a story made in the Compositor, which records nothing", async () => {
    state.stories = [{ story_id: "mine", title: "Mine", draft: false, private: false, source_path: null }];
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(committedDeletions().filter((p) => p.startsWith(SHEETS))).toEqual([]);
  });

  it("reads a story's earlier CSV for the layer files it no longer writes", async () => {
    state.stories = [{ story_id: "mine", title: "Mine", draft: false, private: false, source_path: null }];
    buildPublishFileSet.mockResolvedValue([{ path: `${SHEETS}/mine.csv` }]);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(layerFiles.mock.calls[0][1]).toContain(`${SHEETS}/mine.csv`);
    expect(committedDeletions()).toContain(`${SHEETS}/mine-layer.md`);
  });

  it("deletes the Spanish sheets beside the English ones it writes, glosario.csv where the glossary was read from it", async () => {
    buildPublishFileSet.mockImplementation(async (params) => {
      if (params?.glossaryReadFrom) params.glossaryReadFrom.path = `${SHEETS}/glosario.csv`;
      return [{ path: `${SHEETS}/project.csv` }, { path: `${SHEETS}/glossary.csv` }];
    });
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(committedDeletions()).toEqual([`${SHEETS}/proyecto.csv`, `${SHEETS}/glosario.csv`]);
  });

  it("keeps a glosario.csv beside the glossary.csv the glossary was read from, which the build converts as a story", async () => {
    buildPublishFileSet.mockImplementation(async (params) => {
      if (params?.glossaryReadFrom) params.glossaryReadFrom.path = `${SHEETS}/glossary.csv`;
      return [{ path: `${SHEETS}/project.csv` }, { path: `${SHEETS}/glossary.csv` }];
    });
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(committedDeletions()).toEqual([`${SHEETS}/proyecto.csv`]);
  });

  it("keeps the CSV of a story D1 holds again", async () => {
    state.owed = await recordedFor(CSV);
    state.stories = [{ story_id: "gone", title: "Gone", draft: false, private: false, source_path: GONE }];
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(committedDeletions()).not.toContain(GONE);
  });

  it("leaves a file changed on GitHub since it was read", async () => {
    state.owed = await recordedFor(CSV);
    fileOnGithub.content = "edited on GitHub\n";
    expect(await publishWithRecord()).toMatchObject({
      ok: true,
      leftFiles: [{ code: "story_file_kept_changed", params: { file: GONE } }],
    });
    expect(committedDeletions()).not.toContain(GONE);
  });

  it("names nothing it left when it deleted the file", async () => {
    state.owed = await recordedFor(CSV);
    expect(await publishWithRecord()).toMatchObject({ ok: true, leftFiles: [] });
  });

  it("clears the record when the commit lands, and not when it fails", async () => {
    state.owed = await recordedFor(CSV);
    commitFilesToRepo.mockRejectedValueOnce(new Error("boom"));
    expect(await publishWithRecord()).toMatchObject({ ok: false });
    expect(state.projectWrites.some((w) => "story_files_to_delete_json" in w)).toBe(false);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(state.projectWrites.find((w) => "story_files_to_delete_json" in w)?.story_files_to_delete_json).toBeNull();
  });
});
