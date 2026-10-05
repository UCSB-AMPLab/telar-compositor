/**
 * A publish and the record of the page files the Compositor answers for.
 *
 * The publish deletes the union of the record's files no captured page holds
 * and the files the last snapshot's `page_slugs` names that no captured page
 * has (`computePageDeletions`), less any path it writes. The commit sends only
 * the deletions present at the head it is built on (`commitFilesToRepo`,
 * pinned in tests/commit.test.ts). A null record adds nothing, so a project
 * with no record deletes exactly what `computePageDeletions` does.
 *
 * The landed publish records every captured page held by a file, a page with a
 * blank title included, at the new head, written as a CASE on the head it
 * published on, so a head another writer recorded keeps that writer's record.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { guardedOnHead, readableHeadWrite } from "./helpers/head-write";

interface PageRow { id: number; slug: string; title: string }

const state = vi.hoisted(() => ({
  pages: [] as PageRow[],
  record: null as string | null,
  snapshot: null as string | null,
  projectWrites: [] as Record<string, unknown>[],
  row: { head_sha: null as string | null, page_files_json: null as string | null },
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", async () => {
  const { projects } = await import("~/db/schema");
  return {
    getDb: vi.fn(() => ({
      select: (columns?: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {};
        // The checks read the pages without their ids, and see each titled: a
        // page whose title was cleared after the checks is captured blank, the
        // one way a publish that lands captures a page with no title.
        const atChecks = columns !== undefined && !("id" in columns);
        const rows = columns && "slug" in columns
          ? state.pages.map((p) => ({
            ...p, title: atChecks && p.title === "" ? "Titled at the checks" : p.title,
            body: "", frontmatter: null, frontmatter_source: null, order: 0,
          }))
          : [];
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
            const record = guardedOnHead(payload.page_files_json);
            // Each CASE is judged against the row before the write, as SQLite does.
            const before = state.row.head_sha;
            if (head && before === head.head) state.row.head_sha = head.value as string;
            if (record && before === record.head) state.row.page_files_json = record.value as string;
          }
          return { where: async () => undefined };
        },
      }),
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
      page_files_json: state.record,
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
const { buildPublishFileSet } = vi.hoisted(() => ({ buildPublishFileSet: vi.fn(async () => [] as Array<{ path: string }>) }));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => true),
  newFreezeOperationId: () => "op-publish",
}));

import { action } from "~/routes/_app.publish";
import { parsePageFilesRecord } from "~/lib/page-files-record";

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

/** The page file deletions the commit was asked for, in order. */
function publishedPageDeletions(): string[] {
  const deletions = ((commitFilesToRepo.mock.calls[0] as unknown[])[7] as string[] | undefined) ?? [];
  return deletions.filter((path) => path.startsWith("telar-content/texts/pages/")).sort();
}

const PAGES = "telar-content/texts/pages";

function recordAtPublishHead(files: Record<string, number | null>): string {
  return JSON.stringify({ commit: RECORDED, files });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.pages = [];
  state.record = null;
  state.snapshot = null;
  state.projectWrites.length = 0;
  state.row.head_sha = RECORDED;
  state.row.page_files_json = null;
  getRepoHead.mockResolvedValue(RECORDED);
  buildPublishFileSet.mockResolvedValue([]);
});

