/**
 * theme-tokens.test.ts — contract spec for the reader-preview theme token map
 * and its neutral fallback, implemented in `app/lib/theme-tokens.ts`.
 *
 * The preview pane is data-driven from a bundled token map keyed by theme_id,
 * covering the five shipped themes (trama, austin, neogranadina, paisajes,
 * santa-barbara). An unknown/custom/null theme_id falls back to a neutral
 * cream/charcoal token set. Hex values are transcribed from the framework
 * `_data/themes/*.yml`.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  THEME_TOKENS,
  NEUTRAL_FALLBACK,
  resolvePreviewTokens,
} from "~/lib/theme-tokens";

describe("THEME_TOKENS", () => {
  it("defines all five shipped theme keys", () => {
    expect(Object.keys(THEME_TOKENS).sort()).toEqual(
      ["austin", "neogranadina", "paisajes", "santa-barbara", "trama"].sort(),
    );
  });

  it("carries the exact trama hexes (bg cream, text charcoal, link terracotta)", () => {
    expect(THEME_TOKENS.trama.bg).toBe("#FFF6EF");
    expect(THEME_TOKENS.trama.text).toBe("#333333");
    expect(THEME_TOKENS.trama.link).toBe("#883C36");
  });

  it("carries the exact austin / neogranadina / paisajes / santa-barbara link hexes", () => {
    expect(THEME_TOKENS.austin.link).toBe("#BF5700");
    expect(THEME_TOKENS.neogranadina.link).toBe("#D35F3A");
    expect(THEME_TOKENS.paisajes.link).toBe("#8b4513");
    expect(THEME_TOKENS["santa-barbara"].link).toBe("#047C91");
  });

  it("exposes heading + body fonts for each theme", () => {
    for (const key of Object.keys(THEME_TOKENS)) {
      expect(THEME_TOKENS[key].headingFont).toBeTruthy();
      expect(THEME_TOKENS[key].bodyFont).toBeTruthy();
    }
  });
});

describe("resolvePreviewTokens", () => {
  it("returns the matching theme's tokens for a known theme_id", () => {
    expect(resolvePreviewTokens("trama")).toEqual(THEME_TOKENS.trama);
    expect(resolvePreviewTokens("santa-barbara")).toEqual(
      THEME_TOKENS["santa-barbara"],
    );
  });

  it("returns the neutral cream/charcoal fallback for an unknown theme_id", () => {
    expect(resolvePreviewTokens("not-a-theme")).toEqual(NEUTRAL_FALLBACK);
  });

  it("returns the neutral fallback for null/undefined theme_id", () => {
    expect(resolvePreviewTokens(null)).toEqual(NEUTRAL_FALLBACK);
    expect(resolvePreviewTokens(undefined)).toEqual(NEUTRAL_FALLBACK);
  });

  it("the neutral fallback is cream/charcoal", () => {
    expect(NEUTRAL_FALLBACK.bg).toBe("#FFF6EF");
    expect(NEUTRAL_FALLBACK.text).toBe("#333333");
  });
});
