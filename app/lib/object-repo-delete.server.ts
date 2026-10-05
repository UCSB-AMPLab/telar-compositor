/**
 * The repository half of an object delete: the image files and the objects.csv
 * record, removed in one commit.
 *
 * Everything the commit is built from is read at a single captured revision
 * and the commit is fenced to it, so a change that lands between the reads and
 * the write is refused as `stale_head` rather than silently missed. A read the
 * branch cannot rely on — a failed tree read, a truncated one, a CSV read that
 * is neither a genuine 404 nor usable content — answers `delete_failed` before
 * anything is committed: a partial tree cannot prove the object's files are
 * gone, and an unreadable CSV cannot say which record to drop.
 *
 * The CSV is edited, not regenerated. Publish rewrites objects.csv from D1;
 * a delete does not, because an author who removed one object did not ask for
 * every other row to be reformatted. Every record carrying the object's id is
 * removed by its exact character range and the rest of the file survives byte
 * for byte.
 *
 * Both image layouts are removed: the folder `telar-content/objects/<id>/…`
 * that older sites carry, and the flat `telar-content/objects/<id>.<ext>` the
 * upload path writes and sync reads.
 *
 * @version v1.5.0-beta
 */

import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { siteSheetFileAt } from "~/lib/site-sheets.server";
import type { TreeEntry } from "~/lib/github.server";
import { commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { removeObjectRecord } from "~/lib/csv-record-scan.server";
import { reserialiseSurvivingObjects } from "~/lib/csv-export.server";
import { OBJECTS_CANONICAL_SCOPE, parseTelarCsv } from "~/lib/import.server";
import { objectFileStems } from "~/lib/object-id";
import { readRepositorySiteVersion } from "~/lib/site-version.server";
import type { getDb } from "~/lib/db.server";
import {
  deletePendingObjectOp,
  ingestRemoval,
  markPendingObjectOpCommitted,
  preparePendingObjectOp,
  removeThroughCommittedRecord,
  type RemovalTarget,
} from "~/lib/pending-object-ops.server";

/** Where a Telar site keeps its object images. */
const OBJECTS_DIR = "telar-content/objects";

/**
 * What the branch answers. `stale_head` means nothing was committed — the
 * fence held. `delete_failed` means the update could not be confirmed: a
 * mutation whose response fails to arrive or decode may still have landed, so
 * the caller must not tell the author that nothing changed.
 */
export type RepoDeleteResult =
  | { ok: true; headSha: string; parentSha: string }
  | { ok: true; headSha: null }
  | { ok: false; error: "stale_head" | "delete_failed" };

export interface RepoDeleteRequest {
  /** Token for the reads — the caller's own GitHub access. */
  readToken: string;
  /** Token for the write; the App installation token where one is available. */
  commitToken: string;
  owner: string;
  repo: string;
  /** The object's slug — its folder name, its file stem, and its CSV id. */
  objectId: string;
  /**
   * D1's `telar_version`. The id the site gives the object, and so the stem it
   * finds the object's file under, follows the repository's version at the
   * captured revision; D1's is used only where the repository names none
   * (`readRepositorySiteVersion`).
   */
  d1FrameworkVersion?: string | null;
  /**
   * Run once the commit is built and before it is sent, with the revision it
   * is fenced to. A throw here refuses the delete with nothing committed.
   */
  beforeCommit?: (capturedHead: string) => Promise<void>;
}

/**
 * Every blob belonging to the object, across both layouts.
 *
 * Matching is on whole names, never on prefixes. The flat layout is a direct
 * child of the objects directory whose name, with its final extension removed,
 * IS the id — the same stem sync reads (`sync.server.ts`), so `mapa.detail.jpg`
 * belongs to an object called `mapa.detail` and a delete of `mapa` leaves it
 * alone. The folder layout is the directory whose own name is the id, so
 * `mapa.detail/001.jpg` stays for the same reason.
 *
 * The flat layout is matched against `flatStems`, the stems that are the
 * object's alone (`objectFileStems`): the site strips an image extension from
 * an id before it looks for the file, so the file `map.jpg` is the image of an
 * object written `map.jpg`, and a stem another row also reads as belongs to
 * both rows and is kept. Without `flatStems` the stem is the id itself.
 */
export function collectObjectBlobPaths(
  tree: TreeEntry[],
  objectId: string,
  flatStems: ReadonlySet<string> = new Set([objectId]),
): string[] {
  return tree
    .filter((item) => item.type === "blob" && typeof item.path === "string")
    .map((item) => item.path)
    .filter((path) => belongsToObject(path, objectId, flatStems));
}

/** True when `path` is one of the object's own files, under either layout. */
function belongsToObject(path: string, objectId: string, flatStems: ReadonlySet<string>): boolean {
  const parts = path.split("/");
  if (parts.length < 3) return false;
  if (`${parts[0]}/${parts[1]}` !== OBJECTS_DIR) return false;
  // Deeper than a direct child: the folder layout, named by its directory.
  if (parts.length > 3) return parts[2] === objectId;
  return flatStems.has(parts[2].replace(/\.[^.]+$/, ""));
}

/**
 * Removes the object's files and its objects.csv record in one commit against
 * `main`, at the revision the reads were taken from.
 *
 * A genuine 404 on objects.csv means the site has no such file, and the delete
 * proceeds with the file deletions alone. With nothing to delete and no record
 * to drop, no commit is made and `headSha` is null: the repository already
 * holds nothing for this object. A commit answers `parentSha`, the revision it
 * was built on and fenced to.
 */
export async function deleteObjectFromRepository(
  request: RepoDeleteRequest,
): Promise<RepoDeleteResult> {
  const { readToken, commitToken, owner, repo, objectId } = request;

  try {
    const capturedHead = await getRepoHead(readToken, owner, repo, "main");

    const tree = await readTreeAtRevision(readToken, owner, repo, capturedHead);
    if (!tree) return { ok: false, error: "delete_failed" };

    const sheet = await objectsCsvAddition(readToken, owner, repo, capturedHead, objectId);
    if (!sheet) return { ok: false, error: "delete_failed" };
    const { files } = sheet;

    // The object's flat files are those under its own id and the id the site
    // gives it, less any stem another row of the sheet reads as.
    const siteVersion = await readRepositorySiteVersion(
      readToken, owner, repo, capturedHead, request.d1FrameworkVersion ?? null,
    );
    const flatStems = objectFileStems(objectId, sheet.ids, siteVersion);
    const deletions = collectObjectBlobPaths(tree, objectId, flatStems);

    if (files.length === 0 && deletions.length === 0) return { ok: true, headSha: null };

    await request.beforeCommit?.(capturedHead);
    const commit = await commitFilesToRepo(
      commitToken,
      owner,
      repo,
      "main",
      files,
      `Remove ${objectId} via Telar Compositor`,
      undefined,                                      // messageBody
      deletions.length > 0 ? deletions : undefined,   // deletions
      undefined,                                      // skipCi
      capturedHead,                                   // expectedHeadOidOverride
    );
    return { ok: true, headSha: commit.newHeadSha, parentSha: capturedHead };
  } catch (err) {
    if (err instanceof StaleHeadError) return { ok: false, error: "stale_head" };
    return { ok: false, error: "delete_failed" };
  }
}

/**
 * The objects.csv the commit should carry, as a one-element addition list — or
 * an empty list when there is nothing to write, or null when the read cannot
 * be relied on and the whole delete must be refused — with the ids of every
 * row the file holds, as the importer reads them.
 *
 * The sheet is the file the build reads (`siteSheetFileAt`: objects.csv, else
 * objetos.csv), and the commit rewrites that file. The read is strict, so
 * "absent" is an HTTP 404 and nothing else: a genuine 404 on both names means
 * the site has no objects sheet and the delete proceeds on the file
 * deletions alone, while any other failure, and any content that is not a CSV
 * with an `object_id` column, refuses. A CSV that holds no record for the
 * object needs no write of its own.
 */
async function objectsCsvAddition(
  token: string,
  owner: string,
  repo: string,
  revision: string,
  objectId: string,
): Promise<{ files: { path: string; content: string }[]; ids: string[] } | null> {
  const { path: objectsPath, file: csv } = await siteSheetFileAt("objects", (at) =>
    getFileAtRef(token, owner, repo, at, revision, { strict: true }),
  );
  if (csv.status === "error") return null;
  if (csv.status === "absent") return { files: [], ids: [] };

  const removal = removeObjectRecord(csv.content, objectId);
  if (removal.status === "unusable") return null;
  const ids = parseTelarCsv(csv.content, undefined, false, OBJECTS_CANONICAL_SCOPE)
    .map((row) => row.object_id ?? "");
  if (removal.status === "absent") return { files: [], ids };
  const content = removal.survivors ? reserialiseSurvivingObjects(removal.survivors, csv.content) : removal.text;
  return { files: [{ path: objectsPath, content }], ids };
}

/**
 * The tree at `revision`, or null when it cannot be trusted. A truncated tree
 * and a failed read are one answer: neither can prove which of the object's
 * files exist.
 */
async function readTreeAtRevision(
  token: string,
  owner: string,
  repo: string,
  revision: string,
): Promise<TreeEntry[] | null> {
  try {
    const read = await getRepoTree(token, owner, repo, revision);
    return read.truncated ? null : read.tree;
  } catch {
    return null;
  }
}

/** What a deletion from the repository answers once its document half has run, or not. */
export type RecordedDeleteResult =
  | { ok: true; headSha: string; parentSha: string; pending: boolean }
  | { ok: true; headSha: null; pending: boolean }
  | { ok: false; error: "stale_head" | "delete_failed" };

/**
 * The whole of a deletion from the repository: the repository half, then the
 * document half, under a `remove` record.
 *
 * The record is written once the commit is built, with the head it is fenced
 * to and the object's D1 id, and before the commit is sent. A stale-head
 * refusal is GitHub declining the ref update before anything is written, so
 * the record goes with it; any other failure leaves the commit's fate unknown
 * and the record prepared, for completion to judge against the sheet. A
 * landed commit marks it committed, and the removal is then sent with the
 * record's id. `pending` answers a removal that did not go through: the
 * repository half is done, and the record finishes the document half later.
 *
 * A repository that holds nothing for the object makes no commit; its removal
 * is an operation of its own (`removeThroughCommittedRecord`).
 *
 * Never throws: the record's own writes after the commit are logged, not
 * raised, since the commit has landed.
 */
export async function deleteObjectWithRecord(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: ReturnType<typeof getDb>,
  projectId: number,
  actorId: number,
  request: RepoDeleteRequest,
  target: RemovalTarget,
): Promise<RecordedDeleteResult> {
  // Written from inside the repository half, once the commit is built.
  const record: { id: number | null } = { id: null };
  const result = await deleteObjectFromRepository({
    ...request,
    beforeCommit: async (capturedHead) => {
      record.id = await preparePendingObjectOp(db, {
        projectId, kind: "remove", targets: [target], parentSha: capturedHead, actorId,
      });
    },
  });
  const recorded = record.id;
  if (!result.ok) {
    if (result.error === "stale_head" && recorded !== null) await quietly(() => deletePendingObjectOp(db, recorded));
    return result;
  }
  if (recorded === null || result.headSha === null) {
    const removal = await removeThroughCommittedRecord(env, db, projectId, actorId, target);
    return removal.ok ? { ok: true, headSha: null, pending: removal.pending } : removal;
  }
  const { headSha, parentSha } = result;
  await quietly(() => markPendingObjectOpCommitted(db, recorded, headSha));
  const removed = await ingestRemoval(env, projectId, recorded, [target]);
  if (removed) await quietly(() => deletePendingObjectOp(db, recorded));
  return { ok: true, headSha, parentSha, pending: !removed };
}

/** Run a record write whose failure must not turn a landed commit into a failure. */
async function quietly(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error("deleteObjectWithRecord: a record write failed after the commit", err);
  }
}
