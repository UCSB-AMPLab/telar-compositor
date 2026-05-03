// @vitest-environment jsdom
/**
 * use-collaboration.test.tsx — unit tests for the CollaborationContext hook.
 *
 * Tests: lastEditorByField population from awareness state,
 * and connectionStatus three-state field.
 */

import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useCollaborationContext, CollaborationProvider } from "~/hooks/use-collaboration";

// ---------------------------------------------------------------------------
// Helpers — mock y-websocket WebsocketProvider
// ---------------------------------------------------------------------------

type StatusCallback = (event: { status: string }) => void;
type SyncCallback = (isSynced: boolean) => void;

let capturedStatusHandler: StatusCallback | null = null;

const mockAwareness = {
  clientID: 1,
  setLocalStateField: vi.fn(),
  getStates: vi.fn(() => new Map()),
  on: vi.fn(),
  off: vi.fn(),
};

const mockProvider = {
  awareness: mockAwareness,
  on: vi.fn((event: string, cb: StatusCallback | SyncCallback) => {
    if (event === "status") capturedStatusHandler = cb as StatusCallback;
  }),
  off: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  destroy: vi.fn(),
  synced: false,
};

vi.mock("y-websocket", () => ({
  WebsocketProvider: vi.fn(() => mockProvider),
}));

vi.mock("yjs", () => ({
  Doc: vi.fn(() => ({
    getArray: vi.fn(() => []),
    destroy: vi.fn(),
  })),
  UndoManager: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    undoStack: [],
    redoStack: [],
  })),
}));

// ---------------------------------------------------------------------------
// Test consumer component — reads connectionStatus from context
// ---------------------------------------------------------------------------

let capturedConnectionStatus: string | undefined;
let capturedConnected: boolean | undefined;

function TestConsumer() {
  const ctx = useCollaborationContext();
  capturedConnectionStatus = ctx.connectionStatus;
  capturedConnected = ctx.connected;
  return null;
}

function renderWithProvider() {
  capturedStatusHandler = null;
  capturedConnectionStatus = undefined;
  capturedConnected = undefined;
  return render(
    <CollaborationProvider
      projectId={1}
      userGithubId={42}
      userName="alice"
      presenceColor="#abc"
    >
      <TestConsumer />
    </CollaborationProvider>
  );
}

// ---------------------------------------------------------------------------
// Existing stubs
// ---------------------------------------------------------------------------

describe("CollaborationContext lastEditorByField", () => {
  it.todo("initialises lastEditorByField as an empty Map");
  it.todo("populates lastEditorByField when a remote user has a fieldKey in awareness state");
  it.todo("updates lastEditorByField entry when the same fieldKey gets a new editor");
  it.todo("preserves previous entries when a new fieldKey is added");
  it.todo("does not include the local client's own awareness state");
});

// ---------------------------------------------------------------------------
// contributionsByUser on CollaborationContext
// ---------------------------------------------------------------------------

interface ProjectMember {
  userId: number;
  role: "convenor" | "collaborator";
  contributions: { fields_edited?: number; sessions?: number } | null;
}

function renderWithMembers(projectMembers: ProjectMember[]) {
  let captured: Map<number, { fields_edited: number }> | undefined;
  function ContribConsumer() {
    const ctx = useCollaborationContext();
    captured = ctx.contributionsByUser;
    return null;
  }
  render(
    <CollaborationProvider
      projectId={1}
      userGithubId={42}
      userName="alice"
      presenceColor="#abc"
      projectMembers={projectMembers}
    >
      <ContribConsumer />
    </CollaborationProvider>
  );
  return { captured };
}

