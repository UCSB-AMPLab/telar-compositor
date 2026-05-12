/**
 * This file is the bespoke v1.2.1 → v1.3.0 ingest module.
 *
 * Most version-to-version upgrades are handled by the generic manifest
 * runner reading the release's `migration.json`. The v1.3.0 manifest is
 * intentionally `operations: []` — its work is too conditional for the
 * declarative format and lives here instead, byte-for-byte mirroring
 * the framework's `scripts/migrations/v121_to_v130.py`.
 *
 * Three transforms run, in order. The first replaces the body of two
 * markdown files (`about.md` and the localised welcome) only when the
 * existing body still hashes to the v1.2.1 default — so a user who
 * edited their welcome message keeps it. The second drops the four
 * v1.2.1 default frontmatter literals from the homepage's `index.md`
 * if they're sitting there unchanged, line by line, so the v1.3.0
 * lang-pack defaults can take over. The third silently creates
 * `acerca.md` for Spanish sites that still have the unchanged v1.2.1
 * `about.md`, since v1.3.0 routes the Spanish about-page through a
 * separate filename.
 *
 * Everything is pure. The route action preloads the relevant files into
 * a `Map<string, string>` virtual filesystem, transforms read and
 * mutate the map, and the route's existing additions-merge picks the
 * result up to commit. CRLF and LF hash identically — without that
 * normalisation, Windows-line-ending repos would silently no-op every
 * transform.
 *
 * @version v1.2.0-beta
 */

// (No drizzle / db imports — every function in this module is pure and operates
// on Map<string, string> virtual filesystems. The DB-touching helper that
// that previously lived here, was removed 2026-05-11 in favour of a
// display-layer treatment in `_app.homepage.tsx`'s loader.)

// ---------------------------------------------------------------------------
// V1.2.1 frontmatter defaults — Transform B comparison targets
//
// Defined in v130-framework-labels.ts (client-safe) so _app.homepage.tsx's
// component can pass them as `defaultValues` to InlineTextField/Area without
// dragging this server-only module into the client bundle. Re-exported here
// for backward compat with existing server-side consumers
// (publish.server.ts, _app.upgrade.tsx, this module's Transform B).
// ---------------------------------------------------------------------------

export { V121_FRONTMATTER_DEFAULTS } from "~/lib/v130-framework-labels";
import { V121_FRONTMATTER_DEFAULTS } from "~/lib/v130-framework-labels";

// ---------------------------------------------------------------------------
// V1.2.1 body literals — Transform A comparison targets
// (verbatim from the framework v1.3.0 template; preserves ASCII hyphens in about.md
//  Credits list; v1.3.0 uses em-dashes — hash naturally distinguishes)
// ---------------------------------------------------------------------------

export const V121_BODIES = {
  index: `## Welcome to the Telar Demo Site
This site showcases the features and **capabilities** of Telar (v.[{{ site.telar.version }}](https://github.com/UCSB-AMPLab/telar/releases/tag/v{{ site.telar.version }})). Build your own visual narrative exhibition by visiting:

- Our **[GitHub repository](https://github.com/UCSB-AMPLab/telar)**, where you can copy the template to create your own project
- The **[documentation site](https://telar.org/docs)**, where you can find guides and tutorials

No installation is required: you can manage your content with Google Sheets and publish it for free on GitHub Pages.

***Note:** To remove or replace this message, edit the \`index.md\` file in your repository.*`,

  glossary: `Key terms and concepts used in these stories.`,

  objects: `Browse {{ site.objects.size }} objects featured in the stories.`,

  about: `# About Telar

Telar (Spanish for 'loom') is a static site generator built on Jekyll that weaves together IIIF images, text, and layered contextual information into interactive digital narrative exhibitions. Telar uses the International Image Interoperability Framework (IIIF) to serve high-resolution images that can be zoomed, panned, and explored in detail. The framework combines these images with narrative text and layered contextual panels to create immersive storytelling experiences.

<div class="alert alert-info" role="alert">
<strong>Customize This Page</strong><br>
You can edit this about page by modifying the <code>telar-content/texts/pages/about.md</code> file in your repository. Add your own project description, credits, and acknowledgments to personalize your site.
</div>

## Credits

Telar is developed by Adelaida Ávila, Juan Cobo Betancourt, Natalie Cobo, Santiago Muñoz, and students and scholars at the [UCSB Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu), the UT Archives, Mapping, and Pedagogy Lab, and [Neogranadina](https://neogranadina.org).

We gratefully acknowledge the support of the [Caribbean Digital Scholarship Collective](https://cdscollective.org), the [Center for Innovative Teaching, Research, and Learning (CITRAL)](https://citral.ucsb.edu/home) at the University of California, Santa Barbara, the [UCSB Library](https://library.ucsb.edu), the [Routes of Enslavement in the Americas University of California MRPI](https://www.humanities.uci.edu/routes-enslavement-americas), and the [Department of History of The University of Texas at Austin](https://liberalarts.utexas.edu/history/).

For more information, visit the [Telar GitHub repository](https://github.com/UCSB-AMPLab/telar).

Telar was built with:

- [Jekyll](https://jekyllrb.com/) - Static site generator
- [Tify](https://tify.rocks/) - IIIF viewer
- [Bootstrap 5](https://getbootstrap.com/) - CSS framework
- [libvips](https://www.libvips.org/) - IIIF tile generator

It is based on [Paisajes Coloniales](https://paisajescoloniales.com/), and inspired by:

- [Wax](https://minicomp.github.io/wax/) - Minimal computing for digital exhibitions
- [CollectionBuilder](https://collectionbuilder.github.io/) - Static digital collections`,
} as const;

