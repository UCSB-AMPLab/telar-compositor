/**
 * An object's ID change, the object page's `rename-object` action.
 *
 * The convenor, or whoever created the object, may change its ID; never a
 * course item's while its marker is set, since the course preload inserts by
 * ID and would bring the old one back. The page posts the ID it showed, and
 * the rename refuses when the object holds another, both before the lease and
 * once earlier operations are finished, so it never renames an ID the author
 * did not see (`rename_stale_object`). The new ID follows the upload's rule as
 * typed, survives the site's sheet reader, and has to be the object's alone
 * (`newIdRefusal`). The repository write gate refuses a site behind the
 * release, as for the repository delete. A site whose reads would pass the
 * Worker's subrequest limit refuses before its first story read
 * (`planRenameCommit`).
 *
 * The whole run holds the `objects` operation lease, so no publish, upload,
 * objects commit, sync or delete runs beside it. Everything is read at one
 * head: the tree (a truncated read refuses), objects.csv, `_config.yml`, the
 * story CSVs and the text files. Earlier operations are finished first
 * (`prepareObjectsCommit`), so a registration or removal still owed reaches
 * D1 before D1 is read; without the unread check, since the rename edits
 * objects.csv in place and keeps an unread GitHub edit to another row.
 *
 * Where objects.csv has a row for the object, one commit fenced to the head
 * moves its files by blob SHA and rewrites the sheets and texts that name it
 * (`planRenameCommit`, `commitTreeOnHead`). Before it, the tile cache is
 * listed with the token that will dispatch the build, so a token that cannot
 * reach the caches refuses with nothing committed. A `rename` record is
 * written prepared just before the commit; a stale head deletes it, a landed
 * commit marks it committed, and the document half deletes it once it has
 * run. After the commit the head and `objects_read_sha` advance from the
 * parent, the tile cache is cleared, and the build is dispatched, so the
 * site retiles under the new ID.
 *
 * Where it has none, nothing of the rename is committed: it runs in the
 * document alone under a record written committed, unless files under the old ID's
 * stems sit in the repository with no row, which the objects sync registers
 * first (`rename_unregistered_files`).
 *
 * On a site that reads Google Sheets the build would overwrite the renamed
 * rows, so the rename goes ahead only when the author switches Sheets off:
 * in the rename's commit, or, for a rename in the document alone, in a
 * commit of `_config.yml` alone before it, under a `rename` record written
 * prepared just before that commit and judged by `_config.yml` at the head
 * when the commit's fate is unknown (`sheets_off`).
 *
 * The page posts what its dialog said about the steps
 * (`renameFactsFingerprint`), worked out from D1 alone. Once the head is
 * read, the facts are worked out again from objects.csv at the head and D1,
 * the reading the rename itself follows, and a rename whose facts differ
 * from the posted ones is not made: the answer carries the new facts, so
 * the author confirms what the rename will actually do. This holds for the
 * commit and for the rename in the document alone.
 *
 * Answers are codes and params; the page words them.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";

import { objects, project_config, projects, steps, stories } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { decrypt } from "~/lib/crypto.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { getFileAtRef, getRepoHead, getRepoTree, type TreeEntry } from "~/lib/github.server";
import { readSiteSheet } from "~/lib/site-sheets.server";
import {
  StaleHeadError,
  SheetsNotDisableableError,
  disableGoogleSheetsInConfig,
  dispatchWorkflow,
} from "~/lib/commit.server";
import { isGoogleSheetsOn } from "~/lib/pyyaml";
import { getUserRole } from "~/lib/membership.server";
import { holdOperationLease } from "~/lib/operation-lease.server";
import { readRepoWriteRefusal } from "~/lib/upgrade-gate.server";
import { readSiteTelarVersion, siteVersionFrom } from "~/lib/site-version.server";
import { objectsSheetOrder } from "~/lib/objects.server";
import { configSiteBase, siteObjectId } from "~/lib/object-id";
import { OBJECTS_CANONICAL_SCOPE, parseTelarCsv } from "~/lib/import.server";
import { bumpObjectsReadFrom, bumpProjectHeadFrom } from "~/lib/github-status.server";
import { repairSiteConfig } from "~/lib/config-repair.server";
import { commitTreeOnHead } from "~/lib/git-tree-commit.server";
import { clearTileCacheEntries, listTileCacheEntries } from "~/lib/tile-cache.server";
import { noFileReferenceRules } from "~/lib/object-file-references";
import { renameStepValues } from "~/lib/object-rename-steps";
import {
  ObjectsSheetChanged,
  commitUnderRecord,
  deletePendingObjectOp,
  ingestRename,
  markPendingObjectOpCommitted,
  parseSheetObjectIds,
  prepareObjectsCommit,
  preparePendingObjectOp,
  type RenameTarget,
} from "~/lib/pending-object-ops.server";
import {
  RENAME_ID_PATTERN,
  objectRenameFacts,
  renameFactsFingerprint,
  type ObjectRenameFacts,
} from "~/lib/object-rename-id";
import {
  RenameRefused,
  isSheetRowOf,
  newIdRefusal,
  ownObjectPaths,
  planRenameCommit,
  renameRowsOf,
  type RenameCommitContent,
  type RenameContext,
  type RenameRefusal,
  type RepoAtHead,
} from "~/lib/object-rename-plan.server";

type Db = ReturnType<typeof getDb>;
type RenameEnv = Env;

const CONFIG_YML_PATH = "_config.yml";

/** What the page posts. */
export interface RenameRequest {
  objectDbId: number;
  /** The object's ID as the page showed it; a rename whose object has since taken another refuses. */
  shownObjectId: string;
  /** The new ID as typed. */
  newId: string;
  /** The author agreed to switch Google Sheets off in a commit made by the rename. */
  disableSheets: boolean;
  /** `renameFactsFingerprint` of the facts the dialog showed for `newId`. */
  confirmedFacts: string;
}

