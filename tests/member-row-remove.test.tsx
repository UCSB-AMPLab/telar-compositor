// @vitest-environment jsdom
/**
 * Tests that MemberRow threads `userId` to the kebab so that
 * `onRemoveRequest` is called with `{ userId, username }` when the
 * Remove item is clicked.
 *
 * Pre-fix: userId never reached MemberRowKebab, so the guard fell
 * through to onRemove?.() (undefined) — nothing happened.
 * Post-fix: userId is passed as a prop and the correct branch fires.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemberRow } from "~/components/features/dashboard/MemberRow";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("MemberRow — sidebar Remove button threads userId", () => {
  it("calls onRemoveRequest with { userId, username } when Remove is clicked", () => {
    const onRemoveRequest = vi.fn();
    const userId = 42;
    const username = "bob";

    render(
      <MemberRow
        githubId={999}
        username={username}
        role="collaborator"
        isPending={false}
        isCurrentUserOwner={true}
        isConvenor={true}
        userId={userId}
        onRemoveRequest={onRemoveRequest}
      />
    );

    // Open the kebab menu
    const kebab = screen.getByRole("button", { name: /row_menu_aria/i });
    fireEvent.click(kebab);

    // Click the Remove item
    const removeItem = screen.getByRole("menuitem");
    fireEvent.click(removeItem);

    expect(onRemoveRequest).toHaveBeenCalledOnce();
    expect(onRemoveRequest).toHaveBeenCalledWith({ userId, username });
  });
});
