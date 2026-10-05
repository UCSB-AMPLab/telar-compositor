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
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { entityMaps, proseString, readProse } from "~/lib/value-domains";
import type { Read } from "~/lib/value-domains";
import { YDOC_FIELDS, proseKeysOf } from "~/lib/field-registry";
import {
  creditChange, creditWords, isRowIdSegment, isTempRowId, proseFieldOf,
} from "./contribution-metrics";
import { unrefusedKeys } from "./refusal-marks";
import type { TimeLedger, WordBaseline, WordsByRow } from "./contribution-metrics";

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
        // Total, like every other render of a document value: this handler
        // runs inside `afterTransaction`, so a throw here escapes the apply of
        // the update that carried the value and takes the socket's whole
        // message with it. An id nothing can render reads as the empty
        // segment, which `buildActivityRows` then declines to attribute rather
        // than filing under a segment that means something else.
        const idStr =
          idVal !== null && idVal !== undefined
            ? renderedValue(idVal)
            : tempId !== null && tempId !== undefined
              ? renderedValue(tempId)
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
  isNewSession: boolean,
  /**
   * When this person last edited, from the handler that saw the edit. Omitted
   * when they have not edited in this Durable Object lifetime, which is not
   * the same as not having edited — so an omitted stamp leaves the stored one
   * alone rather than clearing it.
   */
  lastEditAt?: string,
): ContributionsJson {
  const base: ContributionsJson = {
    stories_edited: prev.stories_edited ?? [],
    objects_edited: prev.objects_edited ?? [],
    // Monotonic, because the input is not cumulative and the stored value is
    // the only record of earlier lifetimes. `fieldSet` holds the paths touched
    // in THIS Durable Object lifetime: it starts empty on every one and dies
    // with the instance, so assigning its size wrote the current lifetime over
    // the whole history — and a member who reconnected before their first edit
    // had the row set to zero. Reconnection is constant, so that is the common
    // case rather than an edge one.
    //
    // Deliberately short of exact: a lifetime-unique count needs the field
    // paths themselves to survive eviction, which means persisting a set with
    // no bound on its size, and the same paths edited across two lifetimes
    // still count once here. What this rules out is the number FALLING, which
    // is the part that destroys information rather than merely lacking it.
    fields_edited: Math.max(prev.fields_edited ?? 0, fieldSet?.size ?? 0),
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

  // Never backwards: two Durable Object instances can snapshot out of order,
  // and a stale stamp overwriting a fresher one would read as the person
  // having gone quiet.
  if (lastEditAt && (base.last_active === null || lastEditAt > base.last_active)) {
    base.last_active = lastEditAt;
  }

  return base;
}

/**
 * One row's last edit: when it happened, and who made it.
 *
 * The two facts come out of the same transaction, so they travel together. Held
 * in two maps keyed alike they could drift apart under any later edit to one of
 * them, and a time bound to the wrong person is worse than no answer at all.
 */
export interface PathEdit {
  at: string;
  by: number;
}

/** When one person first and last wrote in one field. */
export interface PathContribution {
  first: string;
  last: string;
}

/**
 * What the Durable Object accumulates about editing: for each field path, every
 * person who has written in it this instance's lifetime, and when they first and
 * last did.
 *
 * This used to be one edit per path — the last one — which answered
 * `last_edited_by` and nothing else. A contributor set is not derivable from
 * that: two people writing the same field left only the second, so the first
 * disappeared the moment anyone edited after them. Rather than keep a second
 * accumulator alongside it, the one structure got deeper. Two maps that must
 * agree are the defect this release has already paid for twice.
 *
 * Additive by construction, which is the property that matters. Nothing here is
 * ever replaced: a person's `last` moves forward and their `first` never moves,
 * and a person already recorded is never dropped by somebody else editing.
 */
export type EditsByPath = Map<string, Map<number, PathContribution>>;

/**
 * Record that `userId` wrote in `path` at `stamp`.
 *
 * Separate from the handler so the invariant lives in one place: `first` is
 * written once and `last` only ever moves forward. Two Durable Object instances
 * can see edits out of order, and a stale stamp overwriting a fresher one would
 * read as the person having gone quiet.
 */
export function recordPathContribution(
  editsByPath: EditsByPath,
  path: string,
  userId: number,
  stamp: string,
): void {
  let byUser = editsByPath.get(path);
  if (!byUser) {
    byUser = new Map<number, PathContribution>();
    editsByPath.set(path, byUser);
  }
  const held = byUser.get(userId);
  if (!held) {
    byUser.set(userId, { first: stamp, last: stamp });
    return;
  }
  if (stamp > held.last) held.last = stamp;
  if (stamp < held.first) held.first = stamp;
}

/**
 * Every field path that belongs to a row of one entity kind, with the row's id.
 *
 * A field path already names the row it belongs to —
 * `stories:7:steps:11:layers:91:content` — so both derivations below read the
 * row out of the path rather than out of anything newly recorded.
 *
 * Ids are the segment as it stands in the path, not a number: an existing row
 * carries its D1 `_id`, and a row being created this window carries the client's
 * `_temp_id`. Keeping both means a row created and written in before the first
 * snapshot can still name its editor at INSERT, which is the common case for a
 * step somebody adds and immediately fills. A segment that is neither an integer
 * nor a `_temp_id` is skipped rather than guessed at — it is a path whose id the
 * resolver could not render, and filing it under a key that means something else
 * is worse than having no entry.
 *
 * A deeper path also matches its ancestors, so a panel's edit belongs to the
 * step holding it and to the story holding that. That is the reading `updated_at`
 * and `last_edited_by` want: a step whose panel someone rewrote did change. It is
 * not the reading a contributor set wants, which is why that one is derived from
 * `proseFieldOf` instead.
 */
function* rowPathsFor(
  editsByPath: EditsByPath,
  segment: string,
): Generator<[string, Map<number, PathContribution>]> {
  for (const [path, byUser] of editsByPath) {
    const parts = path.split(":");
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== segment) continue;
      const id = parts[i + 1];
      if (isRowIdSegment(id)) yield [id, byUser];
      break;
    }
  }
}