describe("contributionsByUser on CollaborationContext", () => {
  it("contributionsByUser is a Map keyed by userId", () => {
    const { captured } = renderWithMembers([
      { userId: 7, role: "convenor", contributions: { fields_edited: 3, sessions: 1 } },
    ]);
    expect(captured).toBeInstanceOf(Map);
    expect(captured?.has(7)).toBe(true);
  });

  it("contributions.fields_edited = 5 maps to contributionsByUser entry with fields_edited === 5", () => {
    const { captured } = renderWithMembers([
      { userId: 7, role: "convenor", contributions: { fields_edited: 5, sessions: 2 } },
    ]);
    expect(captured?.get(7)?.fields_edited).toBe(5);
  });

  it("user with no contributions JSON resolves to fields_edited: 0 (not undefined)", () => {
    const { captured } = renderWithMembers([
      { userId: 99, role: "collaborator", contributions: null },
    ]);
    expect(captured?.get(99)?.fields_edited).toBe(0);
  });

  it("contributionsByUser only includes users from authenticated projectMembers loader output", () => {
    const { captured } = renderWithMembers([
      { userId: 7, role: "convenor", contributions: { fields_edited: 1 } },
      { userId: 8, role: "collaborator", contributions: { fields_edited: 2 } },
    ]);
    expect(captured?.size).toBe(2);
    expect(captured?.has(7)).toBe(true);
    expect(captured?.has(8)).toBe(true);
    // A hypothetical awareness client ID that is NOT in projectMembers should not appear
    expect(captured?.has(999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// connectionStatus field
// ---------------------------------------------------------------------------

describe("connectionStatus field", () => {
  it("initial status is 'connecting' before first ws event", () => {
    renderWithProvider();
    expect(capturedConnectionStatus).toBe("connecting");
  });

  it("SC-6: y-websocket status='connected' maps to connectionStatus='connected'", () => {
    renderWithProvider();
    act(() => {
      capturedStatusHandler?.({ status: "connected" });
    });
    expect(capturedConnectionStatus).toBe("connected");
  });

  it("SC-6: y-websocket status='connecting' maps to connectionStatus='connecting'", () => {
    renderWithProvider();
    // First go connected, then back to connecting
    act(() => {
      capturedStatusHandler?.({ status: "connected" });
    });
    act(() => {
      capturedStatusHandler?.({ status: "connecting" });
    });
    expect(capturedConnectionStatus).toBe("connecting");
  });

  it("SC-6: y-websocket status='disconnected' maps to connectionStatus='offline' (D-14 label)", () => {
    renderWithProvider();
    act(() => {
      capturedStatusHandler?.({ status: "disconnected" });
    });
    expect(capturedConnectionStatus).toBe("offline");
  });

  it("SC-6: legacy `connected` boolean remains true when status==='connected' (backwards compat)", () => {
    renderWithProvider();
    act(() => {
      capturedStatusHandler?.({ status: "connected" });
    });
    expect(capturedConnected).toBe(true);
    act(() => {
      capturedStatusHandler?.({ status: "disconnected" });
    });
    expect(capturedConnected).toBe(false);
  });

  it.todo("onlineMembers list only contains session-authenticated awareness clients");
});

// ---------------------------------------------------------------------------
// isUpgrading / upgradeError awareness fields
// ---------------------------------------------------------------------------

let capturedIsUpgrading: boolean | undefined;
let capturedUpgradeError: boolean | undefined;
let capturedIsPublishing: boolean | undefined;
let capturedPublishError: boolean | undefined;
let capturedAwarenessChangeHandler: (() => void) | null = null;

function UpgradeConsumer() {
  const ctx = useCollaborationContext();
  capturedIsUpgrading = ctx.isUpgrading;
  capturedUpgradeError = ctx.upgradeError;
  capturedIsPublishing = ctx.isPublishing;
  capturedPublishError = ctx.publishError;
  return null;
}

function renderForUpgradeFields() {
  capturedIsUpgrading = undefined;
  capturedUpgradeError = undefined;
  capturedIsPublishing = undefined;
  capturedPublishError = undefined;
  capturedAwarenessChangeHandler = null;
  // Capture the awareness 'change' handler registered by the provider
  mockAwareness.on.mockImplementation((event: string, cb: () => void) => {
    if (event === "change") capturedAwarenessChangeHandler = cb;
  });
  return render(
    <CollaborationProvider
      projectId={1}
      userGithubId={42}
      userName="alice"
      presenceColor="#abc"
    >
      <UpgradeConsumer />
    </CollaborationProvider>,
  );
}

function simulateAwarenessStates(states: Map<number, Record<string, unknown>>) {
  mockAwareness.getStates.mockReturnValue(states);
  act(() => {
    capturedAwarenessChangeHandler?.();
  });
}

describe("isUpgrading / upgradeError awareness fields", () => {
  it("isUpgrading becomes true when any client broadcasts state.upgrading=true", () => {
    renderForUpgradeFields();
    simulateAwarenessStates(new Map([[2, { upgrading: true }]]));
    expect(capturedIsUpgrading).toBe(true);
  });

  it("SC-1: upgradeError becomes true when any client broadcasts state.upgradeError=true", () => {
    renderForUpgradeFields();
    simulateAwarenessStates(new Map([[2, { upgradeError: true }]]));
    expect(capturedUpgradeError).toBe(true);
  });

  it("SC-1: isUpgrading clears to false when no client has state.upgrading set", () => {
    renderForUpgradeFields();
    simulateAwarenessStates(new Map([[2, { upgrading: true }]]));
    expect(capturedIsUpgrading).toBe(true);
    simulateAwarenessStates(new Map([[2, {}]]));
    expect(capturedIsUpgrading).toBe(false);
  });

  it("upgrading OR-reduces across clients (any true -> true)", () => {
    renderForUpgradeFields();
    simulateAwarenessStates(
      new Map([
        [2, { upgrading: false }],
        [3, { upgrading: true }],
        [4, {}],
      ]),
    );
    expect(capturedIsUpgrading).toBe(true);
  });

  it("publishing and upgrading states are independent", () => {
    renderForUpgradeFields();
    // Only upgrading=true on one client
    simulateAwarenessStates(new Map([[2, { upgrading: true }]]));
    expect(capturedIsUpgrading).toBe(true);
    expect(capturedIsPublishing).toBe(false);
    expect(capturedPublishError).toBe(false);

    // Only publishing=true on one client
    simulateAwarenessStates(new Map([[2, { publishing: true }]]));
    expect(capturedIsPublishing).toBe(true);
    expect(capturedIsUpgrading).toBe(false);
    expect(capturedUpgradeError).toBe(false);
  });
});
