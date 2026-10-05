/**
 * A publish records what it committed, from the rows it committed.
 *
 * The snapshot a publish writes afterwards is what the next publish compares
 * against: its `page_slugs` decide which page files are deleted, and its
 * `config_managed` is what the settings diff reads. Those used to be read
 * after the commit, so an edit landing while the commit was in flight was
 * recorded as published without being committed. The pages, the settings row
 * and the landing row are now captured once, before the file set, and the
 * commit, the deletions and the record are all made from them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => 1 }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
// The action reads _config.yml before publishing, to refuse a managed block
// its writer cannot edit. "absent" is the answer that reports nothing, which
// is what these cases are about — the commit message, not the config.
vi.mock("~/lib/github.server", () => ({
  GitHubPermissionError: class GitHubPermissionError extends Error {},
  getRepoHead: vi.fn(async () => "sha"),
  getFileAtRef: vi.fn(async () => ({ status: "absent" })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
  normalizeVersionTag: vi.fn((v: string) => v),
}));

const { commitFilesToRepo } = vi.hoisted(() => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));

// The kept-columns capture reads the story CSVs through the story subtrees,
// which this harness does not serve; it is covered by its own suites.
vi.mock("~/lib/kept-columns-capture.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  captureKeptColumns: vi.fn(async () => {}),
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet: vi.fn(async () => [{ path: "telar-content/texts/pages/about.md", content: "x" }]) };
});

// `resolvePageProject` and `siteChangedAnswer` are re-implemented here against
// the same mocked `resolveActiveProjectFromRequest`, matching the real
// module's own logic (app/lib/active-project.server.ts), because this file
// mocks the whole module rather than importing its original.
vi.mock("~/lib/active-project.server", () => {
  const resolveActiveProjectFromRequest = vi.fn(async () => ({
    project: {
      id: 7,
      head_sha: "sha",
      published_sha: null,
      last_published_at: null,
      publish_snapshot: null,
      github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo",
      installation_id: 1,
    },
    userRole: "convenor",
  }));
  return {
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number, formData: FormData) => {
      const resolved = await resolveActiveProjectFromRequest();
      if (!resolved) return { kind: "no_project" };
      if (formData.get("siteId") !== String(resolved.project.id)) {
        return { kind: "site_changed", currentSiteName: resolved.project.github_repo_full_name };
      }
      return { kind: "ok", ...resolved };
    }),
    siteChangedAnswer: vi.fn((intent: string, currentSiteName: string) => ({
      ok: false,
      intent,
      error: "site_changed",
      currentSiteName,
    })),
  };
});

// D1 stand-in keyed by drizzle's own table name, so a test can move one table's
// rows between the loader's read and the action's and nothing else changes.
const { tableRows, updates, selectsAfterCommit, commitState, afterRead } = vi.hoisted(() => ({
  tableRows: { current: {} as Record<string, unknown[]> },
  /** Every `set` the action writes, in order. */
  updates: [] as Array<Record<string, unknown>>,
  /** Tables read once the commit has been made. */
  selectsAfterCommit: [] as string[],
  commitState: { landed: false },
  /** Runs once, after the first read of a table, to land an edit just behind it. */
  afterRead: { table: "", edit: null as null | (() => void) },
}));

function tableName(table: unknown): string {
  if (table === null || typeof table !== "object") return "unknown";
  const sym = Object.getOwnPropertySymbols(table).find(
    (s) => s.description === "drizzle:Name",
  );
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
}

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let rows: unknown[] = [];
      chain.from = (table: unknown) => {
        if (commitState.landed) selectsAfterCommit.push(tableName(table));
        rows = tableRows.current[tableName(table)] ?? [];
        if (afterRead.edit && afterRead.table === tableName(table)) {
          const edit = afterRead.edit;
          afterRead.edit = null;
          edit();
        }
        return chain;
      };
      // The step fetch joins stories in; the rows it resolves to are the
      // ones its `from(steps)` already chose.
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      chain.orderBy = () => Promise.resolve(rows);
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => {} };
      },
    }),
  }),
}));

import { loader, action } from "~/routes/_app.publish";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type DOFetch = (request: Request) => Promise<Response>;
const snapshotOk: DOFetch = async () => new Response("OK", { status: 200 });

function buildContext(doFetch: DOFetch) {
  const doStub = { fetch: doFetch };
  return {
    get: vi.fn(() => ({
      id: 1,
      encrypted_access_token: "x",
      github_login: "u",
      github_name: "U",
      github_email: "u@e.co",
    })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) },
      },
    },
  } as unknown as Record<string, unknown>;
}

