/**
 * can-delete.ts — server-side enforcement of the `canDelete` rule for
 * collaborative Yjs operations.
 *
 * Mirrors the client-side gate at `app/hooks/use-structural-ops.ts:153-156`:
 *
 *     const canDelete = (yMap) =>
 *       role === "convenor" || yMap.get("created_by") === currentUserId;
 *
 * Approach (b) — post-apply observe + revert:
 *   - A second `afterTransaction` handler sits alongside the contribution
 *     tracker on the same Y.Doc.
 *   - Walks `tr.deleteSet`, identifies deleted Y.Maps embedded in protected
 *     Y.Arrays, and reverts deletes where `created_by !== userId` for
 *     non-convenor origins.
 *   - Re-entrancy guard prevents the revert transaction from re-triggering
 *     itself; reorder/cascade detection prevents legitimate ops from being
 *     classified as unauthorised.
 *
 * Pure module — extracted from collaboration.ts so the handler can be
 * unit-tested with a bare Y.Doc and synthetic WebSocket origins.
 */

import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root Y.Arrays whose direct child Y.Maps carry `created_by`. */
export const PROTECTED_ROOT_NAMES: ReadonlySet<string> = new Set([
  "stories",
  "objects",
  "glossary",
  "pages",
]);

/** Nested Y.Arrays addressed via key on a parent Y.Map. */
export const PROTECTED_NESTED_KEYS: ReadonlySet<string> = new Set([
  "steps",
  "layers",
]);

/** Sliding-window violation policy. */
export const VIOLATION_THRESHOLD = 3;
export const VIOLATION_WINDOW_MS = 60_000;

/**
 * String origin tag for the revert transaction. The handler short-circuits
 * on string origins so its own revert never re-triggers itself, even if
 * `isReverting` were somehow falsy.
 */
export const REVERT_ORIGIN = "do-revert-unauthorised-delete";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserContext {
  userId: number;
  role: "convenor" | "collaborator";
}

export interface UnauthorisedDelete {
  /** The deleted Y.Map (still readable post-deletion via _map). */
  deletedMap: Y.Map<unknown>;
  /** The parent Y.Array the Y.Map was a member of. */
  parentArray: Y.Array<Y.Map<unknown>>;
  /** Original index (0-based) prior to deletion. */
  originalIndex: number;
}

/**
 * Dependencies the canDelete handler needs from the Durable Object. Injected
 * so the handler is testable without a live DO runtime.
 */
