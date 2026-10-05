/**
 * displaced-edits.ts — how many inbound edits are addressed to a container the
 * structural guard took out of the document.
 *
 * When the guard refuses a write that replaced a container, it puts a CLONE in
 * the document's place. A client that has not yet applied the correction still
 * holds the displaced container and keeps addressing its items, and those edits
 * land nowhere a reader can see. This module measures how often that happens.
 *
 * The measure is partial by construction, and the partiality is the point of
 * every rule below:
 *
 *   - A displaced subtree is recorded as CLOCK RANGES, `(client, clock, length)`
 *     per struct, not as a set of ids. A text item spans `length` clocks, and a
 *     reference into its middle — an append after `"hello"` stored at clock 3
 *     references clock 7, an interior deletion covers clock 5 — matches no
 *     single id.
 *   - The container's OWN item is recorded first. A first insertion into a
 *     displaced empty array decodes with `parent` equal to that id and no
 *     origins, and would otherwise match nothing.
 *   - An inbound struct matches through its explicit parent id, its origin or
 *     its right origin. A decoded struct carries `parent: null` when the parent
 *     is inferred from an origin (`yjs/src/utils/updates.js`), which is the
 *     ordinary case for a text append into a displaced subtree.
 *   - A delete-only update carries no structs at all, so delete-set ranges are
 *     matched against the recorded ranges by overlap.
 *   - The delete-set count is only meaningful against a PROVIDER-SHAPED
 *     update — a transaction's own deletions, the shape `readSyncMessage` and
 *     the document's own `update` event carry. A state diff from
 *     `encodeStateAsUpdate` carries the whole document's delete set instead,
 *     every deletion the sender has ever seen, on every message — a shape no
 *     editor sends over this path, and one this module does not attempt to
 *     tell apart from a provider update.
 *
 * What it cannot see, and is not claimed to: an edit whose every reference is
 * to items created after the displacement, and anything arriving after the
 * window below or after an eviction.
 *
 * Why the count is not simply zero for a connected client. Applying the
 * correction changes the container's identity without firing the old
 * container's observers, and the step editor derives its array during render
 * (`_app.stories.$storyId.tsx`) while its subscription observes the old one
 * (`use-yjs-array-sync.ts`) — so whether the editor rebinds before the next
 * edit depends on a re-render the correction may not trigger. A client that is
 * offline or reconnecting can hold the displaced container longer still and
 * submit edits addressed to it through a later sync, outside any window this
 * measure states. Both are accepted residuals of the ruling, not defects.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

/** A half-open run of clocks belonging to one client: `from` ≤ clock < `to`. */
export interface ClockRange {
  client: number;
  from: number;
  to: number;
}

/** Structs recorded for one displacement. Bounds a hostile subtree's cost. */
export const DISPLACED_RANGE_CAP = 4096;
/** Displacements held at once. The oldest is evicted rather than the newest. */
export const DISPLACEMENT_CAP = 64;
/** How long after a displacement an inbound edit is still attributed to it. */
export const DISPLACEMENT_TTL_MS = 60_000;

/** The item shape this module reads. Yjs's own `Item`, narrowed to the fields
 *  that survive on a tombstone: ids and lengths outlive the content. */
interface StructItem {
  id: { client: number; clock: number };
  length: number;
  right?: StructItem | null;
  left?: StructItem | null;
  content?: unknown;
}

function itemOf(type: Y.AbstractType<unknown>): StructItem | null {
  return (type as unknown as { _item?: StructItem | null })._item ?? null;
}

/**
 * The type a `ContentType` item holds, or null for every other content kind.
 * The walk has to descend through these because the ids of a nested map's or
 * text's items are exactly what a stale client's edit references.
 */
function containedType(item: StructItem): Y.AbstractType<unknown> | null {
  const content = item.content;
  if (!(content instanceof Y.ContentType)) return null;
  return (content as unknown as { type: Y.AbstractType<unknown> }).type ?? null;
}