// ---------------------------------------------------------------------------
// V1.3.0 replacement bodies — Transform A output
// (verbatim from the framework v1.3.0 template)
// ---------------------------------------------------------------------------

export const V130_BODIES = {
  index: `{% assign lang = site.data.languages[site.telar_language] | default: site.data.languages.en %}
<!--
  EN: Default welcome content for this page comes from your language
  pack (lang.index_page.welcome in _data/languages/<telar_language>.yml).
  To replace it with your own, delete the line that follows and write
  your welcome content here in markdown.

  ES: El contenido de bienvenida predeterminado de esta página viene
  del paquete de idioma (lang.index_page.welcome en _data/languages/<telar_language>.yml).
  Para reemplazarlo con el tuyo, borra la línea que sigue y escribe
  tu contenido de bienvenida aquí en markdown.
-->

{{ lang.index_page.welcome | markdownify }}`,

  glossary: `{% assign lang = site.data.languages[site.telar_language] | default: site.data.languages.en %}
<!--
  EN: Default content for this page comes from your language pack
  (lang.pages.glossary_intro in _data/languages/<telar_language>.yml).
  To use your own intro text, delete the line that follows and write
  it here in markdown.

  ES: El contenido predeterminado de esta página viene del paquete
  de idioma (lang.pages.glossary_intro en _data/languages/<telar_language>.yml).
  Para usar tu propio texto introductorio, borra la línea que sigue
  y escríbelo aquí en markdown.
-->

{{ lang.pages.glossary_intro }}`,

  objects: `{% assign lang = site.data.languages[site.telar_language] | default: site.data.languages.en %}
<!--
  EN: Default content for this page comes from your language pack
  (lang.pages.objects_count in _data/languages/<telar_language>.yml).
  The {count} placeholder is filled in automatically. To use your
  own intro text, delete the two lines that follow and write it
  here in markdown.

  ES: El contenido predeterminado de esta página viene del paquete
  de idioma (lang.pages.objects_count en _data/languages/<telar_language>.yml).
  El marcador {count} se rellena automáticamente. Para usar tu propio
  texto introductorio, borra las dos líneas que siguen y escríbelo
  aquí en markdown.
-->

{% assign objects_intro = lang.pages.objects_count | replace: "{count}", site.objects.size %}
{{ objects_intro }}`,

  about: `# About Telar

Telar (Spanish for "loom") is a static site generator built on Jekyll for digital storytelling and publishing small digital collections. It weaves IIIF images, video, audio, narrative text, and contextual layers into interactive visual exhibitions, with a card-stacking architecture, fluid scroll navigation, deep linking, and shareable URLs. It follows minimal computing principles: plain text authoring, static generation, and free hosting on GitHub Pages.

<div class="alert alert-info" role="alert">
<strong>Customize this page</strong><br>
You can edit this about page by modifying the <code>telar-content/texts/pages/about.md</code> file in your repository. Add your own project description, credits, and acknowledgments to personalize your site. To localize for other languages, create a sister file alongside this one (for example, <code>acerca.md</code> for Spanish) with frontmatter <code>localized_for: about.md</code> and <code>language: &lt;lang_code&gt;</code>; the build picks the file matching <code>telar_language</code>.
</div>

## Credits

Telar is developed by Adelaida Ávila, Juan Cobo Betancourt, Natalie Cobo, Santiago Muñoz, and students and scholars at the [UCSB Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu), the UT Archives, Mapping, and Pedagogy Lab, and [Neogranadina](https://neogranadina.org).

We gratefully acknowledge the support of the [Caribbean Digital Scholarship Collective](https://cdscollective.org), the [Center for Innovative Teaching, Research, and Learning (CITRAL)](https://citral.ucsb.edu/home) at the University of California, Santa Barbara, the [UCSB Library](https://library.ucsb.edu), the [Routes of Enslavement in the Americas University of California MRPI](https://www.humanities.uci.edu/routes-enslavement-americas), and the [Department of History of The University of Texas at Austin](https://liberalarts.utexas.edu/history/).

For more information, visit the [Telar GitHub repository](https://github.com/UCSB-AMPLab/telar) or the [Telar Compositor](https://compositor.telar.org).

Telar is built with:

- [Jekyll](https://jekyllrb.com/) — Static site generator
- [Tify](https://tify.rocks/) — IIIF viewer
- [Bootstrap 5](https://getbootstrap.com/) — CSS framework
- [libvips](https://www.libvips.org/) — IIIF tile generator

It is based on [Paisajes Coloniales](https://paisajescoloniales.com/), and inspired by:

- [Wax](https://minicomp.github.io/wax/) — Minimal computing for digital exhibitions
- [CollectionBuilder](https://collectionbuilder.github.io/) — Static digital collections`,
} as const;