async function runLoader(): Promise<Record<string, unknown>> {
  return (await loader({
    request: new Request("https://app/publish", { headers: { Cookie: "" } }),
    context: buildContext(snapshotOk),
    params: {},
  } as never)) as Record<string, unknown>;
}

async function runPublish(fields: Record<string, string>) {
  const form = new FormData();
  form.set("intent", "publish");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return (await action({
    request: new Request("https://app/publish", {
      method: "POST",
      body: form,
      headers: { Cookie: "" },
    }),
    context: buildContext(snapshotOk),
    params: {},
  } as never)) as { ok?: boolean; error?: string };
}

/** The message and body the action actually handed to GitHub. */
function committed(): { message: string; body: string | undefined } {
  expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
  const call = commitFilesToRepo.mock.calls[0] as unknown[];
  return { message: call[5] as string, body: call[6] as string | undefined };
}

// A site with one story and one page. Every table the publish path reads is
// present so the real `buildEntityHashes` runs over a complete shape.
function seedRows(storyTitles: string[]) {
  tableRows.current = {
    stories: storyTitles.map((title, i) => ({
      id: i + 1,
      story_id: `story-${i + 1}`,
      title,
      draft: false,
      private: false,
    })),
    objects: [],
    project_pages: [{ slug: "about", title: "About us", body: "hi", order: 1 }],
    glossary_terms: [],
    project_config: [{ project_id: 7, title: "Site", navigation_json: null }],
    project_landing: [],
    steps: [],
    layers: [],
    projects: [],
  };
}


function seed(pages: Array<{ slug: string; title: string; body: string; order: number }>, siteTitle = "Site") {
  tableRows.current = {
    stories: [],
    objects: [{ object_id: "obj-1" }],
    project_pages: pages,
    glossary_terms: [],
    project_config: [{ project_id: 7, title: siteTitle, navigation_json: null }],
    project_landing: [],
    steps: [],
    layers: [],
    projects: [],
  };
}

async function publishWithEditDuringCommit(edit: () => void) {
  commitFilesToRepo.mockImplementationOnce(async () => {
    edit();
    commitState.landed = true;
    return { newHeadSha: "new-sha" };
  });
  return runPublish({ commitMessage: "Update site" });
}

