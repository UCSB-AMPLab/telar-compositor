/**
 * The `run-validation` action reads `.github/workflows/build.yml` so the
 * publish preflight can warn when the site's build workflow lacks the step that
 * encrypts private stories — the framework's second prerequisite, beside the
 * story key.
 *
 * Two properties belong to the action rather than to the validator, which is
 * pure and takes the read's outcome as a parameter:
 *   - the read is made only when a private, non-draft story exists, so a site
 *     without one pays no GitHub call;
 *   - it is pinned to the commit the stale-head check compared against, so the
 *     warning describes the tree the publish will land on rather than the
 *     default branch's tip.
 *
 * The database mock answers by table, keyed on the columns each selection asks
 * for: the action reads objects, stories, steps, layers, pages, glossary terms
 * and config, and a mock
 * that guessed from call order would answer the wrong table the moment a fetch
 * moves.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. Resolved-module-id equality is what vi.mock matches on: the route
// imports signInternalMarker from "../../workers/auth" (app/routes/ → root),
// and this file reaches the same module via "../workers/auth".
// ---------------------------------------------------------------------------

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

// Rows each table resolves to. Which set a `select(...)` call gets is decided
// by the columns it asks for, never by call order.
const { tableRows, selections, layersReadFails } = vi.hoisted(() => ({
  /** The columns of every `select(...)` the action made, in order. */
  selections: [] as Array<Record<string, unknown> | undefined>,
  /** Whether the layers query rejects, as a D1 read can. */
  layersReadFails: { current: false },
  tableRows: {
    objects: [] as unknown[],
    stories: [] as unknown[],
    steps: [] as unknown[],
    pages: [] as unknown[],
    config: [] as unknown[],
    glossary: [] as unknown[],
    layers: [] as unknown[],
  },
}));

function rowsFor(columns?: Record<string, unknown>): unknown[] {
  if (!columns) return [];
  if ("story_id" in columns && "draft" in columns) return tableRows.stories;
  if ("step_number" in columns) return tableRows.steps;
  if ("step_id" in columns) return tableRows.layers;
  if ("term_id" in columns) return tableRows.glossary;
  if ("story_key" in columns) return tableRows.config;
  if ("slug" in columns) return tableRows.pages;
  if ("object_id" in columns) return tableRows.objects;
  return [];
}

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: (columns?: Record<string, unknown>) => {
      selections.push(columns);
      const rows = rowsFor(columns);
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () =>
        Object.assign(
          layersReadFails.current && columns !== undefined && "step_id" in columns
            ? Promise.reject(new Error("D1 unavailable"))
            : Promise.resolve(rows),
          chain,
        );
      chain.limit = () => Promise.resolve(rows);
      // An ordered read (glossary terms, `glossarySheetOrder`) answers the same rows.
      chain.orderBy = () => Promise.resolve(rows);
      return chain;
    },
  })),
}));

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));

vi.mock("~/lib/membership.server", () => ({
  requirePublishingRole: vi.fn(async () => {}),
}));

