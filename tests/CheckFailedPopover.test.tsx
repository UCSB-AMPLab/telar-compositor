// @vitest-environment jsdom
/**
 * The bodies of the pill's failed-check and first-publish states. The
 * failed-check popover says what happened and that publishing waits, and its
 * Try again asks for a recheck and is disabled while one runs. The
 * first-publish popover states what the first publish does to the files and
 * has no action.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { CheckFailedPopover } from "~/components/features/site-status/popovers/CheckFailedPopover";
import { FirstPublishPopover } from "~/components/features/site-status/popovers/FirstPublishPopover";

describe("CheckFailedPopover", () => {
  it("shows the title, what happened, and that publishing waits", () => {
    render(<CheckFailedPopover onTryAgain={() => {}} />);
    expect(screen.getByText("check_failed.title")).toBeTruthy();
    expect(screen.getByText("check_failed.body")).toBeTruthy();
    expect(screen.getByText("check_failed.publish_line")).toBeTruthy();
  });

  it("Try again calls back once", () => {
    const onTryAgain = vi.fn();
    render(<CheckFailedPopover onTryAgain={onTryAgain} />);
    fireEvent.click(screen.getByRole("button", { name: "check_failed.try_again" }));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });

  it("Try again is disabled while a check is running", () => {
    const onTryAgain = vi.fn();
    render(<CheckFailedPopover onTryAgain={onTryAgain} busy />);
    const button = screen.getByRole("button", { name: "check_failed.try_again" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onTryAgain).not.toHaveBeenCalled();
  });
});

describe("FirstPublishPopover", () => {
  it("states what the first publish does to the files, with no action", () => {
    const { container } = render(<FirstPublishPopover />);
    expect(screen.getByText("first_publish.title")).toBeTruthy();
    expect(screen.getByText("first_publish.body")).toBeTruthy();
    expect(container.querySelector("button, a")).toBeNull();
  });
});
