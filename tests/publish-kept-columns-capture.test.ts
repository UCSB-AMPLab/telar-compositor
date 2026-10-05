/**
 * A publish reads a story's kept columns before it rewrites the story's CSV
 * from D1: a story imported before steps kept their unmapped
 * columns publishes with them rather than without.
 *
 * Runs the publish action with the real file set, the real capture and the
 * real commit primitive. The database is stood in for by table, the
 * repository's story files are served at the network (`story-repo-fetch`),
 * and the collaboration object is a fake that writes a capture into the
 * stood-in steps table as its flush writes D1, then answers as the arm does.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Papa from "papaparse";

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => 1 }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
// The story files are read through the real reader; every other file is
// absent, as in tests/story-csv-passthrough.test.ts.
vi.mock("~/lib/github.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/github.server")>();
  return {
    ...actual,
    getRepoHead: vi.fn(async () => "sha"),
    getFileAtRef: vi.fn(async (...args: Parameters<typeof actual.getFileAtRef>) =>
      args[3].startsWith("telar-content/") && args[3] !== "telar-content/spreadsheets/objects.csv"
        ? actual.getFileAtRef(...args)
        : { status: "absent" as const }),
  };
});
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
    resolvePageProject: vi.fn(async (_request: Request, _env: unknown, _userId: number, formData: FormData) => {
      const resolved = await resolveActiveProjectFromRequest();
      if (formData.get("siteId") !== String(resolved.project.id)) {
        return { kind: "site_changed", currentSiteName: resolved.project.github_repo_full_name };
      }
      return { kind: "ok", ...resolved };
    }),
    siteChangedAnswer: vi.fn(),
  };
});

const { tableRows } = vi.hoisted(() => ({ tableRows: { current: {} as Record<string, Array<Record<string, unknown>>> } }));

function tableName(table: unknown): string {
  if (table === null || typeof table !== "object") return "unknown";
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.description === "drizzle:Name");
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
}

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let rows: unknown[] = [];
      chain.from = (table: unknown) => {
        rows = tableRows.current[tableName(table)] ?? [];
        return chain;
      };
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      chain.orderBy = () => Promise.resolve(rows);
      return chain;
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));

import { action } from "~/routes/_app.publish";
import { __clearStoryBlobCacheForTest } from "~/lib/story-files.server";
import { renderStoryFiles } from "~/lib/publish.server";
import { SHEETS, TEXTS, addStoryCommit, emptyStoryRepo, storyRepoAnswer } from "./helpers/story-repo-fetch";
import type { StoryRepo } from "./helpers/story-repo-fetch";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Capture {
  storyId: string;
  expected: string;
  steps: Array<{ stepId: number; extra_columns: string }>;
  inserts?: Array<{ afterStepId: number | null; step: Record<string, unknown> }>;
}

/**
 * An insert as the snapshot lands it: a section step after the step it
 * names, after any inserted there before it, the story renumbered in order as
 * the snapshot numbers steps by rank.
 */
function landInserts(inserts: NonNullable<Capture["inserts"]>): void {
  const rows = tableRows.current.steps;
  let nextId = 100;
  let previous: { after: number | null; at: number } | null = null;
  for (const { afterStepId, step } of inserts) {
    const at: number = previous?.after === afterStepId ? previous.at + 1 : afterStepId === null ? 0 : rows.findIndex((r) => r.id === afterStepId) + 1;
    rows.splice(at, 0, {
      story: 1, story_id: "historia", story_title: "Historia", id: nextId++, order_key: null, kind: "section",
      object_id: null, x: null, y: null, zoom: null, page: null, question: null, answer: null, alt_text: null,
      clip_start: null, clip_end: null, loop: null, ...step,
    });
    previous = { after: afterStepId, at };
  }
  rows.forEach((row, rank) => { row.step_number = rank + 1; });
}

let captureAnswer: (captures: Capture[]) => Record<string, unknown>;
const ingests: Capture[][] = [];