/** The person renaming. */
export interface RenameActor {
  id: number;
  encrypted_access_token: string;
}

/**
 * What the action answers. `pending`: the new ID is in the repository and the
 * document half is still owed; its record finishes it. `committed`: the
 * repository was changed (false for a rename in the document alone).
 */
export type RenameAnswer =
  | {
      ok: true;
      intent: "rename-object";
      objectDbId: number;
      newId: string;
      pending: boolean;
      committed: boolean;
      dispatchRunId: number | null;
    }
  | { ok: false; intent: "rename-object"; objectDbId: number; error: string; params?: Record<string, string> }
  | { ok: false; intent: "rename-object"; objectDbId: number; error: "rename_facts_changed"; facts: ObjectRenameFacts };

type ObjectRow = typeof objects.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** The object, its own site, and the caller's role there. */
interface Standing {
  target: ObjectRow;
  project: ProjectRow;
  role: string;
}

/** How the leased run ended: refused, or stopped on facts the author has not seen, with nothing committed; or done. */
type LeasedOutcome =
  | { done: false; refusal: RenameRefusal }
  | { done: false; changed: ObjectRenameFacts }
  | { done: true; pending: boolean; repository: RepoAtHead | null };

/** The object and its site as the caller stands on it, or null when either is gone or the caller is no member. */
async function readStanding(db: Db, actorId: number, objectDbId: number): Promise<Standing | null> {
  const [target] = await db.select().from(objects).where(eq(objects.id, objectDbId)).limit(1);
  if (!target) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, target.project_id)).limit(1);
  if (!project) return null;
  const role = await getUserRole(db, project.id, actorId);
  return role === null ? null : { target, project, role };
}

/** The refusals answered before anything is read from the repository. */
async function refusalBeforeLease(
  env: RenameEnv,
  db: Db,
  actor: RenameActor,
  standing: Standing,
  request: RenameRequest,
): Promise<RenameRefusal | null> {
  const { newId } = request;
  const { target, project, role } = standing;
  if (role !== "convenor" && target.created_by !== actor.id) return { error: "forbidden" };
  if (target.course_project_id != null) return { error: "course_item_rename_refused" };
  if (newId === target.object_id) return { error: "rename_unchanged" };
  if (target.object_id !== request.shownObjectId) return { error: "rename_stale_object" };
  if (!RENAME_ID_PATTERN.test(newId)) return { error: "invalid_id" };
  const gate = await readRepoWriteRefusal(db, env, {
    project,
    userRole: role,
    encryptedToken: actor.encrypted_access_token,
  });
  return gate === null ? null : { error: gate };
}

