/**
 * `restore-orphan-drafts` answers with what its story parses found wrong in
 * the files it restored, each named by its sheet, through the real
 * parse and mapper. Only GitHub, D1 and the collaboration object are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const files: Record<string, string> = {};
/** The files whose bytes are not valid UTF-8. */
const lossy = new Set<string>();

/** Each `set` the action writes to D1. */
const dbSets: Array<Record<string, unknown>> = [];
const dbMock = {
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  update: vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      dbSets.push(values);
      return { where: vi.fn(async () => undefined) };
    }),
  })),
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
  getRepoHead: vi.fn(async () => "head-sha"),
  getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string) => files[path] ?? null),
  // The restore reads strictly at the head it resolves.
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) => {
    if (files[path] === undefined) return { status: "absent" };
    return lossy.has(path) ? { status: "ok", content: files[path], lossy: true } : { status: "ok", content: files[path] };
  }),
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
vi.mock("~/lib/import.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/import.server")>();
  return { ...actual, scanRepoOrphanStoryIds: vi.fn(async () => ["story-one", "story-two"]) };
});
vi.mock("~/lib/internal-marker.server", () => ({ makeInternalMarkerHeaders: vi.fn(async () => ({})) }));
// The published sheet's tabs, listed only when a warning names a sheet and
// Google Sheets is on.
vi.mock("~/lib/sheets.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sheets.server")>()),
  discoverSheetTabs: vi.fn(async () => [{ name: "story-one" }]),
}));

vi.mock("~/lib/story-files-to-delete.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, recordStoryFileReads: vi.fn(actual.recordStoryFileReads as never) };
});

import { action } from "~/routes/_app.dashboard";
import { recordStoryFileReads } from "~/lib/story-files-to-delete.server";
import { gitBlobSha } from "~/lib/story-files.server";
import { discoverSheetTabs } from "~/lib/sheets.server";

const SHEETS = "telar-content/spreadsheets";

function request(): Request {
  return new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    // siteId matches the mocked resolveActiveProject's project id (1), which
    // is what resolvePageProject's page-site gate compares it against.
    body: new URLSearchParams({ intent: "restore-orphan-drafts", siteId: "1" }).toString(),
  });
}

