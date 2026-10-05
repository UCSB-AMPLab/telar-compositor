/**
 * What a tab's closing socket does to the same browser's other tabs.
 *
 * When a socket closes, y-websocket removes every remote awareness entry the
 * tab holds and publishes the removal; the socket is already gone, so only
 * BroadcastChannel carries it, and the sibling tabs drop every collaborator
 * until each one's next renewal. These cases run two real providers in one
 * process, where lib0's BroadcastChannel reaches same-process subscribers: with the channel on,
 * the sibling loses the collaborator; with it off, as the Compositor builds its
 * provider (`app/hooks/use-collaboration.tsx`), it keeps them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";

const providers: WebsocketProvider[] = [];

afterEach(() => {
  for (const p of providers.splice(0)) p.destroy();
});

/** A tab: a provider that opens no socket, with its BroadcastChannel as configured. */
function tab(room: string, disableBc: boolean): WebsocketProvider {
  const provider = new WebsocketProvider("ws://localhost:1", room, new Y.Doc(), {
    connect: false,
    disableBc,
  });
  provider.connectBc();
  providers.push(provider);
  return provider;
}

/** A collaborator in another browser, known to both tabs. */
function collaboratorKnownTo(...tabs: WebsocketProvider[]): number {
  const other = new awarenessProtocol.Awareness(new Y.Doc());
  other.setLocalState({ user: { name: "Other" } });
  const update = awarenessProtocol.encodeAwarenessUpdate(other, [other.clientID]);
  for (const t of tabs) awarenessProtocol.applyAwarenessUpdate(t.awareness, update, "server");
  const id = other.clientID;
  other.destroy();
  return id;
}

/** What y-websocket's closeWebsocketConnection does to the closing tab's awareness. */
function closeSocket(closing: WebsocketProvider): void {
  const remote = Array.from(closing.awareness.getStates().keys())
    .filter((id) => id !== closing.doc.clientID);
  awarenessProtocol.removeAwarenessStates(closing.awareness, remote, closing);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("a tab whose socket closes", () => {
  it("takes every collaborator from its sibling tab when BroadcastChannel is on", async () => {
    const room = `ws/bc-on-${Math.random()}`;
    const closing = tab(room, false);
    const sibling = tab(room, false);
    const other = collaboratorKnownTo(closing, sibling);

    closeSocket(closing);
    await settle();

    expect(sibling.awareness.getStates().has(other)).toBe(false);
  });

  it("leaves its sibling tab's collaborators alone with BroadcastChannel off", async () => {
    const room = `ws/bc-off-${Math.random()}`;
    const closing = tab(room, true);
    const sibling = tab(room, true);
    const other = collaboratorKnownTo(closing, sibling);

    closeSocket(closing);
    await settle();

    expect(sibling.awareness.getStates().has(other)).toBe(true);
  });
});
