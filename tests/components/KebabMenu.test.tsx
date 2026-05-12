// @vitest-environment jsdom

/**
 * This file pins the KebabMenu primitive's contract: keyboard nav,
 * outside-click dismissal, Escape returns focus to the trigger,
 * destructive items render in `text-terracotta`, the single-open
 * invariant across multiple menus, and listener cleanup on unmount.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { KebabMenu } from "~/components/ui/KebabMenu";

afterEach(() => {
  cleanup();
});

function buildItems(overrides: any[] = []) {
  return [
    { label: "Open", onClick: vi.fn() },
    { label: "Settings", onClick: vi.fn() },
    { label: "Delete", onClick: vi.fn(), destructive: true },
    ...overrides,
  ];
}

describe("KebabMenu primitive", () => {
  it("renders trigger button with aria-haspopup='menu' and aria-expanded='false' initially", () => {
    const { getByLabelText } = render(
      <KebabMenu items={buildItems()} ariaLabel="Project actions" />,
    );
    const trigger = getByLabelText("Project actions");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("click trigger opens the popover (aria-expanded='true'); first item gets focus", async () => {
    const { getByLabelText, getByRole } = render(
      <KebabMenu items={buildItems()} ariaLabel="Project actions" />,
    );
    const trigger = getByLabelText("Project actions");
    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = getByRole("menu");
    expect(menu).not.toBeNull();

    // Focus moves on requestAnimationFrame; wait a microtask + frame.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBe(3);
    expect(document.activeElement).toBe(items[0]);
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    const { getByLabelText } = render(
      <KebabMenu items={buildItems()} ariaLabel="Project actions" />,
    );
    const trigger = getByLabelText("Project actions");
    fireEvent.click(trigger);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("click outside closes the menu", async () => {
    const { getByLabelText, container } = render(
      <div>
        <KebabMenu items={buildItems()} ariaLabel="Project actions" />
        <button data-testid="outside">outside</button>
      </div>,
    );
    const trigger = getByLabelText("Project actions");
    fireEvent.click(trigger);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const outside = container.querySelector(
      '[data-testid="outside"]',
    ) as HTMLElement;
    fireEvent.mouseDown(outside);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Arrow Down cycles to next item; Arrow Up cycles to previous; disabled items are skipped", async () => {
    const items = [
      { label: "First", onClick: vi.fn() },
      { label: "Disabled", onClick: vi.fn(), disabled: true },
      { label: "Third", onClick: vi.fn() },
    ];
    const { getByLabelText, getByRole } = render(
      <KebabMenu items={items} ariaLabel="Project actions" />,
    );
    fireEvent.click(getByLabelText("Project actions"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const menu = getByRole("menu");
    const menuItems = menu.querySelectorAll('[role="menuitem"]');

    // Arrow Down from index 0: skip disabled (1) → land on 2 (Third)
    fireEvent.keyDown(menuItems[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItems[2]);

    // Arrow Down again wraps to 0 (skipping disabled 1)
    fireEvent.keyDown(menuItems[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItems[0]);

    // Arrow Up from 0: wrap to 2
    fireEvent.keyDown(menuItems[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(menuItems[2]);
  });

  it("Enter on a focused item activates it then closes the menu", async () => {
    const onOpenClick = vi.fn();
    const items = [
      { label: "Open", onClick: onOpenClick },
      { label: "Other", onClick: vi.fn() },
    ];
    const { getByLabelText, getByRole } = render(
      <KebabMenu items={items} ariaLabel="Project actions" />,
    );
    const trigger = getByLabelText("Project actions");
    fireEvent.click(trigger);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const menuItems = getByRole("menu").querySelectorAll(
      '[role="menuitem"]',
    );
    fireEvent.keyDown(menuItems[0], { key: "Enter" });

    expect(onOpenClick).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("destructive items have text-terracotta class (not bg-terracotta)", () => {
    const { getByLabelText, getByRole } = render(
      <KebabMenu items={buildItems()} ariaLabel="Project actions" />,
    );
    fireEvent.click(getByLabelText("Project actions"));
    const menu = getByRole("menu");
    const items = menu.querySelectorAll('[role="menuitem"]');
    const destructive = items[2] as HTMLElement;
    expect(destructive.className).toContain("text-terracotta");
    expect(destructive.className).not.toContain("bg-terracotta");
  });

  it("popover has role='menu' and items have role='menuitem'", () => {
    const { getByLabelText, getByRole } = render(
      <KebabMenu items={buildItems()} ariaLabel="Project actions" />,
    );
    fireEvent.click(getByLabelText("Project actions"));
    const menu = getByRole("menu");
    expect(menu).not.toBeNull();
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBe(3);
  });

  it("opening a second KebabMenu closes the first (single-open invariant)", async () => {
    const { getAllByLabelText } = render(
      <div>
        <KebabMenu items={buildItems()} ariaLabel="Menu A" />
        <KebabMenu items={buildItems()} ariaLabel="Menu B" />
      </div>,
    );
    const triggerA = getAllByLabelText("Menu A")[0];
    const triggerB = getAllByLabelText("Menu B")[0];

    fireEvent.click(triggerA);
    expect(triggerA.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(triggerB);
    expect(triggerA.getAttribute("aria-expanded")).toBe("false");
    expect(triggerB.getAttribute("aria-expanded")).toBe("true");
  });

  it("removes document mousedown + keydown listeners on unmount (no leak)", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { getByLabelText, unmount } = render(
      <KebabMenu items={buildItems()} ariaLabel="Project actions" />,
    );
    fireEvent.click(getByLabelText("Project actions"));

    const addedKeys = addSpy.mock.calls.map((c) => c[0]);
    expect(addedKeys).toContain("mousedown");
    expect(addedKeys).toContain("keydown");

    unmount();

    const removedKeys = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedKeys).toContain("mousedown");
    expect(removedKeys).toContain("keydown");

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
