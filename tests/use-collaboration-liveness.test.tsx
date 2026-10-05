// @vitest-environment jsdom
/**
 * The collaboration hook starts the liveness check and the
 * presence expiry on the provider it creates, against the page's
 * own visibility, and stops both before tearing the provider down.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const { stopLiveness, watchLiveness, stopPresenceExpiry, watchPresenceExpiry, mockProvider } = vi.hoisted(() => {
  const stopLiveness = vi.fn();
  const stopPresenceExpiry = vi.fn();
  return {
    stopLiveness,
    watchLiveness: vi.fn(() => stopLiveness),
    stopPresenceExpiry,
    watchPresenceExpiry: vi.fn(() => stopPresenceExpiry),
    mockProvider: {
      awareness: {
        clientID: 1,
        setLocalStateField: vi.fn(),
        getStates: vi.fn(() => new Map()),
        on: vi.fn(),
        off: vi.fn(),
      },
      messageHandlers: [] as unknown[],
      on: vi.fn(),
      off: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      destroy: vi.fn(),
      synced: false,
    },
  };
});
vi.mock("~/lib/connection-liveness", () => ({ watchLiveness }));
vi.mock("~/lib/presence-expiry", () => ({ watchPresenceExpiry }));

vi.mock("y-websocket", () => ({
  WebsocketProvider: vi.fn(function () {
    return mockProvider;
  }),
}));

vi.mock("yjs", () => ({
  Doc: vi.fn(function () {
    return { getArray: vi.fn(() => []), destroy: vi.fn() };
  }),
  UndoManager: vi.fn(function () {
    return { on: vi.fn(), off: vi.fn(), destroy: vi.fn(), undoStack: [], redoStack: [] };
  }),
}));

import { CollaborationProvider } from "~/hooks/use-collaboration";

describe("the collaboration hook's liveness check and presence expiry", () => {
  it("watches the provider and its awareness against the document, and stops both before disconnecting", () => {
    const { unmount } = render(
      <CollaborationProvider projectId={1} userGithubId={42} userName="alice" presenceColor="#abc">
        {null}
      </CollaborationProvider>,
    );
    expect(watchLiveness).toHaveBeenCalledWith(mockProvider, document);
    expect(watchLiveness.mock.invocationCallOrder[0]).toBeLessThan(
      mockProvider.connect.mock.invocationCallOrder[0],
    );
    expect(watchPresenceExpiry).toHaveBeenCalledWith(mockProvider.awareness, document);
    expect(watchPresenceExpiry.mock.invocationCallOrder[0]).toBeLessThan(
      mockProvider.connect.mock.invocationCallOrder[0],
    );

    unmount();
    expect(stopLiveness).toHaveBeenCalledTimes(1);
    expect(stopLiveness.mock.invocationCallOrder[0]).toBeLessThan(
      mockProvider.disconnect.mock.invocationCallOrder[0],
    );
    expect(stopPresenceExpiry).toHaveBeenCalledTimes(1);
    expect(stopPresenceExpiry.mock.invocationCallOrder[0]).toBeLessThan(
      mockProvider.disconnect.mock.invocationCallOrder[0],
    );
  });
});
