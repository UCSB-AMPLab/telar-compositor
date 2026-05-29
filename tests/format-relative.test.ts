import { describe, it, expect } from "vitest";
import { formatRelative } from "../app/lib/format-relative";

// A fixed reference "now" so every assertion is deterministic — the whole
// point of the post-fix contract is that output depends ONLY on
// (isoString, now, locale), never on the ambient clock, locale, or timezone.
const NOW = Date.UTC(2026, 4, 28, 12, 0, 0); // 2026-05-28T12:00:00Z
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatRelative (deterministic, localized)", () => {
  it("returns neverLabel for null/undefined input", () => {
    expect(formatRelative(null, { now: NOW })).toBe("");
    expect(formatRelative(undefined, { now: NOW })).toBe("");
    expect(formatRelative(null, { now: NOW, neverLabel: "Never" })).toBe("Never");
  });

  it("returns neverLabel for an unparseable timestamp", () => {
    expect(formatRelative("not-a-date", { now: NOW, neverLabel: "Never" })).toBe("Never");
  });

  it("localizes recent relative times in English", () => {
    expect(formatRelative(ago(5 * M), { now: NOW, locale: "en" })).toBe("5 minutes ago");
    expect(formatRelative(ago(3 * H), { now: NOW, locale: "en" })).toBe("3 hours ago");
    expect(formatRelative(ago(3 * D), { now: NOW, locale: "en" })).toBe("3 days ago");
    expect(formatRelative(ago(14 * D), { now: NOW, locale: "en" })).toBe("2 weeks ago");
  });

  it("localizes recent relative times in Spanish (incl. idioms via numeric:auto)", () => {
    expect(formatRelative(ago(5 * M), { now: NOW, locale: "es" })).toBe("hace 5 minutos");
    expect(formatRelative(ago(3 * H), { now: NOW, locale: "es" })).toBe("hace 3 horas");
    expect(formatRelative(ago(3 * D), { now: NOW, locale: "es" })).toBe("hace 3 días");
    // numeric:"auto" yields locale idioms — Spanish has a word for -2 days.
    expect(formatRelative(ago(2 * D), { now: NOW, locale: "es" })).toBe("anteayer");
  });

  it("renders an absolute date beyond 30 days, locale-aware and UTC-pinned", () => {
    // > 30 days before NOW. The UTC pin makes this identical regardless of the
    // host timezone — the exact property the locale-dependent toLocaleDateString
    // bug violated (server UTC date vs client local date → hydration mismatch).
    const iso = "2026-03-01T02:00:00Z";
    expect(formatRelative(iso, { now: NOW, locale: "en" })).toBe("Mar 1, 2026");
    expect(formatRelative(iso, { now: NOW, locale: "es" })).toMatch(/^1 mar\.? 2026$/);
  });

  it("is a pure function — identical inputs yield identical output", () => {
    const iso = ago(45 * D);
    expect(formatRelative(iso, { now: NOW, locale: "en" })).toBe(
      formatRelative(iso, { now: NOW, locale: "en" }),
    );
    // ...and never falls back to the host-locale toLocaleDateString.
    expect(formatRelative(iso, { now: NOW, locale: "en" })).not.toBe(
      new Date(iso).toLocaleDateString(),
    );
  });
});
