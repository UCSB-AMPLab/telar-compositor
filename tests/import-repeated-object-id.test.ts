/**
 * An import keeps one row per repeated object_id, the last, where the site and
 * the sync (`githubSheet`) take it. Storing every row would give D1 two
 * objects under one id, which the next publish re-keys as `map-2`. The warning
 * naming the repeated id is still given.
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
const REPEATED = "object_id,title\nmap,First\nbell,Bell\nmap,Second\n";
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

function storedObjects(): Array<{ object_id: string; title: string | null }> {
  return memory.raw.prepare("SELECT object_id, title FROM objects ORDER BY id").all() as never;
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
    path === "_config.yml" ? config : path === OBJECTS_CSV ? REPEATED : null,
  );
  vi.mocked(getFileAtRef).mockImplementation(
    strictReadsFromFileContent(vi.mocked(getFileContent), async () => ({ status: "absent" })) as never,
  );
  vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "objects", gid: "10" }] as never);
  vi.mocked(fetchSheetCsv).mockResolvedValue(REPEATED);
});

afterEach(() => {
  memory.close();
});

describe.each([
  ["the repository's objects.csv", REPO_CONFIG],
  ["a Google Sheet's objects tab", SHEETS_CONFIG],
])("an import from %s with an object_id in two rows", (_, siteConfig) => {
  it("stores one object for the id, from its last row, and still warns", async () => {
    config = siteConfig;
    const result = await importNow();
    expect(result.valid).toBe(true);
    expect(storedObjects()).toEqual([
      { object_id: "bell", title: "Bell" },
      { object_id: "map", title: "Second" },
    ]);
    expect(result.objects.imported).toBe(2);
    expect(JSON.stringify(result.objects.warnings)).toContain("object_id_repeated");
  });
});
