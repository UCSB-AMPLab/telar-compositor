/**
 * Pure helpers for the off-screen undo/redo toast (UndoFeedback).
 *
 * Given the `changedParentTypes` from a Yjs UndoManager `stack-item-popped`
 * event, work out which top-level entities (stories/objects/glossary/pages) an
 * undo/redo touched, so the caller can compare them to what's on screen and only
 * toast when the change happened somewhere the user isn't looking.
 *
 * @version v1.3.0-beta
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- these `any`s mirror Yjs's own published AbstractType/YEvent signatures */
import * as Y from "yjs";

export type EntitySection = "stories" | "objects" | "glossary" | "pages";

const SECTIONS: EntitySection[] = ["stories", "objects", "glossary", "pages"];

/** Route-facing slug field per section (matches the URL param for stories/objects). */
const SLUG_FIELD: Record<EntitySection, string> = {
  stories: "story_id",
  objects: "object_id",
  glossary: "term_id",
  pages: "slug",
};

export interface UndoTarget {
  section: EntitySection;
  /** Route-facing slug, or null when unreadable (e.g. an undone addition). */
  entityId: string | null;
  /** Entity title/term for the label, or null when empty/unreadable. */
  title: string | null;
}

export interface RouteTarget {
  section: EntitySection;
  entityId: string | null;
}

function readString(map: Y.Map<unknown>, field: string): string | null {
  const v = map.get(field);
  if (v == null) return null;
  if (v instanceof Y.Text) return v.toString() || null;
  return String(v) || null;
}

function describeEntityMap(map: Y.Map<unknown>, section: EntitySection): UndoTarget {
  return {
    section,
    entityId: readString(map, SLUG_FIELD[section]),
    title: readString(map, "title"),
  };
}

/**
 * Collect entity Y.Maps inserted into a root array by this event.
 *
 * Reads the array's live item list rather than `event.changes.delta`: Yjs
 * forbids computing `changes`/`delta`/`keys` once the firing transaction's
 * cleanups are done ("You must not compute changes after the event-handler
 * fired."), which is exactly our situation — the `stack-item-popped` handler
 * captures the event and the caller inspects it afterwards. `event.adds()`
 * only reads `transaction.beforeState`, so it stays valid post-handler.
 */
function collectInserts(
  array: Y.AbstractType<any>,
  event: Y.YEvent<any>,
  section: EntitySection
): UndoTarget[] {
  const found: UndoTarget[] = [];
  // Walk the underlying item linked list; only live items can be reinserts.
  for (let item: any = (array as any)._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    if (!event.adds(item)) continue;
    for (const value of item.content.getContent() as unknown[]) {
      if (value instanceof Y.Map) {
        found.push(describeEntityMap(value, section));
      }
    }
  }
  return found;
}

/**
 * Detect whether this event removed any items from the array (an undone
 * addition). Uses `event.deletes()`, which — like `adds()` — relies only on
 * transaction state and is safe to call after the handler fired.
 *
 * This relies on GC not having run between the undo transaction committing and
 * the `stack-item-popped` emit — which holds because JS is single-threaded and
 * the event is emitted synchronously inside Yjs's popStackItem right after
 * `transact` returns, so a tombstoned item is still reachable here.
 */
function hasDeletion(array: Y.AbstractType<any>, event: Y.YEvent<any>): boolean {
  for (let item: any = (array as any)._start; item !== null; item = item.right) {
    if (item.deleted && event.deletes(item) && !event.adds(item)) return true;
  }
  return false;
}

/** Walk a changed nested type up to the entity Y.Map that sits in a root array. */
function walkUpToEntity(
  type: Y.AbstractType<any>,
  roots: Map<Y.AbstractType<any>, EntitySection>
): UndoTarget | null {
  let cur: Y.AbstractType<any> | null = type;
  while (cur) {
    const parent: Y.AbstractType<any> | null = (cur as { parent: Y.AbstractType<any> | null }).parent;
    if (parent && roots.has(parent) && cur instanceof Y.Map) {
      return describeEntityMap(cur, roots.get(parent)!);
    }
    cur = parent ?? null;
  }
  return null;
}

export function describeUndoneChange(
  changedParentTypes: Map<Y.AbstractType<any>, Array<Y.YEvent<any>>>,
  ydoc: Y.Doc
): UndoTarget[] {
  const roots = new Map<Y.AbstractType<any>, EntitySection>();
  for (const section of SECTIONS) {
    roots.set(ydoc.getArray(section) as Y.AbstractType<any>, section);
  }

  const out: UndoTarget[] = [];
  const seen = new Set<string>();
  const push = (t: UndoTarget) => {
    // Null-entityId targets in the same section intentionally collapse to one
    // entry (key `section:`), which is the correct section-level fallback for
    // the toast — both for undone deletions and for unidentified inserts.
    const key = `${t.section}:${t.entityId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  for (const [type, events] of changedParentTypes) {
    const section = roots.get(type);
    if (section) {
      // Structural change on a root array. Ignore bubbled deep-edit events
      // (their target is a descendant, not the array) so a field edit does not
      // emit a section-level target.
      for (const event of events) {
        if (event.target !== type) continue;
        const inserts = collectInserts(type, event, section);
        for (const t of inserts) push(t);
        // Undone addition (deletion) — entity content is gone; section-level only.
        if (inserts.length === 0 && hasDeletion(type, event)) {
          push({ section, entityId: null, title: null });
        }
      }
    } else {
      const entity = walkUpToEntity(type, roots);
      if (entity) push(entity);
    }
  }
  return out;
}

const ROUTE_RE = /\/(stories|objects|glossary|pages)(?:\/([^/?#]+))?/;

export function routeToTarget(pathname: string): RouteTarget | null {
  const m = ROUTE_RE.exec(pathname);
  if (!m) return null;
  return { section: m[1] as EntitySection, entityId: m[2] ?? null };
}

export function isOffScreen(current: RouteTarget | null, target: UndoTarget): boolean {
  if (!current) return true;
  if (current.section !== target.section) return true;
  // Same section: if we cannot pin the current entity (glossary/pages, list
  // views), treat it as on-screen to avoid noisy toasts. Otherwise compare ids.
  if (current.entityId == null) return false;
  if (target.entityId == null) return false;
  return current.entityId !== target.entityId;
}