describe("the publish's page file deletions", () => {
  it("deletes the file of a page renamed after the import and before any publish (the gap)", async () => {
    // Imported as about.md (page 11), renamed here to credits; no publish since.
    state.record = recordAtPublishHead({ "about.md": 11 });
    state.pages = [{ id: 11, slug: "credits", title: "About" }];
    buildPublishFileSet.mockResolvedValue([{ path: `${PAGES}/credits.md` }]);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(publishedPageDeletions()).toEqual([`${PAGES}/about.md`]);
  });

  it("deletes a recorded file with no page, and a recorded file whose page was deleted here", async () => {
    state.record = recordAtPublishHead({ "about.md": 11, "added.md": null });
    state.pages = [];
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(publishedPageDeletions()).toEqual([`${PAGES}/about.md`, `${PAGES}/added.md`]);
  });

  it("takes the union with the snapshot's page_slugs: a file only page_slugs names and a file only the record names", async () => {
    state.snapshot = JSON.stringify({ story_ids: [], object_ids: [], page_slugs: ["old"] });
    state.record = recordAtPublishHead({ "acerca.md": null, "about.md": 11 });
    state.pages = [{ id: 11, slug: "about", title: "About" }];
    buildPublishFileSet.mockResolvedValue([{ path: `${PAGES}/about.md` }]);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(publishedPageDeletions()).toEqual([`${PAGES}/acerca.md`, `${PAGES}/old.md`]);
  });

  it("with a null record deletes exactly what computePageDeletions does", async () => {
    state.snapshot = JSON.stringify({ story_ids: [], object_ids: [], page_slugs: ["about", "old"] });
    state.pages = [{ id: 11, slug: "about", title: "About" }];
    buildPublishFileSet.mockResolvedValue([{ path: `${PAGES}/about.md` }]);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(publishedPageDeletions()).toEqual([`${PAGES}/old.md`]);
  });

  it("keeps a recorded file a captured page now holds, a blank-title page included", async () => {
    // A page now at the recorded name of another holds it, and is written
    // there; a page with a blank title is not written, and its file stays.
    state.record = recordAtPublishHead({ "about.md": 11, "draft.md": 12 });
    state.pages = [
      { id: 13, slug: "about", title: "New about" },
      { id: 12, slug: "draft", title: "" },
    ];
    buildPublishFileSet.mockResolvedValue([{ path: `${PAGES}/about.md` }]);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(publishedPageDeletions()).toEqual([]);
  });
});

describe("the landed publish's record", () => {
  it("records every captured page held by a file at the new head, a blank-title page included", async () => {
    state.record = recordAtPublishHead({ "about.md": 11, "gone.md": null });
    state.pages = [
      { id: 11, slug: "about", title: "About" },
      { id: 12, slug: "draft", title: "" },
      { id: 14, slug: "", title: "No slug" },
    ];
    buildPublishFileSet.mockResolvedValue([{ path: `${PAGES}/about.md` }]);
    expect(await publishWithRecord()).toMatchObject({ ok: true, newHeadSha: "new-sha" });
    const write = state.projectWrites[0];
    expect(write.page_files_json_while_head).toBe(RECORDED);
    expect(parsePageFilesRecord(write.page_files_json as string)).toEqual({
      commit: "new-sha",
      files: { "about.md": 11, "draft.md": 12 },
    });
    expect(parsePageFilesRecord(state.row.page_files_json)).toEqual({
      commit: "new-sha",
      files: { "about.md": 11, "draft.md": 12 },
    });
  });

  it("the next publish, on the landed record, keeps a held blank-title page's file", async () => {
    state.pages = [{ id: 12, slug: "draft", title: "" }];
    await publishWithRecord();
    // The next publish, on the head and record the first recorded.
    state.record = state.row.page_files_json;
    commitFilesToRepo.mockClear();
    getRepoHead.mockResolvedValue("new-sha");
    state.row.head_sha = "new-sha";
    const { resolveActiveProject } = await import("~/lib/membership.server");
    vi.mocked(resolveActiveProject).mockResolvedValueOnce({
      project: { id: 7, github_repo_full_name: "owner/repo", installation_id: 55, publish_snapshot: null, page_files_json: state.record, head_sha: "new-sha" },
      userRole: "convenor",
    } as never);
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(publishedPageDeletions()).toEqual([]);
  });

  it("keeps the record of a writer that moved the head during the publish", async () => {
    const COMPETING = "2222222222222222222222222222222222222222";
    const theirs = JSON.stringify({ commit: COMPETING, files: { "theirs.md": 99 } });
    state.pages = [{ id: 11, slug: "about", title: "About" }];
    commitFilesToRepo.mockImplementationOnce(async () => {
      state.row.head_sha = COMPETING;
      state.row.page_files_json = theirs;
      return { newHeadSha: "new-sha" };
    });
    expect(await publishWithRecord()).toMatchObject({ ok: true });
    expect(state.row.head_sha).toBe(COMPETING);
    expect(state.row.page_files_json).toBe(theirs);
  });
});