/** The collaboration object: a snapshot answers 200; a capture lands in the steps table, then answers. */
const doFetch = vi.fn(async (request: Request) => {
  if (!request.url.endsWith("/ingest-sync")) return new Response("OK", { status: 200 });
  const captures = ((await request.json()) as { steps: { captureKeptColumns: Capture[] } }).steps.captureKeptColumns;
  ingests.push(captures);
  const answer = captureAnswer(captures);
  const captured = (answer.keptColumns as { captured: string[] }).captured;
  for (const c of captures.filter((c) => captured.includes(c.storyId))) {
    for (const step of c.steps) {
      const row = tableRows.current.steps.find((r) => r.id === step.stepId)!;
      row.extra_columns = step.extra_columns;
    }
    landInserts(c.inserts ?? []);
  }
  return Response.json(answer);
});

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u", github_name: "U", github_email: "u@e.co" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: doFetch })) },
      },
    },
  } as unknown as Record<string, unknown>;
}

async function runPublish() {
  const form = new FormData();
  form.set("siteId", "7");
  form.set("intent", "publish");
  form.set("commitMessage", "Update site");
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as never)) as { ok?: boolean; error?: string };
}

let repo: StoryRepo;
let fetchMock: ReturnType<typeof vi.fn>;

/** GitHub: the story files from `repo`, and the head, path check and commit the publish sends. */
function githubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const query = url === "https://api.github.com/graphql" ? String(JSON.parse(String(init?.body)).query) : "";
    if (!query || query.includes("SubtreeOids")) {
      const answer = await storyRepoAnswer(repo, input, init);
      if (answer) return answer;
      throw new Error(`unexpected request: ${url}`);
    }
    const json = query.includes("GetHeadOid")
      ? { data: { repository: { ref: { target: { oid: "sha" } } } } }
      : query.includes("CheckPaths")
        ? { data: { repository: {} } }
        : { data: { createCommitOnBranch: { commit: { oid: "new-sha", url: "u" } } } };
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

/** Every file each CreateCommit carried, decoded, in commit order. */
function commitsSent(): Array<Record<string, string>> {
  const commits: Array<Record<string, string>> = [];
  for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
    if (String(url) !== "https://api.github.com/graphql") continue;
    const body = JSON.parse((init?.body as string) ?? "{}");
    if (!String(body.query).includes("CreateCommit")) continue;
    const files: Record<string, string> = {};
    for (const a of body.variables.input.fileChanges.additions as Array<{ path: string; contents: string }>) {
      files[a.path] = Buffer.from(a.contents, "base64").toString("utf-8");
    }
    commits.push(files);
  }
  return commits;
}

/** A step as an import from before steps kept their columns left it: its kept columns never recorded. */
function importedStep(id: number, rank: number, question: string) {
  return {
    story: 1, story_id: "historia", story_title: "Historia",
    id, step_number: rank, order_key: `a${rank}`, kind: "media", object_id: "obj-1", x: 0.5, y: 0.5, zoom: 1,
    page: null, question, answer: `Respuesta ${rank}`, alt_text: null, clip_start: null, clip_end: null, loop: null,
    extra_columns: null,
  };
}

const AUTHOR_CSV =
  "step,object,x,y,zoom,question,answer,Nota del autor\n" +
  "1,obj-1,0.5,0.5,1,Primera,Respuesta 1,una nota\n" +
  "2,obj-1,0.5,0.5,1,Segunda,Respuesta 2,otra nota\n";