/**
 * The page's `rename-object`: the checks, then the rename under the objects
 * lease, then the tile cache and the build for a rename that committed.
 * Answers `not_found` when the object or its site is gone, or the caller is
 * no member of it.
 */
export async function renameObjectFromPage(
  env: RenameEnv,
  db: Db,
  actor: RenameActor,
  request: RenameRequest,
): Promise<RenameAnswer | "not_found"> {
  const standing = await readStanding(db, actor.id, request.objectDbId);
  if (!standing) return "not_found";
  const refuse = (refusal: RenameRefusal): RenameAnswer => ({
    ok: false, intent: "rename-object", objectDbId: request.objectDbId, ...refusal,
  });
  const early = await refusalBeforeLease(env, db, actor, standing, request);
  if (early) return refuse(early);

  const held = await holdOperationLease(env, standing.project.id, actor.id, "objects", (landed) =>
    renameUnderLease(env, db, actor, standing, request, landed),
  );
  if (held.refused) return refuse({ error: "rename_operation_in_progress" });
  const outcome = held.value;
  if (!outcome.done && "changed" in outcome) {
    return { ok: false, intent: "rename-object", objectDbId: request.objectDbId, error: "rename_facts_changed", facts: outcome.changed };
  }
  if (!outcome.done) return refuse(outcome.refusal);

  const dispatchRunId = outcome.repository ? await rebuildAfterRename(outcome.repository) : null;
  return {
    ok: true,
    intent: "rename-object",
    objectDbId: request.objectDbId,
    newId: request.newId,
    pending: outcome.pending,
    committed: outcome.repository !== null,
    dispatchRunId,
  };
}

/**
 * After a rename commit: the tile cache cleared, then the build dispatched,
 * which then finds no entry and retiles under the new ID. Never throws; a
 * failed dispatch answers null and the next build retiles.
 */
async function rebuildAfterRename(at: RepoAtHead): Promise<number | null> {
  await clearTileCacheEntries(at.token, at.owner, at.repo);
  try {
    const dispatch = await dispatchWorkflow(at.token, at.owner, at.repo, "build.yml");
    return dispatch.runId || null;
  } catch (err) {
    console.error(`rename-object: dispatching ${at.owner}/${at.repo}'s build failed`, err);
    return null;
  }
}

/** The leased run, with every failure before the commit answered as a refusal. */
async function renameUnderLease(
  env: RenameEnv,
  db: Db,
  actor: RenameActor,
  standing: Standing,
  request: RenameRequest,
  landed: () => void,
): Promise<LeasedOutcome> {
  try {
    return await renameAtHead(env, db, actor, standing, request, landed);
  } catch (err) {
    return { done: false, refusal: refusalOf(err) };
  }
}

/** The refusal a throw before the commit answers. */
function refusalOf(err: unknown): RenameRefusal {
  if (err instanceof RenameRefused) return err.answer;
  if (err instanceof StaleHeadError || err instanceof ObjectsSheetChanged) return { error: "rename_stale_head" };
  if (err instanceof SheetsNotDisableableError) return { error: "rename_sheets_not_disableable" };
  console.error("rename-object: failed before the commit", err);
  return { error: "rename_failed" };
}

/** The installation token for the reads and the commit, and the head they are taken at. */
async function openRepository(env: RenameEnv, actor: RenameActor, standing: Standing): Promise<RepoAtHead> {
  const userToken = await decrypt(actor.encrypted_access_token, env.ENCRYPTION_KEY);
  const token = await resolveProjectToken(
    env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, standing.project.installation_id, userToken, standing.role,
  );
  const [owner, repo] = standing.project.github_repo_full_name.split("/");
  return { token, owner, repo, head: await getRepoHead(token, owner, repo, "main") };
}

/** One strict read at the head: the text, null for a 404; a failed or lossy read refuses. */
async function readOptionalAtHead(at: RepoAtHead, path: string): Promise<string | null> {
  const read = await getFileAtRef(at.token, at.owner, at.repo, path, at.head, { strict: true });
  if (read.status === "absent") return null;
  if (read.status !== "ok" || read.lossy) throw new RenameRefused({ error: "rename_failed" });
  return read.content;
}

