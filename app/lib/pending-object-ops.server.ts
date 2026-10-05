/**
 * The record of each objects operation whose document half has not yet run,
 * and the completion that runs it.
 *
 * An objects operation commits to the repository, then applies its document
 * half through the collaboration object's `/ingest-sync`, which writes D1. A
 * publish, an upload and an objects commit all write objects.csv from D1, so a
 * commit whose document half never ran is undone by the next of them: its
 * objects are dropped from the sheet, or a removed object is written back. The
 * row here outlives that gap. It is written `prepared` before the commit,
 * marked `committed` once the commit is known to have landed, and deleted once
 * the document half has run.
 *
 * `completePendingObjectOps` finishes what is left, and every caller that is
 * about to serialise objects.csv from D1 runs it first, holding a lease, with
 * the sheet read at the head it will commit on. A committed row is simply
 * applied: the collaboration object's receipt, which names each object the
 * operation has settled, and the skip-if-present rule stop it overwriting or
 * reviving anything. A prepared row's commit may or may not have landed, since
 * a thrown request proves neither, so the sheet is the evidence, object by
 * object: a registered object present, a removed one absent, or a renamed one
 * under its new id and not its old, has landed and is applied now. A rename
 * whose only commit switches Google Sheets off in `_config.yml` (`sheets_off`)
 * names an object objects.csv has no row for, so its evidence is
 * `_config.yml` at the same head instead: Sheets off there means it has
 * landed, and D1's configuration is repaired with it, unless a newer such
 * rename from the same id supersedes it. Each object without that evidence is held for
 * `PREPARED_OP_HOLD_MS`, the longest any operation holds its lease, and dropped
 * after. A sheet whose ids cannot be read is no evidence at all: a row inside
 * the hold that needs it fails completion, so the caller does not rewrite that
 * sheet, and one past the hold is dropped.
 *
 * @version v1.5.0-beta
 */

import { and, asc, eq } from "drizzle-orm";

import { objects, pending_object_ops } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { getFileAtRef, type FileAtRef } from "~/lib/github.server";
import { pythonStrip } from "~/lib/column-mapping";
import { readCsvSourceRows } from "~/lib/csv-record-scan.server";
import { BOM } from "~/lib/csv-records";
import {
  OBJECTS_CANONICAL_SCOPE,
  createCsvRecordSkipDetector,
  instructionHeaderOf,
  parseTelarCsv,
  resolvedColumnPosition,
} from "~/lib/import.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { siteSheetFileAt } from "~/lib/site-sheets.server";
import { hasPaddedId, legacyPairingRef, legacyRespellings } from "~/lib/legacy-object-ids.server";
import { StaleHeadError } from "~/lib/commit.server";
import { repairSiteConfig } from "~/lib/config-repair.server";
import { isGoogleSheetsOn } from "~/lib/pyyaml";
import {
  pendingObjectsInDomain,
  registerCommittedObjects,
  type RegistrationResult,
} from "~/lib/register-objects.server";
import type { PendingObject } from "~/lib/sync.server";
import type { IngestObjectRemove } from "../../workers/collaboration";
import type { IngestObjectRename } from "../../workers/object-rename";
import type { FileReferenceRules } from "~/lib/object-file-references";

type Db = ReturnType<typeof getDb>;

/**
 * How long a prepared row is kept without evidence that its commit landed.
 * No operation holds the `objects` lease longer, so past this no commit still
 * in flight can be the one the row records.
 */
export const PREPARED_OP_HOLD_MS = 60 * 60 * 1000;

/** One object a removal names: its key, and the D1 row it meant. */
export interface RemovalTarget {
  object_id: string;
  doc_id: number;
}

/**
 * An object's ID change: the old and new ids, the object's D1 id,
 * the raw step values that take the new id, and the rules its text rewrites follow.
 */
export interface RenameTarget {
  from: string;
  to: string;
  doc_id: number;
  step_values: string[];
  rules: FileReferenceRules;
  /**
   * The rename's only commit is `_config.yml` switching Google Sheets off, for
   * an object with no row in objects.csv: its prepared record is judged by
   * whether the site reads Sheets at the head, not by the sheet.
   */
  sheets_off?: true;
}

/**
 * objects.csv as evidence: no file, the object ids it holds, or a file whose
 * ids cannot be read (no identity column Telar recognises, or a file that does
 * not parse cleanly).
 */
export type SheetObjectIds =
  | { kind: "absent" }
  | { kind: "ids"; ids: Set<string> }
  | { kind: "unusable" };

/** A prepared or committed row, as read back. */
export type PendingObjectOpRow = typeof pending_object_ops.$inferSelect;

/** What completion did with one row. */
export type PendingObjectOpOutcome = "completed" | "dropped" | "kept";

