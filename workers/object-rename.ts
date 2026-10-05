/**
 * The `objects.rename` arm of `/ingest-sync`: the document half of an
 * object's ID change whose commit has landed.
 *
 * The arm travels alone with the operation id of its `rename` record, since
 * its step and text rewrites are its own effect and no other arm carries a
 * per-object receipt. Each entry finds its object by D1 row id (`docId`), not
 * by key: the map holding `from` is renamed; one holding `to` already has
 * been (a replay whose receipt was pruned) and nothing is written; one holding
 * another key is `superseded`; no such map is `absent`; a course item is
 * refused as `course`, as removals are. Each of these finishes the operation.
 *
 * A rename that applies does all of this in the caller's one transaction: the
 * map's key becomes `to`; its thumbnail, and an imported audio object's
 * `source_url` (the audio file's name), are rewritten where the rules name
 * them, as the repository half rewrites the same cells of objects.csv: a
 * publish writes objects.csv from D1, so a cell left here would undo the
 * repository's; every step whose `object_id` is one of `stepValues` takes `to`; and the rules'
 * text edits are applied to layer contents, page bodies and glossary
 * definitions as edits at their match offsets, never by replacing a Y.Text
 * whole, so a concurrent edit elsewhere in the same text is kept. Another map
 * holding `to` can only be an object a client created after the action's
 * uniqueness check; the commit has landed, so that map is re-keyed in the same
 * transaction, clear of every key the document and D1 hold, and named in
 * `displaced`.
 *
 * The receipt names `to` under `renamed` only once D1, read after the flush,
 * shows `to` under `docId`.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

import { makeUniqueTermId } from "~/lib/glossary-slug";
import {
  fileReferenceEdits,
  rewriteAudioSource,
  rewriteThumbnail,
  type FileReferenceRules,
} from "~/lib/object-file-references";
import { partitionOnIdentityDomainIndexed } from "./can-delete";
import { markerCourse } from "./course-marker-invariant";

/** One object's ID change, as the rename record states it. */
export interface IngestObjectRename {
  from: string;
  to: string;
  docId: number;
  /** The raw step `object_id` values that resolve to the object and take `to`. */
  stepValues: string[];
  rules: FileReferenceRules;
}

/** Another object that held `to`, re-keyed by the rename. */
export interface DisplacedObject {
  docId: unknown;
  objectId: string;
  rekeyedTo: string;
}

/** What each entry met, by its `to`. */
export interface ObjectRenameOutcome {
  applied: string[];
  alreadyApplied: string[];
  superseded: string[];
  absent: string[];
  course: string[];
  displaced: DisplacedObject[];
}

export function emptyObjectRenameOutcome(): ObjectRenameOutcome {
  return { applied: [], alreadyApplied: [], superseded: [], absent: [], course: [], displaced: [] };
}

/**
 * Whether a payload carrying `objects.rename` carries an operation id and
 * nothing else: no other top-level field and no other `objects` arm.
 */
export function renameTravelsAlone(payload: Record<string, unknown>): boolean {
  const objects = payload.objects as Record<string, unknown> | null | undefined;
  if (objects === null || typeof objects !== "object" || objects.rename === undefined) return true;
  if (payload.opId === undefined) return false;
  const topLevel = Object.keys(payload).every((key) => key === "opId" || key === "objects");
  return topLevel && Object.keys(objects).every((key) => key === "rename");
}

function isPlainEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNameChange(value: unknown): boolean {
  return isPlainEntry(value) && typeof value.from === "string" && typeof value.to === "string";
}

function isFileReferenceRules(value: unknown): value is FileReferenceRules {
  if (!isPlainEntry(value)) return false;
  const { moved, carouselShadowed, tiles, oldSiteId } = value;
  return (
    Array.isArray(moved) &&
    moved.every(isNameChange) &&
    isStringList(carouselShadowed) &&
    (tiles === null || isNameChange(tiles)) &&
    typeof oldSiteId === "string"
  );
}

