/**
 * This file holds the pure helper functions behind the collaboration
 * Durable Object — the logic that turns raw Yjs document changes into the
 * derived data the DO persists to D1: human-readable field paths, per-user
 * contribution tallies, and coarse activity-log rows.
 *
 * They live apart from the DO class itself because the DO depends on the
 * `cloudflare:workers` runtime, which cannot be loaded in a plain test
 * harness. Keeping these functions runtime-free means they can be unit-tested
 * directly, and it lets both the DO and the request-side server services share
 * the same definitions (for example the activity-log retention cap) without
 * either one importing the other's runtime.
 *
 * The central idea is the field-path string — a colon-joined address such as
 * `stories:9:title` or `stories:9:steps:3:question_md` — derived by walking a
 * changed Yjs shared type up its parent chain to the document root. Those
 * paths are what let the DO attribute edits to entities and users without
 * threading bespoke metadata through every Yjs mutation.
 *
 * @version v1.3.2-beta
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

    // Is the changed type itself a value stored under a map key (e.g. a `title`
    // Y.Text or a `steps` Y.Array living under a story map)? If so, the field
    // name is its own parentSub, and the walk below will unshift it into the
    // prefix. A character-level edit to a Y.Text registers as a null-keyed
    // change on the Y.Text type (not a keyed change on the parent map), so the
    // field name never arrives via `changedKeys` — we recover it from here.
    const ownParentSub = (sharedType as unknown as {
      _item?: { parentSub?: string | null };
    })._item?.parentSub;

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
    let appendedKey = false;
    for (const key of changedKeys) {
      if (key !== null && key !== undefined) {
        results.push([...prefixSegments, key].join(":"));
        appendedKey = true;
      }
    }
    // Null-keyed content change on a field value (a Y.Text / Y.Array stored
    // under a map key — the dominant editor edit). No string key arrived via
    // `changedKeys`, but the prefix already ends with the field name (the
    // type's own parentSub), so emit the prefix itself as the field path.
    // Guarded on `ownParentSub` being a string so root-collection structural
    // changes (e.g. a push onto the "stories" array, parentSub-less) don't
    // emit a bare, id-less `stories` path.
    if (!appendedKey && typeof ownParentSub === "string") {
      results.push(prefixSegments.join(":"));
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

/**
 * A coarse activity row derived from a snapshot window. One row per (actor,
 * entity) touched this window — not per field. Persisted by the snapshot block
 * as a raw INSERT into activity_log.
 */
export interface SnapshotActivityRow {
  projectId: number;
  actorUserId: number;
  verb: "edited" | "added";
  entityType: "story" | "object" | "term" | "page" | "config";
  entityId: string;
}

/**
 * Map a Y.doc root collection name (the first field-path segment) to the
 * activity_log entity_type. Returns null for unknown collections (no row).
 */
const COLLECTION_TO_ENTITY_TYPE: Record<string, SnapshotActivityRow["entityType"]> = {
  stories: "story",
  objects: "object",
  glossary: "term",
  pages: "page",
  config: "config",
};

/**
 * A v4 UUID (with dashes) — the shape of a client-generated `_temp_id`. When an
 * entity's id segment looks like this, the entity was freshly created this
 * session (its D1 `_id` is still null), so the verb is 'added'. Existing
 * entities carry a numeric D1 id and read as 'edited'.
 */
