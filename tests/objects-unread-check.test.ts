/**
 * The check the image upload and the objects commit make before writing
 * objects.csv from D1: `prepareObjectsCommit`'s `unreadCheck`.
 *
 * `readSha` is the last commit whose objects.csv object rows D1 accounts for.
 * When GitHub's head is another commit, objects.csv is read strictly there too,
 * and the object rows of the two files are compared as text, in order. Comment
 * rows are left out, since the writer carries them from GitHub's copy as they
 * are; every other row is compared, including the header and the bilingual
 * row, which the writer writes itself. A difference throws
 * `ObjectsSheetChanged`. With no record, the commit goes on only while GitHub
 * has no objects.csv. A failed read at `readSha` is `ObjectsCommitUnready`
 * ("unreadable"), as a failed read at the head is.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/github.server")>();
  return { ...actual, getFileAtRef: vi.fn() };
});

import { getFileAtRef } from "~/lib/github.server";
import {
  ObjectsCommitUnready,
  ObjectsSheetChanged,
  prepareObjectsCommit,
} from "~/lib/pending-object-ops.server";

const HEAD = "head-sha";
const READ = "read-sha";
const PATH = "telar-content/spreadsheets/objects.csv";

const BASE = [
  "object_id,title,creator",
  "id_objeto,titulo,creador",
  "# Fill in one row per object",
  "a,Alpha,Ann",
  "b,Beta,Bo",
].join("\n");

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** objects.csv by commit: a string is the file, null is no file, absent is a failed read. */
let files: Map<string, string | null>;

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
  files = new Map();
  vi.mocked(getFileAtRef).mockReset();
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref, options) => {
    // The Spanish name is read only where objects.csv is not there, and no commit here has it.
    if (path === "telar-content/spreadsheets/objetos.csv" && options?.strict === true) return { status: "absent" };
    if (path !== PATH || options?.strict !== true) throw new Error(`unexpected read of ${path}`);
    if (!files.has(ref)) return { status: "error" };
    const content = files.get(ref);
    return content === null || content === undefined ? { status: "absent" } : { status: "ok", content };
  });
});

afterEach(() => {
  memory.close();
});

const env = {} as never;

function prepare(readSha: string | null | undefined) {
  return prepareObjectsCommit(
    env,
    db as never,
    1,
    { token: "t", owner: "o", repo: "r", head: HEAD },
    readSha === undefined ? {} : { unreadCheck: { readSha } },
  );
}

const readsAt = () => vi.mocked(getFileAtRef).mock.calls.filter((call) => call[3] === PATH).map((call) => call[4]);

describe("GitHub at the record", () => {
  it("goes on with one read of objects.csv", async () => {
    files.set(HEAD, BASE);
    await expect(prepareObjectsCommit(env, db as never, 1, { token: "t", owner: "o", repo: "r", head: HEAD }, { unreadCheck: { readSha: HEAD } }))
      .resolves.toEqual({ path: PATH, existingCsv: BASE });
    expect(readsAt()).toEqual([HEAD]);
  });
});

