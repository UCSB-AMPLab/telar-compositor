// @vitest-environment jsdom
/**
 * use-escape-to-close.test.tsx — unit tests for the useEscapeToClose hook.
 *
 * Covers: no listener when disabled, Escape fires the callback with the
 * event when enabled, non-Escape keys are ignored, the listener is removed
 * on unmount, and the callback ref stays current across re-renders without
 * re-subscribing the listener (mirrors the six sites this hook replaces).
 */

import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEscapeToClose } from "~/hooks/use-escape-to-close";

describe("useEscapeToClose", () => {
  it("does not attach a listener when enabled is false", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeToClose(onEscape, false));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("calls onEscape with the event when Escape is pressed while enabled", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeToClose(onEscape, true));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onEscape.mock.calls[0][0]).toBeInstanceOf(KeyboardEvent);
  });

  it("defaults enabled to true when omitted", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeToClose(onEscape));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Escape keys", () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeToClose(onEscape, true));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", () => {
    const onEscape = vi.fn();
    const { unmount } = renderHook(() => useEscapeToClose(onEscape, true));
    unmount();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("re-attaches the listener when enabled toggles false -> true", () => {
    const onEscape = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useEscapeToClose(onEscape, enabled),
      { initialProps: { enabled: false } },
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onEscape).not.toHaveBeenCalled();

    rerender({ enabled: true });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("uses the latest onEscape without re-subscribing on every render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => useEscapeToClose(fn, true),
      { initialProps: { fn: first } },
    );
    rerender({ fn: second });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
