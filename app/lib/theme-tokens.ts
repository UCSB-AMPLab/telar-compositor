/**
 * This file holds the static reader-preview token map for the glossary
 * editor's preview pane. The preview shows a term's definition roughly as it
 * will render on the published site, so it needs the published theme's
 * background, text, link, and font choices.
 *
 * The preview is data-driven from this bundled map keyed by `theme_id`,
 * covering the five shipped themes (trama, austin, neogranadina, paisajes,
 * santa-barbara). An unknown, custom, empty, or null theme_id falls back to a
 * neutral cream/charcoal token set with the app's own heading/body font vars
 * and an anil-ink link — so a hand-edited or future theme never breaks the
 * preview, it just renders neutrally.
 *
 * The hex / font values are transcribed from the framework
 * `_data/themes/*.yml` and verified against them.
 *
 * Exports:
 *   - `GlossaryPreviewTokens` — the per-theme token shape
 *   - `THEME_TOKENS` — the five shipped themes
 *   - `NEUTRAL_FALLBACK` — the cream/charcoal neutral set
 *   - `resolvePreviewTokens(themeId)` — lookup with neutral fallback
 *
 * @version v1.3.0-beta
 */

export interface GlossaryPreviewTokens {
  /** Page / panel background. */
  bg: string;
  /** Body text colour. */
  text: string;
  /** Inline glossary-link colour. */
  link: string;
  /** Heading font stack. */
  headingFont: string;
  /** Body font stack. */
  bodyFont: string;
}

/**
 * The five shipped themes, keyed by `theme_id`. Values transcribed from the
 * framework `_data/themes/*.yml` and verified against them.
 */
export const THEME_TOKENS: Record<string, GlossaryPreviewTokens> = {
  trama: {
    bg: "#FFF6EF",
    text: "#333333",
    link: "#883C36",
    headingFont: "'Space Grotesk', sans-serif",
    bodyFont: "'Roboto Condensed', sans-serif",
  },
  austin: {
    bg: "#D6D2C4",
    text: "#333F48",
    link: "#BF5700",
    headingFont: "'Crimson Pro', serif",
    bodyFont: "'Inter', sans-serif",
  },
  neogranadina: {
    bg: "#F5F7FA",
    text: "#2A2F36",
    link: "#D35F3A",
    headingFont: "'IM Fell DW Pica', serif",
    bodyFont: "'Mulish', sans-serif",
  },
  paisajes: {
    bg: "#F5EDE1",
    text: "#333333",
    link: "#8b4513",
    headingFont: "'Playfair Display', serif",
    bodyFont: "'Source Sans Pro', sans-serif",
  },
  "santa-barbara": {
    bg: "#F1EEEA",
    text: "#333333",
    link: "#047C91",
    headingFont: "'Roboto Serif', serif",
    bodyFont: "'Nunito Sans', sans-serif",
  },
};

/**
 * Neutral cream/charcoal fallback for unknown / custom / null theme_ids. Uses
 * the app's own heading/body font vars and an anil-ink link.
 */
export const NEUTRAL_FALLBACK: GlossaryPreviewTokens = {
  bg: "#FFF6EF",
  text: "#333333",
  link: "#2E3F6E",
  headingFont: "var(--font-heading)",
  bodyFont: "var(--font-body)",
};

/**
 * resolvePreviewTokens — return the matching theme's tokens for a known
 * theme_id, or the neutral fallback when the theme_id is null / undefined /
 * empty / unrecognised. Mirrors the lookup-with-fallback shape of
 * `detectThemeAlert` in `theme-recognition.ts`.
 */
export function resolvePreviewTokens(
  themeId: string | null | undefined,
): GlossaryPreviewTokens {
  if (!themeId) return NEUTRAL_FALLBACK;
  return THEME_TOKENS[themeId] ?? NEUTRAL_FALLBACK;
}
