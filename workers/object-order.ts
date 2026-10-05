/**
 * The two `/ingest-sync` object arms that put rows where GitHub's objects.csv
 * has them: `objects.order`, which re-keys the rows the document already holds
 * into GitHub's order, and `objects.sheet`, which places each row the same
 * ingest inserts between the rows GitHub has either side of it.
 *
 * Both find a held row by its key and its D1 id together: D1 has no unique
 * index on (project_id, object_id), and an object deleted and re-created under
 * the same key since the sync read D1 is not the row the sync paired.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import {
  nextOrderKeyAfterLast,
  orderKeyForSheetPlace,
  orderedMaps,
  rekeyToOrder,
  type SheetEntry,
} from "~/lib/field-order";

/** One `objects.order` entry: a held row, by key and D1 id. */
export interface IngestObjectOrder {
  objectId: string;
  docId: number;
}

/** The Y.Map holding `objectId` under D1 id `docId`, or null. */
function heldRow(objectsArray: Y.Array<Y.Map<unknown>>, objectId: string, docId: number): Y.Map<unknown> | null {
  for (const member of objectsArray.toArray()) {
    if (member instanceof Y.Map && member.get("object_id") === objectId && member.get("_id") === docId) return member;
  }
  return null;
}

/** Whether any Y.Map holds `objectId`. */
function holdsKey(objectsArray: Y.Array<Y.Map<unknown>>, objectId: string): boolean {
  return objectsArray.toArray().some((m) => m instanceof Y.Map && m.get("object_id") === objectId);
}

/**
 * Re-key the rows `entries` name into the order given, and answer how many
 * keys were written. An entry no row holds with both its key and its id is
 * left out and named in `skipped`; where another row holds the key, the row
 * the sync paired has been re-created since, and it is named in `superseded`
 * too. The rows found keep the order of the arm among themselves.
 */
export function applyObjectOrder(
  objectsArray: Y.Array<Y.Map<unknown>>,
  entries: readonly IngestObjectOrder[],
  outcome: { skipped: string[]; superseded: string[] },
): number {
  const found: Y.Map<unknown>[] = [];
  for (const entry of entries) {
    const row = heldRow(objectsArray, entry.objectId, entry.docId);
    if (row) {
      if (!found.includes(row)) found.push(row);
      continue;
    }
    outcome.skipped.push(entry.objectId);
    if (holdsKey(objectsArray, entry.objectId)) outcome.superseded.push(entry.objectId);
  }
  if (found.length === 0) return 0;
  return rekeyToOrder(orderedMaps(objectsArray), found);
}

/**
 * The keys for the rows one ingest inserts. A row GitHub's `sheet` names
 * without a D1 id is placed between the held rows either side of it
 * (`orderKeyForSheetPlace`); an insert earlier in the same ingest counts as
 * held, so a run of new rows sent in sheet order keeps it. Any other insert,
 * and every insert of an ingest with no sheet, sorts after every row.
 */
export function sheetPlacement(
  objectsArray: Y.Array<Y.Map<unknown>>,
  sheet: readonly SheetEntry[],
): { keyFor(objectId: string): string; placed(objectId: string, map: Y.Map<unknown>): void } {
  const inserted = new Map<string, Y.Map<unknown>>();
  const held = (entry: SheetEntry): Y.Map<unknown> | null =>
    entry.docId === undefined
      ? inserted.get(entry.objectId) ?? null
      : heldRow(objectsArray, entry.objectId, entry.docId);
  return {
    keyFor(objectId) {
      const at = sheet.findIndex((entry) => entry.docId === undefined && entry.objectId === objectId);
      return at < 0 ? nextOrderKeyAfterLast(objectsArray) : orderKeyForSheetPlace(objectsArray, sheet, at, held);
    },
    placed(objectId, map) {
      inserted.set(objectId, map);
    },
  };
}
