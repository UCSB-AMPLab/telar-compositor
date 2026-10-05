/**
 * Live coupling smoke test: born-clean transforms vs the REAL Telar template.
 *
 * Born-clean (`create-site.server.ts`) reads `_config.yml`, `project.csv`, and
 * `glossary.csv` from a freshly-generated copy of `ucsb-amplab/telar` and rewrites
 * them line-by-line / column-by-column. Each transform throws loud when an expected
 * line, column, row, or starter-story slug is missing — so if the template drifts
 * (a renamed key, a restructured glossary cell, a re-slugged starter story), the
 * failure surfaces at *site-creation time, to a user*, degraded to the repair flow.
 *
 * This test moves that detection earlier: it fetches the live template and runs the
 * actual exported transforms against it, so template drift fails loud *before a
 * release* instead of in a user's create flow. It deliberately reuses the real code
 * path (imports from `create-site.server`) rather than reimplementing the parse, so
 * it cannot pass while the shipped transform breaks.
 *
 * The second block is a related tripwire: it checks that KNOWN_CONFIG_KEYS in
 * `publish.server.ts` (the allowlist the config sweep uses to tell real
 * top-level `_config.yml` keys from swept prose) still covers every top-level
 * key the live template actually ships. That maintenance rule — every framework
 * release that adds a top-level config key must extend the allowlist — lives
 * only in prose otherwise, and a miss corrupts published configs silently.
 *
 * The third block is the same kind of tripwire over file types: the Compositor's
 * TILEABLE_EXTENSIONS, OBJECT_ID_STRIPPED_EXTENSIONS and AUDIO_EXTENSIONS
 * (`app/lib/file-types.ts`) predict what the framework's Python actually tiles,
 * strips and recognises, and nothing but this check couples them to it. The
 * first two are declared per release and compared for the template's own
 * `telar.version`.
 *
 * Gated behind `LIVE_TEMPLATE_CHECK` so the normal offline suite (`npm test`) skips
 * it — it makes a network call to api.github.com. Run it at the release gate:
 *   LIVE_TEMPLATE_CHECK=1 npx vitest run tests/template-coupling.live.test.ts
 * It hits the public template unauthenticated; set `GITHUB_TOKEN` to dodge the
 * unauthenticated rate limit if needed.
 *
 * @version v1.5.0-beta
 */

