// @vitest-environment jsdom
/**
 * upgrade-reload.test.tsx — edge-transition reload hook tests.
 *
 * When isUpgrading transitions true -> false
 * (and no upgradeError), collaborators call window.location.reload() exactly
 * once. Owners never reload — they stay on the "upgrade complete" screen.
 *
 * Verifies the ReloadOnUpgradeComplete component extracted from _app.tsx.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ReloadOnUpgradeComplete } from "~/components/layout/ReloadOnUpgradeComplete";

// ---------------------------------------------------------------------------
// Mock use-collaboration so we can drive context values imperatively per test.
// ---------------------------------------------------------------------------

const mockContext = {
  provider: { awareness: { setLocalStateField: vi.fn() } } as unknown as {
    awareness: { setLocalStateField: (field: string, value: unknown) => void };
  } | null,
  isUpgrading: false,
  upgradeError: false,
};

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => mockContext,
}));

// ---------------------------------------------------------------------------
// reload spy harness
// ---------------------------------------------------------------------------

let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reloadSpy = vi.fn();
  Object.defineProperty(window, "location", {
    value: { reload: reloadSpy },
    writable: true,
    configurable: true,
  });
  mockContext.isUpgrading = false;
  mockContext.upgradeError = false;
  mockContext.provider = {
    awareness: { setLocalStateField: vi.fn() },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReloadOnUpgradeComplete", () => {
  it("does not reload when isUpgrading never transitions", () => {
    mockContext.isUpgrading = false;
    render(<ReloadOnUpgradeComplete isOwner={false} />);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("reloads collaborator when isUpgrading transitions true -> false with no error", () => {
    mockContext.isUpgrading = true;
    const { rerender } = render(<ReloadOnUpgradeComplete isOwner={false} />);
    expect(reloadSpy).not.toHaveBeenCalled();
    mockContext.isUpgrading = false;
    rerender(<ReloadOnUpgradeComplete isOwner={false} />);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload owner on same transition (Pitfall 8)", () => {
    mockContext.isUpgrading = true;
    const { rerender } = render(<ReloadOnUpgradeComplete isOwner={true} />);
    mockContext.isUpgrading = false;
    rerender(<ReloadOnUpgradeComplete isOwner={true} />);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("does NOT reload on transition when upgradeError=true", () => {
    mockContext.isUpgrading = true;
    const { rerender } = render(<ReloadOnUpgradeComplete isOwner={false} />);
    mockContext.isUpgrading = false;
    mockContext.upgradeError = true;
    rerender(<ReloadOnUpgradeComplete isOwner={false} />);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("does NOT reload when provider is null", () => {
    mockContext.isUpgrading = true;
    mockContext.provider = null;
    const { rerender } = render(<ReloadOnUpgradeComplete isOwner={false} />);
    mockContext.isUpgrading = false;
    rerender(<ReloadOnUpgradeComplete isOwner={false} />);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
