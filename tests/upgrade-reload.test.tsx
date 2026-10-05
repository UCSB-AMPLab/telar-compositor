// @vitest-environment jsdom
/**
 * A collaborator's page reloads when another user's upgrade has succeeded,
 * and on nothing else.
 *
 * The decision that an upgrade succeeded is made in `~/lib/freeze-view` (see
 * freeze-view.test.ts); this holds the component to acting on that decision
 * alone — in particular, not to reading a freeze that lifted as a finished
 * upgrade, which an expiry or a dropped socket also does.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ReloadOnUpgradeComplete } from "~/components/layout/ReloadOnUpgradeComplete";

const mockContext = { isUpgrading: false, upgradeError: false, upgradeSucceeded: false };

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => mockContext,
}));

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
  mockContext.upgradeSucceeded = false;
});

describe("ReloadOnUpgradeComplete", () => {
  it("reloads once another user's upgrade has succeeded", () => {
    const { rerender } = render(<ReloadOnUpgradeComplete />);
    expect(reloadSpy).not.toHaveBeenCalled();
    mockContext.upgradeSucceeded = true;
    rerender(<ReloadOnUpgradeComplete />);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the freeze lifts without a success", () => {
    mockContext.isUpgrading = true;
    const { rerender } = render(<ReloadOnUpgradeComplete />);
    mockContext.isUpgrading = false;
    rerender(<ReloadOnUpgradeComplete />);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("does not reload on a failed upgrade", () => {
    mockContext.isUpgrading = true;
    const { rerender } = render(<ReloadOnUpgradeComplete />);
    mockContext.isUpgrading = false;
    mockContext.upgradeError = true;
    rerender(<ReloadOnUpgradeComplete />);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