import { BUILT_IN_PAGES } from "~/lib/framework-page-frontmatter.server";
import { describe, it, expect, beforeAll } from "vitest";
import {
  buildBornCleanConfig,
  stripStarterStories,
  stripPlaceholderObject,
  languageMatchGlossary,
  storySlugForLocale,
  otherStorySlug,
  TEMPLATE_OWNER,
  TEMPLATE_REPO,
  SPREADSHEETS_DIR,
  STORIES_TEXTS_DIR,
  OBJECTS_DIR,
  PLACEHOLDER_OBJECT_FILE,
  STARTER_STORY_SLUGS,
} from "~/lib/create-site.server";
import { isGoogleSheetsEnabled } from "~/lib/commit.server";
import { KNOWN_CONFIG_KEYS } from "~/lib/publish.server";
import { FRAMEWORK_PREFIXES, FRAMEWORK_FILES } from "~/lib/upgrade.server";
import { AUDIO_EXTENSIONS } from "~/lib/file-types";
import { strippedExtensions, tileableExtensions } from "~/lib/object-id";
import {
  isTemplateStory,
  isTemplateStep,
  isTemplateObject,
  isTemplateTerm,
  isTemplatePage,
} from "~/lib/template-content.server";

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "telar-compositor-template-coupling-check",
  };
  // The template is public, so the call works unauthenticated; a token only
  // raises the rate limit. Honour GITHUB_TOKEN when present for CI/release runs.
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Decode a contents-API file the same way born-clean's readRepoFile does. */
async function fetchTemplateFile(path: string): Promise<string> {
  const res = await fetch(
    `${GITHUB_API}/repos/${TEMPLATE_OWNER}/${TEMPLATE_REPO}/contents/${path}`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new Error(`fetchTemplateFile(${path}): HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { content: string; encoding: string };
  return Buffer.from(data.content, "base64").toString("utf-8");
}

async function listTemplateDir(dir: string): Promise<string[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${TEMPLATE_OWNER}/${TEMPLATE_REPO}/contents/${dir}`,
    { headers: authHeaders() },
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`listTemplateDir(${dir}): HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as Array<{ type: string; name: string }>;
  return data.map((e) => e.name);
}

// Skipped in the offline suite; runs only when LIVE_TEMPLATE_CHECK is set.
describe.runIf(process.env.LIVE_TEMPLATE_CHECK)(
  "born-clean transforms couple to the live ucsb-amplab/telar template",
  () => {
    let config: string;
    let projectCsv: string;
    let glossaryCsv: string;
    let objectsCsv: string;

    beforeAll(async () => {
      [config, projectCsv, glossaryCsv, objectsCsv] = await Promise.all([
        fetchTemplateFile("_config.yml"),
        fetchTemplateFile(`${SPREADSHEETS_DIR}/project.csv`),
        fetchTemplateFile(`${SPREADSHEETS_DIR}/glossary.csv`),
        fetchTemplateFile(`${SPREADSHEETS_DIR}/objects.csv`),
      ]);
    }, 30_000);

    for (const locale of ["en", "es"] as const) {
      it(`buildBornCleanConfig accepts the live _config.yml and produces a clean config (${locale})`, () => {
        const out = buildBornCleanConfig(config, {
          owner: "coupling-owner",
          name: "coupling-site",
          locale,
          title: "Coupling Check",
          description: "Coupling Check",
          theme: "trama",
          author: "Coupling Owner",
        });
        // The load-bearing invariants born-clean must guarantee on any template.
        expect(out).toContain('url: "https://coupling-owner.github.io"');
        expect(out).toContain('baseurl: "/coupling-site"');
        expect(out).toContain('title: "Coupling Check"');
        expect(out).toContain(`telar_language: "${locale}"`);
        expect(out).toMatch(/include_demo_content:\s*false/);
        expect(isGoogleSheetsEnabled(out)).toBe(false);
      });

      it(`stripStarterStories leaves no story rows for ${locale}`, () => {
        const out = stripStarterStories(projectCsv);
        for (const slug of STARTER_STORY_SLUGS) {
          expect(out).not.toContain(slug);
        }
        // Both language slugs must still be the ones the template ships, or the
        // strip silently stops matching and a starter story survives.
        expect(projectCsv).toContain(storySlugForLocale(locale));
        expect(projectCsv).toContain(otherStorySlug(locale));
      });

      it(`languageMatchGlossary collapses the bilingual telar row for ${locale}`, () => {
        // No throw means the telar row is still a two-language block with the
        // expected columns; that's the coupling we care about.
        expect(() => languageMatchGlossary(glossaryCsv, locale)).not.toThrow();
      });
    }

    it("ships the placeholder object row born-clean strips", () => {
      // stripPlaceholderObject throws when the row is absent, so a template
      // that drops the placeholder would fail every site creation.
      const out = stripPlaceholderObject(objectsCsv);
      expect(objectsCsv).toContain("telar-placeholder");
      expect(out).not.toContain("telar-placeholder");
    });

    it("ships the placeholder image at the path born-clean deletes", async () => {
      const res = await fetch(
        `${GITHUB_API}/repos/${TEMPLATE_OWNER}/${TEMPLATE_REPO}/contents/${OBJECTS_DIR}/${PLACEHOLDER_OBJECT_FILE}`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);
    }, 30_000);

    it("ships a panel directory for every starter story", async () => {
      for (const slug of STARTER_STORY_SLUGS) {
        const res = await fetch(
          `${GITHUB_API}/repos/${TEMPLATE_OWNER}/${TEMPLATE_REPO}/contents/${STORIES_TEXTS_DIR}/${slug}`,
          { headers: authHeaders() },
        );
        expect(res.status).toBe(200);
      }
    }, 30_000);

    it("ships google_sheets ENABLED (the born-clean idempotency gate depends on this)", () => {
      // commitBornCleanSite treats a sheets-disabled config as 'already
      // born-clean' and skips the re-commit (the atomic born-clean commit flips
      // sheets off together with url/baseurl/etc.). That proxy is only valid
      // because the template ships sheets ENABLED — if a future template flips
      // this default, the gate would skip the very first commit and ship a
      // half-configured site. Fail loud here rather than in a user's create flow.
      expect(isGoogleSheetsEnabled(config)).toBe(true);
    });

    it("ships a starter-story directory for both language slugs", async () => {
      const dirs = await listTemplateDir(STORIES_TEXTS_DIR);
      expect(dirs).toContain(storySlugForLocale("en"));
      expect(dirs).toContain(storySlugForLocale("es"));
    });
  },
);

/**
 * Top-level keys of a `_config.yml` string: column-0, lowercase-initial `key:`
 * lines. This is deliberately the SAME shape publish.server.ts's
 * isStructuralConfigLine uses to decide whether a line is a real key or swept
 * prose, so what we enumerate here is exactly what the sweep would test against
 * KNOWN_CONFIG_KEYS. Indented block contents and multi-line scalar
 * continuations sit past column 0 and are correctly excluded.
 */
function topLevelConfigKeys(yaml: string): string[] {
  const keys: string[] = [];
  for (const line of yaml.split("\n")) {
    const m = line.match(/^([a-z][a-z0-9_-]*):(\s|$)/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Skipped in the offline suite; runs only when LIVE_TEMPLATE_CHECK is set.
describe.runIf(process.env.LIVE_TEMPLATE_CHECK)(
  "the config-sweep allowlist covers every top-level key in the live template",
  () => {
    // FAILURE MODE THIS GUARDS
    // ------------------------
    // publish.server.ts sweeps _config.yml one line at a time and only treats a
    // line as a real, structural config key when that line's key is in
    // KNOWN_CONFIG_KEYS (see isStructuralConfigLine). Anything else is treated
    // as prose the sweep may replace. So when a future Telar framework release
    // adds a NEW top-level key to the template's _config.yml, the sweep silently
    // classifies that key's line as prose: a repo-side edit to that key can then
    // be clobbered (or its continuation lines swept away) at publish time, with
    // no error — the corruption only surfaces later in a published site.
    //
    // This test fetches the live template and fails loud, BEFORE a release, the
    // moment the template grows a top-level key the allowlist doesn't cover. The
    // fix at that point is to extend KNOWN_CONFIG_KEYS in publish.server.ts and,
    // if the new key is a managed field, teach the config sync differ about it.

    // Keys the sweep DELIBERATELY does not manage. A live top-level key belongs
    // here only when the sweep is meant to ignore it and leave it as unmanaged
    // prose. It is EMPTY today: every top-level key the live ucsb-amplab/telar
    // template ships is already in KNOWN_CONFIG_KEYS. Add a key here (with a
    // one-line justification) only after confirming against isStructuralConfigLine
    // and updateConfigFields that the sweep truly should not manage it.
    const DELIBERATELY_UNMANAGED = new Set<string>([]);

    let liveKeys: string[];
    // Imported directly from publish.server.ts — the exact Set the shipped
    // config sweep tests against, so this check can't pass while the allowlist
    // has drifted.
    const knownKeys = KNOWN_CONFIG_KEYS;

    beforeAll(async () => {
      const config = await fetchTemplateFile("_config.yml");
      liveKeys = topLevelConfigKeys(config);
    }, 30_000);

    it("has no live top-level key the allowlist fails to account for", () => {
      // Sanity: if we parsed nothing, the fetch or the key regex broke — a
      // silently-empty list would make the real assertion vacuously pass.
      expect(liveKeys.length).toBeGreaterThan(0);

      const unaccounted = liveKeys.filter(
        (k) => !knownKeys.has(k) && !DELIBERATELY_UNMANAGED.has(k),
      );

      const guidance =
        unaccounted.length === 0
          ? ""
          : `The live ucsb-amplab/telar _config.yml has top-level key(s) ` +
            `[${unaccounted.join(", ")}] that KNOWN_CONFIG_KEYS in ` +
            `app/lib/publish.server.ts does not list. The config sweep will treat ` +
            `${unaccounted.length === 1 ? "it" : "them"} as prose and can clobber ` +
            `repo-side edits at publish time. Before releasing: add ` +
            `${unaccounted.map((k) => `"${k}"`).join(", ")} to KNOWN_CONFIG_KEYS ` +
            `(and, if it is a managed field, extend the config sync differ to ` +
            `match). If the sweep should deliberately ignore a new key, add it to ` +
            `DELIBERATELY_UNMANAGED in this test with a justification instead.`;

      expect(unaccounted, guidance).toEqual([]);
    });
  },
);

// Skipped in the offline suite; runs only when LIVE_TEMPLATE_CHECK is set.
describe.runIf(process.env.LIVE_TEMPLATE_CHECK)(
  "template-content still recognises what the live template ships",
  () => {
    // The authorship backfill labels a row as the template's only while it
    // still holds the shipped content. That test is only as good as its record
    // of what "shipped" means: the moment the template rewrites its about page
    // or its starter story, every new site's copy stops being recognised and
    // the sole member is credited with writing the template's own text.
    //
    // Nothing else catches that. The offline tests compare against the values
    // recorded in `template-content.server.ts`, which is exactly the thing that
    // would be out of date.

    it("recognises the starter story and its steps", async () => {
      const projectCsv = await fetchTemplateFile(`${SPREADSHEETS_DIR}/project.csv`);
      const rows = projectCsv.split("\n").map((line) => line.split(","));
      const starters = rows.filter((r) => STARTER_STORY_SLUGS.includes((r[1] ?? "").trim()));

      expect(starters.length, "no starter story rows in the live project.csv").toBeGreaterThan(0);
      for (const row of starters) {
        const story = { story_id: row[1]?.trim(), title: row[2]?.trim() };
        expect(
          isTemplateStory(story),
          `The live template ships starter story ${JSON.stringify(story)}, which ` +
            "STARTER_STORY_TITLES in app/lib/template-content.server.ts no longer " +
            "recognises. Add the new title before releasing, or the backfill will " +
            "credit a person with the template's own starter story.",
        ).toBe(true);
      }

      for (const slug of STARTER_STORY_SLUGS) {
        const storyCsv = await fetchTemplateFile(`${SPREADSHEETS_DIR}/${slug}.csv`);
        const lines = storyCsv.split("\n").map((line) => line.split(","));
        const steps = lines.filter((r) => /^\d+$/.test((r[0] ?? "").trim()));
        expect(steps.length, `no step rows in ${slug}.csv`).toBeGreaterThan(0);
        for (const step of steps) {
          const shape = { object_id: step[1]?.trim(), question: step[10]?.trim(), answer: step[11]?.trim() };
          expect(
            isTemplateStep(shape),
            `The live template ships starter step ${JSON.stringify(shape)}, which ` +
              "STARTER_STEP_QUESTIONS/ANSWERS in app/lib/template-content.server.ts " +
              "no longer recognises.",
          ).toBe(true);
        }
      }
    });

    it("recognises the placeholder object and the seeded glossary term", async () => {
      const objectsCsv = await fetchTemplateFile(`${SPREADSHEETS_DIR}/objects.csv`);
      const objectRow = objectsCsv.split("\n").map((l) => l.split(",")).find(
        (r) => (r[0] ?? "").trim() === "telar-placeholder",
      );
      expect(objectRow, "no telar-placeholder row in the live objects.csv").toBeDefined();
      expect(
        isTemplateObject({ object_id: objectRow![0].trim(), title: objectRow![1].trim() }),
        "The live template's placeholder object has been retitled; update " +
          "PLACEHOLDER_OBJECT_TITLE in app/lib/template-content.server.ts.",
      ).toBe(true);

      const glossaryCsv = await fetchTemplateFile(`${SPREADSHEETS_DIR}/glossary.csv`);
      for (const locale of ["en", "es"] as const) {
        // Through languageMatchGlossary, because that is the form a born-clean
        // site actually stores.
        const matched = languageMatchGlossary(glossaryCsv, locale);
        const definition = matched
          .split("\n")
          .find((line) => line.startsWith("telar,"))
          ?.replace(/^telar,Telar,/, "")
          .replace(/^"|"$/g, "");
        expect(
          isTemplateTerm({ term_id: "telar", definition }),
          `The live template ships a ${locale} 'telar' definition that ` +
            "TELAR_TERM_DEFINITIONS in app/lib/template-content.server.ts does not " +
            "hold. Add the new block before releasing.",
        ).toBe(true);
      }
    });

    it("recognises the about pages it ships", async () => {
      for (const slug of ["about", "acerca"]) {
        const file = await fetchTemplateFile(`telar-content/texts/pages/${slug}.md`);
        const body = file.replace(/^---\n[\s\S]*?\n---\n/, "");
        expect(
          await isTemplatePage({ slug, body }),
          `The live template's ${slug}.md body is not in ` +
            "TEMPLATE_PAGE_BODY_HASHES (app/lib/template-content.server.ts). Add its " +
            "SHA-256 with a label saying which release it came from, or every new " +
            "site's about page will be credited to whoever created the site.",
        ).toBe(true);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// File-type coupling: what the framework tiles, and what it hears as audio
// ---------------------------------------------------------------------------

const CSV_UTILS_PATH = "scripts/telar/csv_utils.py";
const GENERATE_IIIF_PATH = "scripts/generate_iiif.py";
const MEDIA_TYPE_PATH = "scripts/telar/media_type.py";

/** ".JPG" → "jpg". The framework writes extensions with the dot, and
 *  media_type.py enumerates uppercase spellings alongside lowercase ones. */
function normaliseExtension(raw: string): string {
  return raw.replace(/^\./, "").toLowerCase();
}

/**
 * The text of the balanced bracketed literal a Python assignment opens, or null
 * when the file has no such assignment at all.
 *
 * Handles `NAME = {...}`, `[...]`, `(...)` and a single call wrapper around any
 * of them (`frozenset({...})`, `tuple([...])`). Throws when the assignment
 * exists but its literal does not close — a shape this cannot read is the event
 * these tests are for, so it must be loud rather than empty.
 */
function pythonAssignmentBody(source: string, name: string): string | null {
  const assignment = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*`, "m");
  const match = assignment.exec(source);
  if (!match) return null;

  let i = match.index + match[0].length;
  // Step over one call wrapper, e.g. frozenset( / set( / tuple( / list(.
  const wrapper = /^[A-Za-z_][A-Za-z0-9_]*\(/.exec(source.slice(i));
  if (wrapper) i += wrapper[0].length - 1;

  const openers: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const open = source[i];
  const close = openers[open];
  if (!close) {
    throw new Error(
      `template-coupling: ${name} in the live template is assigned something ` +
        `this check cannot read (${JSON.stringify(source.slice(i, i + 60))}). ` +
        `The framework has changed the shape of its extension declaration; ` +
        `teach pythonAssignmentBody the new shape before releasing.`,
    );
  }

  let depth = 0;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(i + 1, j);
    }
  }
  throw new Error(
    `template-coupling: ${name} in the live template opens a literal that never ` +
      `closes. The fetch or the file is truncated; re-run before concluding anything.`,
  );
}

/**
 * The extension set a Python name holds, following one level of indirection
 * (`IMAGE_EXTENSIONS = frozenset(IMAGE_EXTENSIONS_ORDERED)`).
 *
 * Throws on every failure to read the value. A parse that fell back to an empty
 * set would turn the framework changing shape — exactly what this test exists
 * to catch — into a silently passing equality against nothing.
 */
function pythonExtensionSet(source: string, file: string, name: string, depth = 0): Set<string> {
  const body = pythonAssignmentBody(source, name);
  if (body === null) {
    throw new Error(
      `template-coupling: the live ${file} no longer assigns ${name}. The ` +
        `Compositor's file-type declarations are pinned to it; find what ` +
        `replaced it and re-point this check before releasing.`,
    );
  }

  const quoted = [...body.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
  if (quoted.length > 0) {
    return new Set(quoted.map(normaliseExtension));
  }

  // No strings in the literal: an alias of another name, e.g.
  // frozenset(IMAGE_EXTENSIONS_ORDERED). Follow it once.
  const alias = body.trim().replace(/,$/, "");
  if (depth < 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    return pythonExtensionSet(source, file, alias, depth + 1);
  }

  throw new Error(
    `template-coupling: ${name} in the live ${file} holds no extension strings ` +
      `and is not an alias this check can follow (body: ${JSON.stringify(body.slice(0, 80))}). ` +
      `Read the file and teach pythonExtensionSet its new shape — do not let ` +
      `this parse produce an empty set.`,
  );
}

function sortedList(set: Iterable<string>): string[] {
  return [...set].sort();
}

/** The `telar.version` a template `_config.yml` declares; throws when it names none. */
function templateVersion(config: string): string {
  const version = /^telar:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:\s*["']?([^"'\s]+)/m.exec(config)?.[1];
  if (!version) {
    throw new Error(
      "template-coupling: the live _config.yml names no telar.version this check can read. " +
        "Find where the version is recorded now and re-point the check.",
    );
  }
  return version;
}

/**
 * The tiler's search list in a framework's sources, against the set
 * TILEABLE_EXTENSIONS gives `version`. generate_iiif.py either holds its own
 * list or imports the ordered tuple from csv_utils; any other shape throws, so
 * an unread list is never compared as an empty one.
 */
function tiledComparison(
  generateIiif: string,
  csvUtils: string,
  version: string,
): { theirs: string[]; ours: string[]; missing: string[]; extra: string[] } {
  const importsFromCsvUtils =
    /^\s*from\s+(?:telar\.)?csv_utils\s+import\s+[^\n]*IMAGE_EXTENSIONS_ORDERED/m.test(generateIiif);
  const hasOwnList = pythonAssignmentBody(generateIiif, "image_extensions") !== null;
  if (!importsFromCsvUtils && !hasOwnList) {
    throw new Error(
      `template-coupling: the live ${GENERATE_IIIF_PATH} neither assigns ` +
        `image_extensions nor imports IMAGE_EXTENSIONS_ORDERED from csv_utils. ` +
        `The tiler's extension list has moved. Find where it lives now and ` +
        `re-point this check — an unread list is not an empty one.`,
    );
  }
  const tiled = hasOwnList
    ? pythonExtensionSet(generateIiif, GENERATE_IIIF_PATH, "image_extensions")
    : pythonExtensionSet(csvUtils, CSV_UTILS_PATH, "IMAGE_EXTENSIONS_ORDERED");
  const claimed = new Set(tileableExtensions(version).map(normaliseExtension));
  const theirs = sortedList(tiled);
  const ours = sortedList(claimed);
  return {
    theirs,
    ours,
    missing: theirs.filter((ext) => !claimed.has(ext)),
    extra: ours.filter((ext) => !tiled.has(ext)),
  };
}

// Skipped in the offline suite; runs only when LIVE_TEMPLATE_CHECK is set.
describe.runIf(process.env.LIVE_TEMPLATE_CHECK)(
  "file-type declarations match what the live template actually does",
  () => {
    // FAILURE MODE THIS GUARDS
    // ------------------------
    // TILEABLE_EXTENSIONS (app/lib/file-types.ts) is the Compositor's
    // prediction of which files in telar-content/objects/ the framework turns
    // into IIIF tiles, per framework release. When it is NARROWER than the
    // framework, an object that publishes perfectly is shown to its author as
    // having no image. When it is WIDER, the Compositor promises a viewer the
    // published site cannot supply.
    //
    // The framework's set is the tiler's search list: an object whose only
    // file has an extension the objects processor does not list is kept with
    // a warning, tiled, and shown by its object page and the story viewer.
    //
    // The assertion is EQUALITY, deliberately. A subset assertion would pass
    // while the Compositor is narrower than the framework, which is the failure
    // this whole area was opened to fix.

    let csvUtils: string;
    let generateIiif: string;
    let mediaType: string;

    beforeAll(async () => {
      [csvUtils, generateIiif, mediaType] = await Promise.all([
        fetchTemplateFile(CSV_UTILS_PATH),
        fetchTemplateFile(GENERATE_IIIF_PATH),
        fetchTemplateFile(MEDIA_TYPE_PATH),
      ]);
    }, 30_000);

    it("tiles exactly the extensions TILEABLE_EXTENSIONS gives the template's version", async () => {
      const version = templateVersion(await fetchTemplateFile("_config.yml"));
      const { theirs, ours, missing, extra } = tiledComparison(generateIiif, csvUtils, version);

      const guidance =
        missing.length === 0 && extra.length === 0
          ? ""
          : `TILEABLE_EXTENSIONS in app/lib/file-types.ts, for the template's ${version}, no ` +
            `longer equals the live tiler's search list.\n` +
            `  framework (${GENERATE_IIIF_PATH}): ${theirs.join(" ")}\n` +
            `  compositor (TILEABLE_EXTENSIONS):  ${ours.join(" ")}\n` +
            (missing.length
              ? `  the tiler searches [${missing.join(", ")}] and we do not claim ${missing.length === 1 ? "it" : "them"} ` +
                `for ${version}. Objects with ${missing.length === 1 ? "that extension" : "those extensions"} are shown ` +
                `to their authors as having no image. Add each with the release whose tiler first searches it, or ` +
                `correct the release given.\n`
              : "") +
            (extra.length
              ? `  we claim [${extra.join(", ")}] for ${version} and the tiler does not search ` +
                `${extra.length === 1 ? "it" : "them"}: the Compositor is promising a viewer the published site ` +
                `cannot supply. Correct the release given for ${extra.length === 1 ? "it" : "each"}.\n`
              : "") +
            `  Whether an author may upload a newly tiled format is UPLOAD_ACCEPTED_EXTENSIONS, a separate ` +
            `declaration that does not move on its own.`;

      expect(theirs, guidance).toEqual(ours);
    }, 30_000);

    it("strips from an object id exactly the extensions OBJECT_ID_STRIPPED_EXTENSIONS gives its version", async () => {
      // The framework strips csv_utils.IMAGE_EXTENSIONS from an id; the
      // Compositor declares that set per release, so the set it gives the
      // live template's own version must be the template's.
      const version = templateVersion(await fetchTemplateFile("_config.yml"));
      const theirs = sortedList(pythonExtensionSet(csvUtils, CSV_UTILS_PATH, "IMAGE_EXTENSIONS"));
      const ours = sortedList(strippedExtensions(version).map(normaliseExtension));
      expect(theirs.length, `no extensions parsed from ${CSV_UTILS_PATH}`).toBeGreaterThan(0);
      expect(
        theirs,
        `OBJECT_ID_STRIPPED_EXTENSIONS in app/lib/file-types.ts, for the template's ${version}, ` +
          `no longer equals the live ${CSV_UTILS_PATH} IMAGE_EXTENSIONS.\n` +
          `  framework:  ${theirs.join(" ")}\n  compositor: ${ours.join(" ")}\n` +
          `  Add the extension with the release that first strips it, or correct the release given.`,
      ).toEqual(ours);
    }, 30_000);

    it("recognises exactly the audio extensions AUDIO_EXTENSIONS claims", () => {
      // media_type.py enumerates uppercase spellings alongside lowercase ones;
      // normalising and deduplicating is what makes this a comparison of
      // formats rather than of spellings.
      const theirSet = pythonExtensionSet(mediaType, MEDIA_TYPE_PATH, "AUDIO_EXTENSIONS");
      expect(theirSet.size, `no extensions parsed from ${MEDIA_TYPE_PATH}`).toBeGreaterThan(0);

      const theirs = sortedList(theirSet);
      const ours = sortedList(AUDIO_EXTENSIONS);

      const guidance =
        `AUDIO_EXTENSIONS in app/lib/file-types.ts no longer equals the live ` +
        `${MEDIA_TYPE_PATH}.\n` +
        `  framework:  ${theirs.join(" ")}\n` +
        `  compositor: ${ours.join(" ")}\n` +
        `  The comparison is case-insensitive and deduplicated, so a difference here ` +
        `is a real format, not a spelling. An extension the framework hears as audio ` +
        `and we do not is an object the story editor offers an image viewer for; one ` +
        `we hear and it does not is an audio player over a file the site serves as an ` +
        `image. Match the framework, and consider whether the format also belongs in ` +
        `UPLOAD_ACCEPTED_EXTENSIONS — that is a separate decision.`;

      expect(theirs, guidance).toEqual(ours);
    });
  },
);

// Not gated: the parser above is the only thing standing between a framework
// reshape and a silently-passing equality, and it must be known to read both
// shapes BEFORE the reshape lands. These run offline against synthetic sources.
describe("the Python extension-literal parser reads both framework shapes", () => {
  const PUBLISHED_CSV_UTILS = `
IMAGE_EXTENSIONS = frozenset({
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.bmp', '.svg', '.pdf',
})
`;

  // The unreleased 1.8.0 shape: an ordered tuple, with the frozenset an alias.
  const ORDERED_CSV_UTILS = `
IMAGE_EXTENSIONS_ORDERED = (
    '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff', '.gif', '.bmp', '.svg', '.pdf',
)
IMAGE_EXTENSIONS = frozenset(IMAGE_EXTENSIONS_ORDERED)
`;

  const PUBLISHED_GENERATE_IIIF = `
def find_image(object_id, source_dir):
    image_extensions = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff', '.pdf']
    return None
`;

  const IMPORTING_GENERATE_IIIF = `
from telar.csv_utils import IMAGE_EXTENSIONS_ORDERED

def find_image(object_id, source_dir):
    for ext in IMAGE_EXTENSIONS_ORDERED:
        pass
`;

  it("reads the published frozenset literal", () => {
    const parsed = pythonExtensionSet(PUBLISHED_CSV_UTILS, "csv_utils.py", "IMAGE_EXTENSIONS");
    expect(sortedList(parsed)).toEqual(
      ["bmp", "gif", "jpeg", "jpg", "pdf", "png", "svg", "tif", "tiff", "webp"],
    );
  });

  it("follows the 1.8.0 alias to the ordered tuple", () => {
    const parsed = pythonExtensionSet(ORDERED_CSV_UTILS, "csv_utils.py", "IMAGE_EXTENSIONS");
    expect(parsed.has("heic")).toBe(true);
    expect(parsed.has("heif")).toBe(true);
    expect(parsed.size).toBe(12);
  });

  it("reads generate_iiif's own list, and reports its absence as absence", () => {
    expect(
      sortedList(pythonExtensionSet(PUBLISHED_GENERATE_IIIF, "generate_iiif.py", "image_extensions")),
    ).toEqual(["heic", "heif", "jpeg", "jpg", "pdf", "png", "tif", "tiff", "webp"]);
    // The import shape holds no literal — null, so the caller can fall back to
    // csv_utils rather than intersecting against nothing.
    expect(pythonAssignmentBody(IMPORTING_GENERATE_IIIF, "image_extensions")).toBeNull();
    expect(
      /^\s*from\s+(?:telar\.)?csv_utils\s+import\s+[^\n]*IMAGE_EXTENSIONS_ORDERED/m.test(
        IMPORTING_GENERATE_IIIF,
      ),
    ).toBe(true);
  });

  it("compares the tiler's own list with the set claimed for the version stated", () => {
    const on17 = tiledComparison(PUBLISHED_GENERATE_IIIF, PUBLISHED_CSV_UTILS, "1.7.0");
    expect(on17.theirs).toEqual(on17.ours);
    expect(on17.missing).toEqual([]);
    expect(on17.extra).toEqual([]);

    const claimedTooLate = tiledComparison(PUBLISHED_GENERATE_IIIF, PUBLISHED_CSV_UTILS, "0.8.0");
    expect(claimedTooLate.missing).toEqual(["pdf"]);
  });

  it("compares the imported ordered tuple with the set claimed for the version stated", () => {
    const on18 = tiledComparison(IMPORTING_GENERATE_IIIF, ORDERED_CSV_UTILS, "1.8.0");
    expect(on18.ours).toHaveLength(12);
    expect(on18.theirs).toEqual(on18.ours);

    const on17 = tiledComparison(IMPORTING_GENERATE_IIIF, ORDERED_CSV_UTILS, "1.7.0");
    expect(on17.missing).toEqual(["bmp", "gif", "svg"]);
    expect(on17.extra).toEqual([]);
  });

  it("reads the template's telar.version, and throws when it names none", () => {
    expect(templateVersion('title: T\ntelar:\n  repo: x\n  version: "1.8.0"\n')).toBe("1.8.0");
    expect(() => templateVersion("title: T\n")).toThrow(/names no telar.version/);
  });

  it("throws rather than returning an empty set when it cannot read a value", () => {
    // Name gone entirely.
    expect(() => pythonExtensionSet(PUBLISHED_CSV_UTILS, "csv_utils.py", "GONE")).toThrow(
      /no longer assigns GONE/,
    );
    // Assigned something that is not a literal this can read.
    expect(() =>
      pythonExtensionSet("IMAGE_EXTENSIONS = load_from_config()\n", "csv_utils.py", "IMAGE_EXTENSIONS"),
    ).toThrow(/cannot read|holds no extension strings/);
    // A literal that never closes — a truncated fetch, not an empty list.
    expect(() =>
      pythonExtensionSet("IMAGE_EXTENSIONS = frozenset({'.jpg',\n", "csv_utils.py", "IMAGE_EXTENSIONS"),
    ).toThrow(/never closes/);
    // An alias chain that goes nowhere.
    expect(() =>
      pythonExtensionSet("IMAGE_EXTENSIONS = frozenset(SOMETHING_ELSE)\n", "csv_utils.py", "IMAGE_EXTENSIONS"),
    ).toThrow(/no longer assigns SOMETHING_ELSE/);
  });
});

// ---------------------------------------------------------------------------
// Upgrade coverage
// ---------------------------------------------------------------------------

/**
 * Every path in the live template, from one call to the git-trees API.
 *
 * The contents API would need one request per directory; the trees API returns
 * the whole tree recursively. `truncated` is checked rather than trusted: GitHub
 * silently caps very large trees, and a truncated listing would report missing
 * paths as covered, which is the failure this block exists to prevent.
 */
async function fetchTemplateTree(): Promise<string[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${TEMPLATE_OWNER}/${TEMPLATE_REPO}/git/trees/HEAD?recursive=1`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new Error(`fetchTemplateTree: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    truncated: boolean;
    tree: Array<{ path: string; type: string }>;
  };
  if (data.truncated) {
    throw new Error(
      "fetchTemplateTree: GitHub truncated the tree listing, so absent paths cannot be told from uncovered ones",
    );
  }
  return data.tree.filter((e) => e.type === "blob").map((e) => e.path);
}

/**
 * Template paths the compositor deliberately does not deliver on upgrade, each
 * with the reason it is not a gap. A prefix ends in "/", anything else is an
 * exact path.
 *
 * This list is the other half of FRAMEWORK_PREFIXES + FRAMEWORK_FILES. Together
 * they have to account for the whole template, so a path the framework adds
 * lands in neither and fails the assertion below, and a person decides which
 * list it joins. Without it the check cannot run at all: 112 of the template's
 * 311 files sit outside the delivery constants and nearly all of them should.
 */
const NOT_DELIVERED: Array<{ path: string; why: string }> = [
  { path: "tests/", why: "the framework's own test suite; never delivered to a user site" },
  { path: "telar-content/", why: "the author's content — the compositor writes it from D1 at publish, never at upgrade" },
  { path: "docs/", why: "framework documentation, published separately as telar-docs" },
  { path: ".gitignore", why: "a user may add their own ignores; overwriting would discard them" },
  { path: "CITATION.cff", why: "names the framework's authors, not the site's; delivering it would misattribute the user's site" },
  { path: "_config.yml", why: "site settings the compositor owns field-by-field through KNOWN_CONFIG_KEYS; a whole-file delivery would overwrite every one" },
  { path: "migration.json", why: "the framework's own migration ledger, read by scripts/upgrade.py, which the compositor does not run" },
  { path: "objects.json", why: "generated at build from objects.csv" },
  // The three built-in pages. Not delivered here because each is author-editable
  // and index.md is managed content besides — see the frontmatter check below
  //
  { path: "index.md", why: "managed content: imported by import.server, published from project_landing" },
  { path: "pages/glossary.md", why: "author-editable body; touched only by the v1.3.0 ingest" },
  { path: "pages/objects.md", why: "author-editable body; touched only by the v1.3.0 ingest" },
];

describe.runIf(process.env.LIVE_TEMPLATE_CHECK)(
  "every path in the live template is either delivered on upgrade or declared as not delivered",
  () => {
    it("leaves no template path unaccounted for", async () => {
      const tree = await fetchTemplateTree();
      expect(tree.length).toBeGreaterThan(100);

      const delivered = (p: string) =>
        FRAMEWORK_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
        (FRAMEWORK_FILES as readonly string[]).includes(p);
      const declared = (p: string) =>
        NOT_DELIVERED.some((e) => (e.path.endsWith("/") ? p.startsWith(e.path) : p === e.path));

      const unaccounted = tree.filter((p) => !delivered(p) && !declared(p));
      expect(
        unaccounted,
        `the template ships ${unaccounted.length} path(s) that upgrade neither delivers nor declares as deliberately skipped. ` +
          `Each is either a framework file the compositor fails to deliver — add it to FRAMEWORK_PREFIXES or FRAMEWORK_FILES ` +
          `in app/lib/upgrade.server.ts — or something a site must keep, which belongs in NOT_DELIVERED with its reason:\n  ` +
          unaccounted.join("\n  "),
      ).toEqual([]);
    });

    it("declares nothing the template has stopped shipping", async () => {
      const tree = await fetchTemplateTree();
      // A stale exclusion is quieter than a missing one: it never fails, and it
      // leaves a reason on record for a file nobody ships any more. It also
      // widens the allowlist, so a future path reusing that name is skipped
      // without anyone deciding to skip it.
      const stale = NOT_DELIVERED.filter((e) =>
        e.path.endsWith("/")
          ? !tree.some((p) => p.startsWith(e.path))
          : !tree.includes(e.path),
      ).map((e) => e.path);
      expect(stale, `NOT_DELIVERED names ${stale.length} path(s) the template no longer ships`).toEqual([]);
    });
  },
);

/**
 * The frontmatter the framework ships on its three built-in pages, as
 * `BUILT_IN_PAGES` classifies it: keys the upgrade merge delivers
 * (`frameworkOwned`) and keys it leaves to the author (`authorOwned`).
 *
 * Exact equality with the union, so a key the framework adds fails here until
 * someone decides which side it is on. A check that every declared key still
 * exists would pass on a new key and let it go undelivered.
 */
const BUILT_IN_PAGE_FRONTMATTER: Record<string, string[]> = Object.fromEntries(
  Object.entries(BUILT_IN_PAGES).map(([path, page]) => [
    path,
    [...page.frameworkOwned, ...page.authorOwned],
  ]),
);

describe.runIf(process.env.LIVE_TEMPLATE_CHECK)(
  "the built-in pages still carry the frontmatter the compositor has accounted for",
  () => {
    it.each(Object.keys(BUILT_IN_PAGE_FRONTMATTER))("%s", async (path) => {
      const content = await fetchTemplateFile(path);
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      expect(match, `${path}: no frontmatter block`).not.toBeNull();

      const keys = (match as RegExpMatchArray)[1]
        .split("\n")
        .map((line) => line.match(/^([A-Za-z_][\w-]*):/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);

      expect(
        keys.sort(),
        `${path}'s frontmatter has changed. Classify each new key in BUILT_IN_PAGES ` +
          `(app/lib/framework-page-frontmatter.server.ts): frameworkOwned if the upgrade should ` +
          `deliver it to existing sites, authorOwned if it is a default the author may change.`,
      ).toEqual([...BUILT_IN_PAGE_FRONTMATTER[path]].sort());
    });
  },
);
