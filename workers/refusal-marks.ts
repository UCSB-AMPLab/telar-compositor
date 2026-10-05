/**
 * refusal-marks.ts — what the structural guard refused, in the terms the
 * contribution accumulator resolves paths in.
 *
 * Both handlers sit on the same `afterTransaction` emitter and run in
 * registration order, the guard first (`collaboration.ts` `attachDocHandlers`).
 * The guard's revert is a SEPARATE transaction under `REVERT_ORIGIN`: its
 * mutations land immediately, so by the time the accumulator runs the document
 * is already corrected — but the change set the accumulator walks is the
 * ORIGINAL transaction's, which still names every key the guard put back. A
 * mark is how the first handler tells the second which of those keys the
 * document holds nothing to credit for.
 *
 * Keyed on the transaction, so a mark cannot outlive the flush it belongs to
 * and cannot reach a later edit to the same key: the WeakMap entry dies with
 * the transaction object. Nothing is ever retracted after the fact — the
 * accumulators persist across snapshots, so removing a path would delete credit
 * legitimately earned earlier.
 *
 * A mark names the shared type by identity and the key that was refused. The
 * key is `null` for an array's structural change, which is how the accumulator
 * itself sees one.
 *
 * The residual that follows from that granularity: a legitimate structural
 * change to the SAME array in the same transaction as a refused one loses its
 * credit with it — an insertion beside a refused `null` push resolves to the
 * array's one path, and by the time the accumulator sees the array it cannot be
 * told which of its structural changes were refused. A field edit INSIDE an
 * element keeps its own credit, because it has a path of its own. Bundling the
 * two is rare outside a hostile client, and the cost falls on the transaction
 * that carried the refusal.
 *
 * @version v1.5.0-beta
 */

import type * as Y from "yjs";

/**
 * Marks per transaction. Weak on purpose: the entry is unreachable the moment
 * yjs drops the transaction, so no cleanup pass and no expiry are needed.
 */
const marksByTransaction = new WeakMap<Y.Transaction, Set<string>>();

/**
 * The identity of a shared type: its item id, or its root key when it is a root
 * type and has no item. Null when neither can be read, which leaves the change
 * unmarkable and therefore credited — a mark that cannot be named must not
 * suppress a path by accident.
 */
function identityOf(type: Y.AbstractType<unknown>, ydoc: Y.Doc): string | null {
  const id = (type as unknown as {
    _item?: { id?: { client: number; clock: number } };
  })._item?.id;
  if (id) return `${id.client}:${id.clock}`;
  const share = (ydoc as unknown as {
    share?: Map<string, Y.AbstractType<unknown>>;
  }).share;
  if (share) {
    for (const [name, shared] of share) {
      if (shared === type) return `root:${name}`;
    }
  }
  return null;
}

/**
 * One mark.
 *
 * The identity never contains the separator — it is either two decimal numbers
 * around a colon or a root name this server chooses — so the split between the
 * two halves is unambiguous whatever a client puts in a key, and no key can
 * forge the mark of another. A null key gets a sentinel of its own rather than
 * the empty string, which a client can spell.
 */
function markOf(identity: string, key: string | null): string {
  return `${identity}\u0000${key ?? "\u0001"}`;
}

/**
 * Record that this transaction's change to `(type, key)` was refused and put
 * back, so the accumulator running after the guard credits nobody for it.
 */
export function markRefused(
  tr: Y.Transaction,
  type: Y.AbstractType<unknown>,
  key: string | null,
  ydoc: Y.Doc,
): void {
  const identity = identityOf(type, ydoc);
  if (identity === null) return;
  let marks = marksByTransaction.get(tr);
  if (!marks) {
    marks = new Set<string>();
    marksByTransaction.set(tr, marks);
  }
  marks.add(markOf(identity, key));
}

/** The marks this transaction carries, for tests and for the reader below. */
export function refusedMarks(tr: Y.Transaction): ReadonlySet<string> | undefined {
  return marksByTransaction.get(tr);
}

/**
 * The changed keys of one type with the refused ones removed. Returns the
 * argument untouched on the ordinary path, where nothing was refused.
 */
export function unrefusedKeys(
  tr: Y.Transaction,
  type: Y.AbstractType<unknown>,
  changedKeys: Set<string | null>,
  ydoc: Y.Doc,
): Set<string | null> {
  const marks = marksByTransaction.get(tr);
  if (!marks || marks.size === 0) return changedKeys;
  const identity = identityOf(type, ydoc);
  if (identity === null) return changedKeys;
  const kept = new Set<string | null>();
  for (const key of changedKeys) {
    if (!marks.has(markOf(identity, key))) kept.add(key);
  }
  return kept;
}