// ---------------------------------------------------------------------------
// ACERCA_MD_FULL — Transform C creation target
// (verbatim from the framework v1.3.0 template, ends with trailing newline)
// ---------------------------------------------------------------------------

export const ACERCA_MD_FULL = `---
title: Acerca de Telar
localized_for: about.md
language: es
---

# Acerca de Telar

Telar es un generador de sitios estáticos construido sobre Jekyll, para crear narrativas digitales y publicar pequeñas colecciones en línea. Combina imágenes IIIF, video, audio, texto narrativo y capas de contexto en exhibiciones visuales interactivas, con una arquitectura de tarjetas apiladas, navegación fluida por desplazamiento, enlaces directos a pasos específicos y URLs compartibles. Sigue los principios de computación mínima: autoría en texto plano, generación estática y alojamiento gratuito en GitHub Pages.

<div class="alert alert-info" role="alert">
<strong>Personaliza esta página</strong><br>
Para editar esta página, modifica el archivo <code>telar-content/texts/pages/acerca.md</code> en tu repositorio. Agrega tu propia descripción del proyecto, créditos y agradecimientos para personalizar tu sitio. Esta es la versión en español de <code>about.md</code>; el frontmatter <code>localized_for: about.md</code> y <code>language: es</code> indica al build cuál archivo usar según <code>telar_language</code>.
</div>

## Créditos

Telar es desarrollado por Adelaida Ávila, Juan Cobo Betancourt, Natalie Cobo, Santiago Muñoz, y estudiantes y académicos del [UCSB Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu), del UT Archives, Mapping, and Pedagogy Lab y de [Neogranadina](https://neogranadina.org).

Agradecemos el apoyo del [Caribbean Digital Scholarship Collective](https://cdscollective.org), del [Center for Innovative Teaching, Research, and Learning (CITRAL)](https://citral.ucsb.edu/home) de la University of California, Santa Barbara, de la [UCSB Library](https://library.ucsb.edu), del [Routes of Enslavement in the Americas University of California MRPI](https://www.humanities.uci.edu/routes-enslavement-americas) y del [Department of History of The University of Texas at Austin](https://liberalarts.utexas.edu/history/).

Para más información, visita el [repositorio de Telar en GitHub](https://github.com/UCSB-AMPLab/telar) o el [Telar Compositor](https://compositor.telar.org).

Telar está construido con:

- [Jekyll](https://jekyllrb.com/) — generador de sitios estáticos
- [Tify](https://tify.rocks/) — visor IIIF
- [Bootstrap 5](https://getbootstrap.com/) — marco CSS
- [libvips](https://www.libvips.org/) — generador de teselas IIIF

Está basado en [Paisajes Coloniales](https://paisajescoloniales.com/), y se inspira en:

- [Wax](https://minicomp.github.io/wax/) — computación mínima para exhibiciones digitales
- [CollectionBuilder](https://collectionbuilder.github.io/) — colecciones digitales estáticas
`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalise CRLF → LF and trim leading/trailing whitespace.
 * Mirrors Python `text.replace('\r\n', '\n').strip()`.
 * Sync.
 */
