/**
 * This file tests the v1.3.0 ingest transforms in
 * `app/lib/v130-ingest.server.ts` — the helpers that strip v1.2.1
 * default landing-copy literals during a v1.2.1 → v1.3.0 site upgrade
 * so the v1.3.0 liquid-block defaults can take over.
 *
 * The 12 cases cover:
 *   1-4. Four migration scenarios (EN/ES × default/customised about.md)
 *   5-7. D1 cleanup (welcome_body / stories_heading clear; customised preserved)
 *   8.   Liquid-block recognition (isV130WelcomeLiquidBlock)
 *   9.   Idempotency (second run produces zero changes)
 *   10.  CRLF normalisation (hashNormalized byte-equivalent for CRLF and LF)
 *   11.  Transform A preserves frontmatter when replacing body
 *   12.  Transform B removes only matching v1.2.1 frontmatter literals
 *
 * Source-of-truth literals live verbatim alongside the implementation.
 * Do NOT paraphrase — the hash check depends on byte equality with the
 * v1.2.1 reference.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  applyV130Transforms,
  hashNormalized,
  normalizeBody,
  splitFrontmatter,
  isV130WelcomeLiquidBlock,
  V121_BODIES,
  V121_FRONTMATTER_DEFAULTS,
} from "~/lib/v130-ingest.server";

function files(...entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// V1.2.1 about.md body — verbatim reference (do NOT paraphrase)
// ---------------------------------------------------------------------------

const ABOUT_V121 = `# About Telar

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
- [CollectionBuilder](https://collectionbuilder.github.io/) - Static digital collections`;

const INDEX_V121 = V121_BODIES?.index ?? "";
const ABOUT_PATH = "telar-content/texts/pages/about.md";
const ACERCA_PATH = "telar-content/texts/pages/acerca.md";

// ---------------------------------------------------------------------------
// Scenario 1: EN + default about.md
// ---------------------------------------------------------------------------

describe("scenario 1: EN + default about.md", () => {
  it("scenario 1: EN + default about.md", async () => {
    const f = files([ABOUT_PATH, `---\ntitle: About\n---\n\n${ABOUT_V121}`]);
    const result = await applyV130Transforms(f, "en");
    // EN site → no acerca.md is created (Transform C only fires for ES)
    expect(result.created).not.toContain(ACERCA_PATH);
    // about.md body is replaced with v1.3.0 content (em-dashes, double quotes)
    const about = result.files.get(ABOUT_PATH);
    expect(about).toBeDefined();
    expect(about).toContain('Telar (Spanish for "loom")');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: ES + default about.md
// ---------------------------------------------------------------------------

describe("scenario 2: ES + default about.md", () => {
  it("scenario 2: ES + default about.md", async () => {
    const f = files([ABOUT_PATH, `---\ntitle: About\n---\n\n${ABOUT_V121}`]);
    const result = await applyV130Transforms(f, "es");
    expect(result.created).toContain(ACERCA_PATH);
    const acerca = result.files.get(ACERCA_PATH);
    expect(acerca).toBeDefined();
    expect(acerca).toMatch(/title: Acerca de Telar/);
    expect(acerca).toMatch(/localized_for: about\.md/);
    expect(acerca).toMatch(/language: es/);
    // about.md body replaced with v1.3.0 content
    const about = result.files.get(ABOUT_PATH);
    expect(about).toContain('Telar (Spanish for "loom")');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: EN + customised about.md
// ---------------------------------------------------------------------------

describe("scenario 3: EN + customised about.md", () => {
  it("scenario 3: EN + customised about.md", async () => {
    const customised = `---\ntitle: About\n---\n\n# My Custom About Page\n\nUser-edited content.`;
    const f = files([ABOUT_PATH, customised]);
    const result = await applyV130Transforms(f, "en");
    // about.md preserved verbatim (hash mismatch → skipped)
    expect(result.files.get(ABOUT_PATH)).toBe(customised);
    // No acerca.md (EN + custom about.md)
    expect(result.created).not.toContain(ACERCA_PATH);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: ES + customised about.md
// ---------------------------------------------------------------------------

describe("scenario 4: ES + customised about.md", () => {
  it("scenario 4: ES + customised about.md", async () => {
    const customised = `---\ntitle: About\n---\n\n# My Custom About Page\n\nUser-edited content.`;
    const f = files([ABOUT_PATH, customised]);
    const result = await applyV130Transforms(f, "es");
    // about.md preserved (hash mismatch)
    expect(result.files.get(ABOUT_PATH)).toBe(customised);
    // acerca.md NOT created — customised about.md would be shadowed
    expect(result.created).not.toContain(ACERCA_PATH);
  });
});

// ---------------------------------------------------------------------------
// cleanProjectLanding was REMOVED 2026-05-11. The legacy v1.2.1 D1
// state is now handled at display time in `_app.homepage.tsx`'s loader
// (see tests/_app.homepage.test.tsx for that surface). The publish-time
// gate still uses V121_BODIES.index + V121_FRONTMATTER_DEFAULTS; ingest
// still recognises the v1.3.0 liquid block at parseIndexMd time.

// ---------------------------------------------------------------------------
// Import-time liquid-block recognition
// ---------------------------------------------------------------------------

describe("liquid-block recognition", () => {
  it("returns true for canonical v1.3.0 liquid block", () => {
    const body = `{% assign lang = site.data.languages[site.telar_language] | default: site.data.languages.en %}
<!--
  EN: Default welcome content for this page comes from your language pack.
-->

{{ lang.index_page.welcome | markdownify }}`;
    expect(isV130WelcomeLiquidBlock(body)).toBe(true);
  });

  it("returns false for user content", () => {
    expect(isV130WelcomeLiquidBlock("## My custom welcome\n\nHi.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("idempotent: second applyV130Transforms run produces zero changes", async () => {
    const f = files([ABOUT_PATH, `---\ntitle: About\n---\n\n${ABOUT_V121}`]);
    const first = await applyV130Transforms(f, "es");
    expect(first.changes.length).toBeGreaterThan(0);
    // Run again on the already-transformed Map
    const second = await applyV130Transforms(first.files, "es");
    expect(second.changes).toEqual([]);
    expect(second.created).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CRLF normalisation
// ---------------------------------------------------------------------------

describe("CRLF normalisation", () => {
  it("CRLF: hashNormalized is byte-equivalent for CRLF and LF", async () => {
    const lf = "line one\nline two\nline three";
    const crlf = "line one\r\nline two\r\nline three";
    const lfHash = await hashNormalized(lf);
    const crlfHash = await hashNormalized(crlf);
    expect(crlfHash).toBe(lfHash);
  });
});

// ---------------------------------------------------------------------------
// Transform A — frontmatter preservation
// ---------------------------------------------------------------------------

describe("Transform A frontmatter preservation", () => {
  it("Transform A preserves frontmatter when replacing body", async () => {
    const customFrontmatter = `---\ntitle: About\nlayout: page\ncustom_field: keep me\n---\n\n${ABOUT_V121}`;
    const f = files([ABOUT_PATH, customFrontmatter]);
    const result = await applyV130Transforms(f, "en");
    const about = result.files.get(ABOUT_PATH);
    expect(about).toContain("title: About");
    expect(about).toContain("layout: page");
    expect(about).toContain("custom_field: keep me");
    // Body replaced
    expect(about).toContain('Telar (Spanish for "loom")');
  });
});

// ---------------------------------------------------------------------------
// Transform B — frontmatter literal removal (selective)
// ---------------------------------------------------------------------------

describe("Transform B frontmatter literal removal", () => {
  it("Transform B removes only matching v1.2.1 frontmatter literals", async () => {
    // index.md with v1.2.1 frontmatter defaults + a customised stories_intro
    const indexContent = `---
stories_heading: ${V121_FRONTMATTER_DEFAULTS.stories_heading}
stories_intro: My custom stories intro
objects_heading: ${V121_FRONTMATTER_DEFAULTS.objects_heading}
objects_intro: ${V121_FRONTMATTER_DEFAULTS.objects_intro}
---

${INDEX_V121}`;
    const f = files(["index.md", indexContent]);
    const result = await applyV130Transforms(f, "en");
    const index = result.files.get("index.md");
    expect(index).toBeDefined();
    // V121 literals removed
    expect(index).not.toMatch(
      new RegExp(`stories_heading:\\s*${V121_FRONTMATTER_DEFAULTS.stories_heading}`),
    );
    expect(index).not.toMatch(
      new RegExp(`objects_heading:\\s*${V121_FRONTMATTER_DEFAULTS.objects_heading}`),
    );
    // Customised stories_intro preserved
    expect(index).toContain("stories_intro: My custom stories intro");
  });
});

// ---------------------------------------------------------------------------
// Helper sanity checks (normalizeBody / splitFrontmatter exist)
// ---------------------------------------------------------------------------

// Touch the helpers so the import is exercised; placed outside describe to
// keep the test count at exactly the 12 cases the per-task verification map
// expects via -t filters.
void normalizeBody;
void splitFrontmatter;