/**
 * The last edit to each row of one entity kind — who, and when.
 *
 * The snapshot's own clock cannot answer this: it writes every row in one batch,
 * which is why `layers.updated_at` read as the same instant for every layer in a
 * project and told a reader nothing about any of them.
 *
 * The latest wins, because one row has many fields and the row was last edited
 * when its most recently edited field was, by whoever edited it.
 */
export function rowEditsFromPaths(
  editsByPath: EditsByPath,
  segment: string,
): Map<string, PathEdit> {
  const edits = new Map<string, PathEdit>();
  for (const [id, byUser] of rowPathsFor(editsByPath, segment)) {
    for (const [userId, contribution] of byUser) {
      const held = edits.get(id);
      if (held === undefined || contribution.last > held.at) {
        edits.set(id, { at: contribution.last, by: userId });
      }
    }
  }
  return edits;
}

/**
 * Everyone who wrote TEXT in each row of one entity kind, and when they first
 * and last did.
 *
 * This is the participation measure, and it is not the same question as
 * `created_by`. Measured over one cohort, steps created against steps written in
 * ran 0 against 3, 1 against 3, 2 against 3, 16 against 10, 7 against 3 — so a
 * creation count reports the person who wrote 837 words as having built nothing.
 *
 * Prose only, and the deepest row only, which is `proseFieldOf`'s test and the
 * same one the word count uses. The record defines `edited` as what a person
 * wrote text in, so framing an image or reordering a list makes nobody a
 * contributor, and writing in a panel makes you a contributor to the panel
 * rather than to the step holding it. One parse for both measures is what keeps
 * a row's `edited` and its `words` from disagreeing: every (row, person) the
 * ledger credits words to gets a row here, and no other does.
 *
 * Union, never replacement: a row's contributors are merged across every field
 * of it, taking the earliest first and the latest last per person. The caller
 * must persist it the same way — this map holds only what THIS Durable Object
 * instance has seen, and an instance that has just started has seen nobody.
 */
