/**
 * Differential-equivalence tests for `readKeyBeforeTransaction`
 * (workers/can-delete.ts) against the snapshot-based `readKeyAtSnapshot`.
 *
 * The new reader recovers a Y.Map key's PRE-transaction value from data Yjs
 * already computes for every transaction — `tr.beforeState` and `tr.deleteSet`
 * — with no `Y.snapshot` call. It is `Y.typeMapGetSnapshot`'s algorithm with
 * the snapshot's state vector replaced by `beforeState` and its delete set by
 * the transaction's own. That equivalence is the whole licence for building an
 * always-on rule on it, so it is pinned here directly: for every scenario the
 * two readers must agree, where the snapshot reader's `undefined` means the
 * same thing as `{ absent: true }`.
 *
 * The reference snapshot is captured in `beforeTransaction`, which is exactly
 * the window the existing course-item passes use it in.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import {
  readKeyAtSnapshot,
  readKeyBeforeTransaction,
} from "../workers/can-delete";

// ---------------------------------------------------------------------------
// Harness: run `mutate` in one transaction and report, for each (map, key)
// pair the probe asks about, what both readers said inside afterTransaction.
// ---------------------------------------------------------------------------

interface Reading {
  before: { absent: true } | { value: unknown };
  reference: unknown; // readKeyAtSnapshot's answer
}

function probeTransaction(
  ydoc: Y.Doc,
  mutate: () => void,
  probe: () => Array<{ map: Y.Map<unknown>; key: string }>,
): Reading[] {
  let snap: Y.Snapshot | null = null;
  const onBefore = () => { snap = Y.snapshot(ydoc); };
  const readings: Reading[] = [];
  const onAfter = (tr: Y.Transaction) => {
    for (const { map, key } of probe()) {
      readings.push({
        before: readKeyBeforeTransaction(map, key, tr),
        reference: readKeyAtSnapshot(map, key, snap as unknown as Y.Snapshot),
      });
    }
  };
  ydoc.on("beforeTransaction", onBefore);
  ydoc.on("afterTransaction", onAfter);
  try {
    ydoc.transact(mutate, { simulatedSocket: true });
  } finally {
    ydoc.off("beforeTransaction", onBefore);
    ydoc.off("afterTransaction", onAfter);
  }
  return readings;
}

/** Both readers agree, treating `undefined` and `{ absent: true }` as one. */
function expectAgreement(r: Reading): void {
  if ("absent" in r.before) {
    expect(r.reference).toBeUndefined();
  } else {
    expect(r.reference).not.toBeUndefined();
    expect(r.before.value).toEqual(r.reference);
  }
}

// ---------------------------------------------------------------------------
// The five named cases from the design note.
// ---------------------------------------------------------------------------

