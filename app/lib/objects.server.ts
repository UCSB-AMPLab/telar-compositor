/**
 * Server-side helpers for the Objects tab that need project-scoped database
 * reads. The objects list shows a "used in N steps" count per object so the
 * author can see, at a glance, which uploads are actually referenced by a
 * story and which are safe to remove.
 *
 * That count is deceptively easy to get wrong: `steps.object_id` is the
 * object's human slug (e.g. `telar-placeholder`), and the same slug is seeded
 * into every project. A naive `GROUP BY object_id` over the whole `steps`
 * table therefore sums references across ALL projects and reports a wildly
 * inflated total on shared slugs. The count must be scoped to the active
 * project — and because `steps` carries no `project_id` of its own, the scope
 * comes from the parent story: each step belongs to a story, and the story
 * carries the `project_id`. Joining through `stories` and filtering on
 * `stories.project_id` is the single source of truth for "in THIS project".
 *
 * A step counts for the object the published site shows for it, which is not
 * always the object whose id it spells: the site strips an image extension
 * from both before it matches them, so a step naming `map` is a use of an
 * object written `map.jpg` (`stepObjectResolver`).
 *
 * @version v1.5.0-beta
 */

import { eq, count, sql } from "drizzle-orm";
import { objects, steps, stories } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { tallyStepObjects } from "~/lib/object-step-counts";
import { pythonStrip } from "~/lib/python-whitespace";
import type { SheetEntry } from "~/lib/field-order";

type DbInstance = ReturnType<typeof getDb>;

/**
 * The order objects.csv is written in: the author's list order, `order_key`
 * ascending, then `id` — the order the collaboration object snapshots objects
 * in, and the one a publish writes. The objects page writes its existing rows
 * so, with rows not yet in D1 after them in the order they were added: each is
 * registered with a key after the last, in that order, so the next publish
 * writes them where that write put them. Where two rows share the site's id,
 * the site's object page and every step naming either show the later row of
 * objects.csv, so every reader that picks "the later row"
 * (`stepObjectResolver`, `sharedSiteIds`) reads the objects in this order.
 */
export function objectsSheetOrder() {
  return sql`${objects.order_key} asc, ${objects.id} asc`;
}

/**
 * `objectsSheetOrder` for rows already read, as SQLite orders them: a null
 * key first, then keys compared as plain strings (keys are ASCII, where
 * JavaScript's comparison and SQLite's BINARY agree), then `id`.
 */
export function compareSheetOrder(
  a: { id: number; order_key: string | null },
  b: { id: number; order_key: string | null },
): number {
  if (a.order_key !== b.order_key) {
    if (a.order_key === null) return -1;
    if (b.order_key === null) return 1;
    return a.order_key < b.order_key ? -1 : 1;
  }
  return a.id - b.id;
}

/** GitHub's order of the rows a sync pairs with D1's, each as its D1 row. */
export interface ObjectOrderChange {
  order: Array<{ objectId: string; docId: number }>;
}

/**
 * The D1 row each of GitHub's rows is paired with, by position in the file, or
 * undefined where it has none. Where the file repeats an `object_id`, the
 * Compositor follows the later occurrence, as the site does (it shows the
 * later row, and the framework's build drops the earlier): occurrences are
 * paired with the D1 rows of that id from the end, the last occurrence with
 * the last D1 row in sheet order. The document holds one row per `object_id`
 * (the snapshot re-keys a second), so that row sits at the id's last
 * occurrence and the earlier occurrences are unpaired. A row on one side only
 * is not paired.
 */
export function pairedD1Rows<T extends { id: number; object_id: string; order_key: string | null }>(
  repoRows: ReadonlyArray<{ object_id: unknown }>,
  d1Rows: readonly T[],
): Array<T | undefined> {
  const byId = new Map<string, T[]>();
  for (const row of [...d1Rows].sort(compareSheetOrder)) {
    const held = byId.get(row.object_id) ?? [];
    held.push(row);
    byId.set(row.object_id, held);
  }
  const ids = repoRows.map((repoRow) => String(repoRow.object_id ?? ""));
  const remaining = new Map<string, number>();
  for (const objectId of ids) remaining.set(objectId, (remaining.get(objectId) ?? 0) + 1);
  return ids.map((objectId) => {
    const fromEnd = (remaining.get(objectId) as number) - 1;
    remaining.set(objectId, fromEnd);
    const held = byId.get(objectId) ?? [];
    return held[held.length - 1 - fromEnd];
  });
}

/**
 * GitHub's order of the rows both sides hold, or null when D1 already holds
 * them in that order. `repoRows` are objects.csv's rows in file order.
 *
 * Only paired rows (`pairedD1Rows`) are compared: a row on GitHub only is new,
 * and a row in D1 only (an unpublished addition, a course item) keeps its
 * place.
 */
export function objectOrderChange(
  repoRows: ReadonlyArray<{ object_id: unknown }>,
  d1Rows: ReadonlyArray<{ id: number; object_id: string; order_key: string | null }>,
): ObjectOrderChange | null {
  const github = pairedD1Rows(repoRows, d1Rows).filter((row) => row !== undefined);
  const paired = new Set(github.map((row) => row.id));
  const d1 = [...d1Rows].sort(compareSheetOrder).filter((row) => paired.has(row.id));
  if (github.every((row, i) => row.id === d1[i].id)) return null;
  return { order: github.map((row) => ({ objectId: row.object_id, docId: row.id })) };
}