/** The tree at the head; a truncated or failed read refuses, as it cannot show which files exist. */
async function readTreeAtHead(at: RepoAtHead): Promise<TreeEntry[]> {
  const read = await getRepoTree(at.token, at.owner, at.repo, at.head).catch(() => null);
  if (read === null || read.truncated) throw new RenameRefused({ error: "rename_failed" });
  return read.tree;
}

/** objects.csv's ids at the head in file order, repeats included; a file whose ids cannot be read refuses. */
function sheetIdsOf(objectsCsv: string | null): string[] {
  if (objectsCsv === null) return [];
  if (parseSheetObjectIds(objectsCsv).kind !== "ids") throw new RenameRefused({ error: "rename_failed" });
  return parseTelarCsv(objectsCsv, undefined, false, OBJECTS_CANONICAL_SCOPE).map((row) => row.object_id ?? "");
}

/** What D1 holds once earlier operations are finished: the object, every object row, every step's value, the site's base. */
async function readD1AfterCompletion(db: Db, projectId: number, objectDbId: number) {
  const [target] = await db
    .select({ id: objects.id, object_id: objects.object_id })
    .from(objects)
    .where(and(eq(objects.id, objectDbId), eq(objects.project_id, projectId)))
    .limit(1);
  const rows = await db
    .select({ id: objects.id, object_id: objects.object_id })
    .from(objects)
    .where(eq(objects.project_id, projectId))
    .orderBy(objectsSheetOrder());
  const stepRows = await db
    .select({ object_id: steps.object_id })
    .from(steps)
    .innerJoin(stories, eq(steps.story_id, stories.id))
    .where(eq(stories.project_id, projectId));
  const [config] = await db.select().from(project_config).where(eq(project_config.project_id, projectId)).limit(1);
  return { target, rows, stepValues: stepRows.map((row) => row.object_id), siteBase: configSiteBase(config) };
}

/**
 * The rename from the head read onwards: the reads, the earlier operations
 * finished, the checks against D1 and the head, then the document-only
 * rename or the commit.
 */
async function renameAtHead(
  env: RenameEnv,
  db: Db,
  actor: RenameActor,
  standing: Standing,
  request: RenameRequest,
  landed: () => void,
): Promise<LeasedOutcome> {
  const projectId = standing.project.id;
  const at = await openRepository(env, actor, standing);
  const [tree, objectsSheet, configYml] = await Promise.all([
    readTreeAtHead(at),
    readSiteSheet("objects", (path) => readOptionalAtHead(at, path)),
    readOptionalAtHead(at, CONFIG_YML_PATH),
  ]);
  const { path: objectsPath, content: objectsCsv } = objectsSheet;
  await prepareObjectsCommit(env, db, projectId, at);
  const d1 = await readD1AfterCompletion(db, projectId, request.objectDbId);
  if (!d1.target) throw new RenameRefused({ error: "rename_failed" });
  // Finishing earlier operations may have renamed the object since the page
  // was drawn: to the new ID itself, which is then unchanged, or to another,
  // and the rename applies only to the ID the author saw. Both answer as they
  // do before the lease.
  if (d1.target.object_id === request.newId) return { done: false, refusal: { error: "rename_unchanged" } };
  if (d1.target.object_id !== request.shownObjectId) return { done: false, refusal: { error: "rename_stale_object" } };

  const ctx: RenameContext = {
    oldId: d1.target.object_id,
    newId: request.newId,
    docId: d1.target.id,
    tree,
    sheetIds: sheetIdsOf(objectsCsv),
    d1Rows: d1.rows,
    version: siteVersionFrom(configYml?.replace(/^﻿/, "") ?? null, await readSiteTelarVersion(db, projectId)),
  };
  const taken = newIdRefusal(ctx);
  if (taken) return { done: false, refusal: taken };
  const facts = objectRenameFacts(d1.target, renameRowsOf(ctx), d1.stepValues);
  if (renameFactsFingerprint(facts, ctx.newId) !== request.confirmedFacts) return { done: false, changed: facts };

  const recorded = { env, db, projectId, actorId: actor.id, landed };
  const sheetsOff = configTextSwitchingSheetsOff(configYml, request.disableSheets);
  if (objectsCsv === null || !ctx.sheetIds.some((id) => isSheetRowOf(id, ctx.oldId))) {
    return renameInDocumentOnly(recorded, at, ctx, { d1StepValues: d1.stepValues, sheetsOff });
  }
  const content = await planRenameCommit(at, ctx, { objectsPath, objectsCsv, d1StepValues: d1.stepValues, siteBase: d1.siteBase });
  if (sheetsOff !== null) content.texts.push({ path: CONFIG_YML_PATH, content: sheetsOff });
  return renameThroughCommit(recorded, at, ctx, content, sheetsOff !== null);
}

