/**
 * The collaboration socket's liveness check, in place of y-websocket's own.
 *
 * y-websocket declares a connection dead once 30 seconds pass with nothing
 * received, polling every 3 seconds. An editor alone in a project receives
 * only the echo of their own 15-second awareness renewal, and in a hidden tab
 * the browser throttles that renewal (Chrome to about once a minute; Firefox
 * on Android and Safari on iOS much longer, or not at all while the page is
 * suspended). The echo then arrives too rarely, and a tab nobody is looking
 * at reconnects over and over, each time as a fresh admission.
 *
 * So silence is judged only while the page is visible, by y-websocket's own
 * rule. While it is hidden, silence closes nothing: a close the browser
 * reports still reconnects through the socket's `onclose`, and a connection
 * that fails without one is found at the first check more than 30 seconds
 * after the page becomes visible again, normally by 33. No timer could find it sooner in a page the browser has
 * stopped running.
 *
 * This reaches into y-websocket: it clears `_checkInterval`, reads
 * `wsLastMessageReceived`, and closes by calling the socket's `onclose`,
 * which is y-websocket's `closeWebsocketConnection`. The behaviour it relies
 * on is pinned in `tests/connection-liveness-contract.test.ts`.
 *
 * @version v1.5.0-beta
 */

import type { WebsocketProvider } from "y-websocket";

/** y-websocket's limit: a connection silent for longer than this is dead. */
const SILENCE_LIMIT_MS = 30_000;

/** How often silence is checked, as y-websocket checks it. */
const POLL_MS = SILENCE_LIMIT_MS / 10;

/** The page's visibility: `document` in the browser. */
export interface LivenessPage {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

type WatchedProvider = Pick<WebsocketProvider, "ws" | "wsconnected" | "wsLastMessageReceived" | "_checkInterval"> & {
  awareness: Pick<WebsocketProvider["awareness"], "getLocalState" | "setLocalState">;
};

/**
 * Replace `provider`'s liveness check with one that judges silence only while
 * `page` is visible. Returns the function that stops it; call it before the
 * provider is disconnected or destroyed.
 */
export function watchLiveness(
  provider: WatchedProvider,
  page: LivenessPage,
  now: () => number = Date.now,
): () => void {
  clearInterval(provider._checkInterval);

  // Silence is counted from the later of the last message and the moment the
  // page last became visible: time spent hidden is not silence.
  let visibleSince = now();

  const onVisibilityChange = () => {
    if (page.hidden) return;
    visibleSince = now();
    // Ask for an echo now rather than waiting for the next renewal. Setting
    // the same state again bumps its clock and sends it; the state itself is
    // unchanged, so nothing reading presence sees a change.
    const state = provider.awareness.getLocalState();
    if (provider.wsconnected && state !== null) provider.awareness.setLocalState(state);
  };

  const check = setInterval(() => {
    if (page.hidden) return;
    const ws = provider.ws;
    // As y-websocket's own check: a socket still connecting is not judged, and
    // a provider with no socket has been disconnected or is reconnecting.
    if (!provider.wsconnected || ws === null) return;
    if (now() - Math.max(provider.wsLastMessageReceived, visibleSince) > SILENCE_LIMIT_MS) {
      // The socket's onclose is y-websocket's closeWebsocketConnection, which
      // closes the socket and schedules the reconnect; its own timeout passes
      // no event, and neither does this.
      ws.onclose?.(null as unknown as CloseEvent);
    }
  }, POLL_MS);

  page.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    clearInterval(check);
    page.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