function isRenameShape(entry: unknown): entry is IngestObjectRename {
  if (!isPlainEntry(entry)) return false;
  const { from, docId, stepValues, rules } = entry;
  const rowId = typeof docId === "number" && Number.isSafeInteger(docId) && docId > 0;
  return typeof from === "string" && from !== "" && rowId && isStringList(stepValues) && isFileReferenceRules(rules);
}

/**
 * The arm split into the entries the document may take and the positions of
 * those it may not: out of shape, or a `to` outside the objects root's
 * identity domain. An arm that is not an array is refused at position 0.
 */
export function partitionObjectRenameArm(raw: unknown): { accepted: IngestObjectRename[]; refused: number[] } {
  if (!Array.isArray(raw)) return { accepted: [], refused: [0] };
  const refused: number[] = [];
  const shaped: Array<{ position: number; entry: IngestObjectRename }> = [];
  raw.forEach((entry, position) => {
    if (isRenameShape(entry)) shaped.push({ position, entry });
    else refused.push(position);
  });
  const identified = partitionOnIdentityDomainIndexed(shaped.map((s) => s.entry), "objects", (e) => e.to);
  for (const at of identified.refused) refused.push(shaped[at].position);
  refused.sort((a, b) => a - b);
  return { accepted: identified.accepted.map((held) => held.entry), refused };
}

/** The entries whose `to` the operation's receipt does not yet name, and those it does. */
export function unreceiptedRenames(
  entries: readonly IngestObjectRename[],
  renamed: readonly string[],
): { remaining: IngestObjectRename[]; receipted: string[] } {
  const settled = new Set(renamed);
  return {
    remaining: entries.filter((entry) => !settled.has(entry.to)),
    receipted: entries.filter((entry) => settled.has(entry.to)).map((entry) => entry.to),
  };
}

function mapsOf(array: unknown): Y.Map<unknown>[] {
  if (!(array instanceof Y.Array)) return [];
  return array.toArray().filter((member): member is Y.Map<unknown> => member instanceof Y.Map);
}

/** Apply the rules' edits to a Y.Text at their match offsets, last first so earlier offsets hold. */
function rewriteYText(value: unknown, rules: FileReferenceRules): void {
  if (!(value instanceof Y.Text)) return;
  const { edits } = fileReferenceEdits(value.toString(), rules);
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    value.delete(edit.offset, edit.length);
    value.insert(edit.offset, edit.insert);
  }
}

/** Every step map in the document, across every story. */
function stepMaps(doc: Y.Doc): Y.Map<unknown>[] {
  return mapsOf(doc.getArray("stories")).flatMap((story) => mapsOf(story.get("steps")));
}

function rewriteDocumentTexts(doc: Y.Doc, rules: FileReferenceRules): void {
  for (const step of stepMaps(doc)) {
    for (const layer of mapsOf(step.get("layers"))) rewriteYText(layer.get("content"), rules);
  }
  for (const page of mapsOf(doc.getArray("pages"))) rewriteYText(page.get("body"), rules);
  for (const term of mapsOf(doc.getArray("glossary"))) rewriteYText(term.get("definition"), rules);
}

/**
 * Re-key every map other than `target` that holds `to`, each to a key no map
 * in the document, no D1 row and none of `reserved` holds, and name it in
 * `displaced`. `reserved` is every value the rename's step rewrite touches: a
 * displaced key equal to one would have its steps rewritten back to `to`. Returns the
 * key the first displaced map took, or null when none was displaced.
 */
