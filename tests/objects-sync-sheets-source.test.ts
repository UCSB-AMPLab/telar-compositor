/**
 * The objects page's check says whether an unreadable objects.csv is taken
 * from Google Sheets by the `_config.yml` at the head it read, as the build
 * decides, never by D1's copy of the setting.
 *
 * The route and the sync run for real against D1 in memory; GitHub answers
 * from the case's files, and the published sheet's tabs are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import type { FileAtRef } from "~/lib/github.server";

const PROJECT_ID = 42;
const CONVENOR = 7;
const HEAD = "a".repeat(40);
const OBJECTS = "telar-content/spreadsheets/objects.csv";
const URL_AT_HEAD = "https://docs.google.com/spreadsheets/d/e/AT-HEAD/pubhtml";

let memory: MemoryD1;
/** File text by "<ref>:<path>". */
let files: Record<string, string> = {};
/** Keys of `files` whose bytes are not valid UTF-8. */
let lossy = new Set<string>();

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(memory), { schema }) }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
  siteChangedAnswer: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
  getInstallationInfo: vi.fn(),
}));
vi.mock("~/lib/github.server", () => {
  const at = async (_t: string, _o: string, _r: string, path: string, ref: string): Promise<FileAtRef> => {
    const key = `${ref}:${path}`;
    const text = files[key];
    if (text === undefined) return { status: "absent" };
    return lossy.has(key) ? { status: "ok", content: text, lossy: true } : { status: "ok", content: text };
  };
  return {
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getRepoHead: vi.fn(async () => HEAD),
    getFileAtRef: vi.fn(at),
    getFileContent: vi.fn(async (t: string, o: string, r: string, path: string, ref?: string) => {
      const read = await at(t, o, r, path, ref ?? HEAD);
      return read.status === "ok" ? read.content : null;
    }),
    commitExists: vi.fn(async () => "exists"),
    githubHeaders: vi.fn(() => ({})),
  };
});
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn(async () => ({ ok: false })) }));
vi.mock("~/lib/page-site-gate.server", () => ({ gatePageSite: vi.fn() }));
vi.mock("~/lib/sheets.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sheets.server")>()),
  discoverSheetTabs: vi.fn(async () => [{ name: "objects" }]),
}));

import { action } from "~/routes/_app.objects";
import { gatePageSite } from "~/lib/page-site-gate.server";
import { discoverSheetTabs } from "~/lib/sheets.server";
import type { SyncDiff } from "~/lib/sync.server";

function context() {
  return {
    get: vi.fn(() => ({ id: CONVENOR, encrypted_access_token: "enc" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {}, GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "p" } },
  } as never;
}

async function objectsEffect(): Promise<unknown> {
  const result = (await action({
    request: new Request("https://compositor.telar.org/objects", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "compute-sync-diff" }).toString(),
    }),
    context: context(),
    params: {},
  } as never)) as { ok: boolean; diff: SyncDiff };
  expect(result.ok).toBe(true);
  return result.diff.warnings?.find((w) => w.code === "unreadable_characters" && w.file === "objects.csv");
}

/** D1's copy of the setting, and `_config.yml` at the head with Google Sheets as `atHead`. */
function sheets(inD1: boolean, atHead: boolean) {
  memory.raw
    .prepare("INSERT INTO project_config (project_id, google_sheets_enabled, google_sheets_published_url) VALUES (?, ?, ?)")
    .run(PROJECT_ID, inD1 ? 1 : 0, "https://docs.google.com/spreadsheets/d/e/IN-D1/pubhtml");
  files[`${HEAD}:_config.yml`] = `title: Site\ngoogle_sheets:\n  enabled: ${atHead}\n  published_url: "${URL_AT_HEAD}"\n`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${CONVENOR}, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, ${CONVENOR}, 'owner/repo', 5)`,
  );
  files = { [`${HEAD}:${OBJECTS}`]: "object_id,title\no1,Bell\n" };
  lossy = new Set([`${HEAD}:${OBJECTS}`]);
  const project = { id: PROJECT_ID, github_repo_full_name: "owner/repo", installation_id: 5, objects_read_sha: null };
  vi.mocked(gatePageSite).mockResolvedValue({ refused: null, page: { project, userRole: "convenor" } } as never);
});

afterEach(() => {
  memory.close();
});

describe("the objects page's warning for an unreadable objects.csv", () => {
  it("is from_sheets when _config.yml at the head turns Google Sheets on and D1 has it off", async () => {
    sheets(false, true);
    expect(await objectsEffect()).toMatchObject({ effect: "from_sheets" });
    expect(vi.mocked(discoverSheetTabs)).toHaveBeenCalledWith(URL_AT_HEAD);
  });

  it("stops the build when _config.yml at the head has Google Sheets off and D1 has it on", async () => {
    sheets(true, false);
    expect(await objectsEffect()).toMatchObject({ effect: "build_stops" });
    expect(vi.mocked(discoverSheetTabs)).not.toHaveBeenCalled();
  });
});