function recordedSnapshot(): Record<string, unknown> {
  const write = updates.find((u) => typeof u.publish_snapshot === "string");
  expect(write).toBeDefined();
  return JSON.parse(write!.publish_snapshot as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  selectsAfterCommit.length = 0;
  commitState.landed = false;
  afterRead.edit = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a publish records the pages and settings it committed", () => {
  it("keeps a page it committed in the record when the page is deleted while the commit is in flight", async () => {
    seed([{ slug: "about", title: "About us", body: "hi", order: 1 }]);
    const res = await publishWithEditDuringCommit(() => {
      tableRows.current.project_pages = [];
    });
    expect(res.ok).toBe(true);
    // Recorded, so the next publish sees the page gone and deletes its file.
    expect(recordedSnapshot().page_slugs).toEqual(["about"]);
  });

  it("records the settings the commit wrote, not a save that landed during it", async () => {
    seed([], "Before");
    await publishWithEditDuringCommit(() => {
      tableRows.current.project_config = [{ project_id: 7, title: "After", navigation_json: null }];
    });
    const managed = recordedSnapshot().config_managed as Record<string, string>;
    expect(JSON.stringify(managed)).toContain("Before");
    expect(JSON.stringify(managed)).not.toContain("After");
  });

  it("reads nothing once the commit has been made", async () => {
    seed([{ slug: "about", title: "About us", body: "hi", order: 1 }]);
    const res = await publishWithEditDuringCommit(() => {});
    expect(res.ok).toBe(true);
    expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
    expect(selectsAfterCommit).toEqual([]);
  });

  it("builds, deletes and records from the capture when an edit lands while the file set is built", async () => {
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    seed([{ slug: "about", title: "About us", body: "hi", order: 1 }], "Before");
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async () => {
      // A page deleted, a page added and a settings save, all after the
      // capture and before the commit.
      tableRows.current.project_pages = [{ slug: "later", title: "Later", body: "l", order: 2 }];
      tableRows.current.project_config = [{ project_id: 7, title: "After", navigation_json: null }];
      return [{ path: "telar-content/texts/pages/about.md", content: "x" }];
    });
    const res = await publishWithEditDuringCommit(() => {});
    expect(res.ok).toBe(true);

    const params = vi.mocked(buildPublishFileSet).mock.calls[0][0] as {
      pages: Array<{ slug: string }>;
      config: { title: string };
      landing: unknown;
    };
    expect(params.pages.map((p) => p.slug)).toEqual(["about"]);
    expect(params.config.title).toBe("Before");
    expect(params.landing).toBeNull();

    const deletions = ((commitFilesToRepo.mock.calls[0] as unknown[])[7] as string[] | undefined) ?? [];
    expect(deletions).not.toContain("telar-content/texts/pages/about.md");

    const snapshot = recordedSnapshot();
    expect(snapshot.page_slugs).toEqual(["about"]);
    const hashes = snapshot.entity_hashes as { pages: Record<string, string> };
    expect(Object.keys(hashes.pages)).toEqual(["about"]);
    expect(JSON.stringify(snapshot.config_managed)).toContain("Before");
  });

  it("hands the file set the rows it records, and deletes a page gone before the capture", async () => {
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    seed([{ slug: "kept", title: "Kept", body: "k", order: 1 }]);
    const { resolveActiveProjectFromRequest } = await import("~/lib/active-project.server");
    vi.mocked(resolveActiveProjectFromRequest).mockResolvedValueOnce({
      project: {
        id: 7, head_sha: "sha", published_sha: "old", last_published_at: null,
        publish_snapshot: JSON.stringify({ story_ids: [], object_ids: [], page_slugs: ["kept", "gone"], config_hash: "", landing_hash: "" }),
        github_repo_full_name: "owner/repo", github_pages_url: "https://owner.github.io/repo", installation_id: 1,
      },
      userRole: "convenor",
    } as never);
    await publishWithEditDuringCommit(() => {});

    const params = vi.mocked(buildPublishFileSet).mock.calls[0][0] as { pages: Array<{ slug: string }>; config: unknown };
    expect(params.pages.map((p) => p.slug)).toEqual(["kept"]);
    const deletions = (commitFilesToRepo.mock.calls[0] as unknown[])[7] as string[];
    expect(deletions).toContain("telar-content/texts/pages/gone.md");
    expect(deletions).not.toContain("telar-content/texts/pages/kept.md");
  });

  it("deletes the file a page was imported as when it is published under another slug, with no snapshot", async () => {
    seed([{ slug: "acerca", title: "Acerca", body: "a", order: 1, frontmatter: "title: About", frontmatter_source: "about" }] as never);
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async () => [{ path: "telar-content/texts/pages/acerca.md", content: "x" }]);
    const res = await publishWithEditDuringCommit(() => {});
    expect(res.ok).toBe(true);
    const deletions = ((commitFilesToRepo.mock.calls[0] as unknown[])[7] as string[] | undefined) ?? [];
    expect(deletions).toContain("telar-content/texts/pages/about.md");
    // Once the commit has landed and been recorded, the page no longer names
    // the file, so the next publish asks nothing of that path.
    const recorded = updates.findIndex((u) => typeof u.publish_snapshot === "string");
    const cleared = updates.findIndex((u) => "frontmatter_source" in u);
    expect(updates[cleared]).toEqual({ frontmatter_source: null });
    expect(cleared).toBeGreaterThan(recorded);
  });

  it("asks the commit to delete the _data copy, and not the root copy, of a story with no recorded path", async () => {
    seedRows(["First"]);
    (tableRows.current.stories[0] as Record<string, unknown>).source_path = null;
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async () => [
      { path: "telar-content/spreadsheets/story-1.csv", content: "step\n1\n" },
    ]);
    const res = await publishWithEditDuringCommit(() => {});
    expect(res.ok).toBe(true);
    const older = (commitFilesToRepo.mock.calls[0] as unknown[])[10] as Array<{ path: string }>;
    expect(older.map((c) => c.path)).toEqual(["_data/story-1.csv"]);
  });

  it("answers validation_blocked, committing nothing, when the file set finds story columns the checks refuse", async () => {
    seed([{ slug: "about", title: "About us", body: "hi", order: 1 }]);
    const { buildPublishFileSet, StoryColumnsBlockedError } = await import("~/lib/publish.server");
    vi.mocked(buildPublishFileSet).mockRejectedValueOnce(new StoryColumnsBlockedError("historia"));
    const res = await runPublish({ commitMessage: "Update site" });
    expect(res).toMatchObject({ ok: false, error: "validation_blocked" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("keeps the file a page was imported as when another held page has its slug", async () => {
    seed([
      { slug: "acerca", title: "Acerca", body: "a", order: 1, frontmatter: "title: About", frontmatter_source: "about" },
      { slug: "about", title: "About", body: "b", order: 2, frontmatter: "title: About", frontmatter_source: null },
    ] as never);
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async () => [{ path: "telar-content/texts/pages/acerca.md", content: "x" }]);
    const res = await publishWithEditDuringCommit(() => {});
    expect(res.ok).toBe(true);
    const deletions = ((commitFilesToRepo.mock.calls[0] as unknown[])[7] as string[] | undefined) ?? [];
    expect(deletions).not.toContain("telar-content/texts/pages/about.md");
    // The file was not deleted, so the page still carries from it.
    expect(updates.some((u) => "frontmatter_source" in u)).toBe(false);
  });

  it("records the hashes of the pages it captured, when a page changes right after the capture", async () => {
    seed([{ slug: "about", title: "About us", body: "hi", order: 1 }]);
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async (params: { pages?: Array<{ slug: string }> }) =>
      (params.pages ?? []).map((p) => ({ path: `telar-content/texts/pages/${p.slug}.md`, content: "x" })));
    // The capture reads the pages, then the landing row: an edit landed on the
    // landing read is behind the captured pages and ahead of any page read
    // the hashes would make of their own.
    afterRead.table = "project_landing";
    afterRead.edit = () => {
      tableRows.current.project_pages = [{ slug: "renamed", title: "Renamed", body: "r", order: 1 }];
    };
    const res = await publishWithEditDuringCommit(() => {});
    expect(res.ok).toBe(true);
    expect(afterRead.edit).toBeNull();

    const params = vi.mocked(buildPublishFileSet).mock.calls[0][0] as { pages: Array<{ slug: string }> };
    expect(params.pages.map((p) => p.slug)).toEqual(["about"]);
    const hashes = recordedSnapshot().entity_hashes as { pages: Record<string, string> };
    expect(Object.keys(hashes.pages)).toEqual(["about"]);
  });
});