export function proseContributorsFromPaths(
  editsByPath: EditsByPath,
  segment: string,
): Map<string, Map<number, PathContribution>> {
  const rows = new Map<string, Map<number, PathContribution>>();
  for (const [path, byUser] of editsByPath) {
    const prose = proseFieldOf(path);
    if (!prose || prose.segment !== segment) continue;
    let held = rows.get(prose.rowId);
    if (!held) {
      held = new Map<number, PathContribution>();
      rows.set(prose.rowId, held);
    }
    mergeContributions(held, byUser);
  }
  return rows;
}

/**
 * Fold one field's contributors into a row's, widening each person's span.
 *
 * A person already in the row keeps their earliest first and takes the latest
 * last; nobody is ever dropped. A row has many fields and its contributors are
 * the union across all of them, so replacement here would make the last field
 * walked the only one that counted.
 */
function mergeContributions(
  held: Map<number, PathContribution>,
  byUser: Map<number, PathContribution>,
): void {
  for (const [userId, contribution] of byUser) {
    const existing = held.get(userId);
    if (!existing) {
      held.set(userId, { first: contribution.first, last: contribution.last });
      continue;
    }
    if (contribution.first < existing.first) existing.first = contribution.first;
    if (contribution.last > existing.last) existing.last = contribution.last;
  }
}

/**
 * makeAfterTransactionHandler — factory for the afterTransaction callback.
 *
 * Returns a function suitable for `ydoc.on("afterTransaction", handler)`.
 * The handler extracts userId from tr.origin via the provided `getUserId`
 * function, then adds touched field paths to the per-user Set in userFieldSets.
 *
 * It also stamps when that person last edited. This is the only place that
 * knows: a transaction arriving is the edit itself, whereas the snapshot only
 * knows when IT ran, which is why `contributions.last_active` used to read the
 * same instant for every member of a project. A reader cannot tell a shared
 * snapshot stamp from a per-person one by looking, so the stamp has to be
 * taken where the difference exists.
 *
 * @param ydoc          The Y.Doc instance
 * @param userFieldSets The Map<userId, Set<string>> to accumulate into
 * @param getUserId     Function that maps tr.origin to a userId (or null to skip)
 * @param lastEditAt    Optional Map<userId, ISO string> stamped per edit
 * @param now           Optional clock, for tests
 * @param editsByPath   Optional accumulator recording, per field path, every
 *                      person who wrote in it and when. It is what lets a row's
 *                      `updated_at` and `last_edited_by` mean the row rather
 *                      than the snapshot, and what a contributor set is derived
 *                      from. Additive: a person recorded here is never dropped
 *                      by somebody else editing the same field afterwards.
 * @param metrics       Optional accumulators for the two measures that can only
 *                      be taken live — words added and time spent. The stamp is
 *                      the same one the contributor set uses, so the clock and
 *                      the authorship can never disagree about when an edit
 *                      happened.
 */
/**
 * Where the live-only measures accumulate: how long each person has been
 * working, how many words they have added, and what each prose field held when
 * it was last seen.
 *
 * Passed in rather than owned here because they outlive a single transaction and
 * are drained by the snapshot. The arithmetic is in `contribution-metrics.ts`;
 * this file only decides when to call it.
 */
export interface MetricsAccumulators {
  ledger: TimeLedger;
  words: WordsByRow;
  baseline: WordBaseline;
}

