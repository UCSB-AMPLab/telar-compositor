/**
 * This file holds a static mirror of the v1.3.0 framework's English and
 * Spanish landing-page labels.
 *
 * The compositor needs these strings in two places. The homepage
 * editor's read-only welcome preview shows the framework's default
 * welcome body when the user hasn't customised theirs, so the editor
 * paints what the live site would actually paint. The three landing
 * heading/intro placeholders also come from here, switched on the
 * project's own language (not the editor UI's language) so an English
 * editor working on a Spanish site sees the Spanish placeholders that
 * end up shipping.
 *
 * This is a static mirror, not a runtime fetch. When the framework's
 * `_data/languages/{en,es}.yml` files change, the constants here have
 * to be re-synced manually. `stories_heading` is intentionally
 * "Stories" / "Historias" — a compositor UI placeholder, not the
 * framework lang-pack default ("Explore the stories"). The other
 * landing labels follow the framework verbatim.
 *
 * @version v1.2.0-beta
 */

/**
 * Welcome markdown body the v1.3.0 framework renders by default for the
 * homepage. Used to preview the live-site default when the user
 * has not customised their welcome message.
 *
 * Source: v1.3.0 _data/languages/{en,es}.yml :: index_page.welcome
 */
export const WELCOME_BODY_LOCALISED = {
  // Source: v1.3.0 _data/languages/en.yml :: index_page.welcome
  en: `## Welcome to the Telar demo site

Telar lets you build scroll-driven narrative exhibitions and browsable digital collections — weaving IIIF images, video, audio, narrative text, and contextual layers into interactive sites you host free on GitHub Pages.

Three ways to build your own:

- **No-code:** set up and manage your site through a visual interface with the **[Telar Compositor](https://compositor.telar.org)**
- **Guided:** copy the **[GitHub template](https://github.com/UCSB-AMPLab/telar)** and edit your content in Google Sheets
- **Hands-on:** clone the template and edit CSV and markdown files locally

See the **[full documentation](https://telar.org/docs)** for guides on each path.

*To replace this welcome with your own, edit \`index.md\` in your repository.*`,
  // Source: v1.3.0 _data/languages/es.yml :: index_page.welcome
  es: `## Bienvenidos a Telar

Telar es una herramienta para crear exhibiciones narrativas y publicar colecciones digitales. Combina imágenes IIIF, video, audio y texto en sitios interactivos con desplazamiento fluido, alojados gratis en GitHub Pages.

Tres formas de empezar:

- **Sin código:** configura y gestiona tu sitio desde una interfaz visual con el **[Telar Compositor](https://compositor.telar.org)**
- **Asistida:** copia la **[plantilla de GitHub](https://github.com/UCSB-AMPLab/telar)** y edita tu contenido en Google Sheets
- **Manual:** clona la plantilla y edita los archivos CSV y markdown localmente

En la **[documentación](https://telar.org/docs)** hay guías para cada ruta.

*Para reemplazar esta bienvenida, edita \`index.md\` en tu repositorio.*`,
} as const;

/**
 * Per-field placeholder strings for the three landing inputs. Switched
 * on `config.lang` (site language), NOT on user UI locale.
 *
 * `{count}` in `objects_intro` is a literal — the framework's
 * `pages.objects_count` substitutes the real count at build time. The
 * placeholder shows the literal so users see the framework's wording.
 *
 * `stories_heading` differs from the framework lang pack: the compositor's
 * UI uses "Stories" / "Historias" as the field placeholder rather than the
 * framework default "Explore the stories" / "Explora las historias", so the
 * placeholder reads as a field label rather than a sentence.
 */
export const LANDING_LABELS = {
  en: {
    // Compositor UI placeholder (NOT the framework default — see module docblock).
    stories_heading: "Stories",
    // Source: v1.3.0 _data/languages/en.yml :: pages.objects_heading
    objects_heading: "See the objects behind the stories",
    // Source: v1.3.0 _data/languages/en.yml :: pages.objects_count
    objects_intro: "Browse {count} objects featured in the stories.",
  },
  es: {
    // Compositor UI placeholder (NOT the framework default).
    stories_heading: "Historias",
    // Source: v1.3.0 _data/languages/es.yml :: pages.objects_heading
    objects_heading: "Explora los objetos detrás de las historias",
    // Source: v1.3.0 _data/languages/es.yml :: pages.objects_count
    objects_intro: "Explora {count} objetos presentes en las historias.",
  },
} as const;

/** Languages the localised label constants cover. */
export type LocalisedLanguage = keyof typeof LANDING_LABELS;

/**
 * Verbatim v1.2.1 framework defaults for the three landing-section
 * frontmatter overrides that v1.3.0 removed in favour of lang-pack
 * resolution. Lives here (not in v130-ingest.server.ts) so client-side
 * code can compare against them without dragging server-only modules
 * into the client bundle. v130-ingest.server.ts re-exports for backward
 * compat with publish.server.ts / import.server.ts.
 *
 * Source: verbatim
 * from UCSB-AMPLab/telar@v1.2.1:index.md frontmatter. Do NOT paraphrase.
 *
 * Used by:
 *   - app/routes/_app.homepage.tsx — `defaultValues` prop on the three
 *     inline-edit fields (suppress display when Y.Text holds the legacy
 *     literal captured at pre-v1.3.0 import time).
 *   - app/lib/v130-ingest.server.ts — Transform B literal-removal targets.
 *   - app/lib/publish.server.ts — defensive gate compares against.
 */
export const V121_FRONTMATTER_DEFAULTS = {
  stories_heading: "Explore the stories",
  objects_heading: "See the objects behind the stories",
  objects_intro: "Browse {count} objects featured in the stories.",
} as const;