export interface CanDeleteDeps {
  /** The collaborative Y.Doc. */
  ydoc: Y.Doc;
  /** True while the DO is mid-snapshot; the handler skips during this window. */
  isSnapshotting: () => boolean;
  /** True while the handler is reverting; prevents recursion. Setter required. */
  isReverting: () => boolean;
  setReverting: (v: boolean) => void;
  /** All connected WebSockets — used to broadcast the post-revert sync step 2. */
  getSockets: () => Iterable<WebSocket>;
  /** Send the post-revert sync step 2 update to the supplied socket. */
  broadcastUpdate: (msg: Uint8Array) => void;
  /**
   * Per-socket violation tracker. Returns true if the socket has crossed the
   * sliding-window threshold and should be closed.
   */
  recordViolation: (ws: WebSocket) => boolean;
  /** Logger for warning lines (defaults to console.warn). */
  warn?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a transaction origin to the acting user's context. Returns null
 * for non-WebSocket origins (DO-internal transactions: cold-start, ID
 * backfill, dedup, revert) and for malformed attachments.
 */
export function getUserContext(origin: unknown): UserContext | null {
  if (!origin || typeof origin !== "object") return null;
  try {
    const att = (origin as {
      deserializeAttachment?: () => { userId?: number; role?: string } | null;
    }).deserializeAttachment?.();
    if (!att || typeof att.userId !== "number") return null;
    if (att.role !== "convenor" && att.role !== "collaborator") return null;
    return { userId: att.userId, role: att.role };
  } catch {
    return null;
  }
}

/**
 * Classify a parent Y.AbstractType as either a root shared type (with name)
 * or a nested type stored on a Y.Map under a key. Returns null when neither.
 */
export function classifyParentArray(
  parent: object,
  ydoc: Y.Doc,
): { kind: "root"; name: string } | { kind: "nested"; key: string } | null {
  const item = (parent as {
    _item?: { parentSub?: string | null; parent?: object | null };
  })._item;

  if (!item) {
    const share = (ydoc as unknown as { share?: Map<string, object> }).share;
    if (!share) return null;
    for (const [name, t] of share) {
      if (t === parent) return { kind: "root", name };
    }
    return null;
  }

  if (typeof item.parentSub === "string") {
    return { kind: "nested", key: item.parentSub };
  }

  return null;
}

/** True iff the immediate parent Y.Array is one we enforce canDelete on. */
export function isProtectedParentArray(parent: object, ydoc: Y.Doc): boolean {
  const cls = classifyParentArray(parent, ydoc);
  if (!cls) return false;
  if (cls.kind === "root") return PROTECTED_ROOT_NAMES.has(cls.name);
  return PROTECTED_NESTED_KEYS.has(cls.key);
}

/**
 * Identity key for a Y.Map used to match deletes against inserts inside the
 * same transaction (reorder detection). Prefers `_temp_id` (UUID), then
 * `_id` (D1 PK), then a synthetic fingerprint.
 */
export function identityKeyFor(yMap: Y.Map<unknown>): string {
  const tempId = yMap.get("_temp_id");
  if (typeof tempId === "string" && tempId.length > 0) return `t:${tempId}`;
  const id = yMap.get("_id");
  if (typeof id === "number") return `i:${id}`;
  const cb = yMap.get("created_by");
  return `c:${cb ?? "null"}:${yMap.size}`;
}

/**
 * Snapshot-aware variant of identityKeyFor — reads keys via
 * `typeMapGetSnapshot` so identity remains computable for Y.Maps whose
 * containing Item is tombstoned post-transaction. When snapshot is null,
 * falls back to the live-read variant.
 */
export function identityKeyForAtSnapshot(
  yMap: Y.Map<unknown>,
  snap: Y.Snapshot | null,
): string {
  if (!snap) return identityKeyFor(yMap);
  const tempId = readKeyAtSnapshot(yMap, "_temp_id", snap);
  if (typeof tempId === "string" && tempId.length > 0) return `t:${tempId}`;
  const id = readKeyAtSnapshot(yMap, "_id", snap);
  if (typeof id === "number") return `i:${id}`;
  const cb = readKeyAtSnapshot(yMap, "created_by", snap);
  return `c:${cb ?? "null"}:0`;
}

/**
 * Walk the linked list left of `deletedItem` and count preceding non-deleted
 * Y.Map struct items in the same parent Y.Array. The count is the original
 * index pre-deletion. Best-effort — clamped to the current parent length.
 */
export function computeOriginalIndex(
  parent: Y.Array<Y.Map<unknown>>,
  deletedItem: Y.Item,
): number {
  let count = 0;
  let cur: Y.Item | null = (deletedItem as unknown as { left: Y.Item | null }).left;
  while (cur) {
    const c = cur.content as unknown as { type?: Y.AbstractType<unknown> };
    if (c.type instanceof Y.Map && !cur.deleted) count++;
    cur = (cur as unknown as { left: Y.Item | null }).left;
  }
  return Math.min(count, parent.length);
}

/**
 * Recursively serialise a Y.Map (and any nested Y.Text / Y.Array of Y.Map
 * children) to a plain-object form that can be cloned back into a fresh
 * Y.Map tree via `fromCloneable`. Read-only.
 *
 * When `snap` is supplied, all reads go through `typeMapGetSnapshot` so
 * the function works on tombstoned Y.Maps (parent Item already deleted).
 * When `snap` is null, live reads via `.get()` are used (suitable for
 * still-live Y.Maps).
 */
export function toCloneable(
  yMap: Y.Map<unknown>,
  snap: Y.Snapshot | null = null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Walk _map keys directly so we see entries even when their containing
  // Item is tombstoned. Y.Map.keys() filters out deleted entries.
  const keys = snap
    ? Array.from((yMap as unknown as { _map: Map<string, unknown> })._map.keys())
    : Array.from(yMap.keys());
  for (const key of keys) {
    const val = snap ? readKeyAtSnapshot(yMap, key, snap) : yMap.get(key);
    if (val === undefined) continue;
    if (val instanceof Y.Text) {
      out[key] = { __ytext: val.toString() };
    } else if (val instanceof Y.Array) {
      const arr: unknown[] = [];
      // Y.Array iteration also filters tombstoned entries, but we still
      // need each element's pre-delete content. For nested arrays under a
      // deleted parent the array itself remains addressable; its visible
      // length post-delete may be 0. Snapshot-read each element via the
      // helper below — for now we copy whatever is currently visible,
      // which is empty for fully-tombstoned children. The R4 spec only
      // requires top-level revert; nested-array fidelity is best-effort.
      for (let i = 0; i < val.length; i++) {
        const el = val.get(i);
        if (el instanceof Y.Map) {
          arr.push({ __ymap: toCloneable(el, null) });
        } else {
          arr.push(el);
        }
      }
      out[key] = { __yarray: arr };
    } else if (val instanceof Y.Map) {
      out[key] = { __ymap: toCloneable(val, null) };
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Inverse of `toCloneable` — build a fresh Y.Map tree from the mirror. */
export function fromCloneable(obj: Record<string, unknown>): Y.Map<unknown> {
  const out = new Y.Map<unknown>();
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === "object" && "__ytext" in val) {
      out.set(key, new Y.Text((val as { __ytext: string }).__ytext));
    } else if (val && typeof val === "object" && "__yarray" in val) {
      const arr = new Y.Array<unknown>();
      const items = (val as { __yarray: unknown[] }).__yarray;
      const built: unknown[] = [];
      for (const el of items) {
        if (el && typeof el === "object" && "__ymap" in el) {
          built.push(fromCloneable((el as { __ymap: Record<string, unknown> }).__ymap));
        } else {
          built.push(el);
        }
      }
      arr.push(built);
      out.set(key, arr);
    } else if (val && typeof val === "object" && "__ymap" in val) {
      out.set(key, fromCloneable((val as { __ymap: Record<string, unknown> }).__ymap));
    } else {
      out.set(key, val);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// extractUnauthorisedDeletes — pure analysis pass over a Y.Transaction
// ---------------------------------------------------------------------------

/**
 * Read a key from a Y.Map at a given snapshot. Wraps `Y.typeMapGetSnapshot`
 * (an internal Yjs helper exposed via the package's index re-exports). Used
 * to read `created_by` from a Y.Map AFTER its parent Item has been
 * tombstoned — direct `.get()` returns undefined for deleted entries, but
 * the snapshot read walks the _map linked list back to the pre-deletion
 * value.
 */
export function readKeyAtSnapshot(
  yMap: Y.Map<unknown>,
  key: string,
  snap: Y.Snapshot,
): unknown {
  const fn = (Y as unknown as {
    typeMapGetSnapshot?: (m: Y.Map<unknown>, k: string, s: Y.Snapshot) => unknown;
  }).typeMapGetSnapshot;
  if (typeof fn === "function") return fn(yMap, key, snap);
  // Fallback — should never run since yjs ^13.6.x exports typeMapGetSnapshot.
  // Walk the _map linked list manually if the helper is missing.
  const entry = (yMap as unknown as { _map?: Map<string, { left?: unknown; deleted: boolean; content: { getContent: () => unknown[] }; length: number }> })._map?.get(key);
  if (entry && !entry.deleted) return entry.content.getContent()[entry.length - 1];
  return undefined;
}

/**
 * Walk `tr.deleteSet` and return the list of unauthorised collaborator
 * deletes — Y.Maps inside protected Y.Arrays whose `created_by` is not the
 * acting user, with reorder and cascade short-circuits applied.
 *
 * @param ydoc            The Y.Doc the transaction ran against.
 * @param tr              The transaction (`afterTransaction` argument).
 * @param actor           The acting user's context.
 * @param beforeSnapshot  Y.Snapshot captured at `beforeTransaction` so we can
 *                        read `created_by` from now-tombstoned Y.Maps. May
 *                        be null only when the doc was empty pre-transaction
 *                        (no protected items exist to delete).
 * @returns               List of unauthorised deletes (empty if all authorised).
 */
export function extractUnauthorisedDeletes(
  ydoc: Y.Doc,
  tr: Y.Transaction,
  actor: { userId: number; role: "convenor" | "collaborator" },
  beforeSnapshot: Y.Snapshot | null = null,
): UnauthorisedDelete[] {
  if (actor.role === "convenor") return [];
  if (tr.deleteSet.clients.size === 0) return [];

  // Build the set of identity keys for Y.Maps INSERTED in this transaction.
  // Used to detect reorders (delete + reinsert within one transaction).
  const insertedIdentities = new Set<string>();
  tr.changed.forEach((_keys, type) => {
    if (type instanceof Y.Array) {
      for (let i = 0; i < type.length; i++) {
        const el = type.get(i);
        if (el instanceof Y.Map) {
          insertedIdentities.add(identityKeyFor(el));
        }
      }
    }
  });

  const unauthorised: UnauthorisedDelete[] = [];
  // Track ancestor-deleted Y.Maps so cascade children inherit the parent's
  // authorisation decision.
  const ancestorDeleted = new Set<object>();

  Y.iterateDeletedStructs(tr, tr.deleteSet, (struct: Y.GC | Y.Item) => {
    if (!(struct instanceof Y.Item)) return;
    const wrapped = (struct.content as unknown as { type?: object }).type;
    if (!wrapped || !(wrapped instanceof Y.Map)) return;

    const parent = struct.parent;
    if (!parent || typeof parent === "string") return;
    const parentType = parent as unknown as Y.AbstractType<unknown>;
    if (!(parentType instanceof Y.Array)) return;

    // Cascade short-circuit.
    let cur: object | null = parentType;
    let isCascade = false;
    while (cur) {
      if (ancestorDeleted.has(cur)) { isCascade = true; break; }
      const parentItem: { parent?: object | null } | undefined =
        (cur as { _item?: { parent?: object | null } })._item;
      cur = parentItem?.parent ?? null;
    }
    if (isCascade) {
      ancestorDeleted.add(wrapped);
      return;
    }
    ancestorDeleted.add(wrapped);

    if (!isProtectedParentArray(parentType, ydoc)) return;

    // Reorder detection.
    // identityKeyFor needs to read _temp_id/_id from the deleted Y.Map; use
    // the snapshot read since direct .get() returns undefined post-delete.
    const idKey = identityKeyForAtSnapshot(wrapped as Y.Map<unknown>, beforeSnapshot);
    if (insertedIdentities.has(idKey)) {
      // A same-identity insert is a genuine reorder ONLY if the clone
      // preserves the deleted item's `created_by`. A clone with a different
      // (forged) `created_by` is a delete-and-replace attack — fall through
      // to the unauthorised-delete revert path.
      const arr = parentType as Y.Array<Y.Map<unknown>>;
      let cloneCreatedBy: unknown = undefined;
      for (let i = 0; i < arr.length; i++) {
        const candidate = arr.get(i);
        if (candidate instanceof Y.Map && identityKeyFor(candidate) === idKey) {
          cloneCreatedBy = candidate.get("created_by");
          break;
        }
      }
      const deletedCreatedBy = beforeSnapshot
        ? readKeyAtSnapshot(wrapped as Y.Map<unknown>, "created_by", beforeSnapshot)
        : (wrapped as Y.Map<unknown>).get("created_by");
      if (
        cloneCreatedBy !== undefined &&
        deletedCreatedBy !== undefined &&
        cloneCreatedBy === deletedCreatedBy
      ) {
        return; // genuine reorder — same identity, same authorship.
      }
      // Mismatch or missing — fall through to the unauthorised-delete check.
    }

    const createdBy = beforeSnapshot
      ? readKeyAtSnapshot(wrapped as Y.Map<unknown>, "created_by", beforeSnapshot)
      : (wrapped as Y.Map<unknown>).get("created_by");
    if (createdBy === actor.userId) return; // legitimate self-delete

    const originalIndex = computeOriginalIndex(
      parentType as Y.Array<Y.Map<unknown>>,
      struct,
    );

    unauthorised.push({
      deletedMap: wrapped as Y.Map<unknown>,
      parentArray: parentType as Y.Array<Y.Map<unknown>>,
      originalIndex,
    });
  });

  return unauthorised;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Install the canDelete enforcement on a Y.Doc. Registers a `beforeTransaction`
 * listener (captures pre-transaction snapshot for reading tombstoned Y.Maps)
 * and an `afterTransaction` listener (walks deleteSet, classifies, reverts).
 *
 * The factory is the single integration point used by both production
 * (workers/collaboration.ts) and the unit tests in
 * tests/collaboration-can-delete.test.ts. Behaviour is fully driven by the
 * injected dependencies — no implicit coupling to the DO runtime.
 *
 * Returns the `afterTransaction` handler for legacy direct-attach use; the
 * `beforeTransaction` listener is also attached internally via deps.ydoc.
 */
export function makeCanDeleteHandler(deps: CanDeleteDeps): (tr: Y.Transaction) => void {
  const warn = deps.warn ?? ((msg) => console.warn(msg));

  // Pre-transaction snapshot — captured on each beforeTransaction (for
  // client-origin transactions; null for DO-internal). Cleared on
  // afterTransaction. Stored on the closure so the after handler can read
  // it without leaking into deps.
  let beforeSnapshot: Y.Snapshot | null = null;

  deps.ydoc.on("beforeTransaction", (tr: Y.Transaction) => {
    // Capture only for transactions we MIGHT need to validate. Skipping the
    // snapshot for known-skip transactions is a meaningful perf saving —
    // every cold-start, snapshot, ID-backfill transaction would otherwise
    // pay a full state-vector encode.
    if (deps.isReverting()) { beforeSnapshot = null; return; }
    if (deps.isSnapshotting()) { beforeSnapshot = null; return; }
    const origin = tr.origin;
    if (typeof origin === "string") { beforeSnapshot = null; return; }
    const actor = getUserContext(origin);
    if (!actor || actor.role === "convenor") { beforeSnapshot = null; return; }
    beforeSnapshot = Y.snapshot(deps.ydoc);
  });

  const afterHandler = (tr: Y.Transaction) => {
    if (deps.isReverting()) { beforeSnapshot = null; return; }
    if (deps.isSnapshotting()) { beforeSnapshot = null; return; }

    const origin = tr.origin;
    if (typeof origin === "string") { beforeSnapshot = null; return; }
    const actor = getUserContext(origin);
    if (!actor) { beforeSnapshot = null; return; }
    if (actor.role === "convenor") { beforeSnapshot = null; return; }

    const snap = beforeSnapshot;
    beforeSnapshot = null; // consume

    const unauthorised = extractUnauthorisedDeletes(deps.ydoc, tr, actor, snap);
    if (unauthorised.length === 0) return;

    // Apply the revert under the re-entrancy guard.
    deps.setReverting(true);
    try {
      deps.ydoc.transact(() => {
        const sorted = [...unauthorised].sort((a, b) => a.originalIndex - b.originalIndex);
        for (const { deletedMap, parentArray, originalIndex } of sorted) {
          const cloneable = toCloneable(deletedMap, snap);
          const clone = fromCloneable(cloneable);
          const clamped = Math.max(0, Math.min(originalIndex, parentArray.length));
          parentArray.insert(clamped, [clone]);
        }
      }, REVERT_ORIGIN);
    } finally {
      deps.setReverting(false);
    }

    // Broadcast post-revert state via writeSyncStep2. Encoding done here so
    // the handler is a single self-contained unit.
    const updateMsg = encodeSyncStep2(deps.ydoc);
    deps.broadcastUpdate(updateMsg);

    // Record violation + log + maybe close socket.
    let closing = false;
    if (origin && typeof origin === "object") {
      closing = deps.recordViolation(origin as WebSocket);
    }
    warn(
      `[canDelete] reverted ${unauthorised.length} unauthorised delete(s) by user ${actor.userId}` +
      (closing ? " — closing socket (>=3 violations in 60s)" : ""),
    );
    if (closing && origin && typeof origin === "object") {
      try { (origin as WebSocket).close(1008, "Repeated unauthorised delete attempts"); } catch { /* already closed */ }
    }
  };

  return afterHandler;
}

// ---------------------------------------------------------------------------
// recordViolation — sliding-window per-socket counter
// ---------------------------------------------------------------------------

/**
 * Stateful violation counter helper. Returns a `record(ws)` function that
 * tracks recent timestamps per socket in a WeakMap (so closed sockets are
 * GC'd), and returns true when a socket crosses the threshold within the
 * window.
 */
export function makeViolationCounter(
  threshold: number = VIOLATION_THRESHOLD,
  windowMs: number = VIOLATION_WINDOW_MS,
  now: () => number = () => Date.now(),
): (ws: WebSocket) => boolean {
  const timestamps: WeakMap<WebSocket, number[]> = new WeakMap();
  return (ws: WebSocket) => {
    const t = now();
    const cutoff = t - windowMs;
    const list = timestamps.get(ws) ?? [];
    const recent = list.filter((x) => x >= cutoff);
    recent.push(t);
    timestamps.set(ws, recent);
    return recent.length >= threshold;
  };
}

// ---------------------------------------------------------------------------
// encodeSyncStep2 — y-protocols sync envelope for the post-revert broadcast.
// ---------------------------------------------------------------------------
//
// Inlined here (rather than imported from y-protocols) so the module has zero
// runtime dependency on lib0/y-protocols at the type level — the import is
// dynamic-friendly and the encoded shape matches workers/collaboration.ts's
// existing snapshot-broadcast pattern.

import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

const messageSync = 0;

function encodeSyncStep2(ydoc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep2(enc, ydoc);
  return encoding.toUint8Array(enc);
}
