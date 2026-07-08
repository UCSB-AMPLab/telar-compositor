/**
 * This file is the server-side scaffolding for the "Create a new Telar
 * site" path of the onboarding wizard.
 *
 * It bundles the small set of GitHub REST calls that path needs —
 * checking whether the user's chosen repo name is available, generating
 * the new repo from the Telar template, polling until the new repo is
 * actually ready (template generation is asynchronous on GitHub's side),
 * confirming the GitHub App installation can see the new repo, and
 * patching the freshly-created repo's `_config.yml` with the site's own
 * Pages URL (and chosen language) so its first GitHub Pages build bakes
 * correct IIIF tile URLs.
 *
 * Callers resolve the GitHub token themselves (user-to-server for most
 * operations, installation token for `isRepoInInstallation`) and pass it
 * in. Errors are thrown as typed subclasses so route handlers can branch
 * with `instanceof` rather than parsing error messages.
 *
 * Style mirrors `app/lib/github.server.ts`: raw fetch against
 * `https://api.github.com`, pinned API version header, throws on non-2xx.
 *
 * @version v1.4.1-beta
 */

import Papa from "papaparse";
import {
  disableGoogleSheetsInConfig,
  isGoogleSheetsEnabled,
  commitFilesToRepo,
  enableGitHubPages,
  dispatchWorkflow,
} from "~/lib/commit.server";
import { configLineRegex } from "~/lib/config-yaml-block.server";

// Constants
export const TEMPLATE_OWNER = "ucsb-amplab";
export const TEMPLATE_REPO = "telar";

const GITHUB_API = "https://api.github.com";

// The template ships one starter story per language (verified against
// ucsb-amplab/telar@main, 2026-06-28). A born-clean site keeps the story whose
// language matches the site and prunes the other one.
const STORY_SLUG_BY_LOCALE = {
  en: "blank_template",
  es: "plantilla_en_blanco",
} as const;

export const SPREADSHEETS_DIR = "telar-content/spreadsheets";
export const STORIES_TEXTS_DIR = "telar-content/texts/stories";

/** The starter-story slug kept for a born-clean site of the given language. */
export function storySlugForLocale(locale: "en" | "es"): string {
  return STORY_SLUG_BY_LOCALE[locale];
}

/** The starter-story slug pruned from a born-clean site of the given language. */
export function otherStorySlug(locale: "en" | "es"): string {
  return STORY_SLUG_BY_LOCALE[locale === "en" ? "es" : "en"];
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "telar-compositor",
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// Typed error subclasses
export class RepoNameTakenError extends Error {
  constructor(message = "Repository name is already taken") {
    super(message);
    this.name = "RepoNameTakenError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message = "GitHub App lacks required permissions") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class GitHubError extends Error {
  status?: number;
  body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

export class RepoNotReadyError extends Error {
  lastStatus?: number;
  constructor(message = "Repository not ready within timeout", lastStatus?: number) {
    super(message);
    this.name = "RepoNotReadyError";
    this.lastStatus = lastStatus;
  }
}

// Public types
export type RepoNameAvailability = { available: boolean; reason?: "exists" | "invalid" };
export type CreateSiteResult = { repoUrl: string; defaultBranch: string };

// Implementations

/**
 * GitHub repo naming rules:
 * - 1–100 characters
 * - character class [a-z0-9._-] (lowercase only — Telar convention)
 * - must not start with '.' or '-'
 * - must not be exactly '.' or '..'
 */
export function isValidRepoName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > 100) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return /^[a-z0-9._-]+$/.test(name);
}

// Async stubs filled in by subsequent plans (19-02, 19-03, 19-04)

export async function checkRepoNameAvailable(
  token: string,
  owner: string,
  name: string,
): Promise<RepoNameAvailability> {
  if (!isValidRepoName(name)) {
    return { available: false, reason: "invalid" };
  }
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (res.status === 404) return { available: true };
  if (res.status === 200) return { available: false, reason: "exists" };
  const body = await safeJson(res);
  throw new GitHubError(
    `checkRepoNameAvailable: unexpected status ${res.status}`,
    res.status,
    body,
  );
}

export async function createSiteFromTemplate(
  token: string,
  owner: string,
  name: string,
): Promise<CreateSiteResult> {
  const res = await fetch(
    `${GITHUB_API}/repos/${TEMPLATE_OWNER}/${TEMPLATE_REPO}/generate`,
    {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        owner,
        name,
        description: "Created with Telar Compositor",
        private: false,
        include_all_branches: false,
      }),
    },
  );

  if (res.status >= 200 && res.status < 300) {
    const body = (await res.json()) as { html_url: string; default_branch: string };
    return { repoUrl: body.html_url, defaultBranch: body.default_branch };
  }

  const body = await safeJson(res);

  if (res.status === 422) {
    throw new RepoNameTakenError(
      `Repository name "${name}" is already taken on ${owner}`,
    );
  }
  if (res.status === 403) {
    throw new PermissionDeniedError(
      "GitHub App lacks Administration:Write — cannot create repo from template",
    );
  }
  throw new GitHubError(
    `createSiteFromTemplate: unexpected status ${res.status}`,
    res.status,
    body,
  );
}

