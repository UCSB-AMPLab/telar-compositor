/**
 * The descent into born containers is iterated, not recursed.
 *
 * Both guards reach the members of a container the transaction created by
 * walking down from the map that holds it — Yjs records nothing in
 * `tr.changed` for a type created in the same transaction, so nothing else
 * will look at them. The nesting is authored by the client, which makes the
 * depth of that walk a client-supplied number.
 *
 * The trap this file exists to pin: a recursive walk bounds depth by the JS
 * stack, and the `RangeError` lands INSIDE the pass — before the guarded
 * revert block. So nothing is reverted, nothing is reported, no enforcement
 * failure fires, and the transaction stands in full. A guard that a client can
 * switch off by nesting is not a guard.
 *
 * Eight thousand levels is past the limit and cheap to build: one transaction,
 * each level attached to an already-integrated parent, which keeps Yjs's own
 * integration shallow. Built in a source document and delivered as an encoded
 * update, because that is how a client delivers anything, and because a
 * preliminary tree that deep overflows inside Yjs before the guard is reached.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  makeCanDeleteHandler,
  makeViolationCounter,
  extractStructuralShapeViolations,
  extractIdentityDomainViolations,
} from "../workers/can-delete";

type Role = "convenor" | "collaborator" | "instructor";

function fakeSocket(userId: number, role: Role) {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

/** Past the stack limit for a per-level frame, and ~85ms to build and apply. */
const DEEP = 8000;

/**
 * A story nested `depth` levels through `steps`, with `tailValue` at the
 * bottom. One transaction; every level is attached to an integrated parent, so
 * Yjs integrates one level at a time rather than recursing down a preliminary
 * tree.
 */
function deepUpdate(depth: number, tailValue: unknown): Uint8Array {
  const src = new Y.Doc();
  const stories = src.getArray<unknown>("stories");
  src.transact(() => {
    const root = new Y.Map<unknown>();
    root.set("_id", 7);
    root.set("story_id", "deep");
    stories.push([root]);
    let cursor = root;
    for (let d = 0; d < depth; d++) {
      const arr = new Y.Array<unknown>();
      cursor.set("steps", arr);
      const child = new Y.Map<unknown>();
      arr.push([child]);
      child.set("_id", 1000 + d);
      cursor = child;
    }
    const tail = new Y.Array<unknown>();
    cursor.set("steps", tail);
    tail.push([tailValue]);
  });
  return Y.encodeStateAsUpdate(src);
}

/**
 * A document with its roots TYPED, which is what the server holds: a root
 * arrives from a remote update as a bare `AbstractType` until something asks
 * for it by type, and every `instanceof` in both guards depends on the answer.
 */
function guardedDoc() {
  const ydoc = new Y.Doc();
  ydoc.getArray("stories");
  ydoc.getArray("objects");
  ydoc.getMap("config");
  return ydoc;
}

describe("the structural pass at depth", () => {
  it("reaches the bottom of a deeply nested born container", () => {
    const ydoc = guardedDoc();
    let elements = -1;
    let threw: unknown = null;
    ydoc.on("afterTransaction", (tr) => {
      if (tr.origin === null) return;
      try { elements = extractStructuralShapeViolations(ydoc, tr).elements.length; }
      catch (error) { threw = error; }
    });

    Y.applyUpdate(ydoc, deepUpdate(DEEP, null), { user: 2 });

    expect(threw).toBeNull();
    expect(elements).toBe(1);
  }, 60000);

  it("refuses the member it found there, through the whole handler", () => {
    const ydoc = guardedDoc();
    const halts: unknown[] = [];
    const isReverting = { value: false };
    ydoc.on("afterTransaction", makeCanDeleteHandler({
      ydoc,
      isSnapshotting: () => false,
      isReverting: () => isReverting.value,
      setReverting: (v: boolean) => { isReverting.value = v; },
      getSockets: () => [] as unknown as Iterable<WebSocket>,
      broadcastUpdate: () => { /* not under test */ },
      recordViolation: makeViolationCounter(),
      warn: () => { /* asserted through the document */ },
      onEnforcementFailure: (detail) => { halts.push(detail); },
    }));

    Y.applyUpdate(ydoc, deepUpdate(DEEP, null), fakeSocket(2, "collaborator"));

    // Walk to the bottom and check nothing non-map stands in the last array.
    let node = ydoc.getArray<unknown>("stories").get(0) as Y.Map<unknown> | undefined;
    let reached = 0;
    let intruder: unknown = "none";
    while (node) {
      const steps = node.get("steps");
      if (!(steps instanceof Y.Array)) break;
      const first = steps.get(0);
      if (first instanceof Y.Map) { node = first; reached++; continue; }
      if (steps.length > 0) intruder = first;
      break;
    }
    expect(reached).toBe(DEEP);
    expect(intruder).toBe("none");
    expect(halts).toEqual([]);
  }, 60000);
});

describe("the identity pass at depth", () => {
  it("reaches a forged row id at the bottom", () => {
    const ydoc = guardedDoc();
    let removals = -1;
    let threw: unknown = null;
    ydoc.on("afterTransaction", (tr) => {
      if (tr.origin === null) return;
      try { removals = extractIdentityDomainViolations(ydoc, tr).removals.length; }
      catch (error) { threw = error; }
    });

    // A born step whose `_id` is a string names no row the DO minted.
    const src = new Y.Doc();
    const update = (() => {
      const stories = src.getArray<unknown>("stories");
      src.transact(() => {
        const root = new Y.Map<unknown>();
        root.set("_id", 7);
        root.set("story_id", "deep");
        stories.push([root]);
        let cursor = root;
        for (let d = 0; d < DEEP; d++) {
          const arr = new Y.Array<unknown>();
          cursor.set("steps", arr);
          const child = new Y.Map<unknown>();
          arr.push([child]);
          child.set("_id", d === DEEP - 1 ? "not-a-row-id" : 1000 + d);
          cursor = child;
        }
      });
      return Y.encodeStateAsUpdate(src);
    })();

    Y.applyUpdate(ydoc, update, { user: 2 });

    expect(threw).toBeNull();
    expect(removals).toBe(1);
  }, 60000);
});

describe("a shallow control, so a broken descent is distinguishable", () => {
  it("finds the same member three levels down", () => {
    const ydoc = guardedDoc();
    let elements = -1;
    ydoc.on("afterTransaction", (tr) => {
      if (tr.origin === null) return;
      elements = extractStructuralShapeViolations(ydoc, tr).elements.length;
    });

    Y.applyUpdate(ydoc, deepUpdate(3, null), { user: 2 });

    expect(elements).toBe(1);
  });
});