/**
 * GitHub's objects.csv as an ingest places rows by it (`objects.sheet`): each
 * row paired with a D1 row (`pairedD1Rows`) by its D1 id, and each row of an
 * id D1 does not hold, without one, at the id's last occurrence, whose values
 * the sync brings in. An earlier occurrence of a repeated id is left out: the
 * site uses the last.
 */
export function githubSheet(
  repoRows: ReadonlyArray<{ object_id: unknown }>,
  d1Rows: ReadonlyArray<{ id: number; object_id: string; order_key: string | null }>,
): SheetEntry[] {
  const paired = pairedD1Rows(repoRows, d1Rows);
  const heldIds = new Set(d1Rows.map((row) => row.object_id));
  const lastAt = new Map(repoRows.map((row, i) => [String(row.object_id ?? ""), i]));
  return repoRows.flatMap((repoRow, i): SheetEntry[] => {
    const objectId = String(repoRow.object_id ?? "");
    const row = paired[i];
    if (row) return [{ objectId, docId: row.id }];
    return heldIds.has(objectId) || lastAt.get(objectId) !== i ? [] : [{ objectId }];
  });
}

/**
 * `rows` in the order `sheet` has them as new rows, which is the order an
 * ingest places them in; a row the sheet does not name keeps its place after
 * them.
 */
export function inSheetOrder<T extends { object_id: string }>(rows: readonly T[], sheet: readonly SheetEntry[]): T[] {
  const at = new Map(sheet.flatMap((entry, i) => (entry.docId === undefined ? [[entry.objectId, i] as const] : [])));
  const rank = (row: T) => at.get(row.object_id) ?? sheet.length;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/**
 * The project-scoped step-reference count query, returned as a builder so
 * callers (and tests) can inspect the generated SQL via `.toSQL()`. Counts
 * steps grouped by `object_id`, restricted to steps whose parent story belongs
 * to `projectId`. `steps.story_id` is a NOT NULL FK to `stories.id`, so the
 * inner join drops no legitimate rows.
 */
export function objectStepCountQuery(db: DbInstance, projectId: number) {
  return db
    .select({ object_id: steps.object_id, count: count() })
    .from(steps)
    .innerJoin(stories, eq(steps.story_id, stories.id))
    .where(eq(stories.project_id, projectId))
    .groupBy(steps.object_id);
}

/**
 * Resolve the per-object step-reference counts for a project as a plain
 * `object_id -> count` map, keyed by the id of the object each step shows as
 * `projectObjects` (in objects.csv order) holds it. Steps bound to no object,
 * or naming none the site has, are skipped. An object with no steps in this
 * project is simply absent from the map, which the UI reads as "not used here".
 */
export async function getObjectStepCounts(
  db: DbInstance,
  projectId: number,
  projectObjects: ReadonlyArray<{ object_id: string }>,
  frameworkVersion: string | null,
): Promise<Record<string, number>> {
  const rows = await objectStepCountQuery(db, projectId);
  return tallyStepObjects(
    rows.map((row) => ({ value: row.object_id, count: row.count })),
    projectObjects,
    frameworkVersion,
  );
}

/**
 * GitHub's object ids that name a D1 row held under their stripped form, each
 * mapped to that D1 id.
 *
 * An import before ids were read as written stored every id stripped, so a
 * site whose objects.csv writes `map  ` holds `map` in D1 while GitHub's file
 * still says `map  `. That is the import's error, not an edit, and only then is
 * a GitHub id paired. The shape has to be unambiguous: no D1 row holds the
 * GitHub id exactly, exactly one D1 row holds its stripped form, no GitHub row
 * holds that stripped form exactly, and no other GitHub spelling strips to it.
 * And the recorded version of objects.csv (`recordedIds`, its ids as written)
 * has to show the padding was there when D1 took the row: it spells the id
 * padded as GitHub does, and does not hold the stripped form. Where it holds
 * `map` and GitHub now holds `map  `, GitHub changed the id, and the sync shows
 * that as a change. With no readable recorded version (null) nothing is
 * paired: an edit on GitHub and the import's error cannot be told apart.
 *
 * Anything else is left to exact pairing, where `map` and `map  ` are two
 * objects.
 */
export function legacyStrippedIds(
  repoIds: readonly string[],
  d1Ids: readonly string[],
  recordedIds: readonly string[] | null,
): Map<string, string> {
  const pairs = new Map<string, string>();
  if (recordedIds === null) return pairs;
  const repoSet = new Set(repoIds);
  const recorded = new Set(recordedIds);
  const d1Count = new Map<string, number>();
  for (const id of d1Ids) d1Count.set(id, (d1Count.get(id) ?? 0) + 1);
  const spellingsOf = new Map<string, string[]>();
  for (const id of repoSet) {
    const stripped = pythonStrip(id);
    if (d1Count.has(id) || stripped === id) continue;
    spellingsOf.set(stripped, [...(spellingsOf.get(stripped) ?? []), id]);
  }
  for (const [stripped, spellings] of spellingsOf) {
    if (spellings.length !== 1 || d1Count.get(stripped) !== 1 || repoSet.has(stripped)) continue;
    if (recorded.has(spellings[0]) && !recorded.has(stripped)) pairs.set(spellings[0], stripped);
  }
  return pairs;
}

/** `rows` with each id `pairs` names written as its D1 id, every other row as it was. */
export function onD1Spelling<T extends { object_id?: unknown }>(rows: readonly T[], pairs: ReadonlyMap<string, string>): T[] {
  if (pairs.size === 0) return [...rows];
  return rows.map((row) => {
    const paired = pairs.get(String(row.object_id ?? ""));
    return paired === undefined ? row : { ...row, object_id: paired };
  });
}
