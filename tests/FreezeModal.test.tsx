// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FreezeModal } from "~/components/ui/FreezeModal";

const baseProps = {
  isActive: false,
  hasError: false,
  isOwner: false,
  heading: "Heading",
  bodyOwner: "Body for owner",
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

  it("renders nothing when isOwner=true", () => {
    // FreezeModal returns null for owners regardless of isActive — see the
    // component's block comment.
    const { container } = render(
      <FreezeModal {...baseProps} isActive={true} isOwner={true} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows bodyCollaborator when isOwner=false", () => {
    render(<FreezeModal {...baseProps} isActive={true} isOwner={false} />);
    expect(screen.getByText("Body for collaborator")).toBeTruthy();
    expect(screen.queryByText("Body for owner")).toBeNull();
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
