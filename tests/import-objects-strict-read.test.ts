/**
 * The import reads objects.csv strictly.
 *
 * A failed read taken for a missing file seeds the project without its
 * objects, and the next publish then writes objects.csv from that empty table.
 * So the import reads the sheet strictly at the head it resolves: a missing
 * file is a site with no objects yet, and any other failure fails the import
 * before anything is written.
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

import { importRepo } from "~/lib/import.server";
import { getFileAtRef, getFileContent } from "~/lib/github.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";

const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';

let memory: MemoryD1;

function count(table: string): number {
  return (memory.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** objects.csv answers `answer`; every other file is read from the repository's stand-in. */
function objectsCsvAnswers(answer: Awaited<ReturnType<typeof getFileAtRef>>) {
  const repository = strictReadsFromFileContent(vi.mocked(getFileContent), async () => ({ status: "absent" }));
  vi.mocked(getFileAtRef).mockImplementation(async (...args) =>
    args[3] === OBJECTS_CSV ? answer : repository(...args),
  );
}

function importNow() {
  return importRepo({
    token: "t",
    installationId: 1,
    repoFullName: "owner/repo",
    userId: 1,
    env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
  });
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
    path === "_config.yml" ? CONFIG : path === OBJECTS_CSV ? "object_id,title\nbell,Bell\n" : null,
  );
});

afterEach(() => {
  memory.close();
});

describe("importRepo reads objects.csv strictly", () => {
  it("fails the import, seeding nothing, when objects.csv cannot be read", async () => {
    objectsCsvAnswers({ status: "error" });

    await expect(importNow()).rejects.toMatchObject({ name: "SheetUnreadableError", path: OBJECTS_CSV });

    expect(count("projects")).toBe(0);
    expect(count("objects")).toBe(0);
  });

  it("reads the sheet at the head, strictly, and seeds its objects", async () => {
    objectsCsvAnswers({ status: "ok", content: "object_id,title\nbell,Bell\n" });

    const result = await importNow();

    expect(result.valid).toBe(true);
    const objectsRead = vi.mocked(getFileAtRef).mock.calls.find((call) => call[3] === OBJECTS_CSV);
    expect(objectsRead?.slice(3)).toEqual([OBJECTS_CSV, "head-sha", { strict: true }]);
    expect(count("objects")).toBe(1);
  });

  it("seeds a site with no objects when objects.csv is missing", async () => {
    objectsCsvAnswers({ status: "absent" });

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(count("projects")).toBe(1);
    expect(count("objects")).toBe(0);
  });
});
