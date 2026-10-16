/**
 * A publish over a page held in two languages applies the version the author
 * chose before it reads what it publishes.
 *
 * The publish action runs with the real choice (`page-language-choice.server`)
 * and the real deletions. The collaboration object is a fake that answers a
 * snapshot, and applies an `/ingest-sync` to the stood-in pages as its flush
 * writes D1, logging each call in order; D1 is stood in for by table, and the
 * file set and the commit are stood in for, as in
 * tests/publish-page-files-record.test.ts.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface PageRow { id: number; slug: string; title: string; body: string; frontmatter: string | null }
interface Ingest { pages: { remove?: Array<{ pageId: number }>; replaceContent?: Array<{ pageId: number; title: string; body: string; frontmatter: string }> }; allOrNothing?: boolean }

const state = vi.hoisted(() => ({
  pages: [] as PageRow[],
  record: null as string | null,
  /** The record as the D1 row holds it, which the choice merges into. */
  storedRecord: null as string | null,
  events: [] as string[],
  ingests: [] as Ingest[],
  heldBack: false,
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: (columns?: Record<string, unknown>) => {
      const chain: Record<string, unknown> = {};
      const rows = columns && "slug" in columns
        ? state.pages.map((p) => ({ ...p, frontmatter_source: null, order: 0 }))
        : [];
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.orderBy = function (this: unknown) { return this; };
      chain.limit = () => Promise.resolve(rows);
      return chain;
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
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
      publish_snapshot: null,
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
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(async () => "0123456789abcdef0123456789abcdef01234567"),
    getFileAtRef: vi.fn(async () => ({ status: "ok" as const, content: "title: \"x\"\n" })),
  };
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
  buildPublishFileSet: vi.fn(async (params: { pages: Array<{ id: number }> }) => {
    state.events.push(`file set of pages ${params.pages.map((p) => p.id).join(",")}`);
    return [] as Array<{ path: string }>;
  }),
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
import { parsePageMarkdown } from "~/lib/import.server";
import { KEEP_PAGE_FILES } from "~/lib/page-language-choice";

const ABOUT = readFileSync(resolve(__dirname, "fixtures/pages/telar/about.md"), "utf8");
const ACERCA = readFileSync(resolve(__dirname, "fixtures/pages/telar/acerca.md"), "utf8");
const PAGES = "telar-content/texts/pages";

function page(id: number, slug: string, file: string): PageRow {
  const { title, body, frontmatter } = parsePageMarkdown(file, slug);
  return { id, slug, title: title ?? "", body: body ?? "", frontmatter: frontmatter ?? "" };
}

/** The collaboration object: a snapshot answers 200; an ingest lands in the pages as its flush would, then answers. */
const doFetch = vi.fn(async (request: Request) => {
  if (!request.url.endsWith("/ingest-sync")) {
    state.events.push(new URL(request.url).pathname.slice(1));
    return new Response("OK", { status: 200 });
  }
  const ingest = (await request.json()) as Ingest;
  state.events.push("ingest");
  state.ingests.push(ingest);
  if (state.heldBack) return Response.json({ heldBack: true, pageRemove: { changedSinceReview: ingest.pages.remove?.map((e) => e.pageId) } });
  for (const entry of ingest.pages.replaceContent ?? []) {
    const row = state.pages.find((p) => p.id === entry.pageId)!;
    Object.assign(row, { title: entry.title, body: entry.body, frontmatter: entry.frontmatter });
  }
  const removed = (ingest.pages.remove ?? []).map((e) => e.pageId);
  state.pages = state.pages.filter((p) => !removed.includes(p.id));
  return Response.json({
    pageContent: { applied: (ingest.pages.replaceContent ?? []).map((e) => e.pageId) },
    pageRemove: { applied: removed },
  });
});

/** The one D1 row the choice merges the record into. */
const recordDb = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => ({ page_files_json: state.storedRecord }),
      run: async () => {
        if (!sql.startsWith("UPDATE") || args[2] !== state.storedRecord) return { meta: { changes: 0 } };
        state.storedRecord = args[0] as string;
        state.events.push("record");
        return { meta: { changes: 1 } };
      },
    }),
  }),
};

function context() {
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: recordDb,
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: doFetch })) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function publish(kept?: string[]) {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  form.set("siteId", "7");
  if (kept) form.set(KEEP_PAGE_FILES, JSON.stringify(kept));
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: context(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as Record<string, unknown>;
}

/** The page file deletions the commit was asked for. */
function publishedPageDeletions(): string[] {
  const deletions = ((commitFilesToRepo.mock.calls[0] as unknown[])[7] as string[] | undefined) ?? [];
  return deletions.filter((path) => path.startsWith(`${PAGES}/`)).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.pages = [page(5, "about", ABOUT), page(6, "acerca", ACERCA)];
  state.record = null;
  state.storedRecord = null;
  state.events = [];
  state.ingests = [];
  state.heldBack = false;
});

describe("a publish over a page held in two languages", () => {
  it("refuses with no version chosen, before the choice is applied or anything committed", async () => {
    expect(await publish()).toMatchObject({ ok: false, error: "page_language_unchosen" });
    expect(state.ingests).toEqual([]);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("keeping about.md removes acerca after the snapshot and before the file set, and deletes acerca.md", async () => {
    expect(await publish(["about.md"])).toMatchObject({ ok: true });
    expect(state.ingests[0].pages.remove?.map((e) => e.pageId)).toEqual([6]);
    expect(state.ingests[0].pages.replaceContent).toBeUndefined();
    expect(state.events).toEqual(["snapshot", "ingest", "file set of pages 5"]);
    expect(publishedPageDeletions()).toEqual([`${PAGES}/acerca.md`]);
  });

  it("keeping acerca.md gives the about page its text, keeps about.md and deletes acerca.md", async () => {
    expect(await publish(["acerca.md"])).toMatchObject({ ok: true });
    const acerca = page(6, "acerca", ACERCA);
    expect(state.pages).toEqual([{ ...page(5, "about", ABOUT), title: acerca.title, body: acerca.body, frontmatter: acerca.frontmatter!.replace("localized_for: about.md\nlanguage: es\n", "") }]);
    expect(state.events).toEqual(["snapshot", "ingest", "file set of pages 5"]);
    expect(publishedPageDeletions()).toEqual([`${PAGES}/acerca.md`]);
  });

  it("enters acerca.md in the stored record with no page before the ingest", async () => {
    state.record = JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", files: { "about.md": 5 } });
    state.storedRecord = state.record;
    expect(await publish(["about.md"])).toMatchObject({ ok: true });
    expect(state.events.slice(0, 3)).toEqual(["snapshot", "record", "ingest"]);
    expect(JSON.parse(state.storedRecord!).files).toEqual({ "about.md": 5, "acerca.md": null });
  });

  it("refuses when the collaboration object holds the choice back, and commits nothing", async () => {
    state.heldBack = true;
    expect(await publish(["about.md"])).toMatchObject({ ok: false, error: "page_language_not_applied" });
    expect(state.pages.map((p) => p.id)).toEqual([5, 6]);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("publishes as before on a site with no such page, whatever the form names", async () => {
    state.pages = [page(5, "about", ABOUT)];
    expect(await publish(["acerca.md"])).toMatchObject({ ok: true });
    expect(state.ingests).toEqual([]);
    expect(publishedPageDeletions()).toEqual([]);
  });
});