export function normalizeBody(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Hex SHA-256 of normalised UTF-8 bytes. Async — Web Crypto only.
 * Mirrors Python `hashlib.sha256(_normalize(text).encode('utf-8')).hexdigest()`.
 */
export async function hashNormalized(text: string): Promise<string> {
  const normalized = normalizeBody(text);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Split content into frontmatter (YAML between ---/---) and body.
 * Returns `{ frontmatter: null, body: content }` when the file has no
 * frontmatter. Pattern matches Python tolerance `^---\s*\n(.*?)\n---\s*\n?(.*)$`
 * (CRLF + leading-whitespace tolerant; mirrors the Python normalisation).
 */
export function splitFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: match[2] };
}

/**
 * Helper used by import.server.ts to recognise the canonical
 * v1.3.0 welcome liquid block so it doesn't get mirrored into D1 as a
 * compositor-authored welcome_body. Tolerates whitespace; matches both the
 * `assign lang` opener and the `markdownify` closer.
 */
export function isV130WelcomeLiquidBlock(body: string): boolean {
  const normalised = normalizeBody(body);
  const hasAssignLang = /^\{%\s*assign\s+lang\s*=\s*site\.data\.languages\[site\.telar_language\]\s*\|\s*default:\s*site\.data\.languages\.en\s*%\}/m.test(
    normalised,
  );
  const hasWelcomeRender =
    /\{\{\s*lang\.index_page\.welcome\s*\|\s*markdownify\s*\}\}/m.test(
      normalised,
    );
  return hasAssignLang && hasWelcomeRender;
}

// ---------------------------------------------------------------------------
// Lazy-memoised SHA-256 hashes of the four V121 bodies.
// Top-level await is not supported in the Workers bundle config,
// and embedding hash literals creates drift when V121_BODIES is edited.
// ---------------------------------------------------------------------------

interface V121Hashes {
  index: string;
  glossary: string;
  objects: string;
  about: string;
}

let _v121Hashes: Readonly<V121Hashes> | null = null;

export async function getV121Hashes(): Promise<Readonly<V121Hashes>> {
  if (_v121Hashes) return _v121Hashes;
  _v121Hashes = Object.freeze({
    index: await hashNormalized(V121_BODIES.index),
    glossary: await hashNormalized(V121_BODIES.glossary),
    objects: await hashNormalized(V121_BODIES.objects),
    about: await hashNormalized(V121_BODIES.about),
  });
  return _v121Hashes;
}

/** Test-only hook to force re-computation between test runs. */
export function __resetV121HashCacheForTests(): void {
  _v121Hashes = null;
}

// ---------------------------------------------------------------------------
// Transforms A / B / C — pure functions over the virtual filesystem
// ---------------------------------------------------------------------------

/**
 * Transform A — hash-gated body replacement.
 *
 * Mirrors `_replace_body_if_default` (Python v121_to_v130.py:261-298 /
 * the framework's existing pattern). Reads files.get(path), splits frontmatter, hashes
 * body, compares against v1.2.1 hash. Only replaces when the hash matches
 * (i.e. user hasn't customised). Frontmatter is preserved verbatim.
 */
export async function applyTransformA(
  files: Map<string, string>,
  path: string,
  v121Body: string,
  v130Body: string,
): Promise<{ changed: boolean; reason: string }> {
  const content = files.get(path);
  if (content === undefined) {
    return { changed: false, reason: `${path}: not present in repo` };
  }
  const { frontmatter, body } = splitFrontmatter(content);
  const userHash = await hashNormalized(body);
  const v121Hash = await hashNormalized(v121Body);
  if (userHash !== v121Hash) {
    return { changed: false, reason: `${path}: user customised; preserved` };
  }
  const newContent =
    frontmatter === null
      ? v130Body + (v130Body.endsWith("\n") ? "" : "\n")
      : `---\n${frontmatter}\n---\n\n${v130Body}\n`;
  files.set(path, newContent);
  return { changed: true, reason: `${path}: replaced with v1.3.0 template` };
}