/**
 * Polls `GET /repos/{owner}/{name}/contents/_config.yml` at a fixed 1s interval
 * until HTTP 200 or `timeoutMs` elapses. Existence of the file is enough;
 * the body is not decoded.
 *
 * Behaviour:
 * - Fixed 1000ms interval
 * - Default `timeoutMs = 15000`
 * - Throws `RepoNotReadyError` on timeout (carries `lastStatus` if one was observed)
 * - Transient 5xx or network errors mid-poll are swallowed and retried until timeout
 */
export async function waitForRepoReady(
  token: string,
  owner: string,
  name: string,
  timeoutMs = 15000,
): Promise<void> {
  const intervalMs = 1000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}/contents/_config.yml`,
        { method: "GET", headers: authHeaders(token) },
      );
      lastStatus = res.status;
      if (res.status === 200) return;
      // 404 (not yet populated) and 5xx (GitHub hiccup) both fall through to retry.
    } catch {
      // Network error — swallow and retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new RepoNotReadyError(
    `Repository ${owner}/${name} not ready within ${timeoutMs}ms`,
    lastStatus,
  );
}

/**
 * Checks whether the installation associated with `installationToken` can see
 * the repo `{owner}/{name}`. Paginates `GET /installation/repositories` at
 * per_page=100.
 *
 * Returns `false` when the target is absent across all pages.
 * Throws `GitHubError` on HTTP/network failure.
 */
export async function isRepoInInstallation(
  installationToken: string,
  owner: string,
  name: string,
): Promise<boolean> {
  const target = `${owner}/${name}`.toLowerCase();
  const perPage = 100;
  let page = 1;

  // Safety cap — a single installation very rarely exceeds 50k repos; 500 pages
  // is a defensive ceiling to avoid infinite loops on API quirks.
  const maxPages = 500;

  while (page <= maxPages) {
    const res = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=${perPage}&page=${page}`,
      { method: "GET", headers: authHeaders(installationToken) },
    );

    if (!res.ok) {
      const body = await safeJson(res);
      throw new GitHubError(
        `isRepoInInstallation: unexpected status ${res.status}`,
        res.status,
        body,
      );
    }

    const body = (await res.json()) as {
      total_count?: number;
      repositories?: Array<{ full_name: string }>;
    };

    const repos = body.repositories ?? [];
    for (const repo of repos) {
      if (repo.full_name.toLowerCase() === target) return true;
    }

    // Stop when the server returned a partial page (last page) or zero items.
    if (repos.length < perPage) return false;
    page += 1;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Born-clean transforms (pure)
//
// These produce the bytes a freshly-created site should ship with, so its first
// public build is correct rather than wearing the template's demo identity.
// They are pure string→string (no network, no DB) so the orchestration layer can
// read the template files, run these, and land the result in one atomic commit.
//
// `_config.yml` is edited line-by-line (never yaml.load/dump) to preserve
// comments and whitespace exactly — mirroring updateTelarVersionInConfig in
// upgrade.server.ts. CSV is mutated with papaparse in array mode, the same stack
// as the import pipeline and manifest runner, so quoted multiline cells and the
// template's `#` comment rows survive untouched.
// ---------------------------------------------------------------------------

