/**
 * A site whose objects.csv has `title` beside ` title `, with only the spaced
 * column filled, and whose D1 row holds that value under `title_1`: the key
 * the import gives the second column when it reads the two header cells
 * stripped, as one text repeated.
 *
 * The import now reads them as two texts that collide, so an unchanged file
 * parses as `title: "Kept"` at both the head and the three-way base. A sync
 * sees every difference from D1 as the editor's own and leaves the row alone,
 * and the next publish writes `title_1` back. The publish check names that
 * rename with the same warning a repeated header gets.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getFileAtRef: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  commitExists: vi.fn(),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

import * as githubServer from "~/lib/github.server";
import type { FileAtRef } from "~/lib/github.server";
import { computeSyncDiff } from "~/lib/sync.server";
import { renamedColumnWarningsAt } from "~/lib/renamed-columns.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";
import { probeSequentialMockDb } from "./sync-probe-fixtures";

const OBJECTS_PATH = "telar-content/spreadsheets/objects.csv";
const OBJECTS_CSV = "object_id,title, title \no1,,Kept\n";
const STORED_BLOB = JSON.stringify({ title_1: "Kept" });

/** The D1 row the stripped reading of `OBJECTS_CSV` stored. */
function storedRow(): Record<string, unknown> {
  return {
    id: 1,
    project_id: 1,
    object_id: "o1",
    origin: "repo",
    missing_from_repo: false,
    title: null,
    featured: false,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: null,
    dimensions: null,
    extra_columns: STORED_BLOB,
    image_available: false,
    updated_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("head-sha");
  vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) =>
    path === OBJECTS_PATH ? OBJECTS_CSV : null,
  );
  vi.mocked(githubServer.getFileAtRef).mockImplementation(
    strictReadsFromFileContent(githubServer.getFileContent, async () => ({ status: "absent" })),
  );
});

describe("an unchanged file whose D1 row holds a title_1 from the stripped reading", () => {
  it("syncs nothing, and the publish check names title_1", async () => {
    const db = probeSequentialMockDb([[storedRow()], [], []]);
    const diff = await computeSyncDiff(1, "t", "o", "r", db, OBJECTS_CSV);
    expect(diff.newObjects).toEqual([]);
    expect(diff.changedObjects).toEqual([]);
    expect(diff.missingObjects).toEqual([]);
    expect(diff.suppressedEditorOnly).toBe(1);

    const read = vi.fn(async (path: string): Promise<FileAtRef> =>
      path === OBJECTS_PATH ? { status: "ok", content: OBJECTS_CSV } : { status: "absent" },
    );
    const warnings = await renamedColumnWarningsAt(
      { blockers: [], warnings: [] },
      {
        objects: [{ object_id: "o1", title: null, extra_columns: STORED_BLOB }],
        glossary: [],
        stories: [],
        steps: [],
        loadLayers: async () => [],
      },
      read,
    );
    expect(warnings).toEqual([
      {
        code: "renamed_duplicate_column",
        message: "renamed_duplicate_column",
        entityId: "objects.csv/title",
        params: { file: "objects.csv", column: "title", renamed: "title_1" },
      },
    ]);
  });

  it("gives no warning once the row holds the value under title", async () => {
    const read = vi.fn(async (): Promise<FileAtRef> => ({ status: "ok", content: OBJECTS_CSV }));
    const warnings = await renamedColumnWarningsAt(
      { blockers: [], warnings: [] },
      {
        objects: [{ object_id: "o1", title: "Kept", extra_columns: null }],
        glossary: [],
        stories: [],
        steps: [],
        loadLayers: async () => [],
      },
      read,
    );
    expect(warnings).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
