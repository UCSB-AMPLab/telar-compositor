// @vitest-environment jsdom
/**
 * This file pins unit tests for the `CollaborationContext` hook.
 *
 * Tests: lastEditorByField population from awareness state, the
 * connectionStatus three-state field, and the admission epoch the halted
 * site-status state reads.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { useCollaborationContext, CollaborationProvider } from "~/hooks/use-collaboration";

// ---------------------------------------------------------------------------
// Helpers — mock y-websocket WebsocketProvider
// ---------------------------------------------------------------------------

type StatusCallback = (event: { status: string }) => void;
type SyncCallback = (isSynced: boolean) => void;

let capturedStatusHandler: StatusCallback | null = null;

const mockAwareness = {
  clientID: 1,
  // What the presence expiry reads on each check.
  meta: new Map(),
  states: new Map(),
  getLocalState: vi.fn(() => null),
  setLocalStateField: vi.fn(),
  getStates: vi.fn(() => new Map()),
  on: vi.fn(),
  off: vi.fn(),
};

const mockProvider = {
  awareness: mockAwareness,
  // The per-instance handler array the session-control install claims slot 2 of.
  // Present here so a test can drive the real frame dispatch.
  messageHandlers: [] as unknown[],
  on: vi.fn((event: string, cb: StatusCallback | SyncCallback) => {
    if (event === "status") capturedStatusHandler = cb as StatusCallback;
  }),
  off: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  destroy: vi.fn(),
  synced: false,
};

// The three mocks below stand in for classes the provider calls with `new`,
// so their implementations are function expressions: an arrow function is not
// a constructor, and Vitest 4 constructs the implementation it was given.
vi.mock("y-websocket", () => ({
  WebsocketProvider: vi.fn(function () {
    return mockProvider;
  }),
}));

vi.mock("yjs", () => ({
  Doc: vi.fn(function () {
    return {
      getArray: vi.fn(() => []),
      destroy: vi.fn(),
    };
  }),
  UndoManager: vi.fn(function () {
    return {
      on: vi.fn(),
      off: vi.fn(),
      destroy: vi.fn(),
      undoStack: [],
      redoStack: [],
    };
  }),
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

  it("y-websocket status='connected' maps to connectionStatus='connected'", () => {
    renderWithProvider();
    act(() => {
      capturedStatusHandler?.({ status: "connected" });
    });
    expect(capturedConnectionStatus).toBe("connected");
  });

  it("y-websocket status='connecting' maps to connectionStatus='connecting'", () => {
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

  it("y-websocket status='disconnected' maps to connectionStatus='offline'", () => {
    renderWithProvider();
    act(() => {
      capturedStatusHandler?.({ status: "disconnected" });
    });
    expect(capturedConnectionStatus).toBe("offline");
  });

  it("legacy `connected` boolean remains true when status==='connected' (backwards compat)", () => {
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
});

// ---------------------------------------------------------------------------
// The freeze comes from the server's lease frames, never from awareness
// ---------------------------------------------------------------------------

const SUB_FREEZE = 0x05;
const ME = 7;
const OTHER = 8;

let freezeCtx: ReturnType<typeof useCollaborationContext> | undefined;
let capturedAwarenessChangeHandler: (() => void) | null = null;

function FreezeConsumer() {
  freezeCtx = useCollaborationContext();
  return null;
}

function freezeTree(projectId: number) {
  return (
    <CollaborationProvider
      projectId={projectId}
      userId={ME}
      userGithubId={42}
      userName="alice"
      presenceColor="#abc"
    >
      <FreezeConsumer />
    </CollaborationProvider>
  );
}

function renderForFreeze() {
  freezeCtx = undefined;
  capturedAwarenessChangeHandler = null;
  mockProvider.messageHandlers = [];
  mockAwareness.on.mockImplementation((event: string, cb: () => void) => {
    if (event === "change") capturedAwarenessChangeHandler = cb;
  });
  return render(
    <CollaborationProvider
      projectId={1}
      userId={ME}
      userGithubId={42}
      userName="alice"
      presenceColor="#abc"
    >
      <FreezeConsumer />
    </CollaborationProvider>,
  );
}

function simulateAwarenessStates(states: Map<number, Record<string, unknown>>) {
  mockAwareness.getStates.mockReturnValue(states);
  act(() => {
    capturedAwarenessChangeHandler?.();
  });
}

type FrameLease = { rev: number; kind: "publish" | "upgrade" | "objects"; userId: number; remainingMs: number };
type FrameEnd = { rev: number; kind: "publish" | "upgrade"; userId: number; outcome: "succeeded" | "failed" };

/** Deliver a freeze frame; `fromSocket` false is how a BroadcastChannel message arrives. */
function deliverFreeze(leases: FrameLease[], ended: FrameEnd[] = [], fromSocket = true) {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, SUB_FREEZE);
  encoding.writeVarString(encoder, JSON.stringify({ leases, ended }));
  const decoder = decoding.createDecoder(encoding.toUint8Array(encoder));
  const handler = mockProvider.messageHandlers[2] as (...args: unknown[]) => void;
  act(() => {
    handler(null, decoder, mockProvider, fromSocket, 2);
  });
}