/**
 * `_config.yml` with Google Sheets switched off, or null when the site does
 * not read Sheets. A site that does, without the author's agreement, refuses:
 * its build would overwrite the renamed rows from the sheet.
 */
function configTextSwitchingSheetsOff(configYml: string | null, disableSheets: boolean): string | null {
  if (configYml === null || !isGoogleSheetsOn(configYml)) return null;
  if (!disableSheets) throw new RenameRefused({ error: "rename_sheets_on" });
  return disableGoogleSheetsInConfig(configYml);
}

/** What a recorded rename needs beside the rename itself. */
interface RecordedRun {
  env: RenameEnv;
  db: Db;
  projectId: number;
  actorId: number;
  landed: () => void;
}

/**
 * A rename with no row for the object in objects.csv: no cache and no build;
 * the document half alone. Files under the old ID's stems with no row refuse:
 * the objects sync registers them first. With nothing to commit, the record
 * is written committed, as `removeThroughCommittedRecord` writes one. On a
 * site reading Google Sheets, whose next build would bring the old ID back
 * from the sheet, `sheetsOff` is `_config.yml` with Sheets switched off,
 * committed alone under the record (`commitSheetsOffUnderRecord`).
 */
async function renameInDocumentOnly(
  run: RecordedRun,
  at: RepoAtHead,
  ctx: RenameContext,
  input: { d1StepValues: ReadonlyArray<string | null>; sheetsOff: string | null },
): Promise<LeasedOutcome> {
  if (ownObjectPaths(ctx).size > 0) return { done: false, refusal: { error: "rename_unregistered_files" } };
  const target: RenameTarget = {
    from: ctx.oldId,
    to: ctx.newId,
    doc_id: ctx.docId,
    step_values: renameStepValues(ctx.oldId, input.d1StepValues, renameRowsOf(ctx)),
    rules: noFileReferenceRules(siteObjectId(ctx.oldId, ctx.version)),
  };
  const opId = input.sheetsOff === null
    ? await recordDocumentRename(run, target)
    : await commitSheetsOffUnderRecord(run, at, ctx, { ...target, sheets_off: true }, input.sheetsOff);
  return { done: true, pending: !(await applyRecordedRename(run, opId, target)), repository: null };
}

/**
 * The record of a rename with no commit, written committed. A write that
 * threw may have landed with its answer lost; the refusal is then
 * `rename_failed`, and a record that landed finishes the rename at the next
 * completion.
 */
async function recordDocumentRename(run: RecordedRun, target: RenameTarget): Promise<number> {
  const opId = await preparePendingObjectOp(run.db, {
    projectId: run.projectId, kind: "rename", rename: target, parentSha: null, actorId: run.actorId, state: "committed",
  });
  run.landed();
  return opId;
}

/**
 * `_config.yml` with Sheets switched off, committed alone and fenced to the
 * head, under a `rename` record written prepared just before it; answers the
 * record's id. A stale head deletes the record and throws with nothing
 * written. Any other failure leaves the commit's fate unknown and the record
 * prepared, and completion applies it, with D1's configuration, once
 * `_config.yml` at the head no longer reads Sheets (`sheets_off`), unless a
 * newer such record from the same id supersedes it. Once the commit lands,
 * the record is marked committed, the head and `objects_read_sha` advance
 * from the parent, and D1's configuration follows.
 */
