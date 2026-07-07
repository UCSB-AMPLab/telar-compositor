// @vitest-environment jsdom
/**
 * Pins the AccountModal — the "Choose where to create your site" dialog
 * extracted from StepConnect so the create-flow account picker (and its new
 * "install on another organisation" CTA) can be tested without rendering the
 * whole CreateSiteForm + fetcher stack.
 *
 * The i18n mock returns the key verbatim so assertions match on the key string.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const revalidateSpy = vi.fn();
vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate: revalidateSpy, state: "idle" }),
}));

import { AccountModal } from "~/components/features/onboarding/AccountModal";

const OPTIONS = [
  { installationId: 1, owner: "juancobo", targetType: "User" as const, isOwnAccount: true },
  { installationId: 2, owner: "Neogranadina", targetType: "Organization" as const, isOwnAccount: false },
];

function baseProps(over: Partial<Parameters<typeof AccountModal>[0]> = {}) {
  return {
    options: OPTIONS,
    activeInstallationId: 1,
    githubAppSlug: "telar-compositor",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...over,
  } as Parameters<typeof AccountModal>[0];
}

describe("AccountModal", () => {
  it("renders a row per installation option with the owner login", () => {
    render(<AccountModal {...baseProps()} />);
    expect(screen.getByText("juancobo")).toBeDefined();
    expect(screen.getByText("Neogranadina")).toBeDefined();
  });

  it("labels the personal account and organisation rows distinctly (bound to the right row)", () => {
    render(<AccountModal {...baseProps()} />);
    // The personal-account row carries the personal label, NOT the org label.
    const personalRow = screen.getByText("juancobo").closest("button") as HTMLElement;
    expect(personalRow.textContent).toMatch(/account_modal\.your_account_label/);
    expect(personalRow.textContent).not.toMatch(/account_modal\.organization_label/);
    // The org row carries the org label, NOT the personal label.
    const orgRow = screen.getByText("Neogranadina").closest("button") as HTMLElement;
    expect(orgRow.textContent).toMatch(/account_modal\.organization_label/);
    expect(orgRow.textContent).not.toMatch(/account_modal\.your_account_label/);
  });

  it("calls onSelect with the installation id when an account row is clicked", () => {
    const onSelect = vi.fn();
    render(<AccountModal {...baseProps({ onSelect })} />);
    fireEvent.click(screen.getByText("Neogranadina"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("renders the 'install on another organisation' CTA pointing at the app install page", () => {
    render(<AccountModal {...baseProps()} />);
    const cta = screen.getByText(/account_modal\.install_elsewhere_cta/);
    const link = cta.closest("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://github.com/apps/telar-compositor/installations/new");
    expect(link.getAttribute("target")).toBe("_blank");
    // And a hint explaining why someone would install elsewhere.
    expect(screen.getByText(/account_modal\.install_elsewhere_hint/)).toBeDefined();
  });

  it("revalidates the loader when the user returns after clicking install (so a new org appears)", () => {
    revalidateSpy.mockClear();
    render(<AccountModal {...baseProps()} />);
    fireEvent.click(screen.getByText(/account_modal\.install_elsewhere_cta/));
    // Nothing yet — only on return to the tab.
    expect(revalidateSpy).not.toHaveBeenCalled();
    fireEvent(window, new Event("focus"));
    expect(revalidateSpy).toHaveBeenCalledTimes(1);
    // One-shot: a second focus without another install click does not refire.
    fireEvent(window, new Event("focus"));
    expect(revalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus from the user when the parent re-renders", () => {
    // StepConnect passes an inline-arrow onClose (new identity each render). The
    // a11y effect must not re-run and yank focus back to the first focusable.
    const { rerender } = render(<AccountModal {...baseProps({ onClose: () => {} })} />);
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled])');
    const userTarget = focusables[focusables.length - 1] as HTMLElement;
    userTarget.focus();
    expect(document.activeElement).toBe(userTarget);
    rerender(<AccountModal {...baseProps({ onClose: () => {} })} />);
    expect(document.activeElement).toBe(userTarget);
  });

  it("removes the install focus listener on unmount (no leaked revalidate)", () => {
    revalidateSpy.mockClear();
    const { unmount } = render(<AccountModal {...baseProps()} />);
    fireEvent.click(screen.getByText(/account_modal\.install_elsewhere_cta/));
    unmount();
    fireEvent(window, new Event("focus"));
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("arming the install listener twice still revalidates only once on return", () => {
    revalidateSpy.mockClear();
    render(<AccountModal {...baseProps()} />);
    const cta = screen.getByText(/account_modal\.install_elsewhere_cta/);
    fireEvent.click(cta);
    fireEvent.click(cta);
    fireEvent(window, new Event("focus"));
    expect(revalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the cancel button is clicked", () => {
    const onClose = vi.fn();
    render(<AccountModal {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByText(/account_modal\.cancel/));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<AccountModal {...baseProps({ onClose })} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on a backdrop click but not on a click inside the dialog", () => {
    const onClose = vi.fn();
    render(<AccountModal {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByRole("dialog")); // inner panel — must NOT close
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", () => {
    render(<AccountModal {...baseProps()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("restores focus to the previously-focused element on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<AccountModal {...baseProps()} />);
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