export function makeAfterTransactionHandler(
  ydoc: Y.Doc,
  userFieldSets: Map<number, Set<string>>,
  getUserId: (origin: unknown) => number | null,
  lastEditAt?: Map<number, string>,
  now: () => string = () => new Date().toISOString(),
  editsByPath?: EditsByPath,
  metrics?: MetricsAccumulators,
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

    let touched = false;
    let wroteProse = false;
    const stamp = lastEditAt || editsByPath || metrics ? now() : "";
    tr.changed.forEach((changedKeys, sharedType) => {
      const paths = creditedPaths(tr, sharedType as Y.AbstractType<unknown>, changedKeys, ydoc);
      for (const path of paths) {
        fieldSet!.add(path);
        if (editsByPath) recordPathContribution(editsByPath, path, userId, stamp);
        if (metrics && proseFieldOf(path)) {
          creditWords(metrics.words, metrics.baseline, path, userId, changedText(sharedType, path));
          wroteProse = true;
        }
        touched = true;
      }
    });
    // Only a transaction that resolved to a field path counts as an edit. A
    // change the resolver cannot place is not evidence of authorship, and
    // stamping it would put a time on people who touched nothing nameable.
    if (touched && lastEditAt) lastEditAt.set(userId, stamp);
    // One credit per transaction, not one per path: a single keystroke can
    // resolve to several paths, and paying for each of them would multiply a
    // minute of work by however many fields it happened to touch.
    if (touched && metrics) creditChange(metrics.ledger, userId, stamp, wroteProse);
  };
}

/**
 * The paths one changed type earns, which are the paths of the keys the
 * structural guard did not refuse.
 *
 * The guard runs first on the same emitter and reverts in a transaction of its
 * own, so by now the document is corrected while `tr.changed` still names every
 * key the client wrote. A refused key is dropped here rather than retracted
 * afterwards: the accumulators persist across snapshots, so removing a path
 * would take credit earned earlier by somebody else with it.
 *
 * The empty case has to short-circuit. `resolveFieldPaths` reads a change with
 * no keys as a content edit on the type itself and answers with the type's own
 * path, which for a fully refused change is the very path being withheld.
 */
function creditedPaths(
  tr: Y.Transaction,
  sharedType: Y.AbstractType<unknown>,
  changedKeys: Set<string | null>,
  ydoc: Y.Doc,
): string[] {
  const keys = unrefusedKeys(tr, sharedType, changedKeys, ydoc);
  if (keys.size === 0) return [];
  return resolveFieldPaths(sharedType, keys, ydoc);
}

/**
 * The new text of the field one resolved path names.
 *
 * Two shapes reach here. A character-level edit registers on the Y.Text itself,
 * which IS the field, so its own contents are the answer. A keyed change
 * registers on the parent Y.Map, and the field is whatever now sits under the
 * path's last segment — a Y.Text on the collaborative fields, a plain string on
 * the ones a form replaces wholesale.
 *
 * Total, like every other render of a document value in this file: it runs inside
 * `afterTransaction`, where a throw escapes the apply of the update that carried
 * the value and takes the socket's whole message with it. An unreadable field
 * counts as empty, which credits nobody rather than crediting wrongly.
 */
function changedText(sharedType: unknown, path: string): string {
  try {
    if (sharedType instanceof Y.Text) return sharedType.toString();
    if (sharedType instanceof Y.Map) {
      return yTextToString(sharedType.get(path.slice(path.lastIndexOf(":") + 1)));
    }
  } catch {
    return "";
  }
  return "";
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
      const verb: SnapshotActivityRow["verb"] = isTempRowId(id) ? "added" : "edited";
      rows.push({ projectId, actorUserId: userId, verb, entityType, entityId: id });
    }
  }

  return rows;
}