/** Escape a value for safe interpolation into a YAML double-quoted scalar. */
function yamlDoubleQuote(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// Identity helpers (slug humanization, theme validation, the URL preview) live
// in the browser-safe `site-identity` module so the wizard UI can import them
// too. Re-exported here so existing server-side imports/tests keep working.
export {
  humanizeSlug,
  deriveSiteUrl,
  normalizeTheme,
  VALID_THEMES,
  DEFAULT_THEME,
  type ThemeId,
} from "~/lib/site-identity";

export interface BornCleanConfigOptions {
  /** Repo owner login (GitHub Pages host is the lowercased form). */
  owner: string;
  /** Canonical repo name as GitHub stored it — used verbatim in `baseurl`. */
  name: string;
  locale: "en" | "es";
  /** Site title (wizard-supplied, or a humanized slug before the wizard exists). */
  title: string;
  /** Non-empty one-liner — an empty `description` drops the published <meta>. */
  description: string;
  /** Theme token; defaults to the template's `trama` when omitted by the caller. */
  theme: string;
  /** Site author byline. Written to the `author:` line when set; if the template
   *  has no such line, it's skipped silently (author is cosmetic, never fatal). */
  author?: string;
}

/**
 * Rewrite the template `_config.yml` body into the born-clean form for a new
 * site. Sets identity (`title`, `description`, `url`, `baseurl`, `telar_theme`,
 * `telar_language`) to the site's own values and switches off the two demo
 * sources a fresh site must not inherit: `include_demo_content` (the
 * content.telar.org demo stories) and `google_sheets.enabled` (which would
 * otherwise make the first import seed D1 from the live demo spreadsheet instead
 * of the repo's own CSVs).
 *
 * Every line this touches must exist in the template; a missing line means the
 * template drifted and the seed would be silently wrong, so we throw loud rather
 * than ship a half-clean site. The google_sheets switch-off is re-asserted via
 * `isGoogleSheetsEnabled` because that block is structural, not a single line.
 */
export function buildBornCleanConfig(
  body: string,
  opts: BornCleanConfigOptions,
): string {
  const pagesUrl = `https://${opts.owner.toLowerCase()}.github.io`;
  const pagesBaseurl = `/${opts.name}`;

  const valued = configLineRegex;

  const edits: Array<[string, RegExp, string]> = [
    ["title", valued("title"), `"${yamlDoubleQuote(opts.title)}"`],
    ["description", valued("description"), `"${yamlDoubleQuote(opts.description)}"`],
    ["url", valued("url"), `"${pagesUrl}"`],
    ["baseurl", valued("baseurl"), `"${pagesBaseurl}"`],
    ["telar_theme", valued("telar_theme"), `"${yamlDoubleQuote(opts.theme)}"`],
    ["telar_language", valued("telar_language"), `"${opts.locale}"`],
  ];

  let patched = body;
  for (const [field, re, value] of edits) {
    if (!re.test(patched)) {
      throw new GitHubError(`buildBornCleanConfig: ${field} line not found in _config.yml`);
    }
    patched = patched.replace(re, `$1${value}$2`);
  }

  // Author is optional and cosmetic. Write the byline when supplied, but if the
  // template ever drops its `author:` line, skip silently rather than throw — a
  // missing author must not fail the whole born-clean commit (which would route
  // to the repair flow and re-open the demo-content leak). This is deliberately
  // NOT in the required-edits loop above.
  if (opts.author && opts.author.trim()) {
    const authorRe = valued("author");
    if (authorRe.test(patched)) {
      patched = patched.replace(authorRe, `$1"${yamlDoubleQuote(opts.author.trim())}"$2`);
    }
  }

  // include_demo_content is an indented, unique key — flip true→false in place,
  // keeping its trailing comment.
  const demoRe = /^(\s*include_demo_content:\s*)(?:true|false)\b(.*)$/m;
  if (!demoRe.test(patched)) {
    throw new GitHubError("buildBornCleanConfig: include_demo_content line not found in _config.yml");
  }
  patched = patched.replace(demoRe, `$1false$2`);

  // google_sheets.enabled lives in a structural block — reuse the import-side
  // helper, then re-assert it actually went off (the leak is load-bearing).
  patched = disableGoogleSheetsInConfig(patched);
  if (isGoogleSheetsEnabled(patched)) {
    throw new GitHubError("buildBornCleanConfig: failed to disable google_sheets");
  }

  return patched;
}

/**
 * Rewrite the `telar` glossary row's definition to the single language-matched
 * paragraph. The template ships that cell as a bilingual block — an English
 * paragraph, a blank line, then a Spanish one — so a born-clean site keeps only
 * the paragraph for its own language. All other rows (header, `#` comment rows,
 * any future terms) pass through untouched.
 */
export function languageMatchGlossary(csv: string, locale: "en" | "es"): string {
  const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: false });
  const rows = parsed.data;
  const header = rows[0] ?? [];
  const defIdx = header.findIndex((c) => c.trim() === "definition");
  if (defIdx === -1) {
    throw new GitHubError("languageMatchGlossary: no 'definition' column in glossary.csv");
  }
  const row = rows.find((r) => r[0] === "telar");
  if (!row) {
    throw new GitHubError("languageMatchGlossary: no 'telar' row in glossary.csv");
  }
  const paragraphs = (row[defIdx] ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    throw new GitHubError("languageMatchGlossary: 'telar' definition is not a two-language block");
  }
  // Template order is English then Spanish.
  row[defIdx] = locale === "en" ? paragraphs[0] : paragraphs[1];
  return Papa.unparse(rows, { newline: "\n" });
}

