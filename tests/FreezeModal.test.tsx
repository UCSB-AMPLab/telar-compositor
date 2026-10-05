// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FreezeModal } from "~/components/ui/FreezeModal";

const baseProps = {
  isActive: false,
  hasError: false,
  heading: "Heading",
  bodyCollaborator: "Body for collaborator",
  errorHeading: "Error heading",
  errorBody: "Error body",
  dismissLabel: "Dismiss",
  onDismiss: () => {},
};

describe("FreezeModal", () => {
  it("renders nothing when isActive=false and hasError=false", () => {
    const { container } = render(<FreezeModal {...baseProps} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders heading and spinner when isActive=true", () => {
    render(<FreezeModal {...baseProps} isActive={true} />);
    expect(screen.getByText("Heading")).toBeTruthy();
    // Loader2 has animate-spin class
    const svg = document.querySelector(".animate-spin");
    expect(svg).toBeTruthy();
  });

  it("shows bodyCollaborator while active", () => {
    render(<FreezeModal {...baseProps} isActive={true} />);
    expect(screen.getByText("Body for collaborator")).toBeTruthy();
  });

  it("renders error state when hasError=true", () => {
    render(<FreezeModal {...baseProps} hasError={true} />);
    expect(screen.getByText("Error heading")).toBeTruthy();
    expect(screen.getByText("Error body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    // No spinner in error state
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("fires onDismiss when dismiss button clicked", () => {
    const onDismiss = vi.fn();
    render(<FreezeModal {...baseProps} hasError={true} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("error state takes precedence over active state", () => {
    render(<FreezeModal {...baseProps} isActive={true} hasError={true} />);
    expect(screen.getByText("Error heading")).toBeTruthy();
    expect(screen.queryByText("Heading")).toBeNull();
  });

  it("has role=dialog and aria-modal=true", () => {
    render(<FreezeModal {...baseProps} isActive={true} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("aria-labelledby points at heading with provided labelId", () => {
    render(<FreezeModal {...baseProps} isActive={true} labelId="test-heading" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("test-heading");
    expect(document.getElementById("test-heading")).toBeTruthy();
  });
});