export type CompletionResult =
  /** `applied`: some entry of some row was applied to D1 or the document, whatever the row's outcome. */
  | { ok: true; outcomes: Map<number, PendingObjectOpOutcome>; applied: boolean }
  | { ok: false; outcomes: Map<number, PendingObjectOpOutcome>; failedOp: number | null };

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/**
 * The object ids in an objects.csv source.
 *
 * Read as the importer reads it: the identity column resolved under the
 * canonical mapping at the position the import puts it, comment and bilingual
 * rows skipped, each id as written. A file Papa cannot read
 * cleanly is unusable rather than short: a record that swallowed its
 * neighbours hides their ids, and a missing id is read as a removal having
 * landed.
 */
export function parseSheetObjectIds(source: string): SheetObjectIds {
  const reading = readCsvSourceRows(source);
  if (!reading || reading.refused || reading.rows.length === 0) return { kind: "unusable" };
  if (reading.rows.some((row) => row.rejected)) return { kind: "unusable" };
  const idColumn = resolvedColumnPosition(
    reading.rows.map((row) => row.cells),
    "object_id",
    OBJECTS_CANONICAL_SCOPE,
  );
  if (idColumn === -1) return { kind: "unusable" };
  const ids = new Set<string>();
  for (const row of parseTelarCsv(source, undefined, false, OBJECTS_CANONICAL_SCOPE)) {
    const id = row.object_id ?? "";
    if (pythonStrip(id) !== "") ids.add(id);
  }
  return { kind: "ids", ids };
}

/**
 * A strict read of objects.csv as evidence, or null when the read failed and
 * nothing can be concluded from it.
 */
export function sheetObjectIds(file: FileAtRef): SheetObjectIds | null {
  if (file.status === "error") return null;
  if (file.status === "absent") return { kind: "absent" };
  return parseSheetObjectIds(file.content);
}

/** The objects sheet the build reads at `ref`, read strictly (`siteSheetFileAt`). */
function objectsSheetFileAt(token: string, owner: string, repo: string, ref: string) {
  return siteSheetFileAt("objects", (path) => getFileAtRef(token, owner, repo, path, ref, { strict: true }));
}

/**
 * The objects sheet read strictly at `head`: the file and its path, for a
 * caller that rewrites it, and the sheet as evidence, null when the read failed.
 */
export async function readObjectsSheetAt(
  token: string,
  owner: string,
  repo: string,
  head: string,
): Promise<{ path: string; file: FileAtRef; sheet: SheetObjectIds | null }> {
  const { path, file } = await objectsSheetFileAt(token, owner, repo, head);
  return { path, file, sheet: sheetObjectIds(file) };
}

/**
 * Whether the site reads Google Sheets at `ref`, from `_config.yml` read
 * strictly; false with no `_config.yml`, null when the read failed or decoded
 * lossily, which is no evidence.
 */
