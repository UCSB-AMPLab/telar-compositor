// @vitest-environment jsdom
/**
 * inline-text-field.test.tsx — unit tests for InlineTextField component.
 *
 * Tests: render with initialValue, input change, debounce timer (1500ms),
 * and sync when initialValue prop changes (DATA-01 behaviour).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { InlineTextField } from "~/components/ui/InlineTextField";

// Mock react-router's useFetcher — we only care about the submit call
const mockSubmit = vi.fn();
vi.mock("react-router", () => ({
  useFetcher: () => ({ submit: mockSubmit, state: "idle", data: null }),
}));

describe("InlineTextField", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSubmit.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with the initial value", () => {
    render(
      <InlineTextField
        initialValue="Hello world"
        fieldName="title"
        entityId={42}
        intent="autosave-story-field"
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Hello world");
  });

  it("updates the displayed value when the user types", () => {
    render(
      <InlineTextField
        initialValue=""
        fieldName="title"
        entityId={42}
        intent="autosave-story-field"
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New title" } });
    expect(input.value).toBe("New title");
  });

  it("does not submit immediately on change", () => {
    render(
      <InlineTextField
        initialValue=""
        fieldName="title"
        entityId={42}
        intent="autosave-story-field"
      />
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Typing…" } });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("submits after 1500ms debounce", () => {
    render(
      <InlineTextField
        initialValue=""
        fieldName="title"
        entityId={42}
        intent="autosave-story-field"
      />
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Final value" } });

    // Should not submit before debounce
    vi.advanceTimersByTime(1400);
    expect(mockSubmit).not.toHaveBeenCalled();

    // Should submit after 1500ms
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(mockSubmit).toHaveBeenCalledOnce();
    expect(mockSubmit).toHaveBeenCalledWith(
      { intent: "autosave-story-field", field: "title", value: "Final value", entityId: "42" },
      { method: "post" }
    );
  });

  it("resets the debounce timer when the user keeps typing", () => {
    render(
      <InlineTextField
        initialValue=""
        fieldName="title"
        entityId={42}
        intent="autosave-story-field"
      />
    );
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "First" } });
    vi.advanceTimersByTime(1000);
    fireEvent.change(input, { target: { value: "Second" } });
    vi.advanceTimersByTime(1000);

    // 2000ms total elapsed but debounce was reset at 1000ms — no submit yet
    expect(mockSubmit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockSubmit).toHaveBeenCalledOnce();
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ value: "Second" }),
      expect.any(Object)
    );
  });

  it("syncs displayed value when initialValue prop changes", () => {
    const { rerender } = render(
      <InlineTextField
        initialValue="Original"
        fieldName="title"
        entityId={42}
        intent="autosave-story-field"
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Original");

    rerender(
      <InlineTextField
        initialValue="Updated from server"
        fieldName="title"
        entityId={42}
        intent="autosave-story-field"
      />
    );
    expect(input.value).toBe("Updated from server");
  });
});
