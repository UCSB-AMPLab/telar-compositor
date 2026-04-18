// @vitest-environment jsdom
/**
 * MemberRow-kebab.test.tsx — kebab menu replaces hover X button.
 *
 * Tests: always-visible MoreVertical icon, dropdown open/close,
 * Remove callback, defence-in-depth isConvenor guard.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemberRow } from "~/components/features/dashboard/MemberRow";

// Mock react-i18next — t(key) returns the key so assertions are stable
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.username) return `${key}:${opts.username}`;
      return key;
    },
  }),
}));

const defaultProps = {
  githubId: 1,
  username: "alice",
  role: "collaborator" as const,
  isPending: false,
  isCurrentUserOwner: false,
  isConvenor: true,
  onRemove: vi.fn(),
};

describe("MemberRow kebab menu", () => {
  it("renders MoreVertical icon always (no opacity-0 class)", () => {
    const { container } = render(<MemberRow {...defaultProps} isConvenor={true} />);
    // The kebab button must be present in the DOM
    const btn = screen.getByRole("button", { name: /row menu/i });
    expect(btn).toBeTruthy();
    // No opacity-0 on any element within the row
    expect(container.innerHTML).not.toContain("opacity-0");
  });

  it("kebab button has no group-hover:opacity-100 modifier", () => {
    const { container } = render(<MemberRow {...defaultProps} isConvenor={true} />);
    expect(container.innerHTML).not.toContain("group-hover:opacity-100");
  });

  it("clicking the kebab opens a dropdown with a Remove item", () => {
    render(<MemberRow {...defaultProps} isConvenor={true} />);
    const btn = screen.getByRole("button", { name: /row menu/i });
    fireEvent.click(btn);
    // Dropdown must contain a Remove option
    const item = screen.getByRole("menuitem");
    expect(item).toBeTruthy();
    expect(item.textContent?.toLowerCase()).toContain("remove");
  });

  it("kebab is only rendered when isConvenor=true (defence-in-depth)", () => {
    render(<MemberRow {...defaultProps} isConvenor={false} />);
    expect(screen.queryByRole("button", { name: /row menu/i })).toBeNull();
  });

  it("Remove item triggers onRemove prop", () => {
    const onRemove = vi.fn();
    render(<MemberRow {...defaultProps} isConvenor={true} onRemove={onRemove} />);
    const btn = screen.getByRole("button", { name: /row menu/i });
    fireEvent.click(btn);
    const removeItem = screen.getByRole("menuitem");
    fireEvent.click(removeItem);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("menu closes on outside click", () => {
    render(
      <div>
        <MemberRow {...defaultProps} isConvenor={true} />
        <button data-testid="outside">Outside</button>
      </div>
    );
    const btn = screen.getByRole("button", { name: /row menu/i });
    fireEvent.click(btn);
    // dropdown is open
    expect(screen.getByRole("menuitem")).toBeTruthy();
    // simulate mousedown outside
    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
