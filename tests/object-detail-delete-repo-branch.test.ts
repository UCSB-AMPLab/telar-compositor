/**
 * The repository half of a `delete-object`: what it reads, what it commits,
 * and what it refuses to commit.
 *
 * Three properties are under test.
 *
 * The reads are fenced. The head of `main` is captured first, the tree and
 * objects.csv are read at that revision, and the commit carries it as its
 * expected head — so a change landing in between is refused as `stale_head`
 * with nothing written, instead of being silently missed. A tree read that
 * fails, and one that comes back truncated, are the same answer: neither can
 * prove which of the object's files exist, so nothing is committed.
 *
 * The CSV read is fail-closed. "Absent" means an HTTP 404 and nothing else,
 * because the branch is about to REWRITE the file: a 429 or a 200 with no
 * usable body read as "no CSV here" would commit the images away and leave the
 * row standing. `getFileAtRef` is the REAL helper here, driven from the action
 * against a fetch mock, so the strictness is tested where it is relied on.
 *
 * The CSV is edited, not regenerated. Publish rewrites objects.csv from D1; a
 * delete does not, because an author who removed one object did not ask for
 * every other row to be reformatted. The fixture carries a BOM, CRLF
 * terminators, non-ASCII text, the bilingual label row, comment rows (one
 * immediately before the target), custom columns and fields holding newlines,
 * commas and doubled quotes — and the committed text is asserted to be the
 * captured text minus one record's exact range.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted, self-contained factories
// ---------------------------------------------------------------------------

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
// The document half goes through the collaboration object and its record is
// tested in tests/object-delete-on-server.test.ts; here it answers done.
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  getUserRole: vi.fn(),
}));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));

// getFileAtRef stays REAL: the strict read is the thing being exercised, and a
// stub of it would only assert that the test's own stub was called.
vi.mock("~/lib/github.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/github.server")>();
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileContent: vi.fn(),
  };
});

/** The project row's head_sha, as D1 holds it. */
const headRow = vi.hoisted(() => ({ head_sha: null as string | null }));
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHeadFrom: vi.fn(async (_db: unknown, _id: number, fromSha: string | null, toSha: string) => {
    if (headRow.head_sha !== fromSha) return false;
    headRow.head_sha = toSha;
    return true;
  }),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
}));

// Client-side deps the route module pulls in but this action case never runs.
vi.mock("~/lib/iiif-types", () => ({ deriveStatus: vi.fn() }));
vi.mock("~/lib/media-type", () => ({
  detectMediaType: vi.fn(() => "image"),
  extractVideoId: vi.fn(),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), getYText: vi.fn() }));
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: vi.fn() }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({
  CommitAndBuildModal: vi.fn(),
}));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: vi.fn() }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: vi.fn() }));
vi.mock("~/components/ui/Switch", () => ({ Switch: vi.fn() }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: vi.fn() }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: vi.fn() }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.objects.$objectId";
import { collectObjectBlobPaths, deleteObjectFromRepository } from "~/lib/object-repo-delete.server";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject, getUserRole } from "~/lib/membership.server";
import { getRepoHead, getRepoTree } from "~/lib/github.server";
import { projects as projectsTable } from "~/db/schema";
import { commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { bumpProjectHeadFrom } from "~/lib/github-status.server";
import { OBJECTS_CANONICAL_SCOPE, parseTelarCsv } from "~/lib/import.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OBJECT_DB_ID = 10;
const OBJECT_ID = "plano-de-tunja";
const CAPTURED_HEAD = "captured-head-sha";
const CSV_PATH = "telar-content/spreadsheets/objects.csv";
const BOM = "\uFEFF";

/** Everything a real site's objects.csv can carry, in one string. */
const CAPTURED_CSV =
  BOM +
  "object_id,title,description,credit,nota_del_curso\r\n" +
  "id_objeto,titulo,descripcion,credito,\r\n" +
  "# Una fila de comentario que el marco conserva\r\n" +
  'mapa-de-santafe,"Mapa de Santafé, 1791","Dice ""la muy noble ciudad"",\r\ny sigue en otra línea.",Archivo General,revisar\r\n' +
  "# comentario pegado justo antes del objetivo\r\n" +
  'plano-de-tunja,"Plano de Tunja","Con coma, y acentos: ñ á é",Biblioteca Nacional,\r\n' +
  "retrato-anonimo,Retrato anónimo,,,\r\n";

const TARGET_RECORD =
  'plano-de-tunja,"Plano de Tunja","Con coma, y acentos: ñ á é",Biblioteca Nacional,\r\n';

const TARGET_ROW = {
  id: OBJECT_DB_ID,
  project_id: 42,
  object_id: OBJECT_ID,
  title: "Plano de Tunja",
  missing_from_repo: false,
  course_project_id: null,
  created_by: 21,
};

function blob(path: string) {
  return { path, mode: "100644", type: "blob" as const, sha: "x" };
}

/** Both image layouts, plus near-miss paths that must survive. */
const TREE = [
  blob(`telar-content/objects/${OBJECT_ID}/001.jpg`),
  blob(`telar-content/objects/${OBJECT_ID}/002.jpg`),
  blob(`telar-content/objects/${OBJECT_ID}.tif`),
  blob(`telar-content/objects/${OBJECT_ID}-detalle.jpg`),
  blob(`telar-content/objects/${OBJECT_ID}.detalle.jpg`),
  blob(`telar-content/objects/${OBJECT_ID}.detalle/001.jpg`),
  blob("telar-content/objects/otro-objeto.jpg"),
  { path: `telar-content/objects/${OBJECT_ID}`, mode: "040000", type: "tree" as const, sha: "y" },
];

/** base64 of a UTF-8 string, the way the Contents API encodes one. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/** A Contents API response for the real getFileAtRef to read. */
function contentsFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  });
}