describe("a publish removes an older copy of a story it writes", () => {
  it("hands the commit the older copy each story it writes was read from, and of no other story", async () => {
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    seedRows(["One", "Two"]);
    (tableRows.current.stories[0] as Record<string, unknown>).source_path = "_data/story-1.csv";
    (tableRows.current.stories[1] as Record<string, unknown>).source_path = "_data/story-2.csv";
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async () => [
      { path: "telar-content/spreadsheets/story-1.csv", content: "step\n1\n" },
    ]);
    const res = await publishWithEditDuringCommit(() => {});
    expect(res).toMatchObject({ ok: true });

    const older = (commitFilesToRepo.mock.calls[0] as unknown[])[10];
    expect(older).toEqual([
      { path: "_data/story-1.csv", unlessPresent: ["telar-content/spreadsheets/story-1.csv"], onlyIfUnreadable: true },
    ]);
  });
});

describe("a publish removes the _data copy of a story deleted since the import", () => {
  const PROJECT = "telar-content/spreadsheets/project.csv";

  afterEach(async () => {
    const { getFileAtRef } = await import("~/lib/github.server");
    vi.mocked(getFileAtRef).mockImplementation(async () => ({ status: "absent" }));
  });

  /** GitHub's project.csv answers `answer`; every other file is absent. */
  async function projectCsvAnswers(answer: { status: "ok"; content: string } | { status: "error" }) {
    const { getFileAtRef } = await import("~/lib/github.server");
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
      path === PROJECT ? answer : { status: "absent" });
  }

  it("hands the commit the _data copy of a story project.csv lists and D1 no longer has, and never its root copy", async () => {
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    seedRows(["One"]);
    (tableRows.current.stories[0] as Record<string, unknown>).source_path = "story-1.csv";
    await projectCsvAnswers({ status: "ok", content: "story_id,title\nstory-1,One\nstory-9,Gone\n" });
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async () => [
      { path: "telar-content/spreadsheets/story-1.csv", content: "step\n1\n" },
    ]);
    const res = await publishWithEditDuringCommit(() => {});
    expect(res).toMatchObject({ ok: true });

    const older = (commitFilesToRepo.mock.calls[0] as unknown[])[10] as Array<{ path: string }>;
    expect(older.map((c) => c.path)).toEqual(["_data/story-1.csv", "story-1.csv", "_data/story-9.csv"]);
    expect(older[2]).toEqual({
      path: "_data/story-9.csv",
      unlessPresent: ["telar-content/spreadsheets/story-9.csv"],
      onlyIfUnreadable: true,
    });
  });

  it("refuses the publish with nothing committed when project.csv cannot be read", async () => {
    seedRows(["One"]);
    await projectCsvAnswers({ status: "error" });
    const res = await runPublish({ commitMessage: "Update site" });
    expect(res).toMatchObject({ ok: false, error: "project_unreadable" });
    const logged = vi.mocked(console.error).mock.calls.flat().find((a) => a instanceof Error) as Error;
    expect(logged.message).toContain(PROJECT);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(updates.some((u) => typeof u.publish_snapshot === "string")).toBe(false);
  });
});
