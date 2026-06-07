// @vitest-environment jsdom
/**
 * This file pins the `StatusPopoverShell` — the shared anchored container
 * every Site Status popover renders inside. It owns the open/dismiss
 * behaviour (outside-click overlay + Esc keydown) and the pixel-locked
 * 380px right-aligned geometry, so the per-state popovers stay pure content.
 *
 * Tests: renders nothing closed; renders children open; overlay click and
 * Escape both fire onClose; the container carries the 380px width, the
 * right-0 anchor, and z-50 over a z-40 overlay.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { StatusPopoverShell } from "~/components/features/site-status/StatusPopoverShell";

describe("StatusPopoverShell", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <StatusPopoverShell open={false} onClose={() => {}}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    // Closed: no children and no overlay in the DOM.
    expect(container.textContent).not.toContain("popover body");
    expect(container.querySelector(".fixed.inset-0")).toBeNull();
  });

  it("renders children inside the anchored container when open=true", () => {
    const { container, getByText } = render(
      <StatusPopoverShell open={true} onClose={() => {}}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    expect(getByText("popover body")).toBeTruthy();
    // The anchored popover container exists.
    expect(container.querySelector(".z-50")).not.toBeNull();
  });

  it("clicking the fixed-inset overlay calls onClose", () => {
    const onClose = vi.fn();
    const { container } = render(
      <StatusPopoverShell open={true} onClose={onClose}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    const overlay = container.querySelector(".fixed.inset-0");
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing Escape while open calls onClose", () => {
    const onClose = vi.fn();
    render(
      <StatusPopoverShell open={true} onClose={onClose}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClose on Escape when closed", () => {
    const onClose = vi.fn();
    render(
      <StatusPopoverShell open={false} onClose={onClose}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the popover container is 380px wide", () => {
    const { container } = render(
      <StatusPopoverShell open={true} onClose={() => {}}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    const popover = container.querySelector(".z-50") as HTMLElement | null;
    expect(popover).not.toBeNull();
    expect(popover?.style.width).toBe("380px");
  });

  it("the popover anchors right-0 (not left-0) at z-50 over a z-40 overlay", () => {
    const { container } = render(
      <StatusPopoverShell open={true} onClose={() => {}}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    const overlay = container.querySelector(".fixed.inset-0");
    expect(overlay?.className).toContain("z-40");

    const popover = container.querySelector(".z-50");
    expect(popover?.className).toContain("right-0");
    expect(popover?.className).not.toContain("left-0");
    expect(popover?.className).toContain("absolute");
    expect(popover?.className).toContain("top-full");
    expect(popover?.className).toContain("mt-2");
  });

  it("carries the exact drop shadow", () => {
    const { container } = render(
      <StatusPopoverShell open={true} onClose={() => {}}>
        <p>popover body</p>
      </StatusPopoverShell>,
    );
    const popover = container.querySelector(".z-50") as HTMLElement | null;
    // Exact artboard-locked shadow (off the Tailwind scale → inline style).
    expect(popover?.style.boxShadow).toContain("0 12px 32px -8px");
    expect(popover?.style.boxShadow).toContain("0 6px 12px -6px");
  });
});
