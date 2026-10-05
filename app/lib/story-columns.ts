/**
 * Removing a kept column from every step of one story, in a document.
 *
 * A story step keeps the cells of story CSV columns the Compositor does not
 * map in its `extra_columns` string: a JSON object keyed by header, `""` for
 * never recorded, or `"{}"` once its last column has been removed. The publish page offers this beside a story column blocker,
 * because the framework refuses the column and there is no other place in
 * the Compositor to remove it. The collaboration object runs it on its own
 * document (`/remove-story-column`), so the change reaches D1 in the snapshot
 * it takes straight after, and the peers receive it as any other edit.
 *
 * Dependency-free apart from yjs, the value-domain readers and the object
 * custom-field map, because the
 * Durable Object imports it.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { entityMaps } from "~/lib/value-domains";
import { applyCustomBlob, customFieldBases, customFieldsBlob, customFieldsOf } from "~/lib/object-custom-map";

/** The blob as an own-key record, or null when it is absent or not an object. */
function readBlob(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The blob with `columns` taken out, or null when it holds none of them. A
 * blob that does not parse as an object is left: it contributes no columns
 * to the published file, so there is nothing in it to remove.
 */
export function withoutColumns(raw: unknown, columns: readonly string[]): string | null {
  const blob = readBlob(raw);
  if (!blob) return null;
  const keys = Object.keys(blob);
  if (!keys.some((key) => columns.includes(key))) return null;
  const kept: Record<string, unknown> = {};
  for (const key of keys.filter((k) => !columns.includes(k))) {
    // `key` is an author's header, so it can be `__proto__`; a plain
    // assignment would set the prototype rather than keep the cell.
    Object.defineProperty(kept, key, {
      value: blob[key], writable: true, enumerable: true, configurable: true,
    });
  }
  // "{}", not "": a step whose last kept column was removed has had its
  // columns recorded, and the publish's capture reads only a story that never
  // had (`~/lib/kept-columns-capture.server`), so it never reads the removed
  // column back from a file not yet published.
  return JSON.stringify(kept);
}

/** Every step map of every story whose `story_id` is `storyId`. */
function storyStepMaps(ydoc: Y.Doc, storyId: string): Y.Map<unknown>[] {
  return entityMaps(ydoc.getArray("stories")).maps
    .filter((story) => story.get("story_id") === storyId)
    .flatMap((story) => entityMaps(story.get("steps")).maps);
}

/**
 * Removes `columns` from `extra_columns` on every step of the story whose
 * `story_id` is `storyId`, in one transaction. Keys are matched exactly, as
 * the blocker names them. Returns the number of steps changed; a step whose
 * blob holds none of the columns is not written, so a repeated removal writes
 * nothing.
 */
export function removeStoryColumns(ydoc: Y.Doc, storyId: string, columns: readonly string[]): number {
  let changed = 0;
  ydoc.transact(() => {
    for (const step of storyStepMaps(ydoc, storyId)) {
      const next = withoutColumns(step.get("extra_columns"), columns);
      if (next === null) continue;
      step.set("extra_columns", next);
      changed += 1;
    }
  });
  return changed;
}

/**
 * The marker detail a removal is signed under: the story and the column, so
 * a signature for one cannot be replayed for another. JSON, because either
 * can hold any character, a colon included.
 */
export function storyColumnDetail(storyId: string, column: string): string {
  return JSON.stringify([storyId, column]);
}

/**
 * Removes `column` from every object's custom fields in a document, in one
 * transaction: from the blob the snapshot writes, and from the per-column map
 * beside it, where an object holding no value for it still has an empty entry.
 * Returns the number of objects whose blob changed.
 */
export function removeObjectColumn(ydoc: Y.Doc, column: string): number {
  const objects = ydoc.getArray("objects");
  let changed = 0;
  ydoc.transact(() => {
    for (const map of entityMaps(objects).maps) {
      const next = withoutColumns(customFieldsBlob(map, () => customFieldBases(objects)), [column]);
      if (next !== null) {
        applyCustomBlob(map, next);
        changed += 1;
      }
      customFieldsOf(map)?.delete(column);
    }
  });
  return changed;
}

/**
 * The marker detail a table-wide column removal is signed under: the table
 * and the column, so a signature for one cannot be replayed for another.
 */
export function tableColumnDetail(table: string, column: string): string {
  return JSON.stringify([table, column]);
}