function context(restored: number) {
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response(JSON.stringify({ restored }), { status: 200 })),
      })),
    },
  };
  return {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

beforeEach(() => {
  for (const key of Object.keys(files)) delete files[key];
  lossy.clear();
  dbSets.length = 0;
  vi.mocked(recordStoryFileReads).mockClear();
});

describe("restore-orphan-drafts — the warnings its parses raise", () => {
  it("returns each story sheet's warnings, named by the sheet", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,x,question\n1,obj-001,abc,Q\n";
    files[`${SHEETS}/story-two.csv`] = "step,object,question\n1,obj-001,Q,surplus\n";
    const result = await action({ request: request(), context: context(2), params: {} } as never);
    expect(result).toEqual({
      ok: true,
      intent: "restore-orphan-drafts",
      restored: 2,
      warnings: [
        { code: "coordinate_invalid", step: 1, column: "x", value: "abc", sheet: "story-one.csv" },
        { code: "ragged_row", row: { label: "1" }, sheet: "story-two.csv" },
      ],
    });
  });

  it("names a story sheet's misread headings, and not one the build takes from a Google Sheets tab", async () => {
    files[`${SHEETS}/story-one.csv`] = "Step,object,question\n1,obj-001,Q\n";
    files[`${SHEETS}/story-two.csv`] = "step,object,Question\n1,obj-001,Q\n";
    const spelling = { code: "header_spelling", headers: ["Step"], names: ["step"], sheet: "story-one.csv" };
    const question = { code: "header_spelling", headers: ["Question"], names: ["question"], sheet: "story-two.csv" };
    expect(await action({ request: request(), context: context(2), params: {} } as never)).toMatchObject({
      warnings: [spelling, question],
    });
    files["_config.yml"] = 'google_sheets:\n  enabled: true\n  published_url: "https://docs.google.com/spreadsheets/d/e/X/pubhtml"\n';
    expect(await action({ request: request(), context: context(2), params: {} } as never)).toMatchObject({
      warnings: [question],
    });
  });

  it("names an orphan step CSV whose bytes are not valid UTF-8, and restores it as read", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,question\n1,obj-001,Q\uFFFD\n";
    lossy.add(`${SHEETS}/story-one.csv`);
    const result = await action({ request: request(), context: context(1), params: {} } as never);
    expect(result).toEqual({
      ok: true,
      intent: "restore-orphan-drafts",
      restored: 1,
      warnings: [{ code: "unreadable_characters", file: "story-one.csv", effect: "left_out", repair: "publish" }],
    });
  });

  it("marks an unreadable orphan sheet as taken from Google Sheets when _config.yml at the head turns it on, though D1 holds no setting", async () => {
    const url = "https://docs.google.com/spreadsheets/d/e/X/pubhtml";
    files["_config.yml"] = `title: Site\ngoogle_sheets:\n  enabled: true\n  published_url: "${url}"\n`;
    files[`${SHEETS}/story-one.csv`] = "step,object,question\n1,obj-001,Q\uFFFD\n";
    lossy.add(`${SHEETS}/story-one.csv`);
    const { getFileAtRef } = await import("~/lib/github.server");
    vi.mocked(getFileAtRef).mockClear();
    const result = await action({ request: request(), context: context(1), params: {} } as never);
    expect(result).toMatchObject({
      ok: true,
      warnings: [{ code: "unreadable_characters", file: "story-one.csv", effect: "from_sheets", repair: "publish" }],
    });
    expect(vi.mocked(discoverSheetTabs)).toHaveBeenCalledWith(url);
    const configReads = vi.mocked(getFileAtRef).mock.calls.filter((c) => c[3] === "_config.yml");
    expect(configReads.map((c) => [c[4], c[5]])).toEqual([["head-sha", { strict: true }]]);
  });

  it("records the spreadsheets CSV as the path each restored story was read from", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,question\n1,obj-001,Q\n";
    files[`${SHEETS}/story-two.csv`] = "step,object,question\n1,obj-001,Q\n";
    await action({ request: request(), context: context(2), params: {} } as never);
    expect(dbSets).toEqual([
      { source_path: `${SHEETS}/story-one.csv` },
      { source_path: `${SHEETS}/story-two.csv` },
    ]);
  });

  it("records each restored story's CSV with the blob of the file as stored, a byte-order mark kept", async () => {
    const one = "\uFEFFstep,object,question\n1,obj-001,Q\n";
    const two = "step,object,question\n1,obj-001,Q\n";
    files[`${SHEETS}/story-one.csv`] = one;
    files[`${SHEETS}/story-two.csv`] = two;
    await action({ request: request(), context: context(2), params: {} } as never);
    expect(vi.mocked(recordStoryFileReads).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, [
        { path: `${SHEETS}/story-one.csv`, sha: await gitBlobSha(one) },
        { path: `${SHEETS}/story-two.csv`, sha: await gitBlobSha(two) },
      ]],
    ]);
  });

  it("names a layer file the orphan's steps name, read lossily", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,question,layer1_button,layer1_content\n1,obj-001,Q,More,panel.md\n";
    files["telar-content/texts/stories/panel.md"] = "Panel \uFFFD\n";
    lossy.add("telar-content/texts/stories/panel.md");
    const result = await action({ request: request(), context: context(1), params: {} } as never);
    expect(result).toMatchObject({
      ok: true,
      warnings: [
        {
          code: "unreadable_characters",
          file: "telar-content/texts/stories/panel.md",
          effect: "name_shown",
          repair: "publish",
        },
      ],
    });
  });

  it("reads a layer file two orphans name once", async () => {
    const csv = "step,object,question,layer1_button,layer1_content\n1,obj-001,Q,More,panel.md\n";
    files[`${SHEETS}/story-one.csv`] = csv;
    files[`${SHEETS}/story-two.csv`] = csv;
    files["telar-content/texts/stories/panel.md"] = "Panel\n";
    const { getFileAtRef } = await import("~/lib/github.server");
    vi.mocked(getFileAtRef).mockClear();
    await action({ request: request(), context: context(2), params: {} } as never);
    const reads = vi.mocked(getFileAtRef).mock.calls.filter((c) => c[3] === "telar-content/texts/stories/panel.md");
    expect(reads).toHaveLength(1);
  });

  it("names nothing for the valid encoding of U+FFFD", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,question\n1,obj-001,Q\uFFFD\n";
    const result = await action({ request: request(), context: context(1), params: {} } as never);
    expect(result).toEqual({ ok: true, intent: "restore-orphan-drafts", restored: 1, warnings: [] });
  });

  it("returns no warnings for clean files", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,question\n1,obj-001,Q\n";
    const result = await action({ request: request(), context: context(1), params: {} } as never);
    expect(result).toEqual({ ok: true, intent: "restore-orphan-drafts", restored: 1, warnings: [] });
  });

  it("answers restored 0 when the files went missing before the read", async () => {
    const result = await action({ request: request(), context: context(0), params: {} } as never);
    expect(result).toMatchObject({ ok: true, intent: "restore-orphan-drafts", restored: 0 });
  });

  // The first file warns; the second has two colliding columns that each hold
  // values, and refuses the restore. The refusal still carries the warning.
  it("carries the warnings already raised when a later file refuses the restore", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,x,question\n1,obj-001,abc,Q\n";
    files[`${SHEETS}/story-two.csv`] = "step,object,question,pregunta\n1,obj-001,What?,¿Qué?\n";
    const result = await action({ request: request(), context: context(0), params: {} } as never);
    expect(result).toEqual({
      ok: false,
      intent: "restore-orphan-drafts",
      error: "colliding_columns",
      collidingColumns: { sheet: "story-two.csv", canonicalName: "question", headers: ["question", "pregunta"] },
      warnings: [{ code: "coordinate_invalid", step: 1, column: "x", value: "abc", sheet: "story-one.csv" }],
    });
  });

  it("carries them when the collaboration object refuses the restore", async () => {
    files[`${SHEETS}/story-one.csv`] = "step,object,x,question\n1,obj-001,abc,Q\n";
    const ctx = context(0);
    const env = (ctx as unknown as { cloudflare: { env: { COLLABORATION: { get: ReturnType<typeof vi.fn> } } } }).cloudflare.env;
    env.COLLABORATION.get = vi.fn(() => ({ fetch: vi.fn(async () => new Response("no", { status: 500 })) }));
    const result = await action({ request: request(), context: ctx, params: {} } as never);
    expect(result).toMatchObject({
      ok: false,
      error: "restore_failed",
      warnings: [{ code: "coordinate_invalid", sheet: "story-one.csv" }],
    });
  });
});