/**
 * Escape a string for use as a regex literal (BMP scope only — sufficient
 * for the v1.2.1 frontmatter literal targets).
 */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Transform B — line-based v1.2.1 frontmatter literal removal on index.md.
 *
 * Mirrors `_cleanup_index_frontmatter` (Python v121_to_v130.py:218-259) BUT
 * implemented as line-based mutation (not full YAML parse) so that the
 * Python reference uses `yaml.safe_dump(sort_keys=False)` whose quote style
 * does not match the compositor's existing `publish.server.ts` convention of
 * always-double-quoting. Round-tripping through js-yaml here would generate
 * spurious diffs on every subsequent publish. Detect each v1.2.1 default
 * literal on its own frontmatter line, drop the line, leave every other
 * frontmatter key (and quote style) verbatim.
 *
 * Tolerated quote variants per line: `key: "literal"`, `key: 'literal'`,
 * `key: literal` (unquoted).
 */
export function applyTransformB(
  files: Map<string, string>,
): { changed: boolean; removedKeys: string[] } {
  const content = files.get("index.md");
  if (content === undefined) return { changed: false, removedKeys: [] };
  const parts = splitFrontmatter(content);
  if (parts.frontmatter === null) return { changed: false, removedKeys: [] };

  const literalChecks: Array<[string, string]> = [
    ["stories_heading", V121_FRONTMATTER_DEFAULTS.stories_heading],
    ["objects_heading", V121_FRONTMATTER_DEFAULTS.objects_heading],
    ["objects_intro", V121_FRONTMATTER_DEFAULTS.objects_intro],
  ];

  const removed: string[] = [];
  const lines = parts.frontmatter.split("\n");
  const remaining = lines.filter((line) => {
    for (const [key, literal] of literalChecks) {
      const re = new RegExp(
        `^\\s*${key}\\s*:\\s*(?:"${escapeForRegex(literal)}"|'${escapeForRegex(literal)}'|${escapeForRegex(literal)})\\s*$`,
      );
      if (re.test(line)) {
        if (!removed.includes(key)) removed.push(key);
        return false;
      }
    }
    return true;
  });

  if (removed.length === 0) return { changed: false, removedKeys: [] };

  const newFrontmatter = remaining.join("\n").trim();
  const newContent = newFrontmatter
    ? `---\n${newFrontmatter}\n---\n\n${parts.body}`
    : parts.body;
  files.set("index.md", newContent);
  return { changed: true, removedKeys: removed };
}

/**
 * Transform C — silent acerca.md creation when ES-language site has the
 * verbatim v1.2.1 about.md (mirrors Python `_create_acerca_for_es_with
 * _default_about` v121_to_v130.py:300-336).
 *
 * Triple gate (all three must pass):
 *   1. language === "es"  (compositor reads top-level `telar_language`)
 *   2. about.md exists AND its body hashes to V121_BODIES.about
 *   3. acerca.md does NOT already exist
 *
 * Ordering constraint: Transform C MUST run BEFORE Transform A on about.md. Transform
 * A would overwrite about.md with the v1.3.0 body; the gate-2 hash check
 * would then fail. The orchestrator below enforces this ordering.
 */
export async function applyTransformC(
  files: Map<string, string>,
  language: "en" | "es",
): Promise<{ changed: boolean; reason: string; created?: string }> {
  if (language !== "es") {
    return { changed: false, reason: "language not es" };
  }
  const acerca = "telar-content/texts/pages/acerca.md";
  if (files.has(acerca)) {
    return { changed: false, reason: "acerca.md already exists" };
  }
  const aboutPath = "telar-content/texts/pages/about.md";
  const aboutContent = files.get(aboutPath);
  if (aboutContent === undefined) {
    return { changed: false, reason: "about.md missing" };
  }
  const aboutBody = splitFrontmatter(aboutContent).body;
  const userHash = await hashNormalized(aboutBody);
  const v121Hash = (await getV121Hashes()).about;
  if (userHash !== v121Hash) {
    return { changed: false, reason: "about.md customised" };
  }
  files.set(acerca, ACERCA_MD_FULL);
  return { changed: true, reason: "acerca.md created", created: acerca };
}

// ---------------------------------------------------------------------------
// Orchestrator — applyV130Transforms
// ---------------------------------------------------------------------------

export interface V130IngestResult {
  /** Transformed virtual filesystem; same reference as the input Map. */
  files: Map<string, string>;
  /** Paths newly created (acerca.md when Transform C fires). */
  created: string[];
  /** Human-readable change log lines for the upgrade summary. */
  changes: string[];
}

