/**
 * When a collaborator's awareness entry counts as gone.
 *
 * y-protocols removes a remote entry 30 seconds after it was last updated,
 * and a client renews its own entry every 15 seconds. A hidden tab's timers
 * are throttled (Chrome to about once a minute), so a collaborator whose tab
 * is in the background renews too rarely, and every other client removed and
 * re-added them at each renewal. So a client says in its entry whether its
 * page is hidden, and an entry that says so is kept for five minutes.
 *
 * The entry is removed sooner by the server, which relays the removal when the
 * socket that owns it closes. The limit decides only for a socket that fails
 * without a close the server sees. That is also why it is five minutes rather
 * than none: a hidden collaborator whose connection died silently leaves
 * everyone else's list after five minutes, not never.
 *
 * `watchPresenceExpiry` replaces the library's interval on the client. It
 * clears the private `_checkInterval`, as the worker's awareness also does;
 * y-protocols is pinned. The worker applies the same rule, through
 * `sweepOutdatedPresence`, to the entries it sends a new socket and to those
 * it rebuilds on a wake.
 *
 * @version v1.5.0-beta
 */

import * as awarenessProtocol from "y-protocols/awareness";

/** The library's limit, for an entry that does not say its page is hidden. */
export const VISIBLE_PRESENCE_LIMIT_MS = awarenessProtocol.outdatedTimeout;

/** The limit for an entry whose page is hidden. */
export const HIDDEN_PRESENCE_LIMIT_MS = 5 * 60_000;

/** How often the client checks, as the library checks. */
const POLL_MS = awarenessProtocol.outdatedTimeout / 10;

/** How long an entry may go without an update before it counts as gone. */
export function presenceLimit(state: unknown): number {
  const hidden = typeof state === "object" && state !== null && (state as { hidden?: unknown }).hidden === true;
  return hidden ? HIDDEN_PRESENCE_LIMIT_MS : VISIBLE_PRESENCE_LIMIT_MS;
}

/**
 * Remove every remote entry past its limit at `now`, with the origin the
 * library's own removal uses. The awareness's own entry is never removed.
 */
export function sweepOutdatedPresence(awareness: awarenessProtocol.Awareness, now: number): void {
  const outdated: number[] = [];
  awareness.meta.forEach((meta, clientId) => {
    if (clientId === awareness.clientID) return;
    const state = awareness.states.get(clientId);
    if (state === undefined) return;
    if (presenceLimit(state) <= now - meta.lastUpdated) outdated.push(clientId);
  });
  if (outdated.length > 0) awarenessProtocol.removeAwarenessStates(awareness, outdated, "timeout");
}

/** The page's visibility: `document` in the browser. */
export interface PresencePage {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Replace `awareness`'s interval with one that keeps a hidden collaborator's
 * entry for `HIDDEN_PRESENCE_LIMIT_MS`, and keep this client's own `hidden`
 * field in step with `page`. Returns the function that stops it.
 *
 * `now` must be the clock the library stamps `lastUpdated` with, which is
 * `Date.now`; it is a parameter so the tests can say so.
 */
export function watchPresenceExpiry(
  awareness: awarenessProtocol.Awareness,
  page: PresencePage,
  now: () => number = Date.now,
): () => void {
  clearInterval((awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);

  // Sent from the event itself, before the browser throttles the page.
  const publishVisibility = () => awareness.setLocalStateField("hidden", page.hidden);
  publishVisibility();

  const check = setInterval(() => {
    const t = now();
    const own = awareness.meta.get(awareness.clientID);
    // As the library: renew the own entry halfway to the visible limit.
    if (awareness.getLocalState() !== null && own !== undefined && VISIBLE_PRESENCE_LIMIT_MS / 2 <= t - own.lastUpdated) {
      awareness.setLocalState(awareness.getLocalState());
    }
    sweepOutdatedPresence(awareness, t);
  }, POLL_MS);

  page.addEventListener("visibilitychange", publishVisibility);

  return () => {
    clearInterval(check);
    page.removeEventListener("visibilitychange", publishVisibility);
  };
}