/**
 * objects.csv answered with `text`. The site's `_config.yml`, which the
 * deletion reads at the same revision for the site's framework version, is
 * absent, so D1's version stands.
 */
function csvFetch(text: string) {
  const csv = { content: base64Utf8(text), encoding: "base64", size: Buffer.byteLength(text, "utf8") };
  return vi.fn().mockImplementation(async (url: string) => {
    const status = url.includes("/contents/_config.yml") ? 404 : 200;
    return {
      ok: status === 200,
      status,
      json: async () => (status === 200 ? csv : { message: "Not Found" }),
      headers: { get: () => null },
    };
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function buildRequest(): Request {
  const form = new URLSearchParams();
  form.set("intent", "delete-object");
  form.set("objectDbId", String(OBJECT_DB_ID));
  form.set("fromRepo", "true");
  return new Request(`https://compositor.telar.org/objects/${OBJECT_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: {
      env: {
        ENCRYPTION_KEY: "key",
        SESSION_SECRET: "sess-secret",
        DB: {},
        GITHUB_APP_ID: "app-id",
        GITHUB_PRIVATE_KEY: "pk",
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

const PROJECT_ROW = {
  id: 42,
  github_repo_full_name: "owner/repo",
  installation_id: 5,
  gh_workflows_write_missing: null,
};

/**
 * The action reads the object row, then the row's own project — two selects
 * against two tables. Dispatch on the table asked for so both answer with
 * the right shape.
 */
function seedDb() {
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(table === projectsTable ? [PROJECT_ROW] : [TARGET_ROW]),
          orderBy: vi.fn().mockResolvedValue([TARGET_ROW]),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })) })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })),
  } as never);
}

async function runRepoDelete(): Promise<unknown> {
  try {
    return await action({
      request: buildRequest(),
      context: buildContext(),
      params: { objectId: OBJECT_ID },
    } as never);
  } catch (e) {
    return e;
  }
}

/** The positional arguments of the one commit the branch makes. */
function commitArgs() {
  return vi.mocked(commitFilesToRepo).mock.calls[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  seedDb();
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: {
      id: 42,
      github_repo_full_name: "owner/repo",
      installation_id: 5,
    } as never,
    userRole: "convenor",
  });
  vi.mocked(getUserRole).mockResolvedValue("convenor");
  vi.mocked(getRepoHead).mockResolvedValue(CAPTURED_HEAD);
  vi.mocked(getRepoTree).mockResolvedValue({ tree: TREE, truncated: false });
  vi.mocked(commitFilesToRepo).mockResolvedValue({ newHeadSha: "sha-after-delete" } as never);
  headRow.head_sha = CAPTURED_HEAD;
  globalThis.fetch = csvFetch(CAPTURED_CSV);
});

// ---------------------------------------------------------------------------
// The reads are pinned and the commit is fenced to them
// ---------------------------------------------------------------------------

describe("delete-object repo branch — one revision, read and written", () => {
  it("reads the tree and the CSV at the captured head and fences the commit to it", async () => {
    expect(await runRepoDelete()).toEqual({
      ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false,
    });

    expect(vi.mocked(getRepoTree).mock.calls[0][3]).toBe(CAPTURED_HEAD);
    const csvUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(csvUrl).toContain(`ref=${CAPTURED_HEAD}`);
    // Positional: token, owner, repo, branch, files, message, body,
    // deletions, skipCi, expectedHeadOid.
    expect(commitArgs()[9]).toBe(CAPTURED_HEAD);
  });

  it("removes the row from objetos.csv of a site that holds only that file, and commits to it", async () => {
    const csv = { content: base64Utf8(CAPTURED_CSV), encoding: "base64", size: Buffer.byteLength(CAPTURED_CSV, "utf8") };
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const status = url.includes("/contents/telar-content/spreadsheets/objetos.csv") ? 200 : 404;
      return { ok: status === 200, status, json: async () => (status === 200 ? csv : { message: "Not Found" }), headers: { get: () => null } };
    });

    expect(await runRepoDelete()).toMatchObject({ ok: true, intent: "delete-object" });

    const files = commitArgs()[4] as Array<{ path: string; content: string }>;
    expect(files.map((f) => f.path)).toEqual(["telar-content/spreadsheets/objetos.csv"]);
    expect(files[0].content).toBe(CAPTURED_CSV.replace(TARGET_RECORD, ""));
  });

  it("refuses a head that moved as stale_head", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValue(new StaleHeadError("Expected HEAD"));

    expect(await runRepoDelete()).toEqual({
      ok: false, error: "stale_head", objectDbId: OBJECT_DB_ID,
    });
    // The fence held on the revision the reads were taken from.
    expect(commitArgs()[9]).toBe(CAPTURED_HEAD);
  });

  it("answers delete_failed when a commit fails for any other reason", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValue(new Error("502 Bad Gateway"));

    expect(await runRepoDelete()).toEqual({
      ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID,
    });
  });

  it("answers ok when the commit lands and the head bump then fails", async () => {
    // The repository WAS updated. Recording the head is bookkeeping the next
    // commit redoes for itself, so its failure must not be reported as one.
    vi.mocked(bumpProjectHeadFrom).mockRejectedValueOnce(new Error("D1 unavailable"));

    expect(await runRepoDelete()).toEqual({
      ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false,
    });
    expect(vi.mocked(bumpProjectHeadFrom)).toHaveBeenCalledWith(
      expect.anything(), 42, CAPTURED_HEAD, "sha-after-delete",
    );
  });

  it("returns the head the commit was built on, with the commit", async () => {
    const result = await deleteObjectFromRepository({
      readToken: "t", commitToken: "t", owner: "owner", repo: "repo", objectId: OBJECT_ID,
    });
    expect(result).toEqual({ ok: true, headSha: "sha-after-delete", parentSha: CAPTURED_HEAD });
  });

  it("advances head_sha from the captured head when that is the recorded head", async () => {
    await runRepoDelete();
    expect(headRow.head_sha).toBe("sha-after-delete");
  });

  it("leaves head_sha when the captured head is a GitHub commit the Compositor never read", async () => {
    headRow.head_sha = "recorded-b";
    expect(await runRepoDelete()).toMatchObject({ ok: true, intent: "delete-object" });
    expect(headRow.head_sha).toBe("recorded-b");
  });
});

// ---------------------------------------------------------------------------
// A tree it cannot rely on commits nothing
// ---------------------------------------------------------------------------

describe("delete-object repo branch — the tree read", () => {
  it("answers delete_failed with no commit when the tree read fails", async () => {
    vi.mocked(getRepoTree).mockRejectedValue(new Error("503"));

    expect(await runRepoDelete()).toEqual({
      ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("answers delete_failed with no commit when the tree is truncated", async () => {
    vi.mocked(getRepoTree).mockResolvedValue({ tree: TREE, truncated: true });

    expect(await runRepoDelete()).toEqual({
      ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("deletes both image layouts and nothing whose name merely starts the same", async () => {
    await runRepoDelete();

    expect(commitArgs()[7]).toEqual([
      `telar-content/objects/${OBJECT_ID}/001.jpg`,
      `telar-content/objects/${OBJECT_ID}/002.jpg`,
      `telar-content/objects/${OBJECT_ID}.tif`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The CSV read is fail-closed
// ---------------------------------------------------------------------------

describe("delete-object repo branch — the CSV read", () => {
  it("answers delete_failed with no commit on a non-404 failure", async () => {
    globalThis.fetch = contentsFetch(429, { message: "Too Many Requests" });

    expect(await runRepoDelete()).toEqual({
      ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("answers delete_failed with no commit on a 200 with no usable content", async () => {
    // A directory at the path: a 200 whose answer is no file.
    globalThis.fetch = contentsFetch(200, [{ type: "file", name: "a.csv", size: 10 }]);

    expect(await runRepoDelete()).toEqual({
      ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("answers delete_failed with no commit when the CSV has no object_id column", async () => {
    globalThis.fetch = csvFetch("id,title\nplano-de-tunja,Plano\n");

    expect(await runRepoDelete()).toEqual({
      ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("proceeds with the file deletions alone when the site has no objects.csv", async () => {
    globalThis.fetch = contentsFetch(404, { message: "Not Found" });

    expect(await runRepoDelete()).toEqual({
      ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false,
    });
    expect(commitArgs()[4]).toEqual([]);
    expect(commitArgs()[7]).toHaveLength(3);
  });

  it("commits nothing when the repository holds nothing for the object", async () => {
    vi.mocked(getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    globalThis.fetch = contentsFetch(404, { message: "Not Found" });

    expect(await runRepoDelete()).toEqual({
      ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
    expect(vi.mocked(bumpProjectHeadFrom)).not.toHaveBeenCalled();
  });

  it("writes the survivors in the Compositor's layout when the cut would promote a row to a repeated header", async () => {
    globalThis.fetch = csvFetch(
      `object_id,title,creator,source\n${OBJECT_ID},Plano,,\nsource,Creator,Title,Object\n`,
    );

    expect(await runRepoDelete()).toMatchObject({ ok: true, intent: "delete-object" });
    const written = (commitArgs()[4] as { path: string; content: string }[])[0].content;
    expect(written.split("\n")[1].startsWith("id_objeto,")).toBe(true);
    const read = parseTelarCsv(written, undefined, false, OBJECTS_CANONICAL_SCOPE);
    expect(read.map((row) => [row.object_id, row.title])).toEqual([["source", "Creator"]]);
    expect(written).not.toContain(OBJECT_ID);
  });

  it("commits nothing when a readable CSV holds no record and no files exist", async () => {
    // Distinct from the 404: objects.csv is there and reads cleanly, it simply
    // has no row for this object. There is nothing to write and nothing to
    // delete, so the repository half is already what the delete wants.
    vi.mocked(getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    globalThis.fetch = csvFetch("object_id,title\r\notro-objeto,Otro\r\n");

    expect(await runRepoDelete()).toEqual({
      ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
    expect(vi.mocked(bumpProjectHeadFrom)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Which files are the object's
// ---------------------------------------------------------------------------

describe("collectObjectBlobPaths — whole names, never prefixes", () => {
  it("leaves an object whose id merely extends this one's", () => {
    // `mapa.detail.jpg` is sync's stem for an object called `mapa.detail`, and
    // `mapa.detail/001.jpg` is that object's folder. Deleting `mapa` takes
    // neither.
    const tree = [
      blob("telar-content/objects/mapa.jpg"),
      blob("telar-content/objects/mapa/001.jpg"),
      blob("telar-content/objects/mapa.detail.jpg"),
      blob("telar-content/objects/mapa.detail/001.jpg"),
      blob("telar-content/objects/mapa-2.jpg"),
      blob("telar-content/spreadsheets/mapa.csv"),
    ];

    expect(collectObjectBlobPaths(tree, "mapa")).toEqual([
      "telar-content/objects/mapa.jpg",
      "telar-content/objects/mapa/001.jpg",
    ]);
  });

  it("takes the extended object's own files when it is the one deleted", () => {
    const tree = [
      blob("telar-content/objects/mapa.jpg"),
      blob("telar-content/objects/mapa.detail.jpg"),
      blob("telar-content/objects/mapa.detail/001.jpg"),
    ];

    expect(collectObjectBlobPaths(tree, "mapa.detail")).toEqual([
      "telar-content/objects/mapa.detail.jpg",
      "telar-content/objects/mapa.detail/001.jpg",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The CSV is edited, not regenerated
// ---------------------------------------------------------------------------

describe("delete-object repo branch — the committed CSV", () => {
  it("differs from the captured text only by the removed record", async () => {
    await runRepoDelete();

    const files = commitArgs()[4] as { path: string; content: string }[];
    expect(files).toEqual([
      { path: CSV_PATH, content: CAPTURED_CSV.replace(TARGET_RECORD, "") },
    ]);
  });

  it("keeps the BOM, CRLF, label row, comments, custom column and quoted fields", async () => {
    await runRepoDelete();

    const content = (commitArgs()[4] as { content: string }[])[0].content;
    expect(content.startsWith(BOM)).toBe(true);
    expect(content).toContain("id_objeto,titulo,descripcion,credito,\r\n");
    expect(content).toContain("# Una fila de comentario que el marco conserva\r\n");
    expect(content).toContain("# comentario pegado justo antes del objetivo\r\n");
    expect(content).toContain('"Dice ""la muy noble ciudad"",\r\ny sigue en otra línea."');
    expect(content).toContain("retrato-anonimo,Retrato anónimo,,,\r\n");
    expect(content).not.toContain("Plano de Tunja");
  });
});

// ---------------------------------------------------------------------------
// An id written in more than one row
// ---------------------------------------------------------------------------

describe("delete-object repo branch — an id written in more than one row", () => {
  // The site shows the last row carrying an id, so every one of them goes, and
  // none of them is another row whose stem the object's files share.
  const HEAD = BOM + "object_id,title,description\r\n" + "# una nota\r\n";
  const FIRST = 'plano-de-tunja,"Plano, primero","Dos\r\nlíneas"\r\n';
  const OTHER = "retrato-anonimo,Retrato anónimo,\r\n";

  function request(objectId: string) {
    return {
      readToken: "user-token", commitToken: "installation-token",
      owner: "owner", repo: "repo", objectId, d1FrameworkVersion: "1.7.0",
    };
  }

  const OWN_FILES = [
    `telar-content/objects/${OBJECT_ID}/001.jpg`,
    `telar-content/objects/${OBJECT_ID}/002.jpg`,
    `telar-content/objects/${OBJECT_ID}.tif`,
  ];

  it("removes both rows and the object's files", async () => {
    globalThis.fetch = csvFetch(HEAD + FIRST + OTHER + `${OBJECT_ID},Plano segundo,\r\n`);

    const result = await deleteObjectFromRepository(request(OBJECT_ID));

    expect(result).toEqual({ ok: true, headSha: "sha-after-delete", parentSha: CAPTURED_HEAD });
    expect(commitArgs()[4]).toEqual([{ path: CSV_PATH, content: HEAD + OTHER }]);
    expect(commitArgs()[7]).toEqual(OWN_FILES);
  });

  // The framework reads an id carrying trailing spaces as an object of its own
  // (`_clean_object_ids` strips an id only to look for an image extension), so
  // its row stays; its files would sit under that id, not this one's.
  it("leaves a second row whose id carries trailing spaces, a different object", async () => {
    const padded = `${OBJECT_ID}   ,Plano segundo,\r\n`;
    globalThis.fetch = csvFetch(HEAD + FIRST + OTHER + padded);

    await deleteObjectFromRepository(request(OBJECT_ID));

    expect(commitArgs()[4]).toEqual([{ path: CSV_PATH, content: HEAD + OTHER + padded }]);
    expect(commitArgs()[7]).toEqual(OWN_FILES);
  });

  it("removes an id written once and its files as before", async () => {
    globalThis.fetch = csvFetch(HEAD + FIRST + OTHER);

    await deleteObjectFromRepository(request(OBJECT_ID));

    expect(commitArgs()[4]).toEqual([{ path: CSV_PATH, content: HEAD + OTHER }]);
    expect(commitArgs()[7]).toEqual(OWN_FILES);
  });

  it("keeps the row and the files of another object the site reads under the same id", async () => {
    vi.mocked(getRepoTree).mockResolvedValue({
      tree: [
        blob("telar-content/objects/map.jpg"),
        blob("telar-content/objects/map/001.jpg"),
        blob("telar-content/objects/colonial.jpg"),
      ],
      truncated: false,
    });
    globalThis.fetch = csvFetch("object_id,title\nmap,Map\nmap.jpg,Map image\nmap,Map again\n");

    await deleteObjectFromRepository(request("map"));

    expect(commitArgs()[4]).toEqual([{ path: CSV_PATH, content: "object_id,title\nmap.jpg,Map image\n" }]);
    expect(commitArgs()[7]).toEqual(["telar-content/objects/map/001.jpg"]);
  });
});