describe("readKeyBeforeTransaction — named cases", () => {
  it("key born in this transaction reads as absent", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    let born: Y.Map<unknown> | null = null;
    const readings = probeTransaction(
      ydoc,
      () => {
        born = new Y.Map<unknown>();
        born.set("_id", 42);
        arr.push([born]);
      },
      () => [{ map: born as unknown as Y.Map<unknown>, key: "_id" }],
    );
    expect(readings[0].before).toEqual({ absent: true });
    expectAgreement(readings[0]);
  });

  it("key overwritten 42 -> 99 reads back 42", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    const m = new Y.Map<unknown>();
    ydoc.transact(() => { m.set("_id", 42); arr.push([m]); });

    const readings = probeTransaction(
      ydoc,
      () => { m.set("_id", 99); },
      () => [{ map: m, key: "_id" }],
    );
    expect(readings[0].before).toEqual({ value: 42 });
    expect(m.get("_id")).toBe(99);
    expectAgreement(readings[0]);
  });

  it("key deleted in an EARLIER transaction then rewritten reads as absent", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    const m = new Y.Map<unknown>();
    ydoc.transact(() => { m.set("_id", 42); arr.push([m]); });
    ydoc.transact(() => { m.delete("_id"); });

    const readings = probeTransaction(
      ydoc,
      () => { m.set("_id", 99); },
      () => [{ map: m, key: "_id" }],
    );
    expect(readings[0].before).toEqual({ absent: true });
    expectAgreement(readings[0]);
  });

  it("key deleted BY this transaction reads back the pre-value", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    const m = new Y.Map<unknown>();
    ydoc.transact(() => { m.set("_id", 42); arr.push([m]); });

    const readings = probeTransaction(
      ydoc,
      () => { m.delete("_id"); },
      () => [{ map: m, key: "_id" }],
    );
    expect(readings[0].before).toEqual({ value: 42 });
    expectAgreement(readings[0]);
  });

  it("untouched key reads back its value", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    const m = new Y.Map<unknown>();
    ydoc.transact(() => { m.set("_id", 42); m.set("object_id", "pot"); arr.push([m]); });

    const readings = probeTransaction(
      ydoc,
      () => { m.set("title", "x"); },
      () => [{ map: m, key: "object_id" }],
    );
    expect(readings[0].before).toEqual({ value: "pot" });
    expectAgreement(readings[0]);
  });

  it("a value written twice inside one transaction still reads the pre-value", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    const m = new Y.Map<unknown>();
    ydoc.transact(() => { m.set("_id", 42); arr.push([m]); });

    const readings = probeTransaction(
      ydoc,
      () => { m.set("_id", 77); m.set("_id", 99); },
      () => [{ map: m, key: "_id" }],
    );
    expect(readings[0].before).toEqual({ value: 42 });
    expectAgreement(readings[0]);
  });

  it("a remote peer's concurrent write is not mistaken for a pre-value", () => {
    // Two docs diverge, then the remote update is applied locally. The applied
    // items post-date the receiving doc's beforeState, so the reader must
    // report the LOCAL pre-transaction value, not the merged winner.
    const a = new Y.Doc();
    const arrA = a.getArray<Y.Map<unknown>>("objects");
    const m = new Y.Map<unknown>();
    a.transact(() => { m.set("_id", 42); arrA.push([m]); });

    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.transact(() => { b.getArray<Y.Map<unknown>>("objects").get(0).set("_id", 99); });
    const remote = Y.encodeStateAsUpdate(b);

    let snap: Y.Snapshot | null = null;
    const readings: Reading[] = [];
    a.on("beforeTransaction", () => { snap = Y.snapshot(a); });
    a.on("afterTransaction", (tr: Y.Transaction) => {
      readings.push({
        before: readKeyBeforeTransaction(m, "_id", tr),
        reference: readKeyAtSnapshot(m, "_id", snap as unknown as Y.Snapshot),
      });
    });
    Y.applyUpdate(a, remote, { simulatedSocket: true });

    expect(readings[0].before).toEqual({ value: 42 });
    expectAgreement(readings[0]);
  });
});

// ---------------------------------------------------------------------------
// Randomised differential sweep. Random key/value churn across several docs,
// interleaved with map deletes and remote merges, comparing both readers on
// every probed key of every transaction.
// ---------------------------------------------------------------------------

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("readKeyBeforeTransaction — randomised differential sweep", () => {
  const KEYS = ["_id", "_temp_id", "object_id", "title", "created_by"];

  it("agrees with readKeyAtSnapshot across 400 randomised transactions", () => {
    const rng = makeRng(20260827);
    let compared = 0;
    let absentSeen = 0;
    let valueSeen = 0;

    for (let doc = 0; doc < 20; doc++) {
      const ydoc = new Y.Doc();
      const arr = ydoc.getArray<Y.Map<unknown>>("objects");
      const maps: Y.Map<unknown>[] = [];

      // Seed with a few pre-existing maps in their own transactions.
      for (let i = 0; i < 3; i++) {
        ydoc.transact(() => {
          const m = new Y.Map<unknown>();
          m.set("_id", i);
          m.set("object_id", `o-${i}`);
          arr.push([m]);
          maps.push(m);
        });
      }

      for (let t = 0; t < 20; t++) {
        const readings = probeTransaction(
          ydoc,
          () => {
            const ops = 1 + Math.floor(rng() * 3);
            for (let o = 0; o < ops; o++) {
              const m = maps[Math.floor(rng() * maps.length)];
              const key = KEYS[Math.floor(rng() * KEYS.length)];
              const roll = rng();
              if (roll < 0.15) {
                m.delete(key);
              } else if (roll < 0.25) {
                // Insert a fresh map that only exists from here on.
                const fresh = new Y.Map<unknown>();
                fresh.set(key, `fresh-${t}-${o}`);
                arr.push([fresh]);
                maps.push(fresh);
              } else if (roll < 0.35) {
                // Remove a map from the array — its keys stay readable.
                const at = arr.toArray().indexOf(m);
                if (at >= 0 && arr.length > 1) arr.delete(at, 1);
              } else {
                m.set(key, `v-${t}-${o}-${Math.floor(rng() * 5)}`);
              }
            }
          },
          () => maps.flatMap((m) => KEYS.map((key) => ({ map: m, key }))),
        );
        for (const r of readings) {
          expectAgreement(r);
          compared++;
          if ("absent" in r.before) absentSeen++; else valueSeen++;
        }
      }
    }

    // Guard against a vacuous sweep: both outcomes must actually be exercised.
    expect(compared).toBeGreaterThan(5000);
    expect(absentSeen).toBeGreaterThan(100);
    expect(valueSeen).toBeGreaterThan(100);
  });
});