/**
 * One type's own structs: its list items, then the items under its keys and the
 * overwritten items behind each of them.
 *
 * Read from `_start` and `_map` rather than through `get`/`toArray`, which
 * answer empty for a displaced type — yjs counts the whole subtree as deleted
 * the instant the key is overwritten. The tombstoned items still carry their
 * ids and lengths until the delete set is collected, which happens after the
 * handler that calls this has returned.
 */
function structsOf(type: Y.AbstractType<unknown>, limit: number): StructItem[] {
  const items: StructItem[] = [];
  const inner = type as unknown as {
    _start?: StructItem | null;
    _map?: Map<string, StructItem>;
  };
  let node = inner._start ?? null;
  while (node && items.length < limit) {
    items.push(node);
    node = node.right ?? null;
  }
  for (const last of inner._map?.values() ?? []) {
    let keyed: StructItem | null = last;
    while (keyed && items.length < limit) {
      items.push(keyed);
      keyed = keyed.left ?? null;
    }
  }
  return items;
}

/**
 * Every clock range the displaced subtree occupies, its own item first.
 *
 * Iterative rather than recursive: a client can author the nesting, and a stack
 * overflow here would land inside the guard's handler, before the revert.
 */
export function collectDisplacedRanges(
  type: Y.AbstractType<unknown>,
  cap: number = DISPLACED_RANGE_CAP,
): ClockRange[] {
  const ranges: ClockRange[] = [];
  const own = itemOf(type);
  if (own) ranges.push({ client: own.id.client, from: own.id.clock, to: own.id.clock + own.length });
  const pending: Array<Y.AbstractType<unknown>> = [type];
  const seen = new Set<Y.AbstractType<unknown>>(pending);
  // A `for...of` over an array visits entries appended while it runs, which is
  // what makes this a breadth-first walk with no second worklist.
  for (const current of pending) {
    for (const item of structsOf(current, cap)) {
      if (ranges.length >= cap) return ranges;
      ranges.push({
        client: item.id.client,
        from: item.id.clock,
        to: item.id.clock + item.length,
      });
      const nested = containedType(item);
      if (nested && !seen.has(nested)) {
        seen.add(nested);
        pending.push(nested);
      }
    }
  }
  return ranges;
}

/**
 * The delete set of a decoded update, narrowed to what this module reads. Yjs's
 * entry point does not export the `DeleteSet` type, so the shape is stated here
 * rather than imported.
 */
interface DeleteRanges {
  clients: Map<number, Array<{ clock: number; len: number }>>;
}

/** One recorded displacement: when, and the clocks its subtree occupied. */
interface Displacement {
  at: number;
  byClient: Map<number, ClockRange[]>;
}

/** What an inbound update addressed, and how old the displacement it hit is. */
export interface DisplacedHit {
  structs: number;
  deletions: number;
  ageMs: number;
}

export interface DisplacementLog {
  /** Hold one displacement's ranges, evicting the oldest past the cap. */
  record(ranges: ClockRange[]): void;
  /** What this decoded update addresses, or null when it addresses none. */
  inspect(update: Uint8Array): DisplacedHit | null;
  /** Live displacements, expiry applied. Reported by the tests. */
  size(): number;
}

function covers(
  displacement: Displacement,
  id: { client: number; clock: number } | null | undefined,
): boolean {
  if (!id) return false;
  const ranges = displacement.byClient.get(id.client);
  if (!ranges) return false;
  return ranges.some((range) => id.clock >= range.from && id.clock < range.to);
}

/** An id when the parent was written explicitly; null when it was inferred. */
function parentId(struct: unknown): { client: number; clock: number } | null {
  const parent = (struct as { parent?: unknown }).parent;
  if (!parent || typeof parent !== "object") return null;
  const id = parent as { client?: unknown; clock?: unknown };
  return typeof id.client === "number" && typeof id.clock === "number"
    ? { client: id.client, clock: id.clock }
    : null;
}