/**
 * Run the full v1.3.0 ingest sequence against the virtual filesystem.
 *
 * Mirrors Python `apply()` in v121_to_v130.py:152-180. Mutates `files` in
 * place and returns the same Map reference.
 *
 * Order (about.md A must run AFTER acerca C; documented inline):
 *   1. Transform B    — index.md frontmatter cleanup
 *   2. Transform A    — index.md body
 *   3. Transform A    — pages/glossary.md body
 *   4. Transform A    — pages/objects.md body
 *   5. Transform C    — acerca.md create (BEFORE about.md A)
 *   6. Transform A    — telar-content/texts/pages/about.md body
 *
 * Idempotent: a second run produces zero changes because (a)
 * the v1.3.0 body never hashes to v1.2.1 default, (b) acerca.md now exists,
 * (c) the v1.2.1 frontmatter literals have already been removed.
 */
export async function applyV130Transforms(
  files: Map<string, string>,
  language: "en" | "es",
): Promise<V130IngestResult> {
  const changes: string[] = [];
  const created: string[] = [];

  // 1. Transform B — index.md frontmatter cleanup
  const bResult = applyTransformB(files);
  if (bResult.changed) {
    changes.push(
      `index.md: removed v1.2.1 frontmatter keys [${bResult.removedKeys.join(", ")}]`,
    );
  }

  // 2. Transform A — index.md body
  const aIndex = await applyTransformA(
    files,
    "index.md",
    V121_BODIES.index,
    V130_BODIES.index,
  );
  if (aIndex.changed) changes.push(aIndex.reason);

  // 3. Transform A — pages/glossary.md body
  const aGlossary = await applyTransformA(
    files,
    "pages/glossary.md",
    V121_BODIES.glossary,
    V130_BODIES.glossary,
  );
  if (aGlossary.changed) changes.push(aGlossary.reason);

  // 4. Transform A — pages/objects.md body
  const aObjects = await applyTransformA(
    files,
    "pages/objects.md",
    V121_BODIES.objects,
    V130_BODIES.objects,
  );
  if (aObjects.changed) changes.push(aObjects.reason);

  // 5. Transform C — acerca.md create.
  //    MUST run BEFORE Transform A on about.md. Transform C's
  //    hash-gate reads the existing about.md body; if Transform A ran first
  //    the body would already be the v1.3.0 template and the gate would
  //    always fail. Mirrors Python ordering (v121_to_v130.py:165-180).
  const cResult = await applyTransformC(files, language);
  if (cResult.changed && cResult.created) {
    created.push(cResult.created);
    changes.push(cResult.reason);
  }

  // 6. Transform A — about.md body (LAST, after acerca creation)
  const aAbout = await applyTransformA(
    files,
    "telar-content/texts/pages/about.md",
    V121_BODIES.about,
    V130_BODIES.about,
  );
  if (aAbout.changed) changes.push(aAbout.reason);

  return { files, created, changes };
}

// ---------------------------------------------------------------------------
// The cleanProjectLanding helper was REMOVED 2026-05-11.
//
// The original design wrote NULL into project_landing fields that still
// held verbatim v1.2.1 English defaults captured at import time. The intent
// was to keep the compositor's homepage editor in sync with the upgraded
// GitHub state, since pre-v1.3.0 imports stored the v1.2.1 English literals
// in D1, and the editor reads from D1.
//
// In practice this layer was the wrong place to handle it:
//   - The publish-time leak on the live site is closed by the v1.3.0
//     framework upgrade itself (Transform A on index.md + lang-pack-driven
//     layouts); this helper was not load-bearing for the user-visible fix.
//   - The publish-time defensive gate (sync) prevents stale D1 from
//     re-emitting English on the next publish — the live-site invariant
//     stays correct regardless of D1's state.
//   - The parseIndexMd liquid-block recognition keeps D1 self-healing
//     on any natural re-sync after upgrade.
//   - The remaining concern — editor display — is now handled in the
//     `_app.homepage.tsx` loader, which surfaces the lang-pack canned text
//     whenever landing.welcome_body is empty/liquid/legacy. The same loader
//     filters legacy v1.2.1 frontmatter literals (stories_heading,
//     objects_heading, objects_intro) to null, letting the existing
//     placeholder + empty-state hint take over.
//
// The display-layer treatment removes a server-side mutation per upgrade,
// a defensive code path with its own failure modes, and the duplicated
// normalisation logic. V121_BODIES + V121_FRONTMATTER_DEFAULTS are still
// exported from this module so the homepage loader and the publish gate can
// compare against them.
// ---------------------------------------------------------------------------