export async function readSheetsOnAt(token: string, owner: string, repo: string, ref: string): Promise<boolean | null> {
  const file = await getFileAtRef(token, owner, repo, "_config.yml", ref, { strict: true }).catch(
    () => ({ status: "error" }) as const,
  );
  if (file.status === "absent") return false;
  if (file.status !== "ok" || file.lossy) return null;
  return isGoogleSheetsOn(file.content);
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

type PrepareInput = {
  projectId: number;
  parentSha: string | null;
  actorId: number | null;
  now?: Date;
  /**
   * `committed` for an operation with no commit to wait for: a removal or an
   * ID change from the Compositor alone, or from a repository that holds
   * nothing for the object. Omitted, the record is `prepared`.
   */
  state?: "prepared" | "committed";
} & (
  | { kind: "register"; objects: PendingObject[] }
  | { kind: "remove"; targets: RemovalTarget[] }
  | { kind: "rename"; rename: RenameTarget }
);

function payloadOf(input: PrepareInput): unknown[] {
  if (input.kind === "register") return input.objects;
  return input.kind === "remove" ? input.targets : [input.rename];
}

/** Write an operation's row, `prepared`, before its commit. Answers its id. */
export async function preparePendingObjectOp(db: Db, input: PrepareInput): Promise<number> {
  const payload = payloadOf(input);
  const [row] = await db
    .insert(pending_object_ops)
    .values({
      project_id: input.projectId,
      kind: input.kind,
      state: input.state ?? "prepared",
      payload: JSON.stringify(payload),
      parent_sha: input.parentSha,
      commit_sha: null,
      actor_id: input.actorId,
      created_at: (input.now ?? new Date()).toISOString(),
    })
    .returning({ id: pending_object_ops.id });
  return row.id;
}

/** The commit is known to have landed. */
export async function markPendingObjectOpCommitted(
  db: Db,
  id: number,
  commitSha: string,
): Promise<void> {
  await db
    .update(pending_object_ops)
    .set({ state: "committed", commit_sha: commitSha })
    .where(eq(pending_object_ops.id, id));
}

/** An operation id as a form states it, or null when it states none. */
export function pendingObjectOpIdOf(value: FormDataEntryValue | null): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** How many records the project has still to complete. */
export async function countPendingObjectOps(db: Db, projectId: number): Promise<number> {
  const rows = await db
    .select({ id: pending_object_ops.id })
    .from(pending_object_ops)
    .where(eq(pending_object_ops.project_id, projectId));
  return rows.length;
}

/** The operation is finished, or dropped. */
export async function deletePendingObjectOp(db: Db, id: number): Promise<void> {
  await db.delete(pending_object_ops).where(eq(pending_object_ops.id, id));
}

/** One of the project's rows, or null when it is gone. */
export async function readPendingObjectOp(
  db: Db,
  projectId: number,
  id: number,
): Promise<PendingObjectOpRow | null> {
  const [row] = await db
    .select()
    .from(pending_object_ops)
    .where(and(eq(pending_object_ops.project_id, projectId), eq(pending_object_ops.id, id)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// A committing action's own record
// ---------------------------------------------------------------------------

/**
 * What a committing action does between its head read and its read of D1:
 * read objects.csv strictly at that head, and finish the project's pending
 * operations with it. Answers the file's text to rewrite (undefined when the
 * site has none yet). Throws `ObjectsCommitUnready` when the read fails
 * (`unreadable`) or completion does (`unregistered`), whether either answers
 * a failure or throws one, and the action must refuse: a failed read taken
 * for a missing file rewrites objects.csv without its comment and instruction
 * rows, and D1 read before completion lacks the objects the CSV written from
 * it would drop.
 *
 * `unreadCheck`, given by the actions that write objects.csv from D1, names
 * the project's `objects_read_sha`, and throws `ObjectsSheetChanged` before
 * completion when GitHub's object rows are not the ones D1 accounts for
 * (`refuseUnreadObjectRows`).
 *
 * Last, while the project's ids have not been repaired
 * (`legacy_ids_repaired_at` NULL), a row D1 holds under the stripped form of an
 * id GitHub writes padded, where the commit whose object rows D1 accounts for
 * (`legacyRecordRef`) writes it padded too, refuses the commit with
 * `ObjectsSheetChanged`, which each caller answers by sending the author to the
 * sync (`refuseStrippedRows`): the file written from D1 would replace GitHub's
 * id with the stripped one, and only the sync's first check repairs it. With
 * no such commit, or none that can be read, nothing can be judged and nothing
 * is refused.
 */
export async function prepareObjectsCommit(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: Db,
  projectId: number,
  repoRead: { token: string; owner: string; repo: string; head: string },
  options: { unreadCheck?: { readSha: string | null } } = {},
): Promise<{ path: string; existingCsv: string | undefined }> {
  const { path, file, sheet } = await readObjectsSheetAt(
    repoRead.token, repoRead.owner, repoRead.repo, repoRead.head,
  ).catch((err: unknown) => {
    throw new ObjectsCommitUnready("unreadable", `objects.csv could not be read: ${String(err)}`);
  });
  if (sheet === null) throw new ObjectsCommitUnready("unreadable", "objects.csv could not be read");
  if (options.unreadCheck) await refuseUnreadObjectRows(repoRead, file, options.unreadCheck.readSha);
  const sheetsOn = () => readSheetsOnAt(repoRead.token, repoRead.owner, repoRead.repo, repoRead.head);
  const completion = await completePendingObjectOps(env, db, projectId, sheet, { sheetsOn }).catch((err: unknown) => {
    throw new ObjectsCommitUnready("unregistered", `pending operations could not be completed: ${String(err)}`);
  });
  if (!completion.ok) {
    throw new ObjectsCommitUnready(
      "unregistered",
      `pending operation ${completion.failedOp} could not be completed`,
    );
  }
  await refuseStrippedRows(db, projectId, repoRead, file);
  return { path, existingCsv: file.status === "ok" ? file.content : undefined };
}

/**
 * objects.csv's text at `ref`, the commit legacy pairing is judged against:
 * GitHub's copy already read where `ref` is the head, null where that commit
 * has no objects.csv, and undefined where it cannot be read.
 */
async function legacyRecordText(
  repoRead: { token: string; owner: string; repo: string; head: string },
  atHead: string,
  ref: string,
): Promise<string | null | undefined> {
  if (ref === repoRead.head) return atHead;
  const read = await objectsSheetFileAt(repoRead.token, repoRead.owner, repoRead.repo, ref)
    .then(({ file }) => file)
    .catch(() => ({ status: "error" }) as const);
  if (read.status === "error") return undefined;
  return read.status === "ok" ? read.content : null;
}

/**
 * Throws `ObjectsSheetChanged` when, before the project's ids have been
 * repaired, D1 holds a row under the stripped form of an id GitHub's
 * objects.csv (`atHead`) writes padded and the commit whose object rows D1
 * accounts for (`legacyPairingRef`) writes padded too (`legacyRespellings`).
 * The project row and that commit are read only when some GitHub id is padded.
 */
async function refuseStrippedRows(
  db: Db,
  projectId: number,
  repoRead: { token: string; owner: string; repo: string; head: string },
  atHead: FileAtRef,
): Promise<void> {
  if (atHead.status !== "ok") return;
  const atGitHub = parseSheetObjectIds(atHead.content);
  if (atGitHub.kind !== "ids" || !hasPaddedId(atGitHub.ids)) return;
  const ref = await legacyPairingRef(db, projectId);
  if (!ref) return;
  const recordedText = await legacyRecordText(repoRead, atHead.content, ref);
  if (recordedText === undefined) return;
  const atRecord = recordedText === null ? { kind: "ids" as const, ids: new Set<string>() } : parseSheetObjectIds(recordedText);
  if (atRecord.kind !== "ids") return;
  const d1Rows = await db
    .select({ id: objects.id, object_id: objects.object_id })
    .from(objects)
    .where(eq(objects.project_id, projectId));
  if (legacyRespellings([...atGitHub.ids], d1Rows, [...atRecord.ids]).size > 0) throw new ObjectsSheetChanged();
}

/**
 * Throws `ObjectsSheetChanged` unless the object rows of objects.csv at
 * `repoRead.head` (`atHead`, read there already) are those at `readSha`, the
 * last commit whose object rows D1 accounts for.
 *
 * At `readSha` itself nothing more is read. With no record there is nothing to
 * compare against, and only a site with no objects.csv goes on. Otherwise the
 * file is read strictly at `readSha`, and a failed read is
 * `ObjectsCommitUnready` ("unreadable").
 */
async function refuseUnreadObjectRows(
  repoRead: { token: string; owner: string; repo: string; head: string },
  atHead: FileAtRef,
  readSha: string | null,
): Promise<void> {
  if (readSha === repoRead.head) return;
  const headText = atHead.status === "ok" ? atHead.content : null;
  if (readSha === null) {
    if (headText === null) return;
    throw new ObjectsSheetChanged();
  }
  const atRead = await objectsSheetFileAt(repoRead.token, repoRead.owner, repoRead.repo, readSha)
    .then(({ file }) => file)
    .catch((err: unknown) => {
      throw new ObjectsCommitUnready("unreadable", `objects.csv could not be read at ${readSha}: ${String(err)}`);
    });
  if (atRead.status === "error") {
    throw new ObjectsCommitUnready("unreadable", `objects.csv could not be read at ${readSha}`);
  }
  if (!sameObjectRows(atRead.status === "ok" ? atRead.content : null, headText)) {
    throw new ObjectsSheetChanged();
  }
}

/**
 * Whether two objects.csv sources, null for no file, hold the same object
 * rows: every record but the comment rows and the blank lines pandas never
 * reads, as the characters the file has them in, in order. Comment rows are
 * left out because the writer carries them from GitHub's copy as they are; the
 * header and the bilingual row are compared, since the writer writes its own
 * over them. Text rather than parsed fields, so a cell the parser drops, under
 * no header, still counts. A source with no clean reading compares equal only
 * to the same text.
 */
function sameObjectRows(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  const rowsA = a === null ? [] : objectRowTexts(a);
  const rowsB = b === null ? [] : objectRowTexts(b);
  if (rowsA === null || rowsB === null) return false;
  return rowsA.length === rowsB.length && rowsA.every((text, i) => text === rowsB[i]);
}

/**
 * The object rows of an objects.csv source as text, or null when the file has
 * no clean reading. The header is the first record, and the rest are
 * classified by `createCsvRecordSkipDetector`, the importer's own, as
 * `extractCommentRows` and `removeObjectRecord` classify them. A mark at the
 * file's offset zero is its encoding, not the header's text.
 */
function objectRowTexts(source: string): string[] | null {
  const reading = readCsvSourceRows(source);
  if (!reading || reading.refused || reading.rows.some((row) => row.rejected)) return null;
  if (reading.rows.length === 0) return [];
  const [header, ...rest] = reading.rows;
  const isSkipped = createCsvRecordSkipDetector(false, instructionHeaderOf(reading.rows.map((row) => row.cells)));
  const kept = rest.filter((row) => {
    const verdict = isSkipped(row.cells, header.cells.length);
    return !verdict.skip || verdict.reason === "bilingual-header";
  });
  const headerText = header.range.start === 0 && header.range.text.startsWith(BOM)
    ? header.range.text.slice(BOM.length)
    : header.range.text;
  return [headerText, ...kept.map((row) => row.range.text)];
}

/**
 * GitHub's objects.csv has object rows the Compositor has not read: they
 * differ from those at the project's `objects_read_sha`, or there is no record
 * and GitHub has the file. Writing objects.csv from D1 would replace them, so
 * the action refuses as it refuses a head that moved during it.
 */
export class ObjectsSheetChanged extends Error {
  constructor() {
    super("objects.csv has object rows the Compositor has not read");
    this.name = "ObjectsSheetChanged";
  }
}

/**
 * A committing action may not go on: objects.csv could not be read, or an
 * earlier operation could not be completed. Thrown rather than answered, so
 * each action refuses it through the generic failure it already gives for a
 * failed read.
 */
export class ObjectsCommitUnready extends Error {
  /**
   * Why: objects.csv could not be read; an earlier operation could not be
   * completed; or an object is outside what the ingest takes. Publish names
   * the first two to the author.
   */
  readonly reason: "unreadable" | "unregistered" | "out_of_domain";

  constructor(reason: ObjectsCommitUnready["reason"], message: string) {
    super(message);
    this.name = "ObjectsCommitUnready";
    this.reason = reason;
  }
}

/**
 * Write a registering commit's record, `prepared`, before the commit; null for
 * a commit that carries no objects, which has nothing to register.
 *
 * Throws `ObjectsCommitUnready`, writing nothing, when the ingest would refuse
 * any of the objects: committed, such an object would sit in the repository
 * with nothing able to register it.
 */
export async function prepareRegistrationRecord(
  db: Db,
  input: { projectId: number; objects: PendingObject[]; parentSha: string; actorId: number },
): Promise<number | null> {
  if (!pendingObjectsInDomain(input.objects, input.actorId)) {
    throw new ObjectsCommitUnready("out_of_domain", "an object is outside the domain the ingest takes");
  }
  if (input.objects.length === 0) return null;
  return preparePendingObjectOp(db, { kind: "register", ...input });
}

/**
 * Run a commit under a prepared record. A stale-head refusal is GitHub
 * declining the ref update before anything is written, so the record goes with
 * it; any other throw — a lost response, a reset connection — leaves the
 * commit's fate unknown, so the record stays prepared for completion to judge
 * against the sheet.
 */
export async function commitUnderRecord<T>(
  db: Db,
  opId: number | null,
  commit: () => Promise<T>,
): Promise<T> {
  try {
    return await commit();
  } catch (err) {
    if (opId !== null && err instanceof StaleHeadError) {
      try {
        await deletePendingObjectOp(db, opId);
      } catch (deleteErr) {
        // A prepared record whose objects never reach the sheet is dropped
        // after the hold, so a failed delete costs only that wait.
        console.error(`commitUnderRecord: could not delete operation ${opId}`, deleteErr);
      }
    }
    throw err;
  }
}

/**
 * The document half of a landed commit: mark its record committed, register
 * the objects with the record's id, and delete the record once they are
 * registered. A failed registration keeps the record, which the modal's retry
 * and every later completion finish. The answer carries the operation's id for
 * that retry.
 *
 * Never throws: the commit has landed, and a D1 failure writing the record is
 * logged. A record left prepared is completed on the sheet's evidence; one left
 * after a registration that succeeded is answered by the receipt.
 */
export async function finishRecordedRegistration(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: Db,
  projectId: number,
  actorId: number,
  objects: PendingObject[],
  opId: number | null,
  commitSha: string,
): Promise<RegistrationResult> {
  // A commit carrying no objects has no record and nothing to register.
  if (opId === null) {
    return { ok: true, insertedCount: 0, alreadyPresent: [], failed: [], operationId: null };
  }
  try {
    await markPendingObjectOpCommitted(db, opId, commitSha);
  } catch (err) {
    console.error(`finishRecordedRegistration: could not mark operation ${opId} committed`, err);
  }
  const registration = await registerCommittedObjects(env, db, projectId, actorId, objects, { opId });
  if (registration.ok) {
    try {
      await deletePendingObjectOp(db, opId);
    } catch (err) {
      console.error(`finishRecordedRegistration: could not delete operation ${opId}`, err);
    }
  }
  return { ...registration, operationId: opId };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** The sheet, or a read of it made only once a row needs it. */
export type SheetSource = SheetObjectIds | (() => Promise<SheetObjectIds | null>);

/** Whether the site reads Google Sheets at the sheet's head, null when that could not be read (`readSheetsOnAt`). */
export type SheetsOnReading = () => Promise<boolean | null>;

/** The head's evidence, each part read at most once and only when a prepared row needs it. */
interface HeadEvidence {
  sheet: () => Promise<SheetObjectIds | null>;
  sheetsOn: () => Promise<boolean | null>;
}

/** A read made once, on first use. */
function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let held: Promise<T> | undefined;
  return () => (held ??= read());
}

/**
 * Complete the project's rows in id order.
 *
 * A row is deleted once none of its objects is held. A failed ingest stops
 * completion and answers failed with that row and every later one standing, as
 * does a sheet that could not be read, or whose ids could not, when a prepared
 * row needs it. `sheet` is objects.csv read strictly at the head the caller will commit
 * on; as a function it is read only when a prepared row needs it, so a project
 * with nothing prepared costs no GitHub read.
 *
 * `sheetsOn` reads `_config.yml` at the same head, for a prepared `sheets_off`
 * rename; without it such a row has no evidence.
 *
 * A prepared `sheets_off` rename is dropped, with nothing applied, when the
 * project holds a newer committed `sheets_off` rename from the same id
 * (`supersededSheetsOffRenames`).
 *
 * `opIds` restricts completion to those operations.
 */
export async function completePendingObjectOps(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: Db,
  projectId: number,
  sheet: SheetSource,
  options: { opIds?: number[]; now?: Date; sheetsOn?: SheetsOnReading } = {},
): Promise<CompletionResult> {
  const outcomes = new Map<number, PendingObjectOpOutcome>();
  const { rows, superseded } = await projectRows(db, projectId, options.opIds);
  if (rows.length === 0) return { ok: true, outcomes, applied: false };

  const now = (options.now ?? new Date()).getTime();
  const evidence: HeadEvidence = {
    sheet: readOnce(async () => (typeof sheet === "function" ? sheet() : sheet)),
    sheetsOn: readOnce(options.sheetsOn ?? (async () => null)),
  };

  const touched = { applied: false };
  for (const row of rows) {
    const outcome = superseded.has(row.id)
      ? await dropSuperseded(db, projectId, row)
      : await completeOne(env, db, projectId, row, evidence, now, touched);
    if (outcome === "failed") return { ok: false, outcomes, failedOp: row.id };
    outcomes.set(row.id, outcome);
  }
  return { ok: true, outcomes, applied: touched.applied };
}

/** The rows to complete, in id order, and the project's superseded ones, read from all its rows whatever `opIds` names. */
async function projectRows(
  db: Db,
  projectId: number,
  opIds: number[] | undefined,
): Promise<{ rows: PendingObjectOpRow[]; superseded: Set<number> }> {
  const all = await db
    .select()
    .from(pending_object_ops)
    .where(eq(pending_object_ops.project_id, projectId))
    .orderBy(asc(pending_object_ops.id));
  return { rows: opIds ? all.filter((row) => opIds.includes(row.id)) : all, superseded: supersededSheetsOffRenames(all) };
}

/**
 * The prepared `sheets_off` renames that a newer committed `sheets_off`
 * rename from the same id supersedes. Sheets off at the head is evidence for
 * every one of them alike, and a rename reaches the document only at
 * completion, so the author never saw an older one: the latest landed request
 * is the rename. A newer one still prepared supersedes nothing, since a stale
 * head may yet delete it while the older one's commit has landed.
 */
function supersededSheetsOffRenames(rows: PendingObjectOpRow[]): Set<number> {
  const renames = rows.filter(isSheetsOffRename).map((row) => ({ row, from: parseRenamePayload(row)[0]?.from ?? "" }));
  const newestCommitted = new Map<string, number>();
  for (const { row, from } of renames) if (row.state === "committed") newestCommitted.set(from, row.id);
  return new Set(
    renames.filter(({ row, from }) => row.state === "prepared" && row.id < (newestCommitted.get(from) ?? -1)).map(({ row }) => row.id),
  );
}

/** A superseded row goes with nothing applied. */
async function dropSuperseded(db: Db, projectId: number, row: PendingObjectOpRow): Promise<PendingObjectOpOutcome> {
  console.error(
    `completePendingObjectOps: dropped rename operation ${row.id} for project ${projectId}: ` +
      `a newer rename from the same id supersedes it`,
  );
  await deletePendingObjectOp(db, row.id);
  return "dropped";
}

/**
 * Complete, keep or drop one row; "failed" stops completion with the row
 * standing.
 *
 * Evidence is per object. The objects the evidence says landed are applied
 * now, with the row's id, and the rest are held; the row goes once nothing is
 * held, or once the hold has run out and the held objects are dropped. Applying
 * the same objects again at the next completion is safe: the ingest's receipt
 * names them as settled.
 */
async function completeOne(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: Db,
  projectId: number,
  row: PendingObjectOpRow,
  evidence: HeadEvidence,
  now: number,
  touched: { applied: boolean },
): Promise<PendingObjectOpOutcome | "failed"> {
  const plan = await planRow(row, evidence, now);
  if (plan === null) return "failed";
  if (plan.apply.length > 0 && !(await applyDocumentHalf(env, db, projectId, row, plan.apply))) {
    return "failed";
  }
  if (plan.apply.length > 0) touched.applied = true;
  if (plan.held.length > 0 && !plan.expired) return "kept";
  if (plan.held.length > 0) {
    console.error(
      `completePendingObjectOps: dropped ${plan.held.length} object(s) of ${row.state} ${row.kind} ` +
        `operation ${row.id} for project ${projectId}: no evidence they landed within the hold`,
    );
  }
  await deletePendingObjectOp(db, row.id);
  return plan.held.length > 0 && plan.apply.length === 0 ? "dropped" : "completed";
}

/** Which of a row's objects to apply now, which to hold, and whether the hold has run out. */
interface RowPlan {
  apply: string[];
  held: string[];
  expired: boolean;
}

/**
 * The plan for one row, or null when the head gives it no evidence — a sheet
 * that could not be read, or whose ids could not be, or a `_config.yml` that
 * could not be — and it is still inside the hold. A committed row applies
 * every object. A prepared one applies the objects the head shows landed
 * (`landedAtHead`) and holds the rest.
 */
async function planRow(row: PendingObjectOpRow, evidence: HeadEvidence, now: number): Promise<RowPlan | null> {
  const keys = objectKeysOf(row);
  if (row.state === "committed") return { apply: keys, held: [], expired: false };
  const expired = now - Date.parse(row.created_at) > PREPARED_OP_HOLD_MS;
  const landed = await landedAtHead(row, evidence);
  // No evidence either way. Inside the hold the caller refuses; past it every
  // object is held and dropped, as any object without evidence is, since the
  // remedy for such a file is on GitHub and a refusal must not outlast it.
  if (landed === null) return expired ? { apply: [], held: keys, expired } : null;
  return { apply: keys.filter(landed), held: keys.filter((key) => !landed(key)), expired };
}

/**
 * Which of a prepared row's objects the head shows landed, or null when it
 * gives no evidence. A `sheets_off` rename has landed once the site no longer
 * reads Sheets; every other row is judged by the sheet (`landedOn`).
 */
async function landedAtHead(row: PendingObjectOpRow, evidence: HeadEvidence): Promise<((key: string) => boolean) | null> {
  if (isSheetsOffRename(row)) {
    const on = await evidence.sheetsOn();
    return on === null ? null : () => !on;
  }
  const sheet = await evidence.sheet();
  if (sheet === null || sheet.kind === "unusable") return null;
  return landedOn(row, (key) => sheet.kind === "ids" && sheet.ids.has(key));
}

/** A rename whose only commit switches Google Sheets off (`RenameTarget.sheets_off`). */
function isSheetsOffRename(row: PendingObjectOpRow): boolean {
  return row.kind === "rename" && parseRenamePayload(row).some((entry) => entry.sheets_off === true);
}

/**
 * Whether the sheet shows one of the row's objects landed: a registered object
 * present, a removed one absent, a renamed one under its new id (the key) and
 * not its old one.
 */
function landedOn(row: PendingObjectOpRow, present: (key: string) => boolean): (key: string) => boolean {
  if (row.kind === "register") return present;
  if (row.kind === "remove") return (key) => !present(key);
  const fromByTo = new Map(parseRenamePayload(row).map((entry) => [entry.to, entry.from]));
  return (key) => present(key) && fromByTo.has(key) && !present(fromByTo.get(key) as string);
}

/** The object ids a row names; a rename's is its new id. */
function objectKeysOf(row: PendingObjectOpRow): string[] {
  if (row.kind === "rename") return parseRenamePayload(row).map((entry) => entry.to);
  return parsePayload(row).map((entry) => entry.object_id);
}

function parseRenamePayload(row: PendingObjectOpRow): RenameTarget[] {
  return parsePayload(row) as unknown as RenameTarget[];
}

function parsePayload(row: PendingObjectOpRow): Array<{ object_id: string }> {
  try {
    const parsed = JSON.parse(row.payload);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Send the document half for the row's objects named in `keys`, with the
 * row's id. True when it has run. A registration refused for a reason no retry
 * changes is not treated as done: after a commit has landed it can only mean
 * the committing action's validation and the ingest's disagree, which is a
 * defect, so the row stays and completion fails where it can be seen.
 */
async function applyDocumentHalf(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: Db,
  projectId: number,
  row: PendingObjectOpRow,
  keys: string[],
): Promise<boolean> {
  const wanted = new Set(keys);
  if (row.kind === "rename") {
    // A prepared `sheets_off` row is applied only once the head shows its
    // commit landed with its answer lost, so the configuration repair that
    // follows a landed commit's answer (`commitSheetsOffUnderRecord`) runs here.
    if (row.state === "prepared" && isSheetsOffRename(row)) {
      await repairSiteConfig(db, env as never, projectId, { google_sheets_enabled: false });
    }
    return ingestRename(env, projectId, row.id, parseRenamePayload(row).filter((entry) => wanted.has(entry.to)));
  }
  const entries = parsePayload(row).filter((entry) => wanted.has(entry.object_id));
  if (row.kind === "remove") {
    return ingestRemoval(env, projectId, row.id, entries as RemovalTarget[]);
  }
  const registration = await registerCommittedObjects(
    env, db, projectId, row.actor_id, entries as PendingObject[], { opId: row.id },
  );
  if (!registration.ok && registration.retryable === false) {
    console.error(
      `completePendingObjectOps: the ingest refused operation ${row.id} for project ${projectId} ` +
        `after its commit landed; the committing action's validation and the ingest's disagree`,
    );
  }
  return registration.ok;
}

/**
 * A removal with no commit to wait for — from the Compositor alone, or from a
 * repository that holds nothing for the object — as an operation of its own.
 *
 * The record is written `committed` with no heads, and the removal is sent
 * with its id, so the collaboration object verifies it against D1 before
 * answering: a removal whose object D1 still holds is not answered done. A
 * removal that succeeds deletes the record. One that fails, or whose outcome is
 * unknown, answers `pending` and keeps the record: the ingest may already have
 * removed the Y.Map before its flush failed, and completion finishes it either
 * way. A record write that throws answers `delete_failed`: it may have landed,
 * and if it did, completion removes the object.
 */
export async function removeThroughCommittedRecord(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  db: Db,
  projectId: number,
  actorId: number,
  target: RemovalTarget,
): Promise<{ ok: true; pending: boolean } | { ok: false; error: "delete_failed" }> {
  let opId: number;
  try {
    opId = await preparePendingObjectOp(db, {
      projectId, kind: "remove", targets: [target], parentSha: null, actorId, state: "committed",
    });
  } catch (err) {
    // A write that threw may still have landed, its answer lost, and a record
    // that landed finishes the removal at the next completion. So this is an
    // unknown outcome, never "nothing was changed".
    console.error(`removeThroughCommittedRecord: the record write for project ${projectId} threw`, err);
    return { ok: false, error: "delete_failed" };
  }
  const removed = await ingestRemoval(env, projectId, opId, [target]);
  if (removed) {
    try {
      await deletePendingObjectOp(db, opId);
    } catch (err) {
      // The receipt answers a later completion of the same record.
      console.error(`removeThroughCommittedRecord: could not delete operation ${opId}`, err);
    }
  }
  return { ok: true, pending: !removed };
}

/**
 * Apply a removal through the collaboration object, as operation `opId` when
 * it is one (a removal with no record carries none). Every answer the ingest
 * gives finishes the operation: removed, already gone, someone else now (the
 * object under that key carries another D1 id), or a course item it refuses.
 */
export async function ingestRemoval(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  opId: number | undefined,
  targets: RemovalTarget[],
): Promise<boolean> {
  const remove: IngestObjectRemove[] = targets.map((t) => ({
    objectId: t.object_id,
    docId: t.doc_id,
  }));
  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    const res = await stub.fetch(
      new Request("https://internal/ingest-sync", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ opId, objects: { remove } }),
      }),
    );
    if (!res.ok) {
      console.error(`ingestRemoval: ingest for project ${projectId} returned ${res.status}`);
      return false;
    }
    const body = (await res.json()) as {
      removals?: { course?: string[]; superseded?: string[] };
    };
    const course = body.removals?.course ?? [];
    if (course.length > 0) {
      console.error(
        `ingestRemoval: operation ${opId} for project ${projectId} named ${course.length} ` +
          `course item(s), which the ingest refuses to remove: ${course.join(", ")}`,
      );
    }
    return true;
  } catch (err) {
    console.error(`ingestRemoval: ingest for project ${projectId} unreachable:`, err);
    return false;
  }
}

/**
 * Apply an ID change through the collaboration object's `objects.rename` arm,
 * as operation `opId`. Every answer the arm gives finishes the operation:
 * renamed, already renamed, someone else now (the row holds another id),
 * gone, or a course item it refuses. A refused entry does not, as a refused
 * registration does not (`applyDocumentHalf`): after a landed commit it is a
 * defect, so the record stays where completion's failure shows it. Nor does
 * any other answer, a 503 included.
 */
export async function ingestRename(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  opId: number,
  targets: RenameTarget[],
): Promise<boolean> {
  const rename: IngestObjectRename[] = targets.map((t) => ({
    from: t.from,
    to: t.to,
    docId: t.doc_id,
    stepValues: t.step_values,
    rules: t.rules,
  }));
  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    const res = await stub.fetch(
      new Request("https://internal/ingest-sync", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ opId, objects: { rename } }),
      }),
    );
    if (!res.ok) {
      console.error(`ingestRename: ingest for project ${projectId} returned ${res.status}`);
      return false;
    }
    const body = (await res.json()) as { renames?: { course?: string[] }; refused?: { objectRename?: number[] } };
    if ((body.refused?.objectRename ?? []).length > 0) {
      console.error(
        `ingestRename: the ingest refused operation ${opId} for project ${projectId} ` +
          `after its commit landed; the renaming action's validation and the ingest's disagree`,
      );
      return false;
    }
    const course = body.renames?.course ?? [];
    if (course.length > 0) {
      console.error(
        `ingestRename: operation ${opId} for project ${projectId} named ${course.length} ` +
          `course item(s), which the ingest refuses to rename: ${course.join(", ")}`,
      );
    }
    return true;
  } catch (err) {
    console.error(`ingestRename: ingest for project ${projectId} unreachable:`, err);
    return false;
  }
}