/**
 * Render a document value to a string TOTALLY: a value nothing can convert to
 * a primitive reads as ABSENT rather than throwing.
 *
 * This is the one totality in the server, and `renderedKey` in `can-delete.ts`
 * is this function under the key contract's name. `String` is partial — a
 * plain object whose `toString` is null converts to no primitive at all and
 * throws `TypeError` — and Yjs stores plain JSON as a map value verbatim, so
 * such a value survives the `yjs_state` round trip and any collaborator can
 * put one at any key the snapshot renders. A throw on the snapshot path
 * rejects the whole batch, and the document stays open and editable while it
 * does: every edit is accepted, none is persisted, and nothing on screen says
 * so.
 *
 * `whenAbsent` is the caller's reading of an unset key, so an unrenderable
 * value is read exactly as a missing one — `"en"` for `lang`, `"media"` for a
 * step's kind, `""` for a human key. Reading it as anything else would be
 * inventing a value the document does not hold.
 *
 * Rendering is the right reading for a value bound to a column and for a
 * search, and NOT for deciding identity: two values that merely happen to be
 * equally unrenderable are not thereby the same value, and a caller that
 * searches on this must require a non-empty result of its own — see
 * `matchesFieldPathId` below and `asSearchKey` in `can-delete.ts`.
 */
export function renderedValue(value: unknown, whenAbsent = ""): string {
  if (value === undefined || value === null) return whenAbsent;
  try {
    return String(value);
  } catch {
    return whenAbsent;
  }
}

/**
 * The same totality for a value bound to a numeric column. `Number` converts
 * through the same primitive coercion `String` does and throws on the same
 * values, so a count read raw is a second way into the permanent failure
 * above.
 *
 * Only the throw is answered here. A value that converts to `NaN` still binds
 * `NaN`, which is what it did before — a coercion that SUCCEEDS is the
 * caller's business, and quietly substituting a default for one would hide a
 * real setting rather than a plant.
 */
export function renderedNumber(value: unknown, whenAbsent: number): number {
  if (value === undefined || value === null) return whenAbsent;
  try {
    return Number(value);
  } catch {
    return whenAbsent;
  }
}

/**
 * Return the string value of a Y.Text or plain string/number/null. Prevents
 * "[object Object]" in D1 rows. Shared by the DO and the activity resolver.
 *
 * Total on BOTH branches, because both are reachable with a value that throws.
 * `renderedValue` answers the fallback. The shared-type branch renders through
 * `proseString`, which states a subclass's characters rather than its own
 * serialisation: `instanceof Y.Text` admits `Y.XmlText`, whose render converts
 * every embed to a string and writes formatting as markup, so an embed that
 * converts to no primitive throws and one that does not reads as
 * `[object Object]`. Such a value survives the `yjs_state` round trip like any
 * other, and the worst of what it reaches is the LOAD: the word baseline walks
 * every prose key through this render before the document is admitted, so a
 * throw stops the document being opened at all, and the hold that keeps a
 * prose column's D1 value never gets its chance. The activity resolver is the
 * other, and it runs before both the blob and the batch. The catch stays: the
 * delta is the value's own code on a subclass too.
 *
 * An unreadable value reads as EMPTY, the reading `changedText` above takes for
 * the same call: it is what the key read as before anybody put the value there,
 * and it credits nobody rather than crediting wrongly.
 *
 * The guard is the render and nothing else. A render that SUCCEEDS is the
 * caller's business however poor its result, and the caller's own read of the
 * key is outside this function, so neither is swallowed here.
 *
 * This is a RENDER and not a domain: it answers "what string does this key
 * read as" for every value, which is what the activity resolver and the word
 * baseline need and what a column bind does not. The entity prose columns are
 * bound through `proseUpdateBind` / `proseInsertBind` below, which read the
 * same keys against a domain instead.
 */
export function yTextToString(val: unknown): string {
  if (val instanceof Y.Text) {
    try {
      return proseString(val);
    } catch {
      return "";
    }
  }
  return renderedValue(val);
}

/**
 * The prose keys of every entity, taken from the registry once.
 *
 * Membership is the registry's answer and nothing else, so a field that stops
 * being declared `ytext` stops being read as prose without a call site being
 * edited — which is the whole reason the selection is not a list at the bind
 * sites.
 */
