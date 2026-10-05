/**
 * A root type has no type until something asks for one, and both guards
 * recognise a root by `instanceof`.
 *
 * An update encodes a NESTED type's constructor — a `ContentType` carries a
 * type ref — but there is nowhere in the format to record a ROOT's, so a root
 * that arrives through `applyUpdate` sits in the document's `share` map as a
 * bare `AbstractType`. Neither `type instanceof Y.Array` nor
 * `type instanceof Y.Map` answers true for one, so the branch of each pass
 * that reads `tr.changed` for a protected root never runs, and a client insert
 * straight into a root array passes unexamined.
 *
 * Which is nobody's plan. It holds today only because the load path happens to
 * ask for the roots by type on its way past: `backfillOrderKeysEverywhere`
 * takes all four, and `backfillBlobGaps` and `buildFromD1Rows` each take the
 * config root. Nothing said that was load-bearing, and no test could fail if
 * it stopped — every other test in this suite reaches its document through
 * typed accessors, so the untyped state never occurs in one.
 *
 * This file is the statement. The negative case is here on purpose: it is the
 * evidence that `typeProtectedRoots` is doing something, and it is what will
 * fail loudly if the call is ever removed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  makeCanDeleteHandler,
  makeViolationCounter,
  typeProtectedRoots,
} from "../workers/can-delete";

type Role = "convenor" | "collaborator" | "instructor";

function fakeSocket(userId: number, role: Role) {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

/** What the DO stores: a project with one story of two steps. */
function storedBlob(): Uint8Array {
  const doc = new Y.Doc();
  const stories = doc.getArray<unknown>("stories");
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    const one = new Y.Map<unknown>();
    const two = new Y.Map<unknown>();
    one.set("_id", 11);
    two.set("_id", 12);
    steps.push([one]);
    steps.push([two]);
    story.set("_id", 7);
    story.set("story_id", "the-story");
    story.set("steps", steps);
    stories.push([story]);
  });
  return Y.encodeStateAsUpdate(doc);
}

/**
 * A client's insert straight into the root array: a whole story, born with a
 * malformed member, and optionally forging the live story's row id.
 */
function rootInsert(blob: Uint8Array, id: unknown): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, blob);
  const before = Y.encodeStateVector(client);
  client.transact(() => {
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    steps.push([null]);
    story.set("_id", id);
    story.set("story_id", "the-twin");
    story.set("steps", steps);
    client.getArray<unknown>("stories").push([story]);
  });
  return Y.encodeStateAsUpdate(client, before);
}

function attachGuard(ydoc: Y.Doc) {
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
  }));
}

function rootConstructorName(ydoc: Y.Doc, name: string): string {
  const share = (ydoc as unknown as { share: Map<string, unknown> }).share;
  return (share.get(name) as object).constructor.name;
}

function storyCount(ydoc: Y.Doc): number {
  return ydoc.getArray<unknown>("stories").length;
}

function twinSteps(ydoc: Y.Doc): unknown {
  const twin = ydoc.getArray<unknown>("stories").get(1) as Y.Map<unknown> | undefined;
  if (!twin) return "no twin";
  const steps = twin.get("steps");
  if (!(steps instanceof Y.Array)) return `NOT AN ARRAY: ${JSON.stringify(steps)}`;
  return steps.toArray().map((s) =>
    s instanceof Y.Map ? s.get("_id") : `NOT A MAP: ${JSON.stringify(s)}`);
}

describe("a document loaded the way the Durable Object loads one", () => {
  it("leaves its roots untyped until asked", () => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, storedBlob());

    expect(rootConstructorName(ydoc, "stories")).toBe("AbstractType");
  });

  it("types them, without creating one that was absent", () => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, storedBlob());

    typeProtectedRoots(ydoc);

    expect(rootConstructorName(ydoc, "stories")).toBe("YArray");
    // The blob carried no config root, and asking for one would create it.
    const share = (ydoc as unknown as { share: Map<string, unknown> }).share;
    expect(share.has("config")).toBe(false);
  });
});

describe("with the roots typed, a root insert is examined", () => {
  it("refuses a malformed member inside a born story", () => {
    const blob = storedBlob();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, blob);
    typeProtectedRoots(ydoc);
    attachGuard(ydoc);

    Y.applyUpdate(ydoc, rootInsert(blob, 8), fakeSocket(2, "collaborator"));

    expect(twinSteps(ydoc)).toEqual([]);
  });

  it("removes a born story forging a live story's row id", () => {
    const blob = storedBlob();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, blob);
    typeProtectedRoots(ydoc);
    attachGuard(ydoc);

    Y.applyUpdate(ydoc, rootInsert(blob, 7), fakeSocket(2, "collaborator"));

    expect(storyCount(ydoc)).toBe(1);
  });
});

describe("without them, it is not — which is why the call exists", () => {
  it("admits the malformed member in silence", () => {
    const blob = storedBlob();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, blob);
    attachGuard(ydoc);

    Y.applyUpdate(ydoc, rootInsert(blob, 8), fakeSocket(2, "collaborator"));

    expect(twinSteps(ydoc)).toEqual(["NOT A MAP: null"]);
  });

  it("admits the forged row id in silence", () => {
    const blob = storedBlob();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, blob);
    attachGuard(ydoc);

    Y.applyUpdate(ydoc, rootInsert(blob, 7), fakeSocket(2, "collaborator"));

    expect(storyCount(ydoc)).toBe(2);
  });
});
