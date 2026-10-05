/**
 * Which entries of an awareness update a socket may set.
 *
 * The filter works on the encoded update y-protocols produces, so these cases
 * build updates with the real encoder where they can: a hand-rolled encoding
 * that agreed with the filter would prove nothing about what a browser sends.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";

import {
  firstAwarenessClientId,
  ownAwarenessEntries,
  parseAwarenessClientId,
} from "../workers/awareness-ownership";

const made: awarenessProtocol.Awareness[] = [];
function client(state: Record<string, unknown>): awarenessProtocol.Awareness {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc());
  awareness.setLocalState(state);
  made.push(awareness);
  return awareness;
}
afterEach(() => {
  for (const awareness of made.splice(0)) awareness.destroy();
});

/** An update carrying every state `holder` knows, as y-websocket answers a query with. */
function everything(holder: awarenessProtocol.Awareness): Uint8Array {
  return awarenessProtocol.encodeAwarenessUpdate(holder, [...holder.getStates().keys()]);
}

describe("an update's own entries", () => {
  it("keep only the entry naming the given client, and apply as that client's state", () => {
    const a = client({ user: "a" });
    const b = client({ user: "b" });
    awarenessProtocol.applyAwarenessUpdate(b, everything(a), "test");
    const mixed = everything(b);

    const own = ownAwarenessEntries(mixed, b.clientID);
    expect(own).not.toBeNull();

    const server = client({});
    awarenessProtocol.applyAwarenessUpdate(server, own!, "test");
    expect(server.getStates().get(b.clientID)).toEqual({ user: "b" });
    expect(server.getStates().has(a.clientID)).toBe(false);
  });

  it("are none when the update names only other clients", () => {
    const a = client({ user: "a" });
    expect(ownAwarenessEntries(everything(a), a.clientID + 1)).toBeNull();
  });

  it("keep a removal of the client's own state", () => {
    const a = client({ user: "a" });
    awarenessProtocol.removeAwarenessStates(a, [a.clientID], "test");
    const removal = awarenessProtocol.encodeAwarenessUpdate(a, [a.clientID]);
    expect(ownAwarenessEntries(removal, a.clientID)).toEqual(removal);
  });

  it("are none for an update that will not decode", () => {
    expect(ownAwarenessEntries(new Uint8Array([5, 1]), 1)).toBeNull();
    expect(firstAwarenessClientId(new Uint8Array([5, 1]))).toBeNull();
  });

  it("start from the first entry's client", () => {
    const a = client({ user: "a" });
    expect(firstAwarenessClientId(awarenessProtocol.encodeAwarenessUpdate(a, [a.clientID]))).toBe(a.clientID);
  });
});

describe("a declared client id", () => {
  it.each([
    ["0", 0],
    ["4294967295", 4294967295],
    ["123", 123],
  ])("accepts %s", (raw, id) => {
    expect(parseAwarenessClientId(raw)).toBe(id);
  });

  it.each([null, "", "-1", "01", "1.5", "4294967296", "undefined", "12a"])("refuses %s", (raw) => {
    expect(parseAwarenessClientId(raw)).toBeNull();
  });
});