// `resolvePageProject` and `siteChangedAnswer` are re-implemented here against
// the same mocked `resolveActiveProjectFromRequest`, matching the real
// module's own logic (app/lib/active-project.server.ts), because this file
// mocks the whole module rather than importing its original.
vi.mock("~/lib/active-project.server", () => {
  const resolveActiveProjectFromRequest = vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      installation_id: 55,
      head_sha: "head-sha",
      publish_snapshot: null,
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

const { getFileAtRef, getRepoHead } = vi.hoisted(() => ({
  getFileAtRef: vi.fn(async () => ({ status: "ok", content: "" }) as unknown),
  getRepoHead: vi.fn(async () => "head-sha"),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFileAtRef, getRepoHead };
});
const { sheetWarningChecksAt } = vi.hoisted(() => ({
  sheetWarningChecksAt: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock("~/lib/sheet-warning-checks.server", () => ({ sheetWarningChecksAt }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));

import { action } from "~/routes/_app.publish";
import type { ValidationResult } from "~/lib/publish.server";
import { sha256Hex } from "~/lib/story-canonical";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { gitBlobSha } from "~/lib/story-files.server";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const WORKFLOW_WITH_MARKER =
  "        run: python3 scripts/encrypt_protected_stories.py\n";
const WORKFLOW_WITHOUT_MARKER = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        GITHUB_APP_ID: "app-id",
        GITHUB_PRIVATE_KEY: "pk",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: vi.fn() })) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

function validationRequest(): Request {
  const form = new FormData();
  form.set("intent", "run-validation");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  return new Request("https://app/publish", {
    method: "POST",
    body: form,
    headers: { Cookie: "" },
  });
}

type ValidationResponse = {
  ok?: boolean;
  intent?: string;
  validation?: ValidationResult;
  resetFailed?: { page: string };
};

async function runValidationAction(): Promise<ValidationResponse> {
  return (await action({
    request: validationRequest(),
    context: buildContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as ValidationResponse;
}

function warningCodes(res: ValidationResponse): string[] {
  return (res.validation?.warnings ?? []).map((w) => w.code);
}

/** How many layers queries the action made. */
function layerQueries(): number {
  return selections.filter((columns) => columns !== undefined && "step_id" in columns).length;
}

function blockerCodes(res: ValidationResponse): string[] {
  return (res.validation?.blockers ?? []).map((b) => b.code);
}

const PRIVATE_STORY = {
  id: 1,
  story_id: "weavers",
  title: "The Weavers",
  private: true,
  draft: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  tableRows.objects = [];
  tableRows.stories = [];
  tableRows.steps = [];
  tableRows.pages = [];
  tableRows.config = [{ story_key: "s3cret" }];
  tableRows.glossary = [];
  tableRows.layers = [];
  layersReadFails.current = false;
  selections.length = 0;
  getRepoHead.mockResolvedValue("head-sha");
  getFileAtRef.mockResolvedValue({ status: "ok", content: WORKFLOW_WITH_MARKER });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------

describe("run-validation — when the build workflow is read", () => {
  // The workflow read is still conditional; _config.yml is not, because every
  // publish writes its managed blocks and the check reports the ones the
  // writer could not edit.
  it("makes no workflow read when no private, non-draft story exists", async () => {
    tableRows.stories = [
      { id: 1, story_id: "public", title: "Public", private: false, draft: false },
      { id: 2, story_id: "wip", title: "WIP", private: true, draft: true },
    ];

    const res = await runValidationAction();

    expect(getFileAtRef).toHaveBeenCalledTimes(1);
    expect(getFileAtRef).toHaveBeenCalledWith(
      "install-token",
      "owner",
      "repo",
      "_config.yml",
      expect.any(String),
    );
    expect(warningCodes(res)).not.toContain("private_story_workflow_stale");
  });

  it("reads build.yml once, at the commit the stale check compared against", async () => {
    tableRows.stories = [PRIVATE_STORY];
    getRepoHead.mockResolvedValue("validated-head");

    await runValidationAction();

    // Two reads: the workflow and _config.yml, both pinned to that commit.
    expect(getFileAtRef).toHaveBeenCalledTimes(2);
    expect(getFileAtRef).toHaveBeenCalledWith(
      "install-token",
      "owner",
      "repo",
      "_config.yml",
      "validated-head",
    );
    expect(getFileAtRef).toHaveBeenCalledWith(
      "install-token",
      "owner",
      "repo",
      ".github/workflows/build.yml",
      "validated-head",
    );
  });
});

describe("run-validation — what the read produces", () => {
  it("warns when the workflow does not run the encryption step", async () => {
    tableRows.stories = [PRIVATE_STORY];
    getFileAtRef.mockResolvedValue({ status: "ok", content: WORKFLOW_WITHOUT_MARKER });

    const res = await runValidationAction();

    expect(warningCodes(res)).toContain("private_story_workflow_stale");
  });

  it("stays quiet when the workflow runs the encryption step", async () => {
    tableRows.stories = [PRIVATE_STORY];
    getFileAtRef.mockResolvedValue({ status: "ok", content: WORKFLOW_WITH_MARKER });

    const res = await runValidationAction();

    expect(warningCodes(res)).not.toContain("private_story_workflow_stale");
  });

  it("stays quiet on a failed read, still returns ok, and logs each one", async () => {
    tableRows.stories = [PRIVATE_STORY];
    getFileAtRef.mockResolvedValue({ status: "error" });

    const res = await runValidationAction();

    expect(res.ok).toBe(true);
    expect(warningCodes(res)).not.toContain("private_story_workflow_stale");
    // One line per file it could not read: the workflow and _config.yml.
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("logs the error behind a failed check and does not carry its text to the page", async () => {
    getRepoHead.mockRejectedValue(new Error("GitHub GraphQL error: 502"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runValidationAction();

    expect(res).toEqual({ ok: false, intent: "run-validation", error: "validation_failed" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("run-validation"), expect.any(Error));
  });

  it("reports no unwritable block when _config.yml could not be read", async () => {
    getFileAtRef.mockResolvedValue({ status: "error" });

    const res = await runValidationAction();

    expect(blockerCodes(res)).not.toContain("config_block_unwritable");
  });

  it("blocks a publish when a managed block is written in a shape it cannot edit", async () => {
    getFileAtRef.mockResolvedValue({
      status: "ok",
      content: "story_interface: {show_on_homepage: false}\n",
    });

    const res = await runValidationAction();

    const blocker = (res.validation?.blockers ?? []).find(
      (b) => b.code === "config_block_unwritable",
    );
    expect(blocker?.params).toEqual({ block: "story_interface" });
  });
});

// ---------------------------------------------------------------------------
// This intent is the pass whose Checks display the author actually
// sees. It fetches real object rows (unlike the publish action's post-snapshot
// re-check, which is a separate, narrower pass — see
// publish-action-revalidates.test.ts), so a reserved column must surface here.
// ---------------------------------------------------------------------------
describe("run-validation — reserved object column", () => {
  it("surfaces object_reserved_column as a blocker, naming the object and column", async () => {
    tableRows.objects = [
      { object_id: "sculpture-1", title: "A Sculpture", extra_columns: JSON.stringify({ _metadata: "x" }) },
    ];

    const res = await runValidationAction();

    expect(blockerCodes(res)).toContain("object_reserved_column");
    const blocker = res.validation?.blockers.find((b) => b.code === "object_reserved_column");
    expect(blocker?.params).toEqual({ id: "sculpture-1", column: "_metadata" });
  });

  it("stays quiet for an object with an ordinary custom column", async () => {
    tableRows.objects = [
      { object_id: "sculpture-1", title: "A Sculpture", extra_columns: JSON.stringify({ procedencia: "Bogotá" }) },
    ];

    const res = await runValidationAction();

    expect(blockerCodes(res)).not.toContain("object_reserved_column");
  });
});

// ---------------------------------------------------------------------------
// A page's kept front matter that no edit can retitle is a blocker
// here, including a block carried forward from the file of a page never
// captured; the blocker's reset travels with a re-run of the checks.
// ---------------------------------------------------------------------------
describe("run-validation — page front matter", () => {
  const UNWRITABLE_FILE = "---\n{title: Acerca, language: es}\n---\n\nTexto.\n";

  it("blocks on a stored block that cannot take the page's title", async () => {
    tableRows.pages = [{ slug: "acerca", title: "Sobre", frontmatter: "\n{title: Acerca, language: es}\n" }];

    const res = await runValidationAction();

    const blocker = res.validation?.blockers.find((b) => b.code === "page_frontmatter_unwritable");
    expect(blocker).toMatchObject({ entityId: "acerca", params: { page: "Sobre" } });
  });

  it("blocks on a carried block, read from the file the page was imported as", async () => {
    tableRows.pages = [{ slug: "sobre", title: "Sobre", frontmatter: null, frontmatter_source: "acerca" }];
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      args[3] === "telar-content/texts/pages/acerca.md"
        ? { status: "ok", content: UNWRITABLE_FILE }
        : { status: "absent" });

    const res = await runValidationAction();

    expect(blockerCodes(res)).toContain("page_frontmatter_unwritable");
  });

  it("warns of a carried block the publish cannot read, naming the page whose settings it replaces", async () => {
    tableRows.pages = [{ slug: "sobre", title: "Sobre", frontmatter: null, frontmatter_source: "acerca" }];
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      args[3] === "telar-content/texts/pages/acerca.md"
        ? { status: "ok", content: "---\ntitle: [Acerca\n---\n\nTexto.\n" }
        : { status: "absent" });

    const res = await runValidationAction();

    const warning = res.validation?.warnings.find((w) => w.code === "page_frontmatter_replaced");
    expect(warning).toMatchObject({ entityId: "sobre", params: { page: "Sobre" } });
    expect(blockerCodes(res)).not.toContain("page_frontmatter_unwritable");
  });

  it("names the page and a fingerprint of the stored block on a settings-replaced warning", async () => {
    tableRows.pages = [{ id: 9, slug: "acerca", title: "Acerca", frontmatter: "title: [Acerca\nlanguage: es\n" }];

    const res = await runValidationAction();

    const warning = res.validation?.warnings.find((w) => w.code === "page_frontmatter_replaced");
    expect(warning?.replacedSettings).toEqual({ pageId: 9, fingerprint: await sha256Hex("title: [Acerca\nlanguage: es\n") });
  });

  it("says nothing of a page whose file could not be read", async () => {
    tableRows.pages = [{ slug: "acerca", title: "Sobre", frontmatter: null, frontmatter_source: "acerca" }];
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      args[3] === "telar-content/texts/pages/acerca.md" ? { status: "error" } : { status: "absent" });

    const res = await runValidationAction();

    expect(res.ok).toBe(true);
    expect(blockerCodes(res)).not.toContain("page_frontmatter_unwritable");
  });

  it("asks the collaboration object to keep only the page's title before it reads D1", async () => {
    const doFetch = vi.fn(async () => Response.json({ reset: 1 }));
    const context = buildContext() as unknown as { cloudflare: { env: { COLLABORATION: { get: () => unknown } } } };
    context.cloudflare.env.COLLABORATION.get = () => ({ fetch: doFetch });
    const form = new FormData();
    form.set("intent", "run-validation");
    form.set("resetPageFrontmatter", "acerca");
    // The mocked active project's id, string-compared by `resolvePageProject`.
    form.set("siteId", "7");

    await action({
      request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(doFetch).toHaveBeenCalledTimes(1);
    const request = (doFetch.mock.calls[0] as unknown as [Request])[0];
    expect(new URL(request.url).pathname).toBe("/reset-page-frontmatter");
    expect(new URL(request.url).searchParams.get("slug")).toBe("acerca");
    expect(request.method).toBe("POST");
  });

  /** Submits a reset for `slug` against a stubbed collaboration object. */
  async function runReset(slug: string, doFetch: (...args: unknown[]) => unknown): Promise<ValidationResponse> {
    const context = buildContext() as unknown as { cloudflare: { env: { COLLABORATION: { get: () => unknown } } } };
    context.cloudflare.env.COLLABORATION.get = () => ({ fetch: doFetch });
    const form = new FormData();
    form.set("intent", "run-validation");
    form.set("resetPageFrontmatter", slug);
    // The mocked active project's id, string-compared by `resolvePageProject`.
    form.set("siteId", "7");
    return (await action({
      request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0])) as ValidationResponse;
  }

  it("carries the marker when the collaboration object refuses the reset, with the blocker standing", async () => {
    tableRows.pages = [{ slug: "acerca", title: "Sobre", frontmatter: "\n{title: Acerca, language: es}\n" }];
    const res = await runReset("acerca", async () => new Response("snapshot_blocked", { status: 503 }));

    expect(res.ok).toBe(true);
    expect(blockerCodes(res)).toContain("page_frontmatter_unwritable");
    expect(res.resetFailed).toEqual({ page: "acerca" });
  });

  it("carries the marker when the collaboration object cannot be reached", async () => {
    tableRows.pages = [{ slug: "acerca", title: "Sobre", frontmatter: "\n{title: Acerca, language: es}\n" }];
    const res = await runReset("acerca", async () => { throw new Error("unreachable"); });

    expect(res.ok).toBe(true);
    expect(blockerCodes(res)).toContain("page_frontmatter_unwritable");
    expect(res.resetFailed).toEqual({ page: "acerca" });
  });

  it("carries no marker when the reset succeeds", async () => {
    const res = await runReset("acerca", async () => Response.json({ reset: 1 }));
    expect(res.resetFailed).toBeUndefined();
  });

  it("carries no marker on the page's ordinary pass", async () => {
    const res = await runValidationAction();
    expect(res.resetFailed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A repeated header the publish writes back under `name_N` is named
// before the publish, from the sheet read at the commit the stale check
// compared against. The read is made only for a sheet whose written keys carry
// such a suffix.
// ---------------------------------------------------------------------------
describe("run-validation — a repeated column the publish renames", () => {
  const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
  const STORY_CSV = "telar-content/spreadsheets/weavers.csv";

  /** Answers each path from `files`, `_config.yml` with an empty file, and any other path as absent. */
  function answerByPath(files: Record<string, unknown>) {
    getFileAtRef.mockImplementation(async (...args: unknown[]) => {
      const path = args[3] as string;
      if (path in files) return files[path];
      return path === "_config.yml" ? { status: "ok", content: "" } : { status: "absent" };
    });
  }

  const readPaths = () => getFileAtRef.mock.calls.map((call) => (call as unknown[])[3]);

  const STORIES = [
    { id: 1, story_id: "weavers", title: "The Weavers", private: false, draft: false },
    { id: 2, story_id: "dyers", title: "The Dyers", private: false, draft: false },
  ];

  it("makes no layers query when no story's steps carry a suffixed key", async () => {
    tableRows.stories = STORIES;
    tableRows.steps = [
      { id: 11, step_number: 1, kind: "media", object_id: "loom", x: null, y: null, zoom: null,
        question: null, answer: null, extra_columns: '{"notes":"a"}' },
    ];

    await runValidationAction();

    expect(layerQueries()).toBe(0);
    expect(readPaths()).toEqual(["_config.yml"]);
  });

  it("makes one layers query for the whole site when stories pass the gate", async () => {
    tableRows.stories = STORIES;
    tableRows.steps = [
      { id: 11, step_number: 1, kind: "media", object_id: "loom", x: null, y: null, zoom: null,
        question: null, answer: null, extra_columns: '{"notes_1":"a"}' },
    ];

    await runValidationAction();

    expect(layerQueries()).toBe(1);
  });

  it("reads objects.csv strictly at the validated head and names the renamed column", async () => {
    getRepoHead.mockResolvedValue("head-sha");
    tableRows.objects = [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }];
    answerByPath({ [OBJECTS_CSV]: { status: "ok", content: "object_id,title,notes,notes\nloom,Loom,a,b\n" } });

    const res = await runValidationAction();

    expect(getFileAtRef).toHaveBeenCalledWith("install-token", "owner", "repo", OBJECTS_CSV, "head-sha", {
      strict: true,
    });
    expect(res.validation?.warnings.find((w) => w.code === "renamed_duplicate_column")).toEqual({
      code: "renamed_duplicate_column",
      message: "renamed_duplicate_column",
      entityId: "objects.csv/notes",
      params: { file: "objects.csv", column: "notes", renamed: "notes_1" },
    });
  });

  it("makes no sheet read while the head has moved", async () => {
    getRepoHead.mockResolvedValue("moved-head");
    tableRows.objects = [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }];
    answerByPath({ [OBJECTS_CSV]: { status: "ok", content: "object_id,title,notes,notes\nloom,Loom,a,b\n" } });

    const res = await runValidationAction();

    expect(blockerCodes(res)).toContain("stale_head");
    expect(readPaths()).not.toContain(OBJECTS_CSV);
    expect(warningCodes(res)).not.toContain("renamed_duplicate_column");
  });

  it("stays quiet and still returns ok when the sheet cannot be read", async () => {
    tableRows.objects = [{ object_id: "loom", title: "Loom", extra_columns: '{"notes":"a","notes_1":"b"}' }];
    answerByPath({ [OBJECTS_CSV]: { status: "error" } });

    const res = await runValidationAction();

    expect(res.ok).toBe(true);
    expect(readPaths()).toContain(OBJECTS_CSV);
    expect(warningCodes(res)).not.toContain("renamed_duplicate_column");
  });

  it("judges a story step by its kind and layers, as the story CSV's writer does", async () => {
    // The step holds only an instruction cell, which does not make it a row;
    // its layer panel does, so the step and its `#note_1` are written.
    tableRows.stories = [{ id: 1, story_id: "weavers", title: "The Weavers", private: false, draft: false }];
    tableRows.steps = [
      { id: 11, step_number: 1, kind: "media", object_id: null, x: null, y: null, zoom: null,
        question: null, answer: null, extra_columns: '{"#note_1":"text"}' },
    ];
    tableRows.layers = [{ step_id: 11, title: "The loom", content: "" }];
    answerByPath({ [STORY_CSV]: { status: "ok", content: "step,#note,#note\n1,,text\n" } });

    const res = await runValidationAction();

    expect(readPaths()).toContain(STORY_CSV);
    expect(res.validation?.warnings.find((w) => w.code === "renamed_duplicate_column")?.params).toEqual({
      file: "weavers.csv",
      column: "#note",
      renamed: "#note_1",
    });
  });

  it("makes no read for a story step the writer drops", async () => {
    tableRows.stories = [{ id: 1, story_id: "weavers", title: "The Weavers", private: false, draft: false }];
    tableRows.steps = [
      { id: 11, step_number: 1, kind: "media", object_id: null, x: null, y: null, zoom: null,
        question: null, answer: null, extra_columns: '{"#note_1":"text"}' },
    ];
    answerByPath({ [STORY_CSV]: { status: "ok", content: "step,#note,#note\n1,,text\n" } });

    const res = await runValidationAction();

    expect(readPaths()).not.toContain(STORY_CSV);
    expect(warningCodes(res)).not.toContain("renamed_duplicate_column");
  });
});

// ---------------------------------------------------------------------------
// The story column blockers judge the steps the story CSV writes, and a step
// with no content of its own is written only if it has a panel. The layers
// are read only when they could change a verdict, in the same query the
// renamed-column check uses.
// ---------------------------------------------------------------------------
describe("run-validation — story column blockers judge the written steps", () => {
  const STORY_CSV = "telar-content/spreadsheets/weavers.csv";

  /** Step 1 carries `Example`; step 2, with no content of its own, carries `example`. */
  function seedDroppedExampleStep(step1Extras: Record<string, string> = { Example: "a" }) {
    tableRows.stories = [{ id: 1, story_id: "weavers", title: "The Weavers", private: false, draft: false }];
    tableRows.steps = [
      { id: 11, step_number: 1, kind: "media", object_id: "loom", x: 0.5, y: 0.5, zoom: 1,
        question: null, answer: null, extra_columns: JSON.stringify(step1Extras) },
      { id: 12, step_number: 2, kind: "media", object_id: null, x: null, y: null, zoom: null,
        question: null, answer: null, extra_columns: '{"example":"b"}' },
    ];
  }

  it("does not block a column only a step the story CSV leaves out carries, reading the layers once", async () => {
    seedDroppedExampleStep();

    const res = await runValidationAction();

    expect(res.ok).toBe(true);
    expect(blockerCodes(res)).not.toContain("story_colliding_columns");
    expect(layerQueries()).toBe(1);
  });

  it("makes no layers query when the columns of every step raise no blocker", async () => {
    tableRows.stories = [{ id: 1, story_id: "weavers", title: "The Weavers", private: false, draft: false }];
    tableRows.steps = [
      { id: 11, step_number: 1, kind: "media", object_id: "loom", x: 0.5, y: 0.5, zoom: 1,
        question: null, answer: null, extra_columns: '{"nota":"a"}' },
      { id: 12, step_number: 2, kind: "media", object_id: null, x: null, y: null, zoom: null,
        question: null, answer: null, extra_columns: '{"example":"b"}' },
    ];

    await runValidationAction();

    expect(layerQueries()).toBe(0);
  });

  it("makes one layers query when the blocker and the renamed-column check both need them", async () => {
    seedDroppedExampleStep({ Example: "a", notes: "x", notes_1: "y" });
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      args[3] === STORY_CSV
        ? { status: "ok", content: "step,object,notes,notes,Example\n1,loom,x,y,a\n" }
        : { status: "ok", content: "" },
    );

    const res = await runValidationAction();

    expect(layerQueries()).toBe(1);
    expect(warningCodes(res)).toContain("renamed_duplicate_column");
    expect(blockerCodes(res)).not.toContain("story_colliding_columns");
  });

  it("judges every step when the layers cannot be read", async () => {
    seedDroppedExampleStep();
    layersReadFails.current = true;

    const res = await runValidationAction();

    expect(res.ok).toBe(true);
    expect(res.validation?.blockers.find((b) => b.code === "story_colliding_columns")?.params).toEqual({
      story: "The Weavers",
      columns: '"Example", "example"',
    });
  });
});

// The sheets' own warnings are the sheet-warning check's concern (its own
// spec); here the action must call it with every story and the strict reader
// at the head the stale check compared against, and list what it returns.
describe("run-validation — warnings in the sheets on GitHub", () => {
  it("lists what the sheet check returns, reading each story's sheet at the head", async () => {
    tableRows.stories = [
      { id: 1, story_id: "weavers", title: "The Weavers", private: false, draft: false },
      { id: 2, story_id: "dyers", title: "The Dyers", private: false, draft: false },
    ];
    sheetWarningChecksAt.mockResolvedValueOnce([{ code: "sheet_warning", message: "sheet_warning", entityId: "objects.csv/0" }]);

    const res = await runValidationAction();

    expect(warningCodes(res)).toContain("sheet_warning");
    const [, storyIds, read] = sheetWarningChecksAt.mock.calls[0] as unknown as [unknown, string[], (p: string) => Promise<unknown>];
    expect(storyIds).toEqual(["weavers", "dyers"]);
    getFileAtRef.mockClear();
    await read("telar-content/spreadsheets/objects.csv");
    expect(getFileAtRef).toHaveBeenCalledWith(
      "install-token", expect.anything(), expect.anything(), "telar-content/spreadsheets/objects.csv", "head-sha", { strict: true },
    );
  });
});

describe("run-validation — the Google Sheets settings the sheet check reads by", () => {
  it("passes the settings of _config.yml at the head", async () => {
    const url = "https://docs.google.com/spreadsheets/d/e/X/pubhtml";
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      args[3] === "_config.yml"
        ? { status: "ok", content: `\uFEFFgoogle_sheets:\n  enabled: true\n  published_url: "${url}"\n` }
        : { status: "ok", content: WORKFLOW_WITH_MARKER },
    );
    await runValidationAction();
    expect(sheetWarningChecksAt.mock.calls[0][3]).toEqual({ enabled: true, publishedUrl: url });
  });

  it("passes none when _config.yml is not there", async () => {
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      args[3] === "_config.yml" ? { status: "absent" } : { status: "ok", content: WORKFLOW_WITH_MARKER },
    );
    await runValidationAction();
    expect(sheetWarningChecksAt.mock.calls[0][3]).toBeNull();
  });
});

describe("run-validation — a recorded story file changed on GitHub", () => {
  const GONE = "telar-content/spreadsheets/gone.csv";

  async function withRecord(onGithub: string): Promise<ValidationResponse> {
    vi.mocked(resolveActiveProjectFromRequest).mockResolvedValueOnce({
      project: {
        id: 7, github_repo_full_name: "owner/repo", installation_id: 55, head_sha: "head-sha", publish_snapshot: null,
        story_files_to_delete_json: JSON.stringify([{ path: GONE, sha: await gitBlobSha("as read\n") }]),
      },
      userRole: "convenor",
    } as never);
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      ({ status: "ok", content: args[3] === GONE ? onGithub : "" }));
    return runValidationAction();
  }

  it("names a file that is no longer the blob read, as a warning", async () => {
    const res = await withRecord("edited on GitHub\n");
    expect(res.validation?.warnings.find((w) => w.code === "story_file_kept_changed")).toMatchObject({ params: { file: GONE } });
    expect(blockerCodes(res)).toEqual([]);
  });

  it("shows no warning when the file cannot be read there, and does not fail the checks", async () => {
    vi.mocked(resolveActiveProjectFromRequest).mockResolvedValueOnce({
      project: {
        id: 7, github_repo_full_name: "owner/repo", installation_id: 55, head_sha: "head-sha", publish_snapshot: null,
        story_files_to_delete_json: JSON.stringify([{ path: GONE, sha: await gitBlobSha("as read\n") }]),
      },
      userRole: "convenor",
    } as never);
    getFileAtRef.mockImplementation(async (...args: unknown[]) =>
      (args[3] === GONE ? { status: "error" } : { status: "ok", content: "" }));
    const res = await runValidationAction();
    expect(res.ok).toBe(true);
    expect(warningCodes(res)).not.toContain("story_file_kept_changed");
  });

  it("is silent while the file is the blob read", async () => {
    expect(warningCodes(await withRecord("as read\n"))).not.toContain("story_file_kept_changed");
  });
});
