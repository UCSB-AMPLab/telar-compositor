/**
 * The collaboration socket's liveness check. y-websocket declares a
 * connection dead after 30 silent seconds; in a hidden tab the browser
 * throttles the client's own renewal, so that check reconnected a tab nobody
 * was looking at every couple of minutes. The replacement judges silence
 * only while the page is visible.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { watchLiveness, type LivenessPage } from "~/lib/connection-liveness";

/** A page whose visibility the test sets. */
function fakePage(hidden = false) {
  const listeners = new Set<() => void>();
  const page = {
    hidden,
    addEventListener: vi.fn((_type: "visibilitychange", listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: "visibilitychange", listener: () => void) => listeners.delete(listener)),
  };
  return {
    page: page as LivenessPage,
    listeners,
    setHidden(value: boolean) {
      page.hidden = value;
      for (const listener of listeners) listener();
    },
  };
}

/** The provider fields the check reads, with a socket whose close handler is recorded. */
function fakeProvider(clock: { t: number }) {
  // As y-websocket's closeWebsocketConnection: the provider lets go of the socket.
  const onclose = vi.fn(() => {
    provider.ws = null;
  });
  const localState: { value: Record<string, unknown> | null } = { value: { user: { name: "a" } } };
  const provider: {
    wsconnected: boolean;
    wsLastMessageReceived: number;
    ws: WebSocket | null;
    _checkInterval: ReturnType<typeof setInterval>;
    awareness: {
      getLocalState: () => Record<string, unknown> | null;
      setLocalState: (value: Record<string, unknown> | null) => void;
    };
  } = {
    wsconnected: true,
    wsLastMessageReceived: clock.t,
    ws: { onclose } as unknown as WebSocket | null,
    _checkInterval: setInterval(() => {}, 3000),
    awareness: {
      getLocalState: vi.fn(() => localState.value),
      setLocalState: vi.fn((value: Record<string, unknown> | null) => {
        localState.value = value;
      }),
    },
  };
  return { provider, onclose, localState };
}

describe("watchLiveness", () => {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  /** Advance the clock and the interval together, in 1-second steps. */
  function advance(ms: number) {
    for (let i = 0; i < ms / 1000; i++) {
      clock.t += 1000;
      vi.advanceTimersByTime(1000);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clock.t = 1_000_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears y-websocket's own check", () => {
    const { provider } = fakeProvider(clock);
    const clear = vi.spyOn(globalThis, "clearInterval");
    const native = provider._checkInterval;
    const stop = watchLiveness(provider, fakePage().page, now);
    expect(clear).toHaveBeenCalledWith(native);
    stop();
  });

  it("closes nothing while the page is hidden, however long it is silent", () => {
    const { provider, onclose } = fakeProvider(clock);
    const stop = watchLiveness(provider, fakePage(true).page, now);
    advance(10 * 60_000);
    expect(onclose).not.toHaveBeenCalled();
    stop();
  });

  it("closes a visible connection silent for more than 30 seconds, and not before", () => {
    const { provider, onclose } = fakeProvider(clock);
    const stop = watchLiveness(provider, fakePage().page, now);
    advance(30_000);
    expect(onclose).not.toHaveBeenCalled();
    advance(3_000);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledWith(null);
    stop();
  });

  it("counts silence from the last message", () => {
    const { provider, onclose } = fakeProvider(clock);
    const stop = watchLiveness(provider, fakePage().page, now);
    advance(20_000);
    provider.wsLastMessageReceived = clock.t;
    advance(20_000);
    expect(onclose).not.toHaveBeenCalled();
    advance(15_000);
    expect(onclose).toHaveBeenCalledTimes(1);
    stop();
  });

  it("restarts the clock and renews awareness when the page becomes visible again", () => {
    const { provider, onclose } = fakeProvider(clock);
    const { page, setHidden } = fakePage(true);
    const stop = watchLiveness(provider, page, now);
    advance(5 * 60_000);

    setHidden(false);
    expect(provider.awareness.setLocalState).toHaveBeenCalledWith({ user: { name: "a" } });
    // Silence counts from the return, not from the last message: still open
    // at 30 visible seconds, when the poll finds exactly 30 and not more.
    advance(30_000);
    expect(onclose).not.toHaveBeenCalled();

    // No echo arrives: dead at the first poll past 30 visible seconds.
    advance(3_000);
    expect(onclose).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not renew when there is no local state, or no connection to send it on", () => {
    const { provider, localState } = fakeProvider(clock);
    const { page, setHidden } = fakePage(true);
    const stop = watchLiveness(provider, page, now);

    localState.value = null;
    setHidden(false);
    setHidden(true);
    localState.value = { user: { name: "a" } };
    provider.wsconnected = false;
    setHidden(false);

    expect(provider.awareness.setLocalState).not.toHaveBeenCalled();
    stop();
  });

  it("never closes a socket that is still connecting, or a provider with no socket", () => {
    const { provider, onclose } = fakeProvider(clock);
    const stop = watchLiveness(provider, fakePage().page, now);
    provider.wsconnected = false;
    advance(60_000);
    provider.wsconnected = true;
    provider.ws = null;
    advance(60_000);
    expect(onclose).not.toHaveBeenCalled();
    stop();
  });

  it("stops checking and listening once stopped", () => {
    const { provider, onclose } = fakeProvider(clock);
    const { page, listeners } = fakePage();
    const stop = watchLiveness(provider, page, now);
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
    advance(60_000);
    expect(onclose).not.toHaveBeenCalled();
  });
});
