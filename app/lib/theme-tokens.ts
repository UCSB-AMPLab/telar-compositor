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
 * The framing stage draws the step card, its button and the layer panels in
 * the published theme, so the same map carries each theme's heading, body,
 * button and panel colours as well. `tests/framing-stage-parity.test.ts`
 * reads them back from the framework's YAML.
 *
 * Exports:
 *   - `GlossaryPreviewTokens` — the per-theme token shape
 *   - `THEME_TOKENS` — the five shipped themes
 *   - `NEUTRAL_FALLBACK` — the cream/charcoal neutral set
 *   - `resolvePreviewTokens(themeId)` — lookup with neutral fallback
 *   - `StageThemeColours`, `STAGE_THEME_COLOURS` — the stage's colours per theme
 *
 * @version v1.5.0-beta
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

/**
 * The colours the published story page draws its card, button and layer
 * panels in, per theme: `colors.text` and `colors.background` in the
 * framework's `_data/themes/*.yml`.
 */
export interface StageThemeColours {
  heading: string;
  body: string;
  link: string;
  buttonText: string;
  buttonBg: string;
  panelLayer1Text: string;
  panelLayer1Bg: string;
  panelLayer2Text: string;
  panelLayer2Bg: string;
}

/** The five shipped themes, keyed by `theme_id`, as their YAML spells each hex. */
export const STAGE_THEME_COLOURS: Record<string, StageThemeColours> = {
  trama: {
    heading: "#333333",
    body: "#333333",
    link: "#883C36",
    buttonText: "#FFFFFF",
    buttonBg: "#883C36",
    panelLayer1Text: "#333333",
    panelLayer1Bg: "#C6D0F8",
    panelLayer2Text: "#FFFFFF",
    panelLayer2Bg: "#883C36",
  },
  austin: {
    heading: "#BF5700",
    body: "#333F48",
    link: "#BF5700",
    buttonText: "#FFFFFF",
    buttonBg: "#BF5700",
    panelLayer1Text: "#333F48",
    panelLayer1Bg: "#9CADB7",
    panelLayer2Text: "#FFFFFF",
    panelLayer2Bg: "#577565",
  },
  neogranadina: {
    heading: "#000000",
    body: "#6C7A89",
    link: "#D35F3A",
    buttonText: "#FFFFFF",
    buttonBg: "#2A2F36",
    panelLayer1Text: "#FFFFFF",
    panelLayer1Bg: "#00b35c",
    panelLayer2Text: "#FFFFFF",
    panelLayer2Bg: "#b31235",
  },
  paisajes: {
    heading: "#2c3e50",
    body: "#333333",
    link: "#8b4513",
    buttonText: "#FFFFFF",
    buttonBg: "#2c3e50",
    panelLayer1Text: "#2c3e50",
    panelLayer1Bg: "#A8C5D4",
    panelLayer2Text: "#FFFFFF",
    panelLayer2Bg: "#3d2645",
  },
  "santa-barbara": {
    heading: "#003660",
    body: "#333333",
    link: "#047C91",
    buttonText: "#FFFFFF",
    buttonBg: "#FEBC11",
    panelLayer1Text: "#FFFFFF",
    panelLayer1Bg: "#047C91",
    panelLayer2Text: "#FFFFFF",
    panelLayer2Bg: "#003660",
  },
};