/**
 * The most recent displacement, of those given, that `id` falls inside — or
 * null when none does.
 *
 * Shared by the struct and deletion counts below so a packet that addresses
 * two recorded displacements is counted against each of them for "how
 * recent", while the STRUCT ITSELF is still counted only once: the caller
 * asks this once per struct or deletion range, not once per displacement.
 */
function mostRecentCoveringAt(
  displacements: readonly Displacement[],
  ids: ReadonlyArray<{ client: number; clock: number } | null | undefined>,
): number | null {
  let at: number | null = null;
  for (const displacement of displacements) {
    if (!ids.some((id) => covers(displacement, id))) continue;
    if (at === null || displacement.at > at) at = displacement.at;
  }
  return at;
}

function deletionCoveringAt(
  displacements: readonly Displacement[],
  client: number,
  clock: number,
  to: number,
): number | null {
  let at: number | null = null;
  for (const displacement of displacements) {
    const ranges = displacement.byClient.get(client);
    if (!ranges) continue;
    if (!ranges.some((range) => clock < range.to && to > range.from)) continue;
    if (at === null || displacement.at > at) at = displacement.at;
  }
  return at;
}

/**
 * The set of live displacements, with expiry checked on insert and on read and
 * no timer of its own: a Durable Object that goes quiet after a displacement
 * must not be kept awake by this measure.
 */
export function createDisplacementLog(options: {
  now?: () => number;
  ttlMs?: number;
  cap?: number;
} = {}): DisplacementLog {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DISPLACEMENT_TTL_MS;
  const cap = options.cap ?? DISPLACEMENT_CAP;
  let live: Displacement[] = [];

  const expire = (): void => {
    const cutoff = now() - ttlMs;
    live = live.filter((displacement) => displacement.at > cutoff);
  };

  return {
    record(ranges: ClockRange[]): void {
      expire();
      const byClient = new Map<number, ClockRange[]>();
      for (const range of ranges) {
        const held = byClient.get(range.client) ?? [];
        held.push(range);
        byClient.set(range.client, held);
      }
      live.push({ at: now(), byClient });
      if (live.length > cap) live = live.slice(live.length - cap);
    },

    inspect(update: Uint8Array): DisplacedHit | null {
      expire();
      if (live.length === 0) return null;
      // Contained on its own: this decode is a second, independent read of a
      // packet `readSyncMessage` has its own containment for, and a malformed
      // update must cost a measurement rather than the socket's message.
      let decoded: { structs: unknown[]; ds: DeleteRanges };
      try {
        decoded = Y.decodeUpdate(update);
      } catch {
        return null;
      }
      // Counted against the UNION of live displacements, not the best single
      // one: a packet that addresses two recorded displacements (two structs,
      // one per displacement, or one struct that falls in both) must report
      // two, not the one struct the most recent displacement happens to
      // explain. `ageMs` alone stays single-valued — it names the most recent
      // displacement hit, which is the only sense "how old" has when several
      // are addressed at once.
      let structs = 0;
      let mostRecentAt: number | null = null;
      for (const struct of decoded.structs) {
        const origins = struct as {
          origin?: { client: number; clock: number } | null;
          rightOrigin?: { client: number; clock: number } | null;
        };
        const at = mostRecentCoveringAt(live, [
          parentId(struct), origins.origin, origins.rightOrigin,
        ]);
        if (at === null) continue;
        structs++;
        if (mostRecentAt === null || at > mostRecentAt) mostRecentAt = at;
      }
      let deletions = 0;
      decoded.ds.clients.forEach((clientDeletions, client) => {
        for (const deletion of clientDeletions) {
          const to = deletion.clock + deletion.len;
          const at = deletionCoveringAt(live, client, deletion.clock, to);
          if (at === null) continue;
          deletions++;
          if (mostRecentAt === null || at > mostRecentAt) mostRecentAt = at;
        }
      });
      if (structs + deletions === 0) return null;
      return { structs, deletions, ageMs: now() - (mostRecentAt as number) };
    },

    size(): number {
      expire();
      return live.length;
    },
  };
}
