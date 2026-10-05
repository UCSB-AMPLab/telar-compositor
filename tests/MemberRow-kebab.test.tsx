// @vitest-environment jsdom
/**
 * This file pins the `MemberRow` kebab-menu contract — the always-visible
 * MoreVertical icon that replaced the older hover-only X button so
 * collaborators on touch devices have a discoverable remove affordance.
 *
 * Tests: always-visible icon, dropdown open/close, Remove callback,
 * defence-in-depth isConvenor guard, outside-click dismissal.
 *
 * @version v1.5.0-beta
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
    const btn = screen.getByRole("button", { name: /row_menu_aria/i });
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
    const btn = screen.getByRole("button", { name: /row_menu_aria/i });
    fireEvent.click(btn);
    // Dropdown must contain a Remove option
    const item = screen.getByRole("menuitem");
    expect(item).toBeTruthy();
    expect(item.textContent?.toLowerCase()).toContain("remove");
  });

  it("kebab is only rendered when isConvenor=true (defence-in-depth for non-convenor accidental clicks)", () => {
    render(<MemberRow {...defaultProps} isConvenor={false} />);
    expect(screen.queryByRole("button", { name: /row_menu_aria/i })).toBeNull();
  });

  it("Remove item triggers onRemove prop", () => {
    const onRemove = vi.fn();
    render(<MemberRow {...defaultProps} isConvenor={true} onRemove={onRemove} />);
    const btn = screen.getByRole("button", { name: /row_menu_aria/i });
    fireEvent.click(btn);
    const removeItem = screen.getByRole("menuitem");
    fireEvent.click(removeItem);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Instructor rows — the kebab shows only on the course project itself
  // (design §5: course-management, including removing staff, belongs to
  // the course project's own member list; instructor membership on a
  // child is tied to the course and can only end by leaving it).
  // ---------------------------------------------------------------------

  it("hides the kebab for an instructor row when isCourseProject is false (a child site)", () => {
    render(
      <MemberRow
        {...defaultProps}
        role="instructor"
        isConvenor={true}
        isCourseProject={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /row_menu_aria/i })).toBeNull();
  });

  it("shows the kebab for an instructor row when isCourseProject is true (the course project's own list)", () => {
    render(
      <MemberRow
        {...defaultProps}
        role="instructor"
        isConvenor={true}
        isCourseProject={true}
      />,
    );
    expect(screen.getByRole("button", { name: /row_menu_aria/i })).toBeTruthy();
  });

  it("defaults isCourseProject to false — an instructor row's kebab does not show when the prop is simply omitted", () => {
    render(<MemberRow {...defaultProps} role="instructor" isConvenor={true} />);
    expect(screen.queryByRole("button", { name: /row_menu_aria/i })).toBeNull();
  });

  it("a collaborator row's kebab is unaffected by isCourseProject — still shows regardless", () => {
    render(
      <MemberRow
        {...defaultProps}
        role="collaborator"
        isConvenor={true}
        isCourseProject={false}
      />,
    );
    expect(screen.getByRole("button", { name: /row_menu_aria/i })).toBeTruthy();
  });

  it("an instructor row on the course project still hides the kebab for a non-convenor viewer", () => {
    render(
      <MemberRow
        {...defaultProps}
        role="instructor"
        isConvenor={false}
        isCourseProject={true}
      />,
    );
    expect(screen.queryByRole("button", { name: /row_menu_aria/i })).toBeNull();
  });

  it("menu closes on outside click", () => {
    render(
      <div>
        <MemberRow {...defaultProps} isConvenor={true} />
        <button data-testid="outside">Outside</button>
      </div>
    );
    const btn = screen.getByRole("button", { name: /row_menu_aria/i });
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
