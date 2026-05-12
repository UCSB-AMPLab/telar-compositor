// @vitest-environment jsdom
/**
 * This file pins the `RemoveCollaboratorModal` contract — render gating
 * on `open`, focus-on-Cancel default, destructive Remove styling, body
 * interpolation of the target username, Escape-to-cancel keyboard path,
 * and the click-to-confirm callback that yields the member userId.
 *
 * @version v1.0.1-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Mock react-i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.username) return `${key}:${opts.username}`;
      return key;
    },
    i18n: { language: "en" },
  }),
}));

import { RemoveCollaboratorModal } from "~/components/features/collaboration/RemoveCollaboratorModal";

const defaultProps = {
  open: true,
  username: "alice",
  userId: 42,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe("RemoveCollaboratorModal", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <RemoveCollaboratorModal {...defaultProps} open={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders when open=true with Cancel and Remove buttons", () => {
    render(<RemoveCollaboratorModal {...defaultProps} />);
    expect(screen.getByRole("button", { name: "remove_cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "remove_confirm" })).toBeTruthy();
  });

  it("focuses Cancel on open (safer default for destructive modals)", async () => {
    render(<RemoveCollaboratorModal {...defaultProps} />);
    // requestAnimationFrame fires in jsdom — wait for the next frame
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const cancelBtn = screen.getByRole("button", { name: "remove_cancel" });
    expect(document.activeElement).toBe(cancelBtn);
  });

  it("Remove button has destructive styling (bg-red-600)", () => {
    render(<RemoveCollaboratorModal {...defaultProps} />);
    const removeBtn = screen.getByRole("button", { name: "remove_confirm" });
    expect(removeBtn.className).toMatch(/bg-red-600/);
  });

  it("body copy interpolates the @username passed via props", () => {
    render(<RemoveCollaboratorModal {...defaultProps} username="bob" />);
    // The t mock returns "key:username" — check the body contains "bob"
    const body = screen.getByTestId("remove-modal-body");
    expect(body.textContent).toContain("bob");
  });

  it("Escape key invokes onCancel", () => {
    const onCancel = vi.fn();
    render(<RemoveCollaboratorModal {...defaultProps} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirming invokes onConfirm with the member userId", () => {
    const onConfirm = vi.fn();
    render(<RemoveCollaboratorModal {...defaultProps} onConfirm={onConfirm} userId={42} />);
    const removeBtn = screen.getByRole("button", { name: "remove_confirm" });
    fireEvent.click(removeBtn);
    expect(onConfirm).toHaveBeenCalledWith(42);
  });
});