/**
 * Drop the non-matching starter story's row from `project.csv`, keeping the
 * header, both `#` comment rows, and the language-matched story. Only the one
 * data row whose `story_id` is the other language's slug is removed.
 */
export function pruneProjectStories(csv: string, locale: "en" | "es"): string {
  const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: false });
  const rows = parsed.data;
  const header = rows[0] ?? [];
  const idIdx = header.findIndex((c) => c.trim() === "story_id");
  if (idIdx === -1) {
    throw new GitHubError("pruneProjectStories: no 'story_id' column in project.csv");
  }
  const drop = otherStorySlug(locale);
  const kept = rows.filter((r) => r[idIdx] !== drop);
  if (kept.length === rows.length) {
    throw new GitHubError(`pruneProjectStories: expected story row '${drop}' not found`);
  }
  return Papa.unparse(kept, { newline: "\n" });
}

// ---------------------------------------------------------------------------
// commitBornCleanSite — born-clean orchestration
// ---------------------------------------------------------------------------

/** Read any repo file's decoded UTF-8 content via the contents API. */
async function readRepoFile(
  token: string,
  owner: string,
  name: string,
  path: string,
  retry: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<string> {
  // GitHub's contents API 404s transiently for a few seconds after a repo is
  // created from a template — even after waitForRepoReady has seen _config.yml
  // at 200 (eventual consistency across replicas). A single read can therefore
  // hit a 404 that resolves on retry; the same window can yield brief 5xx. Retry
  // those rather than failing the whole born-clean commit. Non-transient errors
  // (403 permission, etc.) fail fast.
  const maxAttempts = retry.maxAttempts ?? 8;
  const intervalMs = retry.intervalMs ?? 700;
  let res!: Response;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    res = await fetch(
      `${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}/contents/${path}`,
      { method: "GET", headers: authHeaders(token) },
    );
    if (res.ok) break;
    const transient = res.status === 404 || res.status >= 500;
    if (!transient || attempt === maxAttempts - 1) {
      const errBody = await safeJson(res);
      throw new GitHubError(`readRepoFile(${path}): status ${res.status}`, res.status, errBody);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const data = (await res.json()) as { content: string; encoding: string };
  if (data.encoding !== "base64") {
    throw new GitHubError(`readRepoFile(${path}): unexpected encoding ${data.encoding}`);
  }
  // atob yields a Latin-1 byte string; decode those bytes as UTF-8 so the
  // returned value is a proper Unicode string. This must match how
  // commitFilesToRepo re-encodes (btoa(unescape(encodeURIComponent(...)))) —
  // otherwise non-ASCII content (Spanish glossary/story text, the "(Español)"
  // config comment) double-encodes into mojibake on commit.
  const bytes = atob(data.content.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
}

/**
 * List the file paths directly under a repo directory. Returns `[]` when the
 * directory is absent (404) so a missing sister-dir degrades to "nothing extra
 * to delete" rather than failing the whole born-clean commit.
 */
async function listRepoDir(
  token: string,
  owner: string,
  name: string,
  dir: string,
): Promise<string[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}/contents/${dir}`,
    { method: "GET", headers: authHeaders(token) },
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    const errBody = await safeJson(res);
    throw new GitHubError(`listRepoDir(${dir}): status ${res.status}`, res.status, errBody);
  }
  const data = (await res.json()) as Array<{ type: string; path: string }>;
  return data.filter((e) => e.type === "file").map((e) => e.path);
}

export interface BornCleanSiteParams {
  /** User-to-server token — authors the commit and dispatches the build. */
  token: string;
  /** Installation token — required to enable GitHub Pages on the new repo. */
  installationToken: string;
  owner: string;
  /** Canonical repo name as GitHub stored it. */
  name: string;
  locale: "en" | "es";
  title: string;
  description: string;
  theme: string;
  /** Author byline; defaults are resolved by the caller (e.g. the owner login). */
  author?: string;
  /** Override the post-/generate read retry interval (ms). Defaults to 700; tests pass 0. */
  fileReadRetryIntervalMs?: number;
}

export interface BornCleanSiteResult {
  /** True only when commit AND Pages-enable AND build-dispatch all succeeded. */
  ok: boolean;
  /** The repo's Pages URL once enabled, for persistence by the caller. */
  pagesUrl?: string;
  /** Which step degraded, when `ok` is false (`commit` | `pages` | `url` | `dispatch`). */
  error?: string;
}

/**
 * Decide whether a newly-enabled Pages site is actually served from a custom
 * domain the account already configured (a CNAME on its `<owner>.github.io`
 * user-pages site makes GitHub serve *project* sites from that domain too). When
 * it is, `enableGitHubPages`'s `html_url` comes back as `https://<domain>/<repo>`
 * rather than the `https://<owner>.github.io/<repo>` default that
 * `buildBornCleanConfig` wrote — so the committed `url`/`baseurl` (and the IIIF
 * tile base derived from them) are wrong for this account.
 *
 * Returns the corrected `{ url, baseurl }` to write, or `null` when the served
 * host is the expected `<owner>.github.io` (no correction needed) or the URL is
 * empty/unparseable (nothing safe to do — leave the github.io default for the
 * repair flow). This mirrors the parse in the onboarding `fix-site-config`
 * repair so born-clean and repair agree on how a Pages URL maps to config.
 */
export function customDomainConfigCorrection(
  servedPagesUrl: string,
  owner: string,
  name: string,
): { url: string; baseurl: string } | null {
  if (!servedPagesUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(servedPagesUrl);
  } catch {
    return null;
  }
  const expectedHost = `${owner.toLowerCase()}.github.io`;
  if (parsed.host.toLowerCase() === expectedHost) return null;
  return {
    url: `${parsed.protocol}//${parsed.host}`,
    baseurl: parsed.pathname.replace(/\/+$/, ""),
  };
}

/**
 * Replace the `url:` and `baseurl:` lines in a `_config.yml` body, preserving
 * every other line AND any inline comment on those lines. Used to re-stamp a
 * born-clean config with the real served URL when a custom domain is detected.
 *
 * Throws (rather than silently no-op'ing) if either line is absent — a missing
 * line means the config drifted from the expected shape, and a silent no-op
 * would ship a half-corrected config with the wrong IIIF base. Mirrors
 * `buildBornCleanConfig`'s loud-on-drift contract via the shared
 * `configLineRegex`.
 */
export function rewriteConfigUrl(body: string, url: string, baseurl: string): string {
  const urlRe = configLineRegex("url");
  const baseRe = configLineRegex("baseurl");
  if (!urlRe.test(body)) {
    throw new GitHubError("rewriteConfigUrl: url line not found in _config.yml");
  }
  if (!baseRe.test(body)) {
    throw new GitHubError("rewriteConfigUrl: baseurl line not found in _config.yml");
  }
  return body
    .replace(urlRe, `$1"${yamlDoubleQuote(url)}"$2`)
    .replace(baseRe, `$1"${yamlDoubleQuote(baseurl)}"$2`);
}

/**
 * Provision a freshly-generated repo into its born-clean state, then make its
 * first public build correct.
 *
 * Order matters and is the whole point:
 *   1.   config + content commit lands FIRST (so the subsequent import reads
 *        `google_sheets.enabled: false` and seeds D1 from the repo's own CSVs
 *        instead of the live demo spreadsheet);
 *   1.5. scope guard — confirm the new repo is in the App installation before
 *        the installation-token Pages call (skipped/`error:"scope"` otherwise);
 *   2.   Pages is enabled;
 *   2.5. if the account serves a custom domain, the committed github.io URL is
 *        corrected and re-committed before the build;
 *   3.   the build is dispatched (Pages with `build_type:"workflow"` does not
 *        auto-run, and the push-triggered build raced ahead of Pages-enable),
 *        forcing IIIF regen so tiles bake the repo's real served base URL.
 *
 * Failure is graded, not fatal. The commit closes the demo-content leak; if it
 * fails, the caller still proceeds and the existing repair flow re-disables
 * Sheets. Scope / Pages-enable / URL-correction / dispatch failures leave a
 * landed commit but an un-deployed (or wrong-URL) site — all recoverable by the
 * repair flow. So any step failing returns `ok: false` (the caller must then NOT
 * skip the repair step) rather than throwing. Bounded Pages-settling backoff is
 * a later hardening pass.
 *
 * Why the commit stays FIRST (not reordered after Pages-enable): the custom-domain
 * path costs a second `_config.yml` commit, which adds a build-run racer to the
 * Pages-deploy concurrency window and can surface a cosmetic "build failed" email.
 * It is tempting to collapse to one commit by enabling Pages first (to learn the
 * served URL) and committing once afterward — but that moves the born-clean commit
 * after the scope/Pages steps, so a scope-grant or Pages-enable failure would let
 * `intent=import` run against the still-demo `_config.yml` and seed D1 from the live
 * demo Google Sheet — re-opening the exact leak born-clean exists to close. Commit
 * order is load-bearing for leak-safety and must not be traded for the email. The
 * duplicate-build race is fixed upstream in the framework's `build.yml`
 * (`concurrency` group), not here.
 */
export async function commitBornCleanSite(
  params: BornCleanSiteParams,
): Promise<BornCleanSiteResult> {
  const { token, installationToken, owner, name, locale, title, description, theme, author } = params;
  const readRetry = { intervalMs: params.fileReadRetryIntervalMs };

  // Hoisted so the custom-domain correction (step 2.5) can re-stamp and re-commit
  // the born-clean config without re-reading it from the repo.
  let config: string;

  // 1. Commit born-clean config + language-matched content in one atomic commit.
  try {
    const [configBody, projectCsv, glossaryCsv] = await Promise.all([
      readRepoFile(token, owner, name, "_config.yml", readRetry),
      readRepoFile(token, owner, name, `${SPREADSHEETS_DIR}/project.csv`, readRetry),
      readRepoFile(token, owner, name, `${SPREADSHEETS_DIR}/glossary.csv`, readRetry),
    ]);

    // Idempotency guard for a retry after a commit that landed but whose
    // response was lost. commitFilesToRepo lands every born-clean change in ONE
    // atomic commit, and the template ships google_sheets ENABLED, so a config
    // that already has it disabled means the whole born-clean commit already
    // landed. Re-running the transforms would throw (pruneProjectStories /
    // languageMatchGlossary expect the pristine two-language template) and
    // re-deleting the already-deleted sister files would be rejected — so skip
    // the re-commit and fall through to Pages-enable + dispatch (the steps that
    // run after the commit, and the ones a retry is actually here to complete).
    if (!isGoogleSheetsEnabled(configBody)) {
      config = configBody;
      // eslint-disable-next-line no-console
      console.warn(
        "[commitBornCleanSite] config already born-clean; skipping re-commit (idempotent retry)",
      );
    } else {
      const drop = otherStorySlug(locale);
      const sisterFiles = await listRepoDir(token, owner, name, `${STORIES_TEXTS_DIR}/${drop}`);

      config = buildBornCleanConfig(configBody, {
        owner,
        name,
        locale,
        title,
        description,
        theme,
        author,
      });
      const project = pruneProjectStories(projectCsv, locale);
      const glossary = languageMatchGlossary(glossaryCsv, locale);

      await commitFilesToRepo(
        token,
        owner,
        name,
        "main",
        [
          { path: "_config.yml", content: config },
          { path: `${SPREADSHEETS_DIR}/project.csv`, content: project },
          { path: `${SPREADSHEETS_DIR}/glossary.csv`, content: glossary },
        ],
        "Set up site configuration and starter content",
        undefined,
        [`${SPREADSHEETS_DIR}/${drop}.csv`, ...sisterFiles],
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commitBornCleanSite] config/content commit failed:", err);
    return { ok: false, error: "commit" };
  }

  // 1.5. Scope guard. Enabling Pages uses the installation token, which can only
  //       see repos in the App installation. A "selected repositories" install
  //       (org OR personal) does not include a just-created repo until the user
  //       grants access — so the installation token would 404 on Pages-enable and
  //       read as a generic "pages" degrade. Check first and surface a precise
  //       `error:"scope"` so the UI shows the grant-access prompt as the primary
  //       state instead of the misleading "we'll finish it for you" message. A
  //       scope-check failure must not dead-end a real success, so it fails open
  //       (fall through to Pages; a genuinely out-of-scope repo still degrades).
  try {
    const inScope = await isRepoInInstallation(installationToken, owner, name);
    if (!inScope) return { ok: false, error: "scope" };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commitBornCleanSite] scope pre-check failed (continuing):", err);
  }

  // 2. Enable GitHub Pages (installation token — the new repo must be in scope).
  let pagesUrl: string;
  try {
    const result = await enableGitHubPages(installationToken, owner, name);
    pagesUrl = result.pagesUrl;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commitBornCleanSite] enableGitHubPages failed:", err);
    return { ok: false, error: "pages" };
  }

  // 2.5. Custom-domain correction. If the account serves Pages from a custom
  //      domain (inherited from its <owner>.github.io CNAME), the served URL
  //      differs from the github.io default `buildBornCleanConfig` wrote in
  //      step 1. Re-stamp the in-memory config and commit it BEFORE the build
  //      dispatch, so the first (and only) IIIF build bakes the real served base
  //      URL. The github.io happy path skips this entirely (correction is null).
  const correction = customDomainConfigCorrection(pagesUrl, owner, name);
  if (correction) {
    try {
      const correctedConfig = rewriteConfigUrl(config, correction.url, correction.baseurl);
      await commitFilesToRepo(
        token,
        owner,
        name,
        "main",
        [{ path: "_config.yml", content: correctedConfig }],
        "Match site URL to served custom domain",
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commitBornCleanSite] custom-domain URL correction failed:", err);
      // The github.io config is committed and Pages is on; the repair flow's
      // site-URL check still catches the mismatch and fixes it. Degrade rather
      // than dispatch a build that would bake the wrong IIIF base.
      return { ok: false, error: "url", pagesUrl };
    }
  }

  // 3. Dispatch the build so the first public deploy is correct (force IIIF
  //    regen against the repo's own base URL).
  try {
    await dispatchWorkflow(token, owner, name, "build.yml", { force_iiif: "true" });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[commitBornCleanSite] dispatchWorkflow failed:", err);
    return { ok: false, error: "dispatch", pagesUrl };
  }

  return { ok: true, pagesUrl };
}