beforeEach(async () => {
  vi.clearAllMocks();
  ingests.length = 0;
  __clearStoryBlobCacheForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  tableRows.current = {
    stories: [{ id: 1, story_id: "historia", title: "Historia", draft: false, private: false, order: 1 }],
    objects: [{ object_id: "obj-1", title: "Mapa" }],
    project_pages: [],
    glossary_terms: [],
    project_config: [{ project_id: 7, title: "Site", navigation_json: null }],
    project_landing: [],
    steps: [importedStep(11, 1, "Primera"), importedStep(12, 2, "Segunda")],
    layers: [],
    projects: [],
  };
  repo = emptyStoryRepo();
  await addStoryCommit(repo, "sha", { [`${SHEETS}/historia.csv`]: AUTHOR_CSV });
  captureAnswer = (captures) => ({
    refused: { stepCaptureKeptColumns: [] },
    keptColumns: { captured: captures.map((c) => c.storyId), changed: [], missing: [], failed: [] },
  });
  fetchMock = githubFetch();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("a story whose kept columns D1 never recorded", () => {
  it("publishes its CSV with the columns the file holds", async () => {
    expect(await runPublish()).toMatchObject({ ok: true });
    const [files] = commitsSent();
    const [header, , ...data] = Papa.parse<string[]>(files[`${SHEETS}/historia.csv`], { skipEmptyLines: true }).data;
    // In the file's own layout, where the author's file has the column.
    const note = header.indexOf("Nota del autor");
    expect(note).toBe(7);
    expect(data.map((row) => row[note])).toEqual(["una nota", "otra nota"]);
    expect(ingests).toHaveLength(1);
  });

  it("refuses, committing nothing, when its CSV cannot be read", async () => {
    repo.failing.add(`sha:${SHEETS}/historia.csv`);
    expect(await runPublish()).toMatchObject({ ok: false, error: "stories_unreadable" });
    expect(ingests).toHaveLength(0);
    expect(commitsSent()).toHaveLength(0);
  });

  it("refuses, committing nothing, when the story changed after the read", async () => {
    captureAnswer = (captures) => ({
      refused: { stepCaptureKeptColumns: [] },
      keptColumns: { captured: [], changed: captures.map((c) => c.storyId), missing: [], failed: [] },
    });
    expect(await runPublish()).toMatchObject({ ok: false, error: "changed_during_publish" });
    expect(commitsSent()).toHaveLength(0);
  });

  it("publishes when its CSV is what D1 renders, though the texts subtree cannot be listed", async () => {
    repo = emptyStoryRepo();
    const steps = tableRows.current.steps as never;
    const csvAsRendered = (await renderStoryFiles("historia", steps, [])).find((f) => f.path === `${SHEETS}/historia.csv`)!.content;
    await addStoryCommit(repo, "sha", {
      [`${SHEETS}/historia.csv`]: csvAsRendered,
      [`${TEXTS}/historia-panel.md`]: "Body\n",
    });
    repo.listings[repo.commits.sha.texts!].truncated = true;
    expect(await runPublish()).toMatchObject({ ok: true });
    expect(ingests).toHaveLength(0);
    expect(commitsSent()).toHaveLength(1);
  });

  it("refuses as a failed snapshot, committing nothing, when the object does not take the capture", async () => {
    captureAnswer = (captures) => ({
      refused: { stepCaptureKeptColumns: [] },
      keptColumns: { captured: [], changed: [], missing: captures.map((c) => c.storyId), failed: [] },
    });
    expect(await runPublish()).toMatchObject({ ok: false, error: "snapshot_failed" });
    expect(commitsSent()).toHaveLength(0);
  });
});

describe("a story imported before steps kept their columns, with a row whose only content is in a custom column", () => {
  // The template's story layout (your-story.csv), with an author's `notes`
  // column and a row the author added with only a note in it.
  const TEMPLATE_CSV =
    "step,object,x,y,zoom,page,question,answer,layer1_button,layer1_content,layer2_button,layer2_content,clip_start,clip_end,loop,notes\n" +
    "paso,objeto,x,y,zoom,pagina,pregunta,respuesta,boton1,contenido1,boton2,contenido2,inicio_clip,fin_clip,bucle,\n" +
    "1,obj-1,0.5,0.5,1,,Primera,Respuesta 1,,,,,,,,\n" +
    "2,,,,,2,,,,,,,15,,,Check the plate number\n" +
    "3,obj-1,0.5,0.5,1,,Segunda,Respuesta 2,,,,,,,,\n";

  it("publishes the row in its place, with its page and clip cells", async () => {
    repo = emptyStoryRepo();
    await addStoryCommit(repo, "sha", { [`${SHEETS}/historia.csv`]: TEMPLATE_CSV });
    expect(await runPublish()).toMatchObject({ ok: true });
    expect(ingests[0][0].inserts).toEqual([
      { afterStepId: 11, step: { page: "2", clip_start: "15", extra_columns: JSON.stringify({ notes: "Check the plate number" }) } },
    ]);
    const [files] = commitsSent();
    const [header, , ...data] = Papa.parse<string[]>(files[`${SHEETS}/historia.csv`], { skipEmptyLines: true }).data;
    const col = (name: string) => header.indexOf(name);
    expect(data.map((row) => [row[col("question")], row[col("page")], row[col("clip_start")], row[col("notes")]])).toEqual([
      ["Primera", "", "", ""],
      ["", "2", "15", "Check the plate number"],
      ["Segunda", "", "", ""],
    ]);
  });
});