describe("the freeze", () => {
  it("is not raised by any awareness field", () => {
    // The whole point: any member can set these, so none of them may freeze.
    renderForFreeze();
    simulateAwarenessStates(
      new Map([[2, { publishing: true, upgrading: true, publishError: true, upgradeError: true }]]),
    );
    expect(freezeCtx?.isPublishing).toBe(false);
    expect(freezeCtx?.isUpgrading).toBe(false);
    expect(freezeCtx?.publishError).toBe(false);
    expect(freezeCtx?.upgradeError).toBe(false);
  });

  it("is raised by a lease frame from the socket, per kind", () => {
    renderForFreeze();
    deliverFreeze([{ rev: 1, kind: "upgrade", userId: OTHER, remainingMs: 60_000 }]);
    expect(freezeCtx?.isUpgrading).toBe(true);
    expect(freezeCtx?.upgradeHeldByOther).toBe(true);
    expect(freezeCtx?.isPublishing).toBe(false);
  });

  it("ignores the same frame arriving from another tab", () => {
    renderForFreeze();
    deliverFreeze([{ rev: 1, kind: "publish", userId: OTHER, remainingMs: 60_000 }], [], false);
    expect(freezeCtx?.isPublishing).toBe(false);
  });

  it("names another member's objects commit and freezes nothing, until its lease goes", () => {
    renderForFreeze();
    deliverFreeze([{ rev: 1, kind: "objects", userId: OTHER, remainingMs: 60_000 }]);
    expect(freezeCtx?.objectsHeldBy).toBe(OTHER);
    expect(freezeCtx?.isPublishing).toBe(false);
    expect(freezeCtx?.isUpgrading).toBe(false);
    expect(freezeCtx?.publishHeldByOther).toBe(false);
    deliverFreeze([]);
    expect(freezeCtx?.objectsHeldBy).toBeNull();
  });

  it("freezes the holder's own editors but shows them no modal", () => {
    renderForFreeze();
    deliverFreeze([{ rev: 1, kind: "publish", userId: ME, remainingMs: 60_000 }]);
    expect(freezeCtx?.isPublishing).toBe(true);
    expect(freezeCtx?.publishHeldByOther).toBe(false);
  });

  it("lifts at the lease's local deadline with no further frame", () => {
    vi.useFakeTimers();
    try {
      renderForFreeze();
      deliverFreeze([{ rev: 1, kind: "publish", userId: OTHER, remainingMs: 5_000 }]);
      expect(freezeCtx?.isPublishing).toBe(true);
      act(() => {
        vi.advanceTimersByTime(5_001);
      });
      expect(freezeCtx?.isPublishing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows another user's failure until it is dismissed", () => {
    renderForFreeze();
    deliverFreeze([{ rev: 3, kind: "publish", userId: OTHER, remainingMs: 60_000 }]);
    deliverFreeze([], [{ rev: 3, kind: "publish", userId: OTHER, outcome: "failed" }]);
    expect(freezeCtx?.isPublishing).toBe(false);
    expect(freezeCtx?.publishError).toBe(true);
    act(() => {
      freezeCtx?.dismissPublishError();
    });
    expect(freezeCtx?.publishError).toBe(false);
  });

  it("forgets what it saw in one project when the page moves to another", () => {
    // Revisions are numbered per project, so revision 1 seen running in one
    // must not license acting on revision 1's end in the next.
    const view = renderForFreeze();
    deliverFreeze([{ rev: 1, kind: "upgrade", userId: OTHER, remainingMs: 60_000 }]);
    expect(freezeCtx?.isUpgrading).toBe(true);

    view.rerender(freezeTree(2));
    expect(freezeCtx?.isUpgrading).toBe(false);
    deliverFreeze([], [{ rev: 1, kind: "upgrade", userId: OTHER, outcome: "succeeded" }]);
    expect(freezeCtx?.upgradeSucceeded).toBe(false);
  });

  it("reports another user's upgrade as succeeded only when this page saw it run", () => {
    renderForFreeze();
    deliverFreeze([], [{ rev: 4, kind: "upgrade", userId: OTHER, outcome: "succeeded" }]);
    expect(freezeCtx?.upgradeSucceeded).toBe(false);
    deliverFreeze([{ rev: 5, kind: "upgrade", userId: OTHER, remainingMs: 60_000 }]);
    deliverFreeze([], [{ rev: 5, kind: "upgrade", userId: OTHER, outcome: "succeeded" }]);
    expect(freezeCtx?.upgradeSucceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// admissionEpoch — the one proof that this connection is being served
// ---------------------------------------------------------------------------

const SUB_STATE_RESET = 0x03;
const SUB_DOC_GENERATION = 0x04;

let capturedAdmissionEpoch: number | undefined;

function EpochConsumer() {
  const ctx = useCollaborationContext();
  capturedAdmissionEpoch = ctx.admissionEpoch;
  return null;
}

function renderForEpoch() {
  capturedAdmissionEpoch = undefined;
  mockProvider.messageHandlers = [];
  return render(
    <CollaborationProvider
      projectId={1}
      userGithubId={42}
      userName="alice"
      presenceColor="#abc"
    >
      <EpochConsumer />
    </CollaborationProvider>,
  );
}

/** Deliver one session-control frame through the installed handler. */
function deliver(subtype: number, generation: number) {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, subtype);
  encoding.writeVarUint(encoder, generation);
  const decoder = decoding.createDecoder(encoding.toUint8Array(encoder));
  const handler = mockProvider.messageHandlers[2] as (
    ...args: unknown[]
  ) => void;
  act(() => {
    handler(null, decoder, mockProvider, false, 2);
  });
}

describe("admissionEpoch counts generation handshakes", () => {
  it("starts at zero, before any handshake", () => {
    renderForEpoch();
    expect(capturedAdmissionEpoch).toBe(0);
  });

  it("increments twice for two handshakes at the same generation on one provider", () => {
    renderForEpoch();
    deliver(SUB_DOC_GENERATION, 3);
    expect(capturedAdmissionEpoch).toBe(1);
    deliver(SUB_DOC_GENERATION, 3);
    expect(capturedAdmissionEpoch).toBe(2);
  });

  it("does not increment for the reset frame a temporary stale admission receives", () => {
    // The stale-generation path opens a socket only to deliver this frame, and
    // sends no handshake: a socket that is open is not a document being served.
    renderForEpoch();
    deliver(SUB_STATE_RESET, 4);
    expect(capturedAdmissionEpoch).toBe(0);
  });

  it("does not increment on a connected status alone", () => {
    renderForEpoch();
    act(() => {
      capturedStatusHandler?.({ status: "connected" });
    });
    expect(capturedAdmissionEpoch).toBe(0);
  });
});

describe("the same browser's other tabs", () => {
  it("are reached through the server only: the provider is built with BroadcastChannel off", async () => {
    const { WebsocketProvider } = await import("y-websocket");
    vi.mocked(WebsocketProvider).mockClear();
    renderForFreeze();
    expect(vi.mocked(WebsocketProvider)).toHaveBeenCalled();
    const options = vi.mocked(WebsocketProvider).mock.calls.at(-1)?.[3] as { disableBc?: boolean };
    expect(options.disableBc).toBe(true);
  });
});
