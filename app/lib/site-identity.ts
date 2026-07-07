/**
 * Browser-safe site-identity helpers shared by the create-site server path and
 * the creation wizard UI. Kept out of any `*.server.ts` so the client bundle can
 * import them (theme metadata, slug humanization, the live URL preview) without
 * dragging in server-only modules.
 *
 * The canonical theme list mirrors the framework template's `_config.yml`
 * comment, and the swatch colours are lifted from the framework's
 * `_data/themes/*.yml` (button background, layer-1 panel, layer-2 panel) so the
 * picker cards are a faithful mini-preview rather than decoration.
 *
 * @version v1.4.0-beta
 */

// English title-case "minor words" left lowercase mid-title (unless first/last).
const EN_TITLE_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of",
  "on", "or", "per", "the", "to", "via", "vs", "with",
]);

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Turn a repo slug into a human title, casing per locale:
 * - `en` (default): title case, but interior minor words (and, of, the, …) stay
 *   lowercase; the first and last word are always capitalized
 *   (`the-art-of-war` → `The Art of War`).
 * - `es`: sentence case — only the first word is capitalized, matching Spanish
 *   title convention (`mi-proyecto-de-cartas` → `Mi proyecto de cartas`). Proper
 *   nouns can't be inferred from a slug, so they're not special-cased.
 */
export function humanizeSlug(slug: string, locale: "en" | "es" = "en"): string {
  const words = slug.split(/[-_.]+/).filter(Boolean);
  // Separator-only slugs (e.g. "_") collapse to [] — fall back to the raw slug
  // so the derived title/description is never empty (empty drops the <meta>).
  if (words.length === 0) return slug;

  const lastIndex = words.length - 1;
  const cased = words.map((word, i) => {
    const lower = word.toLowerCase();
    if (locale === "es") {
      // Sentence case: capitalize the first word only, lowercase the rest.
      return i === 0 ? capitalize(lower) : lower;
    }
    // English title case with stopword exceptions.
    if (i !== 0 && i !== lastIndex && EN_TITLE_STOPWORDS.has(lower)) return lower;
    return capitalize(lower);
  });
  return cased.join(" ");
}

/**
 * The public GitHub Pages URL a site will be served at. The host is always the
 * lowercased owner; the repo-name case is preserved verbatim (GitHub keeps it in
 * the Pages path), matching how `buildBornCleanConfig` writes `url`/`baseurl`.
 */
export function deriveSiteUrl(owner: string, name: string): string {
  return `https://${owner.toLowerCase()}.github.io/${name}`;
}

/**
 * Site themes the wizard offers and the server accepts. Mirrors the template
 * `_config.yml` comment (`trama, paisajes, neogranadina, santa-barbara, austin,
 * or custom`); `custom` is intentionally excluded — it's a hand-edit escape
 * hatch, not a pick.
 */
export const VALID_THEMES = [
  "trama",
  "paisajes",
  "neogranadina",
  "santa-barbara",
  "austin",
] as const;

export type ThemeId = (typeof VALID_THEMES)[number];

export const DEFAULT_THEME: ThemeId = "trama";

/** Coerce arbitrary input to a valid theme, defaulting unknown/`custom` to `trama`. */
export function normalizeTheme(value: unknown): ThemeId {
  return VALID_THEMES.includes(value as ThemeId) ? (value as ThemeId) : DEFAULT_THEME;
}

/**
 * Display metadata for the theme picker. `name` is a proper noun (framework
 * theme/place name) shown as-is in both locales. `swatches` are three signature
 * colours from the framework theme data. `partner` groups the three
 * institution themes under a "Partner themes" label so they don't read as
 * confusing peers of the two general themes.
 */
export interface ThemeMeta {
  id: ThemeId;
  name: string;
  partner: boolean;
  swatches: [string, string, string];
}

export const THEME_META: ThemeMeta[] = [
  { id: "trama", name: "Trama", partner: false, swatches: ["#883C36", "#C6D0F8", "#FFF6EF"] },
  { id: "paisajes", name: "Paisajes", partner: false, swatches: ["#2C3E50", "#A8C5D4", "#3D2645"] },
  { id: "neogranadina", name: "Neogranadina", partner: true, swatches: ["#00B35C", "#B31235", "#2A2F36"] },
  { id: "santa-barbara", name: "Santa Barbara", partner: true, swatches: ["#003660", "#047C91", "#FEBC11"] },
  { id: "austin", name: "Austin", partner: true, swatches: ["#BF5700", "#577565", "#333F48"] },
];
