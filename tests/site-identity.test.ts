/**
 * site-identity.test.ts — pure, browser-safe identity helpers shared by the
 * create-site server path and the creation wizard UI.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  humanizeSlug,
  deriveSiteUrl,
  normalizeTheme,
  VALID_THEMES,
  DEFAULT_THEME,
  THEME_META,
} from "~/lib/site-identity";

describe("humanizeSlug", () => {
  it("splits on separators and title-cases", () => {
    expect(humanizeSlug("my-cool_site.archive")).toBe("My Cool Site Archive");
  });
  it("collapses repeats and trims", () => {
    expect(humanizeSlug("--my--site--")).toBe("My Site");
  });
  it("falls back to the raw slug when separators-only would yield empty", () => {
    expect(humanizeSlug("_")).toBe("_");
  });
});

describe("deriveSiteUrl", () => {
  it("lowercases the owner host but preserves the repo-name case", () => {
    expect(deriveSiteUrl("My-Org", "My-Archive")).toBe(
      "https://my-org.github.io/My-Archive",
    );
  });
  it("formats a simple owner/name", () => {
    expect(deriveSiteUrl("juancobo", "my-archive")).toBe(
      "https://juancobo.github.io/my-archive",
    );
  });
});

describe("normalizeTheme", () => {
  it("passes through every valid theme", () => {
    for (const t of VALID_THEMES) expect(normalizeTheme(t)).toBe(t);
  });
  it("falls back to the default for the hidden custom theme", () => {
    expect(normalizeTheme("custom")).toBe(DEFAULT_THEME);
  });
  it("falls back to the default for unknown/empty/non-string input", () => {
    expect(normalizeTheme("nope")).toBe(DEFAULT_THEME);
    expect(normalizeTheme("")).toBe(DEFAULT_THEME);
    expect(normalizeTheme(null)).toBe(DEFAULT_THEME);
    expect(normalizeTheme(undefined)).toBe(DEFAULT_THEME);
  });
});

describe("THEME_META", () => {
  it("has exactly one entry per valid theme, in order", () => {
    expect(THEME_META.map((m) => m.id)).toEqual([...VALID_THEMES]);
  });
  it("gives every theme three signature swatch colours", () => {
    for (const m of THEME_META) {
      expect(m.swatches).toHaveLength(3);
      for (const c of m.swatches) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
  it("marks the three institution themes as partner themes", () => {
    const partners = THEME_META.filter((m) => m.partner).map((m) => m.id);
    expect(partners).toEqual(["neogranadina", "santa-barbara", "austin"]);
  });
  it("default theme is a non-partner (general) theme", () => {
    const def = THEME_META.find((m) => m.id === DEFAULT_THEME);
    expect(def?.partner).toBe(false);
  });
});