function rekeyDisplaced(
  objects: Y.Map<unknown>[],
  target: Y.Map<unknown>,
  to: string,
  d1Keys: ReadonlySet<string>,
  reserved: readonly string[],
  displaced: DisplacedObject[],
): string | null {
  const holders = objects.filter((map) => map !== target && map.get("object_id") === to);
  if (holders.length === 0) return null;
  const taken = new Set<string>([...d1Keys, ...reserved]);
  for (const map of objects) {
    const key = map.get("object_id");
    if (typeof key === "string") taken.add(key);
  }
  for (const map of holders) {
    const fresh = makeUniqueTermId(to, [...taken]);
    taken.add(fresh);
    map.set("object_id", fresh);
    displaced.push({ docId: map.get("_id") ?? null, objectId: to, rekeyedTo: fresh });
  }
  return displaced[displaced.length - holders.length].rekeyedTo;
}

/** Set one of the renamed object's plain string fields to what `rewrite` answers, or leave it on null. */
function rewriteOwnCell(target: Y.Map<unknown>, key: string, rewrite: (value: string) => string | null): void {
  const value = target.get(key);
  const rewritten = typeof value === "string" ? rewrite(value) : null;
  if (rewritten !== null) target.set(key, rewritten);
}

function applyRenameToTarget(
  doc: Y.Doc,
  target: Y.Map<unknown>,
  objects: Y.Map<unknown>[],
  entry: IngestObjectRename,
  d1Keys: ReadonlySet<string>,
  outcome: ObjectRenameOutcome,
): void {
  const displacedKey = rekeyDisplaced(objects, target, entry.to, d1Keys, [entry.to, ...entry.stepValues], outcome.displaced);
  // Before this rename applies, a step holding `to` can only mean the displaced
  // object, so those steps follow it to its new key ahead of the rename's own
  // step rewrites, which then point theirs at `to`.
  if (displacedKey !== null) {
    for (const step of stepMaps(doc)) {
      if (step.get("object_id") === entry.to) step.set("object_id", displacedKey);
    }
  }
  target.set("object_id", entry.to);
  rewriteOwnCell(target, "thumbnail", (value) => rewriteThumbnail(value, entry.rules));
  rewriteOwnCell(target, "source_url", (value) => rewriteAudioSource(value, entry.rules));
  const values = new Set(entry.stepValues);
  for (const step of stepMaps(doc)) {
    const value = step.get("object_id");
    if (typeof value === "string" && values.has(value)) step.set("object_id", entry.to);
  }
  rewriteDocumentTexts(doc, entry.rules);
  outcome.applied.push(entry.to);
}

/**
 * Apply one entry to the document and record what it met. Runs inside the
 * caller's transaction; `d1Keys` is every `object_id` D1 holds for the
 * project, read before it.
 */
export function applyObjectRename(
  doc: Y.Doc,
  entry: IngestObjectRename,
  d1Keys: ReadonlySet<string>,
  outcome: ObjectRenameOutcome,
): void {
  const objects = mapsOf(doc.getArray("objects"));
  const target = objects.find((map) => map.get("_id") === entry.docId);
  if (!target) {
    outcome.absent.push(entry.to);
    return;
  }
  if (markerCourse(target.get("course_project_id")) !== null) {
    outcome.course.push(entry.to);
    return;
  }
  const key = target.get("object_id");
  if (key === entry.to) outcome.alreadyApplied.push(entry.to);
  else if (key === entry.from) applyRenameToTarget(doc, target, objects, entry, d1Keys, outcome);
  else outcome.superseded.push(entry.to);
}

/**
 * The entries the document holds renamed (`applied` or `alreadyApplied`)
 * whose `to` D1 shows under their `docId`, and how many it does not.
 */
export function settledRenames(
  entries: readonly IngestObjectRename[],
  outcome: ObjectRenameOutcome,
  rows: ReadonlyArray<{ id: number; object_id: string }>,
): { renamed: string[]; unsettled: number } {
  const held = new Set([...outcome.applied, ...outcome.alreadyApplied]);
  const keyById = new Map(rows.map((row) => [row.id, row.object_id]));
  const candidates = entries.filter((entry) => held.has(entry.to));
  const renamed = candidates.filter((entry) => keyById.get(entry.docId) === entry.to).map((entry) => entry.to);
  return { renamed, unsettled: candidates.length - renamed.length };
}
