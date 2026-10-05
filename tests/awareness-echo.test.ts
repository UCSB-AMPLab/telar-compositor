/**
 * The collaboration object answers a socket with its own awareness entry, so
 * y-websocket's 30-second silence check sees traffic for an editor alone in a
 * project. That is only safe while no echo a client can receive changes
 * anything for it. These cases pin that against the installed y-protocols and
 * y-websocket.
 *
 * A renewal comes back at the clock it was sent with, or at an older one if the
 * client has renewed since; y-protocols applies neither.
 *
 * The removal is the exception. `disconnect()` sends the client's own entry as
 * null at its current clock while its local state is still set, and applying
 * that back would bump the clock and re-announce the client. It can never be
 * applied: the same call closes the socket before returning, and a browser
 * WebSocket dispatches no message once `close()` has been called (a received
 * message is delivered only while the socket is OPEN). The last case holds
 * y-websocket to that order.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import { WebsocketProvider } from "y-websocket";

/** A client's awareness with every change and update it emits recorded. */
function client() {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc());
  // The renewal timer is irrelevant here and would hold the process open.
  clearInterval((awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
  const events: string[] = [];
  awareness.on("change", () => events.push("change"));
  awareness.on("update", () => events.push("update"));
  return { awareness, events };
}

/** What the client sent for its own entry, as the object relays it. */
function sent(awareness: awarenessProtocol.Awareness): Uint8Array {
  return awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]);
}

/**
 * A WebSocket that records what the provider does to it, in order. It never
 * delivers anything: the case below is about what the provider sends and
 * when it closes.
 */
class RecordingSocket {
  static readonly log: Array<{ op: "send"; frame: Uint8Array } | { op: "close" }> = [];
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readyState = 1;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  static last: RecordingSocket | null = null;
  constructor() {
    RecordingSocket.last = this;
  }
  send(frame: Uint8Array) {
    RecordingSocket.log.push({ op: "send", frame: new Uint8Array(frame) });
  }
  close() {
    this.readyState = this.CLOSING;
    RecordingSocket.log.push({ op: "close" });
  }
}

describe("an echoed own awareness entry", () => {
  it("changes nothing when it is the entry the client holds", () => {
    const { awareness, events } = client();
    awareness.setLocalState({ user: { name: "a" } });
    const echo = sent(awareness);
    const clock = awareness.meta.get(awareness.clientID)!.clock;
    events.length = 0;

    awarenessProtocol.applyAwarenessUpdate(awareness, echo, "server");

    expect(events).toEqual([]);
    expect(awareness.getLocalState()).toEqual({ user: { name: "a" } });
    expect(awareness.meta.get(awareness.clientID)!.clock).toBe(clock);
  });

  it("changes nothing when the client has renewed since sending it", () => {
    const { awareness, events } = client();
    awareness.setLocalState({ user: { name: "a" } });
    const echo = sent(awareness);
    awareness.setLocalState({ user: { name: "a" }, cursor: 1 });
    const clock = awareness.meta.get(awareness.clientID)!.clock;
    events.length = 0;

    awarenessProtocol.applyAwarenessUpdate(awareness, echo, "server");

    expect(events).toEqual([]);
    expect(awareness.getLocalState()).toEqual({ user: { name: "a" }, cursor: 1 });
    expect(awareness.meta.get(awareness.clientID)!.clock).toBe(clock);
  });

  it("cannot reach the client for the removal disconnect() sends, which closes the socket in the same call", () => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider("ws://harness", "ws/1", doc, {
      WebSocketPolyfill: RecordingSocket as unknown as typeof WebSocket,
      disableBc: true,
    });
    try {
      RecordingSocket.last!.onopen!();
      provider.awareness.setLocalState({ user: { name: "a" } });
      const clock = provider.awareness.meta.get(doc.clientID)!.clock;
      RecordingSocket.log.length = 0;

      provider.disconnect();

      // Sent, then closed, within the one synchronous call: no message from
      // the network can be delivered to the socket between the two.
      expect(RecordingSocket.log.map((entry) => entry.op)).toEqual(["send", "close"]);

      // And what was sent is the removal that would not be a no-op: the
      // client's own entry, null, at the clock it still holds with its local
      // state set.
      const frame = (RecordingSocket.log[0] as { frame: Uint8Array }).frame;
      const decoder = decoding.createDecoder(frame);
      decoding.readVarUint(decoder); // message type
      const update = decoding.readVarUint8Array(decoder);
      const entries = decoding.createDecoder(update);
      expect(decoding.readVarUint(entries)).toBe(1);
      expect(decoding.readVarUint(entries)).toBe(doc.clientID);
      expect(decoding.readVarUint(entries)).toBe(clock);
      expect(JSON.parse(decoding.readVarString(entries))).toBeNull();
      expect(provider.awareness.getLocalState()).toEqual({ user: { name: "a" } });

      const probe = client();
      (probe.awareness as unknown as { clientID: number }).clientID = doc.clientID;
      probe.awareness.setLocalState({ user: { name: "a" } });
      probe.awareness.meta.get(doc.clientID)!.clock = clock;
      probe.events.length = 0;
      awarenessProtocol.applyAwarenessUpdate(probe.awareness, update, "server");
      expect(probe.events).toEqual(["change", "update"]);
    } finally {
      provider.destroy();
      doc.destroy();
    }
  });
});
