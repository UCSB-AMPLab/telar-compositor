// @vitest-environment jsdom
/**
 * upgrade-collaboration.test.ts — two-client Yjs awareness propagation tests.
 *
 * Owner broadcasts state.upgrading (and state.upgradeError)
 * via Yjs awareness; collaborators observe those fields and set their local
 * isUpgrading / upgradeError derived state.
 *
 * This file focuses on the MULTI-CLIENT interleaving — in particular the
 * true -> false edge transition driven by a second awareness snapshot,
 * and the independence of publishing vs. upgrading channels. The
 * single-client broadcast case is already covered by use-collaboration.test.tsx.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useCollaborationContext, CollaborationProvider } from "~/hooks/use-collaboration";

// ---------------------------------------------------------------------------
// Mocks — clone the shape from tests/use-collaboration.test.tsx so the
// CollaborationProvider runs under our control without a real WebSocket.
// ---------------------------------------------------------------------------

const mockAwareness = {
  clientID: 1,
  setLocalStateField: vi.fn(),
  getStates: vi.fn(() => new Map()),
  on: vi.fn(),
  off: vi.fn(),
};

const mockProvider = {
  awareness: mockAwareness,
  on: vi.fn(),
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
// Test harness
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

function renderCollaboratorClient() {
  // Collaborator's own clientID stays 1 in the mock; owner is simulated
  // by putting an awareness entry under a different clientID in getStates.
  capturedIsUpgrading = undefined;
  capturedUpgradeError = undefined;
  capturedIsPublishing = undefined;
  capturedPublishError = undefined;
  capturedAwarenessChangeHandler = null;
  mockAwareness.on.mockImplementation((event: string, cb: () => void) => {
    if (event === "change") capturedAwarenessChangeHandler = cb;
  });
  return render(
    React.createElement(
      CollaborationProvider,
      {
        projectId: 1,
        userGithubId: 42,
        userName: "alice",
        presenceColor: "#abc",
      },
      React.createElement(UpgradeConsumer),
    ),
  );
}

function simulateAwarenessStates(states: Map<number, Record<string, unknown>>) {
  mockAwareness.getStates.mockReturnValue(states);
  act(() => {
    capturedAwarenessChangeHandler?.();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upgrade awareness broadcast (multi-client)", () => {
  it("collaborator sees isUpgrading=true after owner broadcasts upgrading", () => {
    renderCollaboratorClient();
    // Owner is client 2; collaborator/self is client 1.
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([
        [1, {}],
        [2, { upgrading: true }],
      ]),
    );
    expect(capturedIsUpgrading).toBe(true);
    expect(capturedUpgradeError).toBe(false);
  });

  it("collaborator sees isUpgrading=false after owner clears upgrading (true -> false edge)", () => {
    renderCollaboratorClient();
    // Step 1: owner sets upgrading=true
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([[2, { upgrading: true }]]),
    );
    expect(capturedIsUpgrading).toBe(true);
    // Step 2: owner clears upgrading (e.g. reached "done" stage)
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([[2, { upgrading: false }]]),
    );
    expect(capturedIsUpgrading).toBe(false);
  });

  it("collaborator sees upgradeError=true when any client has state.upgradeError", () => {
    renderCollaboratorClient();
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([
        [2, { upgrading: false, upgradeError: true }],
      ]),
    );
    expect(capturedUpgradeError).toBe(true);
  });

  it("publish and upgrade fields are independent", () => {
    renderCollaboratorClient();
    // Owner is publishing — upgrading channel must stay false
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([[2, { publishing: true }]]),
    );
    expect(capturedIsPublishing).toBe(true);
    expect(capturedIsUpgrading).toBe(false);
    expect(capturedUpgradeError).toBe(false);

    // Owner is upgrading — publishing channel must stay false
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([[2, { upgrading: true }]]),
    );
    expect(capturedIsUpgrading).toBe(true);
    expect(capturedIsPublishing).toBe(false);
    expect(capturedPublishError).toBe(false);
  });

  it("when no client has either upgrading or upgradeError, both return false", () => {
    renderCollaboratorClient();
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([
        [2, { user: { githubId: 7, name: "bob", color: "#def" } }],
        [3, {}],
      ]),
    );
    expect(capturedIsUpgrading).toBe(false);
    expect(capturedUpgradeError).toBe(false);
  });

  it("upgrading OR-reduces across multiple peers", () => {
    renderCollaboratorClient();
    // Two other clients; only one has upgrading=true — collaborator sees true.
    simulateAwarenessStates(
      new Map<number, Record<string, unknown>>([
        [2, { upgrading: false }],
        [3, { upgrading: true }],
        [4, { upgrading: false }],
      ]),
    );
    expect(capturedIsUpgrading).toBe(true);
  });
});
