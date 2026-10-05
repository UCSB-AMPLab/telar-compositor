/**
 * What the object page and the `rename-object` action both judge a new
 * object ID by, and what the page's Change ID dialog says before it posts.
 *
 * The new ID follows the upload's rule as typed, survives the site's sheet
 * reader, and is no other row's: not as written, and not as the site reads
 * it, an image extension stripped or the letter case folded, since a step is
 * matched ignoring case when no exact match exists. The action applies the
 * same judgement against D1 and objects.csv at the head, and adds the file
 * check, which needs the repository's tree; the page applies it against the
 * rows its loader read, so most refusals are shown before anything is posted.
 *
 * The dialog's step lines count what the action will do with D1's steps,
 * each by the object the site shows for it today: the rewritten steps that
 * show this object, the rewritten steps that show another row (inside a
 * collision the value naming this row can show the other) or no object, the
 * steps that show this object and keep their value inside a collision (they
 * show the other row afterwards), and the step values that name no object
 * today, any of which the typed ID would take over.
 *
 * The page computes them from D1's rows alone; the action computes them again
 * from objects.csv at the head and D1, and renames only when they agree with
 * what the page showed (`renameFactsFingerprint`). Today's object is read in
 * the sheet's order, which the site builds from, and in D1's where the sheet
 * shows none, as a row not yet in the sheet is shown by the Compositor.
 *
 * @version v1.5.0-beta
 */

import { sharedSiteIds, sheetReaderLosesId, siteObjectId, stepObjectResolver } from "~/lib/object-id";
import { renameStepValues, type RenameObjectRows } from "~/lib/object-rename-steps";
import { pythonStrip } from "~/lib/python-whitespace";

/** The upload's rule for an object ID; the rename applies it to the value as typed. */
export const RENAME_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A refusal code with the values its message names. */
export interface RenameIdRefusal {
  error: string;
  params?: Record<string, string>;
}

/**
 * Why `newId` cannot be an object's ID beside rows carrying `otherIds`, or
 * null when it can: the site's sheet reader would lose it, another row has it
 * as written, or the site reads another row as it.
 */
export function renameIdRefusal(
  newId: string,
  otherIds: readonly string[],
  version: string | null | undefined,
): RenameIdRefusal | null {
  if (sheetReaderLosesId(newId, version)) return { error: "rename_id_unreadable", params: { id: newId } };
  if (otherIds.includes(newId)) return { error: "rename_taken", params: { id: newId } };
  const target = newId.toLowerCase();
  const reading = otherIds.find((other) => siteObjectId(other, version).toLowerCase() === target);
  return reading === undefined ? null : { error: "rename_site_taken", params: { id: newId, other: reading } };
}

/** What the Change ID dialog shows about one object. */
export interface ObjectRenameFacts {
  /** Every other row's ID as written: D1's in sheet order, then the sheet's that D1 lacks. */
  otherIds: string[];
  version: string | null;
  /** Steps that show this object today and whose value the rename rewrites. */
  stepsRewritten: number;
  /** Steps that show another row today and whose value the rename rewrites, so they show this object afterwards. */
  stepsTakenOver: number;
  /** The rows `stepsTakenOver` show today, each once. */
  takenOverFrom: string[];
  /** Steps that show no object today and whose value the rename rewrites, so they show this object afterwards. */
  stepsGained: number;
  /** Steps that show this object today and keep their value; non-zero only inside a collision. */
  stepsKept: number;
  /** Step values that name no object today and are not rewritten, one per step. */
  unresolvedStepValues: string[];
  /**
   * The rows the site reads as this object, the row it shows today, and the
   * row it shows once this one is renamed; null outside a collision.
   */
  shared: { others: string[]; shown: string; after: string } | null;
}

/**
 * The dialog's facts for `object`, from the object rows in both orders
 * (`RenameObjectRows`) and every step's `object` value. The page passes D1's
 * rows as both orders.
 */
export function objectRenameFacts(
  object: { object_id: string },
  rows: RenameObjectRows,
  stepValues: ReadonlyArray<string | null>,
): ObjectRenameFacts {
  const id = object.object_id;
  const version = rows.version ?? null;
  const renamed = new Set(renameStepValues(id, stepValues, rows));
  const [inSheet, inD1] = [rows.sheet, rows.d1].map((order) => stepObjectResolver(order, version));
  const isThis = (shown: string) => shown === id || pythonStrip(shown) === id;
  let stepsRewritten = 0;
  let stepsTakenOver = 0;
  let stepsGained = 0;
  let stepsKept = 0;
  const takenOverFrom = new Set<string>();
  const unresolvedStepValues: string[] = [];
  for (const value of stepValues) {
    if (!value) continue;
    const shown = (inSheet(value) ?? inD1(value))?.object_id ?? null;
    if (renamed.has(value)) {
      if (shown === null) stepsGained += 1;
      else if (isThis(shown)) stepsRewritten += 1;
      else {
        stepsTakenOver += 1;
        takenOverFrom.add(shown);
      }
    } else if (shown !== null && isThis(shown)) stepsKept += 1;
    else if (shown === null) unresolvedStepValues.push(value);
  }
  const share = sharedSiteIds(rows.sheet, version).get(id) ?? sharedSiteIds(rows.d1, version).get(id);
  const otherIds = rows.d1.map((row) => row.object_id).filter((other) => other !== id);
  for (const row of rows.sheet) {
    if (!isThis(row.object_id) && !otherIds.includes(row.object_id)) otherIds.push(row.object_id);
  }
  return {
    otherIds,
    version,
    stepsRewritten,
    stepsTakenOver,
    takenOverFrom: [...takenOverFrom],
    stepsGained,
    stepsKept,
    unresolvedStepValues,
    shared: share ? { others: share.others, shown: share.shown, after: share.others[share.others.length - 1] } : null,
  };
}

/**
 * Everything the dialog promises about the steps and the image for a rename
 * to `newId`, as one string: the page posts it with the form, and the action
 * renames only when its own facts give the same string.
 */
export function renameFactsFingerprint(facts: ObjectRenameFacts, newId: string): string {
  return JSON.stringify([
    facts.stepsRewritten,
    facts.stepsTakenOver,
    facts.takenOverFrom,
    facts.stepsGained,
    facts.stepsKept,
    stepsTakenOverBy(newId, facts.unresolvedStepValues, facts.version),
    facts.shared,
  ]);
}

/** How many of `values` the site would read as an object with the ID `newId`. */
export function stepsTakenOverBy(newId: string, values: readonly string[], version: string | null): number {
  const resolve = stepObjectResolver([{ object_id: newId }], version);
  return values.filter((value) => resolve(value) !== null).length;
}
