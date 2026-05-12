// @vitest-environment jsdom
/**
 * This file pins the error-capture buffer's behaviour: append newest-first,
 * cap at five entries via FIFO eviction, redact each message before
 * storing, and never double-attach the global error listener.
 *
 * @version v1.2.0-beta
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordError,
  getRecentErrors,
  clearErrors,
  attachListeners,
  __resetForTests,
} from "../app/lib/error-capture";

beforeEach(() => {
  __resetForTests();
});

describe("error-capture", () => {
  it("starts with an empty buffer", () => {
    expect(getRecentErrors()).toEqual([]);
  });

  it("appends new errors newest-first", () => {
    recordError(new Error("first"), "error");
    recordError(new Error("second"), "error");
    const errors = getRecentErrors();
    expect(errors[0].message).toContain("second");
    expect(errors[1].message).toContain("first");
  });

  it("evicts the oldest when capacity 5 is exceeded (FIFO)", () => {
    for (let i = 0; i < 7; i++) recordError(new Error(`e${i}`), "error");
    const errors = getRecentErrors();
    expect(errors).toHaveLength(5);
    expect(errors[0].message).toContain("e6");
    expect(errors[4].message).toContain("e2");
    expect(errors.find((e) => e.message.includes("e0"))).toBeUndefined();
    expect(errors.find((e) => e.message.includes("e1"))).toBeUndefined();
  });

  it("applies redact() to message before storing", () => {
    recordError(new Error("contact admin@example.com"), "error");
    expect(getRecentErrors()[0].message).toContain("<email>");
    expect(getRecentErrors()[0].message).not.toContain("admin@example.com");
  });

  it("applies redact() to stack before storing", () => {
    const e = new Error("boom");
    e.stack =
      "Error: boom\n  at fn (Bearer eyJabc.def.ghi)";
    recordError(e, "error");
    const stored = getRecentErrors()[0];
    expect(stored.stack).toBeDefined();
    expect(stored.stack!).not.toMatch(/eyJ/);
    expect(stored.stack!).toContain("Bearer <token>");
  });

  it("clearErrors() empties the buffer", () => {
    recordError(new Error("x"), "error");
    clearErrors();
    expect(getRecentErrors()).toEqual([]);
  });

  it("attachListeners() is idempotent — second call does NOT register a second 'error' listener", () => {
    const spy = vi.spyOn(window, "addEventListener");
    attachListeners();
    const callsAfterFirst = spy.mock.calls.filter(
      (c) => (c[0] as string) === "error",
    ).length;
    attachListeners();
    const callsAfterSecond = spy.mock.calls.filter(
      (c) => (c[0] as string) === "error",
    ).length;
    expect(callsAfterSecond).toBe(callsAfterFirst);
    spy.mockRestore();
  });

  it("attachListeners() registers BOTH 'error' and 'unhandledrejection' on window", () => {
    const spy = vi.spyOn(window, "addEventListener");
    attachListeners();
    const events = spy.mock.calls.map((c) => c[0] as string);
    expect(events).toContain("error");
    expect(events).toContain("unhandledrejection");
    spy.mockRestore();
  });

  it("recordError accepts an unknown (non-Error) input without throwing", () => {
    expect(() => recordError("plain string", "error")).not.toThrow();
    expect(() =>
      recordError({ unusual: "object" }, "unhandledrejection"),
    ).not.toThrow();
    expect(() => recordError(undefined, "boundary")).not.toThrow();
  });
});
