// @vitest-environment jsdom
/**
 * y-websocket-slot-pin.test.ts — version-lock + install-path pins for the
 * session-control handler override in use-collaboration.tsx.
 *
 * The override replaces y-websocket's reserved `messageAuth` handler (slot 2)
 * with Telar's session-control handler. That is safe only while three
 * assumptions hold in the installed y-websocket: the auth slot is index 2,
 * each provider instance owns its own `messageHandlers` array, and the array
 * is present and pre-populated. All three break silently — no throw, no
 * console line — so these tests assert them against the REAL y-websocket
 * (not the mock used by the other collaboration suites) and against the real
 * `installSessionControlHandler` install path, which no other test exercises.
 *
 * When bumping y-websocket past the pinned version below, re-verify that:
 *   - `messageAuth` is still 2,
 *   - `provider.messageHandlers` is still a per-instance array of functions,
 *   - the install path still lands on slot 2 and leaves 0/1/3 untouched,
 * then update PINNED_YWS_VERSION to the new known-good release.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { WebsocketProvider, messageAuth } from "y-websocket";
import * as decoding from "lib0/decoding";
import ywsPkg from "y-websocket/package.json";
import { installSessionControlHandler } from "~/hooks/use-collaboration";

// The override was verified sound against this exact y-websocket release.
// A mismatch means the dependency was bumped and someone must re-verify the
// assumptions documented in the file header before trusting the override.
const PINNED_YWS_VERSION = "3.0.0";

// Session-control subtypes (mirror use-collaboration.tsx / collaboration.ts).
const SUB_PROJECT_DELETED = 0x01;
const SUB_REMOVED_FROM_PROJECT = 0x02;

function makeRealProvider() {
  const doc = new Y.Doc();
  // connect:false → the constructor opens no socket; disableBc:true → no
  // BroadcastChannel. Neither performs network I/O, so this is safe in the
  // jsdom test environment. Always destroy() to clear the reconnect interval.
  const provider = new WebsocketProvider("ws://localhost:1234", "room", doc, {
    connect: false,
    disableBc: true,
  });
  return {
    provider,
    cleanup: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

describe("y-websocket version + slot assumptions", () => {
  it("installed y-websocket matches the pinned, verified version", () => {
    expect(ywsPkg.version).toBe(PINNED_YWS_VERSION);
  });

  it("messageAuth still occupies slot 2 (the slot the override claims)", () => {
    // MSG_SESSION_CONTROL in use-collaboration.tsx is hard-coded to 2 to
    // collide with this reserved slot. If y-websocket ever renumbers it, this
    // fails and the override must be re-pointed.
    expect(messageAuth).toBe(2);
  });

  it("each provider instance owns its own messageHandlers array of functions", () => {
    const a = makeRealProvider();
    const b = makeRealProvider();
    try {
      expect(Array.isArray(a.provider.messageHandlers)).toBe(true);
      expect(typeof a.provider.messageHandlers[messageAuth]).toBe("function");
      // Per-instance copy (src: this.messageHandlers = messageHandlers.slice()):
      // mutating one provider's array must not touch another's.
      expect(a.provider.messageHandlers).not.toBe(b.provider.messageHandlers);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe("installSessionControlHandler — real provider", () => {
  it("replaces slot 2 and leaves slots 0/1/3 untouched", () => {
    const { provider, cleanup } = makeRealProvider();
    try {
      const original = provider.messageHandlers.slice();
      installSessionControlHandler(provider, {
        onProjectDeleted: vi.fn(),
        onRemovedFromProject: vi.fn(),
      });
      expect(provider.messageHandlers[2]).not.toBe(original[2]);
      expect(typeof provider.messageHandlers[2]).toBe("function");
      expect(provider.messageHandlers[0]).toBe(original[0]);
      expect(provider.messageHandlers[1]).toBe(original[1]);
      expect(provider.messageHandlers[3]).toBe(original[3]);
    } finally {
      cleanup();
    }
  });
});

describe("installSessionControlHandler — frame dispatch", () => {
  // Install onto a provider-shaped fixture and drive an encoded subtype byte
  // through the installed handler. The real dispatcher hands the handler a
  // decoder positioned after the leading message-type varuint, so the handler
  // reads only the subtype byte — which is what we feed it here.
  function installAndDrive(subtype: number) {
    const onProjectDeleted = vi.fn();
    const onRemovedFromProject = vi.fn();
    const handlers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    installSessionControlHandler(
      { messageHandlers: handlers },
      { onProjectDeleted, onRemovedFromProject },
    );
    const decoder = decoding.createDecoder(new Uint8Array([subtype]));
    handlers[2](null, decoder, null, false, 2);
    return { onProjectDeleted, onRemovedFromProject };
  }

  it("routes subtype 0x01 to onProjectDeleted", () => {
    const { onProjectDeleted, onRemovedFromProject } = installAndDrive(SUB_PROJECT_DELETED);
    expect(onProjectDeleted).toHaveBeenCalledTimes(1);
    expect(onRemovedFromProject).not.toHaveBeenCalled();
  });

  it("routes subtype 0x02 to onRemovedFromProject", () => {
    const { onProjectDeleted, onRemovedFromProject } = installAndDrive(SUB_REMOVED_FROM_PROJECT);
    expect(onRemovedFromProject).toHaveBeenCalledTimes(1);
    expect(onProjectDeleted).not.toHaveBeenCalled();
  });

  it("ignores unknown subtypes (no callback fires)", () => {
    const { onProjectDeleted, onRemovedFromProject } = installAndDrive(0x09);
    expect(onProjectDeleted).not.toHaveBeenCalled();
    expect(onRemovedFromProject).not.toHaveBeenCalled();
  });

  it("no-ops when the provider has no messageHandlers array (mock-shaped provider)", () => {
    const fixture = {} as Pick<WebsocketProvider, "messageHandlers">;
    expect(() =>
      installSessionControlHandler(fixture, {
        onProjectDeleted: vi.fn(),
        onRemovedFromProject: vi.fn(),
      }),
    ).not.toThrow();
  });
});