async function commitSheetsOffUnderRecord(
  run: RecordedRun,
  at: RepoAtHead,
  ctx: RenameContext,
  target: RenameTarget,
  configText: string,
): Promise<number> {
  const opId = await preparePendingObjectOp(run.db, {
    projectId: run.projectId, kind: "rename", rename: target, parentSha: at.head, actorId: run.actorId,
  });
  const { commitSha } = await commitUnderRecord(run.db, opId, () => commitTreeOnHead({
    token: at.token,
    owner: at.owner,
    repo: at.repo,
    branch: "main",
    parentSha: at.head,
    message: `Turn off Google Sheets to rename ${ctx.oldId} to ${ctx.newId} via Telar Compositor [skip ci]`,
    placements: [],
    texts: [{ path: CONFIG_YML_PATH, content: configText }],
    deletions: [],
  }));
  run.landed();
  await writeAfterRenameLanded(() => markPendingObjectOpCommitted(run.db, opId, commitSha));
  await recordRenameCommit(run, at.head, commitSha);
  await writeAfterRenameLanded(() =>
    repairSiteConfig(run.db, run.env as never, run.projectId, { google_sheets_enabled: false }),
  );
  return opId;
}

/** The document half of a recorded rename; the record goes once it has run. True when it has. */
async function applyRecordedRename(run: RecordedRun, opId: number, target: RenameTarget): Promise<boolean> {
  const renamed = await ingestRename(run.env, run.projectId, opId, [target]);
  if (renamed) await writeAfterRenameLanded(() => deletePendingObjectOp(run.db, opId));
  return renamed;
}

/**
 * The rename through one commit fenced to the head, under a `rename` record
 * written prepared just before it, and the bookkeeping after it lands.
 */
async function renameThroughCommit(
  run: RecordedRun,
  at: RepoAtHead,
  ctx: RenameContext,
  content: RenameCommitContent,
  sheetsOff: boolean,
): Promise<LeasedOutcome> {
  const listing = await listTileCacheEntries(at.token, at.owner, at.repo);
  if (!listing.ok) return { done: false, refusal: { error: "rename_cache_unreachable" } };

  const target: RenameTarget = {
    from: ctx.oldId, to: ctx.newId, doc_id: ctx.docId, step_values: content.stepValues, rules: content.rules,
  };
  const opId = await preparePendingObjectOp(run.db, {
    projectId: run.projectId, kind: "rename", rename: target, parentSha: at.head, actorId: run.actorId,
  });
  const { commitSha } = await commitUnderRecord(run.db, opId, () =>
    commitTreeOnHead({
      token: at.token,
      owner: at.owner,
      repo: at.repo,
      branch: "main",
      parentSha: at.head,
      message: `Rename ${ctx.oldId} to ${ctx.newId} via Telar Compositor [skip ci]`,
      placements: content.placements,
      texts: content.texts,
      deletions: content.deletions,
    }),
  );
  run.landed();

  await writeAfterRenameLanded(() => markPendingObjectOpCommitted(run.db, opId, commitSha));
  const renamed = await applyRecordedRename(run, opId, target);
  await recordRenameCommit(run, at.head, commitSha);
  if (sheetsOff) await repairSiteConfig(run.db, run.env as never, run.projectId, { google_sheets_enabled: false });
  return { done: true, pending: !renamed, repository: at };
}

/**
 * The head, then `objects_read_sha`, advanced from the parent the commit was
 * built on, as `recordObjectsCommit` advances them. The commit's objects.csv
 * is the parent's with the rename's cells changed, so the record advances
 * only where it stood at the parent; a commit on a head the Compositor had
 * not read leaves both where they were.
 */
async function recordRenameCommit(run: RecordedRun, parent: string, committed: string): Promise<void> {
  await writeAfterRenameLanded(() => bumpProjectHeadFrom(run.db, run.projectId, parent, committed));
  await writeAfterRenameLanded(() => bumpObjectsReadFrom(run.db, run.projectId, parent, committed));
}

/** Run a write whose failure must not turn a rename that has landed into a failure. */
async function writeAfterRenameLanded(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error("rename-object: a record write failed after the commit", err);
  }
}
