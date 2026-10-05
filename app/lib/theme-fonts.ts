/**
 * theme-fonts — the web fonts a shipped theme publishes with, for the
 * previews that draw author text in the site's theme (the glossary
 * definition preview, and the step card and panels of the framing stage).
 *
 * Each value is the Google Fonts stylesheet the theme names; the families
 * match the heading and body fonts in `theme-tokens.ts`. Trama's fonts
 * (Space Grotesk, Roboto Condensed) are the app shell's own and are already
 * loaded, so Trama has no entry, and neither has a custom or unknown theme,
 * which previews in the neutral fallback's fonts.
 *
 * @version v1.5.0-beta
 */

const THEME_FONT_HREFS: Record<string, string> = {
  austin:
    "https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600&family=Inter:wght@400;500&display=swap",
  neogranadina:
    "https://fonts.googleapis.com/css2?family=IM+Fell+DW+Pica&family=Mulish:wght@400;500&display=swap",
  paisajes:
    "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=Source+Sans+Pro:wght@400;600&display=swap",
  "santa-barbara":
    "https://fonts.googleapis.com/css2?family=Roboto+Serif:wght@400;600&family=Nunito+Sans:wght@400;600&display=swap",
};

/** The stylesheet to load for `theme`'s fonts, or undefined when none is needed. */
export function themeFontHref(theme: string | null | undefined): string | undefined {
  return theme && Object.hasOwn(THEME_FONT_HREFS, theme) ? THEME_FONT_HREFS[theme] : undefined;
}