const PROSE_KEYS: Record<string, ReadonlySet<string>> = Object.create(null);
for (const entity of Object.keys(YDOC_FIELDS) as Array<keyof typeof YDOC_FIELDS>) {
  PROSE_KEYS[entity] = proseKeysOf(entity);
}

/**
 * One entity key read against the domain the registry declares for it: prose
 * for a key declared `ytext`, and the total render for every other key.
 */
export function readProseField(
  entity: string,
  map: Y.Map<unknown>,
  key: string,
): Read<string> {
  const value = map.get(key);
  if (!PROSE_KEYS[entity]?.has(key)) return { ok: true, value: yTextToString(value) };
  return readProse(value);
}

/**
 * What a prose column binds on UPDATE: its string, `""` where the key is
 * absent, and `null` where the document's value is one the snapshot cannot
 * read.
 *
 * `null` HOLDS, against the `col = COALESCE(?, col)` form every entity UPDATE
 * already uses for `last_edited_by` and `updated_at`: D1 keeps the value it
 * holds and the site goes on publishing it, rather than the column being
 * overwritten by a value no editor can have written. Wrapping an assignment
 * adds no placeholder, so bind arity is unchanged.
 *
 * Clearing still clears. An absent key and an empty `Y.Text` both bind `''`,
 * and `COALESCE('', col)` is `''` — only `null` holds.
 */
export function proseUpdateBind(
  entity: string,
  map: Y.Map<unknown>,
  key: string,
): string | null {
  const read = readProseField(entity, map, key);
  if (read.ok) return read.value;
  return read.reason === "missing" ? "" : null;
}

/**
 * What a prose column binds on INSERT: its string, and `""` for a value the
 * snapshot cannot read.
 *
 * Never `null`. There is no prior value on an INSERT, so there is nothing for
 * a null to hold — it would write NULL, and against `project_pages.title`,
 * which is NOT NULL, it would fail the statement instead.
 */
export function proseInsertBind(
  entity: string,
  map: Y.Map<unknown>,
  key: string,
): string {
  const read = readProseField(entity, map, key);
  return read.ok ? read.value : "";
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
  // Element-safe, and it has to be: this scans EVERY entity in the collection
  // to resolve one field path, it runs inside the snapshot batch, and a
  // position holding plain JSON has no `.get`. So a single such value standing
  // anywhere in the project would throw here while resolving an edit to some
  // unrelated entity, and take the whole batch with it.
  const arr = ydoc.getArray<unknown>(map.collection);
  for (const m of entityMaps(arr).maps) {
    if (
      matchesFieldPathId(m.get("_id"), fieldPathId) ||
      matchesFieldPathId(m.get("_temp_id"), fieldPathId)
    ) {
      const slug = renderedValue(m.get(map.slug)) || fieldPathId; // plain string
      const label = yTextToString(m.get("title")) || null; // Y.Text
      return { entityId: slug, entityLabel: label };
    }
  }
  return { entityId: fieldPathId, entityLabel: null };
}

/**
 * Whether the value at an identity key is the one this field path named.
 *
 * A SEARCH, and read as one. The scan visits EVERY map in the collection, so a
 * raw render here throws on a plant standing anywhere in the project rather
 * than only on the entity being resolved — and the caller runs inside the
 * snapshot batch, so that throw is the permanent failure `renderedValue`
 * exists to close.
 *
 * The sentinel matches nothing, on the same terms as `asSearchKey`: an id the
 * document cannot state is not an id any field path can have named, and
 * treating two unrenderable values as equal would file one entity's edit under
 * another's name.
 */
function matchesFieldPathId(value: unknown, fieldPathId: string): boolean {
  const rendered = renderedValue(value);
  return rendered.length > 0 && rendered === fieldPathId;
}
