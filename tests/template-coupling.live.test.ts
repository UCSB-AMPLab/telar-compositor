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
 * Gated behind `LIVE_TEMPLATE_CHECK` so the normal offline suite (`npm test`) skips
 * it — it makes a network call to api.github.com. Run it at the release gate:
 *   LIVE_TEMPLATE_CHECK=1 npx vitest run tests/template-coupling.live.test.ts
 * It hits the public template unauthenticated; set `GITHUB_TOKEN` to dodge the
 * unauthenticated rate limit if needed.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  buildBornCleanConfig,
  pruneProjectStories,
  languageMatchGlossary,
  storySlugForLocale,
  otherStorySlug,
  TEMPLATE_OWNER,
  TEMPLATE_REPO,
  SPREADSHEETS_DIR,
  STORIES_TEXTS_DIR,
} from "~/lib/create-site.server";
import { isGoogleSheetsEnabled } from "~/lib/commit.server";

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

    beforeAll(async () => {
      [config, projectCsv, glossaryCsv] = await Promise.all([
        fetchTemplateFile("_config.yml"),
        fetchTemplateFile(`${SPREADSHEETS_DIR}/project.csv`),
        fetchTemplateFile(`${SPREADSHEETS_DIR}/glossary.csv`),
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

      it(`pruneProjectStories keeps the ${locale} starter story and drops the other`, () => {
        const out = pruneProjectStories(projectCsv, locale);
        expect(out).toContain(storySlugForLocale(locale));
        expect(out).not.toContain(otherStorySlug(locale));
      });

      it(`languageMatchGlossary collapses the bilingual telar row for ${locale}`, () => {
        // No throw means the telar row is still a two-language block with the
        // expected columns; that's the coupling we care about.
        expect(() => languageMatchGlossary(glossaryCsv, locale)).not.toThrow();
      });
    }

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