const TEMP_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * buildActivityRows — pure derivation of coarse activity rows from a snapshot
 * window's per-user field-path Sets.
 *
 * For each active user, group their field-paths by entity prefix
 * (`collection:id` — the first two segments of paths like `stories:9:title` or
 * `pages:about:body`) into one row per (user, entity). The collection name maps
 * to an activity_log entity_type; the verb is 'added' when the id segment is a
 * fresh client UUID (`_temp_id`, i.e. the entity has no D1 id yet) and 'edited'
 * otherwise. Users with no field edits produce no rows.
 *
 * The actor is the server-resolved userId (the key of userFieldSets) — never a
 * client-supplied value (spoofing mitigation).
 *
 * @param activeUserIds The userIds to emit for (the snapshot's active set)
 * @param userFieldSets The Map<userId, Set<field-path>> accumulated this window
 * @param projectId     The DO's resolved project id
 */
/**
 * Per-project activity_log retention cap. Single source of truth shared
 * by BOTH activity emit paths so the cap can never drift between them:
 *   - the request-side `recordActivity` (publish/sync) in activity.server.ts,
 *     which re-exports this constant, and
 *   - the Durable Object snapshot loop (editor edits — the high-volume path),
 *     which prunes inline after each batch of inserts.
 * Kept here, in the pure (cloudflare-runtime-free) helper module, because it is
 * the only module both the DO and the server service can import.
 */
export const ACTIVITY_RETENTION_CAP = 200;

export function buildActivityRows(
  activeUserIds: number[],
  userFieldSets: Map<number, Set<string>>,
  projectId: number
): SnapshotActivityRow[] {
  const rows: SnapshotActivityRow[] = [];

  for (const userId of activeUserIds) {
    const fieldSet = userFieldSets.get(userId);
    if (!fieldSet || fieldSet.size === 0) continue;

    // Group field-paths by entity prefix → one row per (user, entity).
    const entities = new Map<string, { type: string; id: string }>();
    for (const path of fieldSet) {
      const segments = path.split(":");
      const [type, id] = segments;
      if (type && id) entities.set(`${type}:${id}`, { type, id });
    }

    for (const { type, id } of entities.values()) {
      const entityType = COLLECTION_TO_ENTITY_TYPE[type];
      if (!entityType) continue; // unknown collection — skip
      const verb: SnapshotActivityRow["verb"] = TEMP_ID_UUID.test(id) ? "added" : "edited";
      rows.push({ projectId, actorUserId: userId, verb, entityType, entityId: id });
    }
  }

  return rows;
}

/**
 * Return the string value of a Y.Text or plain string/number/null. Prevents
 * "[object Object]" in D1 rows. Shared by the DO and the activity resolver.
 */
export function yTextToString(val: unknown): string {
  if (val instanceof Y.Text) return val.toString();
  return String(val ?? "");
}

/**
 * Map an activity entity type to its Y.Doc collection + human-slug field.
 * (config is handled specially — it is a single root map, not an array.)
 */
const ENTITY_RESOLUTION: Record<string, { collection: string; slug: string }> = {
  story: { collection: "stories", slug: "story_id" },
  object: { collection: "objects", slug: "object_id" },
  term: { collection: "glossary", slug: "term_id" },
  page: { collection: "pages", slug: "slug" },
};

/**
 * resolveActivityEntity — turn a field-path id (the numeric D1 `_id` for an
 * existing entity, or the client `_temp_id` UUID for a freshly-added one) into
 * the entity's human slug + title, read from the live Y.Doc at snapshot time.
 *
 * Pure (Y.Doc in, plain object out) so it unit-tests without the Durable Object
 * runtime. Returns:
 *   - story/object/term/page → { entityId: <slug>, entityLabel: <title|null> }
 *     matched by `_id` OR `_temp_id` (the latter is retained after backfill, so
 *     a same-session "added" row still resolves). Slug is bound as a plain
 *     string; title via yTextToString (it is a Y.Text).
 *   - config → { entityId: null, entityLabel: <site title|null> } (site-level).
 *   - unresolved (entity since deleted) → { entityId: <fieldPathId>, entityLabel: null }.
 */
export function resolveActivityEntity(
  ydoc: Y.Doc,
  entityType: string,
  fieldPathId: string,
): { entityId: string | null; entityLabel: string | null } {
  if (entityType === "config") {
    const title = yTextToString(ydoc.getMap<unknown>("config").get("title"));
    return { entityId: null, entityLabel: title || null };
  }
  const map = ENTITY_RESOLUTION[entityType];
  if (!map) return { entityId: fieldPathId, entityLabel: null };
  const arr = ydoc.getArray<Y.Map<unknown>>(map.collection);
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    const idVal = m.get("_id");
    const tempId = m.get("_temp_id");
    if (
      (idVal !== null && idVal !== undefined && String(idVal) === fieldPathId) ||
      (tempId !== null && tempId !== undefined && String(tempId) === fieldPathId)
    ) {
      const slug = String(m.get(map.slug) ?? "") || fieldPathId; // plain string
      const label = yTextToString(m.get("title")) || null; // Y.Text
      return { entityId: slug, entityLabel: label };
    }
  }
  return { entityId: fieldPathId, entityLabel: null };
}
