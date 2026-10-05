/**
 * When a collaborator's awareness entry counts as gone. A hidden
 * tab renews its entry about once a minute, and the library removes a remote
 * entry after 30 seconds, so every other client dropped and re-added a
 * collaborator whose tab was in the background. An entry that says its page
 * is hidden is kept for five minutes.
 *
 * These run on the real y-protocols `Awareness`. lib0 takes its clock from
 * `Date.now` when it is first imported and stamps `lastUpdated` with it, so
 * the fake clock is installed before y-protocols is.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import type * as AwarenessModule from "y-protocols/awareness";
import type * as YType from "yjs";

import type { PresencePage } from "~/lib/presence-expiry";

let awarenessProtocol: typeof AwarenessModule;
let Y: typeof YType;
let expiry: typeof import("~/lib/presence-expiry");

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.resetModules();
  awarenessProtocol = await import("y-protocols/awareness");
  Y = await import("yjs");
  expiry = await import("~/lib/presence-expiry");
});
afterAll(() => {
  vi.useRealTimers();
});

/** A page whose visibility the test sets. */
function fakePage(hidden = false) {
  const listeners = new Set<() => void>();
  const page = {
    hidden,
    addEventListener: vi.fn((_type: "visibilitychange", listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: "visibilitychange", listener: () => void) => listeners.delete(listener)),
  };
  return {
    page: page as PresencePage,
    listeners,
    setHidden(value: boolean) {
      page.hidden = value;
      for (const listener of listeners) listener();
    },
  };
}

const created: AwarenessModule.Awareness[] = [];
afterEach(() => {
  for (const a of created.splice(0)) a.destroy();
});

