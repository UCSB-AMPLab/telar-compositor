/**
 * The import records the commit whose objects.csv it read.
 *
 * `projects.objects_read_sha` is the last commit whose objects.csv object rows
 * D1 accounts for. An import from the repository reads objects.csv at the head
 * it resolves, so it records that head. An import from Google Sheets builds
 * its objects from the Sheet and never reads GitHub's objects.csv, so it
 * records nothing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getDefaultBranchHead: vi.fn(async () => ({ name: "main", oid: "head-sha" })),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileContent: vi.fn(),
    getFileAtRef: vi.fn(),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});
vi.mock("~/lib/sheets.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, discoverSheetTabs: vi.fn(), fetchSheetCsv: vi.fn() };
});

import { importRepo } from "~/lib/import.server";
import { getFileAtRef, getFileContent } from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";

const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const REPO_CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';
const SHEETS_CONFIG =
  'title: "Site"\ntelar:\n  version: "1.0.0"\ngoogle_sheets:\n  enabled: true\n' +
  '  published_url: "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml"\n';

let memory: MemoryD1;
let config: string;

function importNow() {
  return importRepo({
    token: "t",
    installationId: 1,
    repoFullName: "owner/repo",
    userId: 1,
    env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
  });
}

function recorded(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT head_sha, objects_read_sha FROM projects").get() as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) =>
    path === "_config.yml" ? config : path === OBJECTS_CSV ? "object_id,title\nbell,Bell\n" : null,
  );
  vi.mocked(getFileAtRef).mockImplementation(
    strictReadsFromFileContent(vi.mocked(getFileContent), async () => ({ status: "absent" })) as never,
  );
  vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "objects", gid: "10" }] as never);
  vi.mocked(fetchSheetCsv).mockResolvedValue("object_id,title\nsheet-bell,Sheet Bell\n");
});

afterEach(() => {
  memory.close();
});

describe("the import's record of the objects.csv it read", () => {
  it("is the head it read at, for an import from the repository", async () => {
    config = REPO_CONFIG;
    expect((await importNow()).valid).toBe(true);
    expect(recorded().objects_read_sha).toBe("head-sha");
  });

  it("is none for an import from Google Sheets, which never reads objects.csv", async () => {
    config = SHEETS_CONFIG;
    expect((await importNow()).valid).toBe(true);
    expect(memory.raw.prepare("SELECT object_id FROM objects").all()).toEqual([{ object_id: "sheet-bell" }]);
    expect(recorded().objects_read_sha).toBeNull();
  });

  // The build loads _config.yml with PyYAML, where `yes` is true and a quoted
  // "true" is a string, so those are what the import follows.
  it.each([
    ["yes", "yes", true],
    ["on", "ON", true],
    ['a quoted "true"', '"true"', false],
    ['a quoted "false"', '"false"', false],
  ])("reads enabled: %s as the build does", async (_name, value, fromSheets) => {
    config = SHEETS_CONFIG.replace("enabled: true", `enabled: ${value}`);
    expect((await importNow()).valid).toBe(true);
    expect(recorded().objects_read_sha).toBe(fromSheets ? null : "head-sha");
    expect(memory.raw.prepare("SELECT google_sheets_enabled AS flag FROM project_config").get()).toEqual({ flag: fromSheets ? 1 : 0 });
  });
});
