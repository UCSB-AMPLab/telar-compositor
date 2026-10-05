/**
 * An import keeps one row per repeated glossary term_id: the one the framework
 * publishes, which is the id's first titled row (`_csv_page_rows`,
 * `first_at_each_address`, scripts/telar). glossary_terms is UNIQUE on
 * (project_id, term_id) outside held ids (migration 0072), so storing every
 * row would fail the import.
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
import { computeGlossarySyncDiff } from "~/lib/sync.server";
import { getFileAtRef, getFileContent } from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";

const GLOSSARY_CSV = "telar-content/spreadsheets/glossary.csv";
// `loom` three times: untitled first, then two titled rows. The framework
// skips the untitled row and publishes the first titled one.
const REPEATED =
  "term_id,title,definition\nloom,,Untitled\nloom,Loom,First titled\nwarp,Warp,Threads\nloom,Loom again,Second titled\n";
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

function storedTerms(): Array<{ term_id: string; title: string | null; definition: string | null }> {
  return memory.raw.prepare("SELECT term_id, title, definition FROM glossary_terms ORDER BY id").all() as never;
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
    path === "_config.yml" ? config : path === GLOSSARY_CSV ? REPEATED : null,
  );
  vi.mocked(getFileAtRef).mockImplementation(
    strictReadsFromFileContent(vi.mocked(getFileContent), async () => ({ status: "absent" })) as never,
  );
  vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "glossary", gid: "10" }] as never);
  vi.mocked(fetchSheetCsv).mockResolvedValue(REPEATED);
});

afterEach(() => {
  memory.close();
});

describe.each([
  ["the repository's glossary.csv", REPO_CONFIG],
  ["a Google Sheet's glossary tab", SHEETS_CONFIG],
])("an import from %s with a term_id in several rows", (_, siteConfig) => {
  it("succeeds under the term_id index and stores the row the site publishes", async () => {
    config = siteConfig;
    const result = await importNow();
    expect(result.valid).toBe(true);
    expect(storedTerms()).toEqual([
      { term_id: "loom", title: "Loom", definition: "First titled" },
      { term_id: "warp", title: "Warp", definition: "Threads" },
    ]);
    expect(result.glossary.imported).toBe(2);
  });
});

describe("the sync's glossary diff with a term_id in several rows", () => {
  it("offers the row the site publishes, as the import stores it", async () => {
    config = REPO_CONFIG;
    const db = { select: () => chain(), batch: async () => [] } as unknown as Parameters<typeof computeGlossarySyncDiff>[4];
    const diff = await computeGlossarySyncDiff(1, "t", "o", "r", db, undefined, "head-sha");
    expect(diff.added.map((t) => [t.term_id, t.title, t.definition])).toEqual([
      ["loom", "Loom", "First titled"],
      ["warp", "Warp", "Threads"],
    ]);
  });
});

/** A drizzle query chain whose every read comes back empty: a project with no terms. */
function chain(): unknown {
  const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
  for (const m of ["from", "where", "limit", "orderBy", "set", "values", "returning", "innerJoin", "leftJoin"]) {
    node[m] = () => chain();
  }
  return node;
}
