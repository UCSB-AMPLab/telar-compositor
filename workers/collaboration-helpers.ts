/**
 * collaboration-helpers.ts — pure helper functions for the Durable Object.
 *
 * Extracted into a separate module so they can be unit-tested without the
 * cloudflare:workers runtime dependency.
 */

import * as Y from "yjs";

/**
 * Resolve a Yjs shared type + changed-key set to a list of field-path strings
 * using the format:
 *
 *   stories:<id>:title
 *   objects:<id>:label_en
 *   stories:<id>:steps:<id>:question_md
 *
 * The algorithm walks sharedType._item.parent up to the Y.Doc root, collecting
 * path segments at each level. Entity Y.Map identity comes from the `_id`
 * field (number) or falls back to `_temp_id` (string) when `_id` is null.
 *
 * Returns an empty array if the chain cannot be walked (disconnected/transient).
 *
 * @param sharedType  The Y.Map that was changed (from tr.changed key)
 * @param changedKeys The set of changed keys on that map (from tr.changed value)
 * @param ydoc        The root Y.Doc (used to look up root shared-type names)
 */
export function resolveFieldPaths(
  sharedType: Y.AbstractType<unknown>,
  changedKeys: Set<string | null>,
  ydoc: Y.Doc
): string[] {
  try {
    // Collect path prefix segments by walking up the parent chain.
    // We start at the changed type and walk up, collecting:
    //   [collection-name, entity-id, nested-key, nested-entity-id, ...]
    // which are then joined with ":" and the changed field key appended at the end.

    const prefixSegments: string[] = [];
    let current: Y.AbstractType<unknown> = sharedType;

    while (true) {
      const item = (current as unknown as {
        _item?: {
          parentSub?: string | null;
          parent?: Y.AbstractType<unknown> | null;
        };
      })._item;

      if (!item) {
        // current is a root shared type (no _item). Look up its name.
        const collectionName = getSharedTypeName(ydoc, current);
        if (collectionName) prefixSegments.unshift(collectionName);
        break;
      }

      const parentSub = item.parentSub; // key in parent Y.Map; null if in Y.Array
      const parent = item.parent;

      if (!parent) break;

      if (parentSub !== null && parentSub !== undefined) {
        // current is a value stored under key `parentSub` in a parent Y.Map.
        // e.g. steps array stored as "steps" in a story map.
        // We do NOT add the entity ID here — that will be added when we visit
        // the parent Y.Map (the entity that owns this key).
        prefixSegments.unshift(parentSub);
        current = parent;
      } else {
        // current is an element of a parent Y.Array (parentSub === null).
        // This is an entity map — get its ID.
        const entityMap = current as Y.Map<unknown>;
        const idVal = (entityMap as unknown as { get?: (k: string) => unknown }).get?.("_id");
        const tempId = (entityMap as unknown as { get?: (k: string) => unknown }).get?.("_temp_id");
        const idStr =
          idVal !== null && idVal !== undefined
            ? String(idVal)
            : tempId !== null && tempId !== undefined
              ? String(tempId)
              : null;

        if (idStr !== null) {
          prefixSegments.unshift(idStr);
        }
        current = parent;
      }
    }

    if (prefixSegments.length === 0) return [];

    const results: string[] = [];
    for (const key of changedKeys) {
      if (key !== null && key !== undefined) {
        results.push([...prefixSegments, key].join(":"));
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Look up a root-level shared type's name from the Y.Doc share map.
 */
function getSharedTypeName(ydoc: Y.Doc, type: Y.AbstractType<unknown>): string | null {
  const share = (ydoc as unknown as { share?: Map<string, Y.AbstractType<unknown>> }).share;
  if (!share) return null;
  for (const [name, t] of share) {
    if (t === type) return name;
  }
  return null;
}

/**
 * Shape of a project_members.contributions JSON blob.
 */
export interface ContributionsJson {
  stories_edited?: unknown[];
  objects_edited?: unknown[];
  fields_edited: number;
  sessions: number;
  last_active: string | null;
  [key: string]: unknown;
}

/**
 * buildContributionUpdate — pure function that produces the next contributions
 * JSON object for a project_members row.
 *
 * Sources `fields_edited` from `fieldSet.size` (unique-field Set semantics).
 * Does NOT reset the Set — the caller keeps accumulating within DO lifetime.
 * If fieldSet is undefined (user with no userFieldSets entry), writes 0.
 *
 * @param prev         The existing contributions JSON (parsed) — defaults applied
 *                     if missing fields.
 * @param fieldSet     The per-user Set<string> of touched field paths, or undefined.
 * @param isNewSession Whether this snapshot marks a new session for this user.
 */
export function buildContributionUpdate(
  prev: Partial<ContributionsJson>,
  fieldSet: Set<string> | undefined,
  isNewSession: boolean
): ContributionsJson {
  const base: ContributionsJson = {
    stories_edited: prev.stories_edited ?? [],
    objects_edited: prev.objects_edited ?? [],
    fields_edited: fieldSet?.size ?? 0,
    sessions: prev.sessions ?? 0,
    last_active: prev.last_active ?? null,
    ...Object.fromEntries(
      Object.entries(prev).filter(([k]) =>
        !["stories_edited", "objects_edited", "fields_edited", "sessions", "last_active"].includes(k)
      )
    ),
  };

  if (isNewSession) {
    base.sessions += 1;
  }

  return base;
}

/**
 * makeAfterTransactionHandler — factory for the afterTransaction callback.
 *
 * Returns a function suitable for `ydoc.on("afterTransaction", handler)`.
 * The handler extracts userId from tr.origin via the provided `getUserId`
 * function, then adds touched field paths to the per-user Set in userFieldSets.
 *
 * @param ydoc          The Y.Doc instance
 * @param userFieldSets The Map<userId, Set<string>> to accumulate into
 * @param getUserId     Function that maps tr.origin to a userId (or null to skip)
 */
export function makeAfterTransactionHandler(
  ydoc: Y.Doc,
  userFieldSets: Map<number, Set<string>>,
  getUserId: (origin: unknown) => number | null
): (tr: Y.Transaction) => void {
  return (tr: Y.Transaction) => {
    const origin = tr.origin;
    if (!origin) return;

    const userId = getUserId(origin);
    if (!userId) return;

    let fieldSet = userFieldSets.get(userId);
    if (!fieldSet) {
      fieldSet = new Set<string>();
      userFieldSets.set(userId, fieldSet);
    }

    tr.changed.forEach((changedKeys, sharedType) => {
      const paths = resolveFieldPaths(sharedType as Y.AbstractType<unknown>, changedKeys, ydoc);
      for (const path of paths) {
        fieldSet!.add(path);
      }
    });
  };
}