/** A reader, and a collaborator whose updates the test delivers to it by hand. */
function pair() {
  const reader = new awarenessProtocol.Awareness(new Y.Doc());
  const writer = new awarenessProtocol.Awareness(new Y.Doc());
  created.push(reader, writer);
  // The writer's own timer stands for the hidden tab's throttled one: the
  // test renews it when the browser would.
  clearInterval((writer as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
  const deliver = () =>
    awarenessProtocol.applyAwarenessUpdate(
      reader,
      awarenessProtocol.encodeAwarenessUpdate(writer, [writer.clientID]),
      "remote",
    );
  const removals: number[] = [];
  reader.on("update", ({ removed }: { removed: number[] }) => removals.push(...removed));
  return { reader, writer, deliver, removals };
}

/** Advance the clock in 1-second steps, running `each` after every step. */
function advance(ms: number, each?: (elapsed: number) => void) {
  for (let elapsed = 1000; elapsed <= ms; elapsed += 1000) {
    vi.advanceTimersByTime(1000);
    each?.(elapsed);
  }
}

describe("a hidden collaborator's entry", () => {
  it("is removed between minute-spaced renewals by the library's own expiry", () => {
    // The defect, so the next case is known to tell the two apart.
    const { writer, deliver, removals } = pair();
    writer.setLocalState({ user: { name: "w" }, hidden: true });
    deliver();
    advance(180_000, (t) => {
      if (t % 60_000 === 0) {
        writer.setLocalState(writer.getLocalState());
        deliver();
      }
    });
    expect(removals).toContain(writer.clientID);
  });

  it("is kept through minute-spaced renewals", () => {
    const { reader, writer, deliver, removals } = pair();
    const stop = expiry.watchPresenceExpiry(reader, fakePage().page);
    writer.setLocalState({ user: { name: "w" }, hidden: true });
    deliver();
    advance(600_000, (t) => {
      if (t % 60_000 === 0) {
        writer.setLocalState(writer.getLocalState());
        deliver();
      }
    });
    expect(removals).toEqual([]);
    expect(reader.getStates().get(writer.clientID)).toEqual({ user: { name: "w" }, hidden: true });
    stop();
  });

  it("is removed at the first check past five minutes of silence, not before", () => {
    const { reader, writer, deliver, removals } = pair();
    const stop = expiry.watchPresenceExpiry(reader, fakePage().page);
    writer.setLocalState({ user: { name: "w" }, hidden: true });
    deliver();
    // Five minutes, stated here rather than read from the module.
    advance(299_000);
    expect(removals).toEqual([]);
    advance(3000);
    expect(removals).toEqual([writer.clientID]);
    stop();
  });
});

describe("a visible collaborator's entry", () => {
  it("is still removed at the library's 30 seconds", () => {
    const { reader, writer, deliver, removals } = pair();
    const stop = expiry.watchPresenceExpiry(reader, fakePage().page);
    writer.setLocalState({ user: { name: "w" } });
    deliver();
    advance(29_000);
    expect(removals).toEqual([]);
    advance(3000);
    expect(removals).toEqual([writer.clientID]);
    stop();
  });

  it("stops being kept once it no longer says hidden", () => {
    const { reader, writer, deliver, removals } = pair();
    const stop = expiry.watchPresenceExpiry(reader, fakePage().page);
    writer.setLocalState({ user: { name: "w" }, hidden: true });
    deliver();
    advance(10_000);
    writer.setLocalStateField("hidden", false);
    deliver();
    advance(32_000);
    expect(removals).toEqual([writer.clientID]);
    stop();
  });
});

describe("the client's own entry", () => {
  it("says whether the page is hidden, changing once per transition", () => {
    const reader = new awarenessProtocol.Awareness(new Y.Doc());
    created.push(reader);
    const { page, setHidden } = fakePage(true);
    const changes: unknown[] = [];
    reader.on("change", () => changes.push(reader.getLocalState()?.hidden));

    const stop = expiry.watchPresenceExpiry(reader, page);
    expect(reader.getLocalState()).toEqual({ hidden: true });
    setHidden(false);
    setHidden(false);
    setHidden(true);
    expect(changes).toEqual([true, false, true]);
    stop();
  });

  it("keeps every other field it holds through a hide and a show", () => {
    const reader = new awarenessProtocol.Awareness(new Y.Doc());
    created.push(reader);
    const held = { user: { name: "r" }, location: { storyId: "s1" }, building: true, publishSha: "abc" };
    reader.setLocalState(held);
    const { page, setHidden } = fakePage();

    const stop = expiry.watchPresenceExpiry(reader, page);
    expect(reader.getLocalState()).toEqual({ ...held, hidden: false });
    setHidden(true);
    expect(reader.getLocalState()).toEqual({ ...held, hidden: true });
    setHidden(false);
    expect(reader.getLocalState()).toEqual({ ...held, hidden: false });
    stop();
  });

  it("is renewed at 15 seconds, as the library renews it", () => {
    const reader = new awarenessProtocol.Awareness(new Y.Doc());
    created.push(reader);
    const stop = expiry.watchPresenceExpiry(reader, fakePage().page);
    const clock = () => reader.meta.get(reader.clientID)!.clock;
    const start = clock();
    advance(14_000);
    expect(clock()).toBe(start);
    advance(3000);
    expect(clock()).toBe(start + 1);
    stop();
  });
});

describe("stopping", () => {
  it("clears its interval and listener, and leaves the library's interval cleared too", () => {
    const { reader, writer, deliver, removals } = pair();
    const { page, listeners } = fakePage();
    const stop = expiry.watchPresenceExpiry(reader, page);
    stop();
    expect(listeners.size).toBe(0);

    writer.setLocalState({ user: { name: "w" } });
    deliver();
    const clock = reader.meta.get(reader.clientID)!.clock;
    advance(120_000);
    // Neither interval ran: no expiry, and no renewal of the own entry.
    expect(removals).toEqual([]);
    expect(reader.meta.get(reader.clientID)!.clock).toBe(clock);
  });
});

describe("presenceLimit", () => {
  it("is five minutes only for an entry that says hidden: true", () => {
    expect(expiry.presenceLimit({ hidden: true })).toBe(300_000);
    expect(expiry.presenceLimit({ hidden: "true" })).toBe(expiry.VISIBLE_PRESENCE_LIMIT_MS);
    expect(expiry.presenceLimit({})).toBe(expiry.VISIBLE_PRESENCE_LIMIT_MS);
    expect(expiry.presenceLimit(null)).toBe(expiry.VISIBLE_PRESENCE_LIMIT_MS);
  });
});