describe("GitHub moved since the record", () => {
  it("goes on when objects.csv is the same file", async () => {
    files.set(READ, BASE);
    files.set(HEAD, BASE);
    await expect(prepare(READ)).resolves.toEqual({ path: PATH, existingCsv: BASE });
    expect(readsAt().sort()).toEqual([HEAD, READ].sort());
  });

  it("goes on when only a comment row changed, was added or was removed", async () => {
    files.set(READ, BASE);
    const comments = BASE.replace("# Fill in one row per object", "# One row per object\n# Ids are lowercase");
    files.set(HEAD, comments);
    await expect(prepare(READ)).resolves.toEqual({ path: PATH, existingCsv: comments });
    files.set(HEAD, BASE.replace("# Fill in one row per object\n", ""));
    await expect(prepare(READ)).resolves.toBeDefined();
  });

  it("refuses when an object row changed", async () => {
    files.set(READ, BASE);
    files.set(HEAD, BASE.replace("b,Beta,Bo", "b,Beta,Bea"));
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("refuses when an object row was added or removed", async () => {
    files.set(READ, BASE);
    files.set(HEAD, `${BASE}\nc,Gamma,Cy`);
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
    files.set(HEAD, BASE.replace("\nb,Beta,Bo", ""));
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("refuses when the object rows are the same rows in another order", async () => {
    files.set(READ, BASE);
    files.set(HEAD, BASE.replace("a,Alpha,Ann\nb,Beta,Bo", "b,Beta,Bo\na,Alpha,Ann"));
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("refuses when only a cell under no header changed, which the parser drops", async () => {
    const unnamed = BASE.replace("object_id,title,creator", "object_id,title,creator,")
      .replace("id_objeto,titulo,creador", "id_objeto,titulo,creador,")
      .replace("a,Alpha,Ann", "a,Alpha,Ann,")
      .replace("b,Beta,Bo", "b,Beta,Bo,x");
    files.set(READ, unnamed);
    files.set(HEAD, unnamed.replace("b,Beta,Bo,x", "b,Beta,Bo,y"));
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("refuses when the header was renamed, which the writer writes over", async () => {
    files.set(READ, BASE);
    files.set(HEAD, BASE.replace("object_id,title,creator", "object_id,title,maker"));
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("refuses when objects.csv was deleted, or created, on GitHub", async () => {
    files.set(READ, BASE);
    files.set(HEAD, null);
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
    files.set(READ, null);
    files.set(HEAD, BASE);
    await expect(prepare(READ)).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("goes on when neither commit has objects.csv", async () => {
    files.set(READ, null);
    files.set(HEAD, null);
    await expect(prepare(READ)).resolves.toEqual({ path: PATH, existingCsv: undefined });
  });

  it("refuses a read at the record that fails, as unreadable", async () => {
    files.set(HEAD, BASE);
    const refusal = await prepare(READ).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ObjectsCommitUnready);
    expect((refusal as ObjectsCommitUnready).reason).toBe("unreadable");
  });

  it("refuses a read at the record that throws, as unreadable", async () => {
    files.set(HEAD, BASE);
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, _p, ref) => {
      if (ref === READ) throw new Error("socket hang up");
      return { status: "ok", content: BASE };
    });
    const refusal = await prepare(READ).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ObjectsCommitUnready);
    expect((refusal as ObjectsCommitUnready).reason).toBe("unreadable");
  });
});

describe("no record", () => {
  it("goes on when GitHub has no objects.csv", async () => {
    files.set(HEAD, null);
    await expect(prepare(null)).resolves.toEqual({ path: PATH, existingCsv: undefined });
    expect(readsAt()).toEqual([HEAD]);
  });

  it("refuses when GitHub has objects.csv", async () => {
    files.set(HEAD, BASE);
    await expect(prepare(null)).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });
});

describe("no check asked for", () => {
  it("never reads at another commit and never refuses for object rows", async () => {
    files.set(HEAD, BASE.replace("b,Beta,Bo", "b,Beta,Bea"));
    await expect(prepare(undefined)).resolves.toBeDefined();
    expect(readsAt()).toEqual([HEAD]);
  });
});

// ---------------------------------------------------------------------------
// A row D1 holds under a stripped id
//
// Every caller writes objects.csv from D1 after this preparation. Until the
// project's first sync check has repaired its ids, a row an earlier import
// stored as `a` where GitHub and the record both write `a  ` refuses the
// commit, and each caller sends the author to the sync, which repairs it;
// written from D1 as it stands, the file would replace GitHub's id.
// ---------------------------------------------------------------------------

describe("a row D1 holds under the stripped form of GitHub's id", () => {
  const PADDED = ["object_id,title", '"a  ",Alpha', "b,Beta"].join("\n");
  const STRIPPED = ["object_id,title", "a,Alpha", "b,Beta"].join("\n");

  beforeEach(() => {
    memory.raw.exec("INSERT INTO objects (id, project_id, object_id, order_key) VALUES (1, 1, 'a', 'a00001'), (2, 1, 'b', 'a00002')");
  });

  function prepareWith(options: Parameters<typeof prepareObjectsCommit>[4]) {
    return prepareObjectsCommit(env, db as never, 1, { token: "t", owner: "o", repo: "r", head: HEAD }, options);
  }

  /** The project's recorded commits: the one D1's object rows are from, and the head. */
  function record(objectsReadSha: string | null, headSha: string | null = null) {
    memory.raw.prepare("UPDATE projects SET objects_read_sha = ?, head_sha = ? WHERE id = 1").run(objectsReadSha, headSha);
  }

  it("refuses the commit where the commit D1's object rows are from writes it padded", async () => {
    record(READ, HEAD);
    files.set(READ, PADDED);
    files.set(HEAD, PADDED);
    await expect(prepareWith({ unreadCheck: { readSha: READ } })).rejects.toBeInstanceOf(ObjectsSheetChanged);
    await expect(prepareWith({})).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("judges against the recorded head where the project has no objects_read_sha", async () => {
    record(null, HEAD);
    files.set(HEAD, PADDED);
    await expect(prepareWith({})).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  // A project whose onboarding made no commit has no head recorded; the import
  // set objects_read_sha, which is the record.
  it("judges against objects_read_sha where the project has no head recorded", async () => {
    record(READ, null);
    files.set(READ, PADDED);
    files.set(HEAD, PADDED);
    await expect(prepareWith({})).rejects.toBeInstanceOf(ObjectsSheetChanged);
  });

  it("goes on where that commit writes it stripped: GitHub changed the id", async () => {
    record(READ, HEAD);
    files.set(READ, STRIPPED);
    files.set(HEAD, PADDED);
    await expect(prepareWith({})).resolves.toEqual({ path: PATH, existingCsv: PADDED });
  });

  // Nothing can be judged, so nothing is refused, and the file is written from
  // D1 with its stripped id.
  it("goes on with no recorded commit, or one that cannot be read", async () => {
    files.set(HEAD, PADDED);
    record(null, null);
    await expect(prepareWith({})).resolves.toBeDefined();
    record("gone-sha", null);
    await expect(prepareWith({})).resolves.toBeDefined();
  });

  it("goes on once the project's ids have been repaired", async () => {
    record(READ, HEAD);
    files.set(READ, PADDED);
    memory.raw.exec("UPDATE projects SET legacy_ids_repaired_at = '2026-09-30' WHERE id = 1");
    files.set(HEAD, PADDED);
    await expect(prepareWith({})).resolves.toEqual({ path: PATH, existingCsv: PADDED });
  });
});
