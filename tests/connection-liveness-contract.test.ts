/**
 * The liveness check against the real y-websocket. The check
 * replaces the provider's own `_checkInterval`, reads `wsLastMessageReceived`,
 * and closes through the socket's `onclose`, which is y-websocket's internal
 * `closeWebsocketConnection`. None of that is public API, so these cases hold
 * the installed release to the behaviour the check depends on, not only to
 * the field names: an upgrade that keeps the names and changes what they do
 * fails here. `tests/y-websocket-slot-pin.test.ts` refuses an unreviewed
 * version bump.
 *
 * lib0 takes its clock from `Date.now` when it is first imported, so the fake
 * clock is installed before y-websocket is.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type * as YWebsocket from "y-websocket";
import type * as YType from "yjs";

import type { LivenessPage } from "~/lib/connection-liveness";

let ywebsocket: typeof YWebsocket;
let Y: typeof YType;
let watchLiveness: typeof import("~/lib/connection-liveness").watchLiveness;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.resetModules();
  ywebsocket = await import("y-websocket");
  Y = await import("yjs");
  ({ watchLiveness } = await import("~/lib/connection-liveness"));
});
afterAll(() => {
  vi.useRealTimers();
});

/** A socket the test opens and feeds; records what the provider does to it. */
class ScriptedSocket {
  static readonly sockets: ScriptedSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  binaryType = "arraybuffer";
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    ScriptedSocket.sockets.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** An awareness frame with no entries: harmless to apply, and still a message received. */
  deliver() {
    this.onmessage?.({ data: new Uint8Array([1, 1, 0]).buffer });
  }
  send() {}
  close() {
    this.closeCalls++;
    this.readyState = 3;
  }
}

function page(hidden: boolean): LivenessPage & { hidden: boolean } {
  return { hidden, addEventListener() {}, removeEventListener() {} };
}

function makeProvider() {
  ScriptedSocket.sockets.length = 0;
  const doc = new Y.Doc();
  const provider = new ywebsocket.WebsocketProvider("ws://harness", "room", doc, {
    WebSocketPolyfill: ScriptedSocket as unknown as typeof WebSocket,
    disableBc: true,
  });
  ScriptedSocket.sockets[0].open();
  return {
    provider,
    first: ScriptedSocket.sockets[0],
    cleanup() {
      provider.destroy();
      doc.destroy();
    },
  };
}

describe("y-websocket as the liveness check relies on it", () => {
  it("advances wsLastMessageReceived on every message it receives", () => {
    const { provider, first, cleanup } = makeProvider();
    vi.advanceTimersByTime(10_000);
    const before = provider.wsLastMessageReceived;
    first.deliver();
    expect(provider.wsLastMessageReceived).toBe(before + 10_000);
    cleanup();
  });

  it("reconnects on its own after 30 silent seconds when the check is not installed", () => {
    const { first, cleanup } = makeProvider();
    vi.advanceTimersByTime(34_000);
    expect(first.closeCalls).toBeGreaterThan(0);
    expect(ScriptedSocket.sockets.length).toBe(2);
    cleanup();
  });

  it("no longer reconnects after 30 silent seconds while hidden, once the check is installed", () => {
    const { provider, first, cleanup } = makeProvider();
    const stop = watchLiveness(provider, page(true));
    vi.advanceTimersByTime(10 * 60_000);
    expect(first.closeCalls).toBe(0);
    expect(ScriptedSocket.sockets.length).toBe(1);
    stop();
    cleanup();
  });

  it("closes and reconnects a visible connection through the check, and a message postpones it", () => {
    const { provider, first, cleanup } = makeProvider();
    const stop = watchLiveness(provider, page(false));
    vi.advanceTimersByTime(20_000);
    first.deliver();
    vi.advanceTimersByTime(20_000);
    expect(first.closeCalls).toBe(0);

    vi.advanceTimersByTime(15_000);
    expect(first.closeCalls).toBe(1);
    expect(provider.ws).not.toBe(first);
    vi.advanceTimersByTime(1_000);
    expect(ScriptedSocket.sockets.length).toBe(2);
    stop();
    cleanup();
  });

  it("ignores a late close event from the socket it has already replaced", () => {
    const { provider, first, cleanup } = makeProvider();
    const stop = watchLiveness(provider, page(false));
    vi.advanceTimersByTime(34_000);
    vi.advanceTimersByTime(1_000);
    const second = ScriptedSocket.sockets[1];
    second.open();
    expect(provider.ws).toBe(second);

    first.onclose?.({ code: 1000 });
    vi.advanceTimersByTime(1_000);
    expect(provider.ws).toBe(second);
    expect(ScriptedSocket.sockets.length).toBe(2);
    stop();
    cleanup();
  });

  it("does not reconnect a provider that disconnect() has stopped", () => {
    const { provider, cleanup } = makeProvider();
    const stop = watchLiveness(provider, page(false));
    provider.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(ScriptedSocket.sockets.length).toBe(1);
    expect(provider.ws).toBeNull();
    stop();
    cleanup();
  });
});
