/**
 * This file pins unit tests for `app/lib/create-site.server.ts` — the
 * helpers that validate a desired repo name, check it's available on
 * GitHub, create a new repo from the Telar template, and seed its
 * `_config.yml` (Pages URL + language) during onboarding.
 *
 * Uses the same `globalThis.fetch` mocking pattern as
 * `tests/github.server.test.ts` — no MSW, no nock, no new dependencies.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isValidRepoName,
  checkRepoNameAvailable,
  createSiteFromTemplate,
  waitForRepoReady,
  isRepoInInstallation,
  humanizeSlug,
  buildBornCleanConfig,
  languageMatchGlossary,
  pruneProjectStories,
  commitBornCleanSite,
  customDomainConfigCorrection,
  rewriteConfigUrl,
  storySlugForLocale,
  otherStorySlug,
  TEMPLATE_OWNER,
  TEMPLATE_REPO,
  RepoNameTakenError,
  PermissionDeniedError,
  GitHubError,
  RepoNotReadyError,
} from "~/lib/create-site.server";

const TOKEN = "test-token-abc";

function makeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

// Export for later plans so they can reuse the helper shape.
export { makeFetch };

describe("TEMPLATE constants", () => {
  it("exports the locked template owner and repo", () => {
    expect(TEMPLATE_OWNER).toBe("ucsb-amplab");
    expect(TEMPLATE_REPO).toBe("telar");
  });
});

describe("isValidRepoName", () => {
  it("accepts simple valid name", () => {
    expect(isValidRepoName("my-site")).toBe(true);
  });
  it("accepts underscores, dots, hyphens, digits", () => {
    expect(isValidRepoName("my_site.1-x")).toBe(true);
  });
  it("rejects uppercase letters", () => {
    expect(isValidRepoName("My-Site")).toBe(false);
  });
  it("accepts single character name (1 char minimum)", () => {
    expect(isValidRepoName("a")).toBe(true);
  });
  it("accepts 100 character name (maximum)", () => {
    expect(isValidRepoName("a".repeat(100))).toBe(true);
  });
  it("rejects 101 character name (too long)", () => {
    expect(isValidRepoName("a".repeat(101))).toBe(false);
  });
  it("rejects empty string", () => {
    expect(isValidRepoName("")).toBe(false);
  });
  it("rejects leading dot", () => {
    expect(isValidRepoName(".hidden")).toBe(false);
  });
  it("rejects leading hyphen", () => {
    expect(isValidRepoName("-start")).toBe(false);
  });
  it("rejects single dot", () => {
    expect(isValidRepoName(".")).toBe(false);
  });
  it("rejects double dot", () => {
    expect(isValidRepoName("..")).toBe(false);
  });
  it("rejects space", () => {
    expect(isValidRepoName("has space")).toBe(false);
  });
  it("rejects slash", () => {
    expect(isValidRepoName("has/slash")).toBe(false);
  });
  it("rejects non-ASCII characters", () => {
    expect(isValidRepoName("emoji🎉")).toBe(false);
  });
});

describe("checkRepoNameAvailable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("short-circuits with reason:invalid for invalid name without calling fetch", async () => {
    const fetchMock = makeFetch({});
    globalThis.fetch = fetchMock;
    const result = await checkRepoNameAvailable(TOKEN, "me", ".bad");
    expect(result).toEqual({ available: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns available:true on HTTP 404", async () => {
    globalThis.fetch = makeFetch({ message: "Not Found" }, 404);
    const result = await checkRepoNameAvailable(TOKEN, "me", "my-site");
    expect(result).toEqual({ available: true });
  });

  it("returns available:false reason:exists on HTTP 200", async () => {
    globalThis.fetch = makeFetch({ id: 1 }, 200);
    const result = await checkRepoNameAvailable(TOKEN, "me", "my-site");
    expect(result).toEqual({ available: false, reason: "exists" });
  });

  it("throws GitHubError on HTTP 500", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    await expect(checkRepoNameAvailable(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      GitHubError,
    );
  });

  it("sends Authorization Bearer header", async () => {
    globalThis.fetch = makeFetch({}, 404);
    await checkRepoNameAvailable(TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

describe("createSiteFromTemplate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns {repoUrl, defaultBranch} on 201", async () => {
    globalThis.fetch = makeFetch(
      { html_url: "https://github.com/me/my-site", default_branch: "main" },
      201,
    );
    const result = await createSiteFromTemplate(TOKEN, "me", "my-site");
    expect(result).toEqual({ repoUrl: "https://github.com/me/my-site", defaultBranch: "main" });
  });

  it("POSTs to the ucsb-amplab/telar generate endpoint", async () => {
    globalThis.fetch = makeFetch(
      { html_url: "https://github.com/me/my-site", default_branch: "main" },
      201,
    );
    await createSiteFromTemplate(TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.github.com/repos/ucsb-amplab/telar/generate");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body as string);
    expect(body.owner).toBe("me");
    expect(body.name).toBe("my-site");
    expect(body.private).toBe(false);
  });

  it("throws RepoNameTakenError on 422", async () => {
    globalThis.fetch = makeFetch({ message: "name already exists" }, 422);
    await expect(createSiteFromTemplate(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      RepoNameTakenError,
    );
  });

  it("throws PermissionDeniedError on 403", async () => {
    globalThis.fetch = makeFetch({ message: "Resource not accessible" }, 403);
    await expect(createSiteFromTemplate(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("throws GitHubError on 500", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    await expect(createSiteFromTemplate(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      GitHubError,
    );
  });

  it("GitHubError on 500 carries status", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    try {
      await createSiteFromTemplate(TOKEN, "me", "my-site");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubError);
      expect((err as GitHubError).status).toBe(500);
    }
  });
});

describe("waitForRepoReady", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when _config.yml exists on first poll", async () => {
    globalThis.fetch = makeFetch({}, 200);
    await expect(waitForRepoReady(TOKEN, "me", "my-site")).resolves.toBeUndefined();
  });

  it("resolves after several polls once _config.yml exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("swallows transient 5xx mid-poll and continues", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws RepoNotReadyError on 15s timeout", async () => {
    globalThis.fetch = makeFetch({}, 404);

    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    const assertion = expect(promise).rejects.toBeInstanceOf(RepoNotReadyError);
    await vi.advanceTimersByTimeAsync(16000);
    await assertion;
  });

  it("RepoNotReadyError carries lastStatus from most recent poll", async () => {
    globalThis.fetch = makeFetch({}, 404);
    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    const assertion = promise.catch((err) => err);
    await vi.advanceTimersByTimeAsync(16000);
    const err = await assertion;
    expect(err).toBeInstanceOf(RepoNotReadyError);
    expect((err as RepoNotReadyError).lastStatus).toBe(404);
  });

  it("polls the _config.yml contents endpoint", async () => {
    globalThis.fetch = makeFetch({}, 200);
    await waitForRepoReady(TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(
      "https://api.github.com/repos/me/my-site/contents/_config.yml",
    );
  });
});

describe("isRepoInInstallation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const INST_TOKEN = "inst-token-xyz";
  const fullPage = (target?: string) => {
    const repos = Array.from({ length: 100 }, (_, i) => ({
      full_name: `owner/repo-${i}`,
    }));
    if (target) repos[50] = { full_name: target };
    return { total_count: 250, repositories: repos };
  };

  it("returns true when repo is on the first page", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        repositories: [{ full_name: "me/my-site" }],
      }),
    });
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(true);
  });

  it("returns true when repo is on a subsequent page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fullPage(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 150,
          repositories: [{ full_name: "me/my-site" }],
        }),
      });
    globalThis.fetch = fetchMock;
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call should request page=2
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall[0]).toContain("page=2");
  });

  it("returns false when repo is absent and page is not full", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        repositories: [{ full_name: "other/other-repo" }],
      }),
    });
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(false);
  });

  it("walks pages until an empty/short page is seen, then returns false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fullPage() })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 150, repositories: [{ full_name: "o/p" }] }),
      });
    globalThis.fetch = fetchMock;
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws GitHubError on HTTP 500", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      GitHubError,
    );
  });

  it("matches case-insensitively", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        repositories: [{ full_name: "Me/My-Site" }],
      }),
    });
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(true);
  });

  it("sends Authorization Bearer header with installation token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ total_count: 0, repositories: [] }),
    });
    await isRepoInInstallation(INST_TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${INST_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// Born-clean transforms (pure)
// ---------------------------------------------------------------------------

// Mirrors the shipped template `_config.yml` (ucsb-amplab/telar@main) for the
// lines the born-clean builder touches, including indentation and inline
// comments so comment-preservation is genuinely exercised.
const TEMPLATE_CONFIG = [
  "# Telar - Digital Storytelling Framework",
  "",
  "# Site Settings",
  'title: "Telar"',
  'description: "Telar weaves IIIF images and text. <a href=\'https://telar.org\'>Telar</a> is a project."',
  'url: "https://ampl.clair.ucsb.edu"',
  'baseurl: "/telar"',
  'author: ""',
  'telar_theme: "trama" # Options: trama, paisajes, neogranadina, santa-barbara, austin, or custom',
  'logo: ""',
  'telar_language: "en" # Options: "en" (English), "es" (Español)',
  "",
  "story_interface:",
  "  show_on_homepage: true # comment",
  "  include_demo_content: true # Fetch demo stories from content.telar.org. Switch this off to hide demo stories.",
  "",
  "story_key: \"test\"",
  "",
  "google_sheets:",
  "  enabled: true",
  '  published_url: "https://docs.google.com/spreadsheets/d/e/XYZ/pubhtml"',
  "",
].join("\n");

const BORN_CLEAN_OPTS = {
  owner: "me",
  name: "my-site",
  locale: "en" as const,
  title: "My Site",
  description: "My Site",
  theme: "trama",
};

describe("humanizeSlug", () => {
  it("splits on hyphens and title-cases", () => {
    expect(humanizeSlug("my-cool-site")).toBe("My Cool Site");
  });
  it("handles underscores and dots", () => {
    expect(humanizeSlug("my_cool.site")).toBe("My Cool Site");
  });
  it("collapses repeated separators and trims", () => {
    expect(humanizeSlug("--my--site--")).toBe("My Site");
  });
  it("leaves a single word capitalized", () => {
    expect(humanizeSlug("archive")).toBe("Archive");
  });
  it("falls back to the raw slug when separators-only would yield empty", () => {
    // `_` passes isValidRepoName but split/filter collapses to "" — an empty
    // title would drop the published <meta>. Fall back to the slug itself.
    expect(humanizeSlug("_")).toBe("_");
    expect(humanizeSlug("-")).toBe("-");
  });

  // English (default) uses title case but leaves minor words (stopwords)
  // lowercase — except the first and last word, which are always capitalized.
  it("en: title-cases but lowercases interior stopwords", () => {
    expect(humanizeSlug("the-art-of-war", "en")).toBe("The Art of War");
    expect(humanizeSlug("war-and-peace", "en")).toBe("War and Peace");
    expect(humanizeSlug("tales-from-the-crypt", "en")).toBe("Tales from the Crypt");
  });
  it("en: capitalizes a stopword when it is the first or last word", () => {
    expect(humanizeSlug("the-crown", "en")).toBe("The Crown");
    expect(humanizeSlug("what-is-it-for", "en")).toBe("What Is It For");
  });
  it("en is the default when no locale is passed", () => {
    expect(humanizeSlug("the-art-of-war")).toBe("The Art of War");
  });

  // Spanish uses sentence case: only the first word is capitalized (Spanish
  // titles are not title-cased). Proper nouns can't be detected from a slug.
  it("es: sentence case — only the first word is capitalized", () => {
    expect(humanizeSlug("mi-proyecto-de-cartas", "es")).toBe("Mi proyecto de cartas");
    expect(humanizeSlug("archivo-de-la-nueva-granada", "es")).toBe("Archivo de la nueva granada");
  });
  it("es: single word is still capitalized", () => {
    expect(humanizeSlug("archivo", "es")).toBe("Archivo");
  });
  it("es: separators-only still falls back to the raw slug", () => {
    expect(humanizeSlug("_", "es")).toBe("_");
  });
});

describe("storySlugForLocale / otherStorySlug", () => {
  it("maps en→blank_template, es→plantilla_en_blanco", () => {
    expect(storySlugForLocale("en")).toBe("blank_template");
    expect(storySlugForLocale("es")).toBe("plantilla_en_blanco");
  });
  it("other slug is the opposite language", () => {
    expect(otherStorySlug("en")).toBe("plantilla_en_blanco");
    expect(otherStorySlug("es")).toBe("blank_template");
  });
});

describe("buildBornCleanConfig", () => {
  it("sets title, description, url, baseurl, theme, language", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, {
      ...BORN_CLEAN_OPTS,
      title: "My Archive",
      description: "A small archive",
      theme: "paisajes",
      locale: "es",
    });
    expect(out).toContain('title: "My Archive"');
    expect(out).toContain('description: "A small archive"');
    expect(out).toContain('url: "https://me.github.io"');
    expect(out).toContain('baseurl: "/my-site"');
    expect(out).toContain('telar_theme: "paisajes"');
    expect(out).toContain('telar_language: "es"');
  });

  it("always sets telar_language, even for en (template default)", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, { ...BORN_CLEAN_OPTS, locale: "en" });
    expect(out).toContain('telar_language: "en"');
  });

  it("disables include_demo_content and google_sheets", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, BORN_CLEAN_OPTS);
    expect(out).toContain("include_demo_content: false");
    expect(out).not.toMatch(/^\s*enabled:\s*true/m);
    expect(out).toMatch(/^\s*enabled:\s*false/m);
  });

  it("preserves inline comments on theme, language, and include_demo_content", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, BORN_CLEAN_OPTS);
    expect(out).toContain("# Options: trama, paisajes");
    expect(out).toContain('# Options: "en" (English), "es" (Español)');
    expect(out).toContain("# Fetch demo stories from content.telar.org");
  });

  it("preserves the google_sheets published_url line", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, BORN_CLEAN_OPTS);
    expect(out).toContain("published_url:");
  });

  it("drops the template demo identity", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, BORN_CLEAN_OPTS);
    expect(out).not.toContain("ampl.clair.ucsb.edu");
    expect(out).not.toContain('baseurl: "/telar"');
    expect(out).not.toContain('title: "Telar"');
  });

  it("lowercases the owner for the Pages host but keeps the repo-name case", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, {
      ...BORN_CLEAN_OPTS,
      owner: "My-Org",
      name: "My-Site",
    });
    expect(out).toContain('url: "https://my-org.github.io"');
    expect(out).toContain('baseurl: "/My-Site"');
  });

  it("escapes double quotes in title/description for valid YAML", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, {
      ...BORN_CLEAN_OPTS,
      title: 'The "Big" Archive',
    });
    expect(out).toContain('title: "The \\"Big\\" Archive"');
  });

  it("escapes newlines so a pasted multi-line title stays one physical line", () => {
    // A free-text field can carry a pasted newline. A raw newline inside the
    // double-quoted scalar would break the single-line edit and corrupt the
    // file; escape it to a YAML `\n` so the value stays on one line.
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, {
      ...BORN_CLEAN_OPTS,
      title: "Line one\nLine two",
    });
    expect(out).toContain('title: "Line one\\nLine two"');
    // The title line must not have been split into two physical lines.
    const titleLine = out.split("\n").find((l) => l.startsWith("title:"));
    expect(titleLine).toBe('title: "Line one\\nLine two"');
  });

  it("escapes carriage returns and tabs too", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, {
      ...BORN_CLEAN_OPTS,
      title: "A\r\tB",
    });
    expect(out).toContain('title: "A\\r\\tB"');
  });

  it("writes the author line when an author is supplied", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, {
      ...BORN_CLEAN_OPTS,
      author: "Jane Doe",
    });
    expect(out).toContain('author: "Jane Doe"');
  });

  it("leaves the empty author line untouched when no author is supplied", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, BORN_CLEAN_OPTS);
    expect(out).toContain('author: ""');
  });

  it("skips the author edit (no throw) when the template has no author line", () => {
    // Author is cosmetic — a drifted template missing `author:` must not fail the
    // whole born-clean commit (which would re-open the demo-content leak via the
    // repair path). The required lines still throw; author silently no-ops.
    const noAuthor = TEMPLATE_CONFIG.replace(/^author:.*$/m, "# author removed");
    const out = buildBornCleanConfig(noAuthor, { ...BORN_CLEAN_OPTS, author: "Jane Doe" });
    expect(out).not.toContain("Jane Doe");
    expect(out).toContain('title: "My Site"'); // required edits still applied
  });

  it("escapes accented author bylines for valid YAML", () => {
    const out = buildBornCleanConfig(TEMPLATE_CONFIG, {
      ...BORN_CLEAN_OPTS,
      author: "José Martínez Muñoz",
    });
    expect(out).toContain('author: "José Martínez Muñoz"');
  });

  it("throws when a required line is missing (template drift)", () => {
    const noTitle = TEMPLATE_CONFIG.replace(/^title:.*$/m, "# title removed");
    expect(() => buildBornCleanConfig(noTitle, BORN_CLEAN_OPTS)).toThrow(GitHubError);
  });

  it("throws when include_demo_content is absent", () => {
    const noDemo = TEMPLATE_CONFIG.replace(/^\s*include_demo_content:.*$/m, "  other: true");
    expect(() => buildBornCleanConfig(noDemo, BORN_CLEAN_OPTS)).toThrow(/include_demo_content/);
  });
});

describe("languageMatchGlossary", () => {
  const GLOSSARY = [
    "term_id,title,definition",
    "id_término,titulo,definición",
    "# lower-case,# required,# panel content",
    'telar,Telar,"English paragraph about Telar. Learn more at [Telar.org](https://telar.org)',
    "",
    'Párrafo en español sobre Telar. Aprende más en [Telar.org](https://telar.org)"',
    "",
  ].join("\n");

  it("keeps the English paragraph for en", () => {
    const out = languageMatchGlossary(GLOSSARY, "en");
    expect(out).toContain("English paragraph about Telar");
    expect(out).not.toContain("Párrafo en español");
  });

  it("keeps the Spanish paragraph for es", () => {
    const out = languageMatchGlossary(GLOSSARY, "es");
    expect(out).toContain("Párrafo en español sobre Telar");
    expect(out).not.toContain("English paragraph about Telar");
  });

  it("preserves the header and comment rows", () => {
    const out = languageMatchGlossary(GLOSSARY, "en");
    expect(out).toContain("term_id,title,definition");
    expect(out).toContain("id_término");
    expect(out).toContain("# lower-case");
  });

  it("throws when the telar row is missing", () => {
    const noRow = "term_id,title,definition\nfoo,Foo,bar\n";
    expect(() => languageMatchGlossary(noRow, "en")).toThrow(/telar/);
  });

  it("throws when the definition is not a two-language block", () => {
    const oneLang = 'term_id,title,definition\ntelar,Telar,"Only one paragraph"\n';
    expect(() => languageMatchGlossary(oneLang, "en")).toThrow(/two-language/);
  });
});

describe("pruneProjectStories", () => {
  const PROJECT = [
    "order,story_id,title,subtitle,byline,private",
    "orden,id_historia,titulo,subtitulo,firma,privada",
    "#,# Must match the tab name,Story title,Optional,Optional,If yes",
    "#,# Debe coincidir,Título,Subtítulo,Atribución,Si sí",
    "1,blank_template,replace me with your title,,,FALSE",
    "2,plantilla_en_blanco,reemplázame con tu título,,,FALSE",
    "",
  ].join("\n");

  it("drops the Spanish story for en, keeping the English one", () => {
    const out = pruneProjectStories(PROJECT, "en");
    expect(out).toContain("blank_template");
    expect(out).not.toContain("plantilla_en_blanco");
  });

  it("drops the English story for es, keeping the Spanish one", () => {
    const out = pruneProjectStories(PROJECT, "es");
    expect(out).toContain("plantilla_en_blanco");
    expect(out).not.toContain(",blank_template,");
  });

  it("preserves header and both comment rows", () => {
    const out = pruneProjectStories(PROJECT, "en");
    expect(out).toContain("order,story_id");
    expect(out).toContain("orden,id_historia");
    expect(out).toContain("# Must match the tab name");
    expect(out).toContain("# Debe coincidir");
  });

  it("throws when the story-to-drop is absent", () => {
    const onlyEn = "order,story_id,title,subtitle,byline,private\n1,blank_template,x,,,FALSE\n";
    expect(() => pruneProjectStories(onlyEn, "en")).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// customDomainConfigCorrection — detect a served custom Pages domain
// ---------------------------------------------------------------------------

describe("customDomainConfigCorrection", () => {
  it("returns null when the served host is the expected <owner>.github.io", () => {
    expect(
      customDomainConfigCorrection("https://me.github.io/my-site", "me", "my-site"),
    ).toBeNull();
  });

  it("matches <owner>.github.io case-insensitively (no false correction)", () => {
    expect(
      customDomainConfigCorrection("https://Me.github.io/my-site", "ME", "my-site"),
    ).toBeNull();
  });

  it("returns corrected url+baseurl when the account serves a custom apex domain", () => {
    expect(
      customDomainConfigCorrection("https://juancobo.com/my-site/", "juancobo", "my-site"),
    ).toEqual({ url: "https://juancobo.com", baseurl: "/my-site" });
  });

  it("handles a custom subdomain that differs from the github.io default", () => {
    expect(
      customDomainConfigCorrection("https://archive.example.org/my-site", "me", "my-site"),
    ).toEqual({ url: "https://archive.example.org", baseurl: "/my-site" });
  });

  it("handles an apex custom domain served at the root (empty baseurl)", () => {
    expect(
      customDomainConfigCorrection("https://juancobo.com/", "juancobo", "site"),
    ).toEqual({ url: "https://juancobo.com", baseurl: "" });
  });

  it("returns null for an empty or malformed served URL (nothing to correct)", () => {
    expect(customDomainConfigCorrection("", "me", "my-site")).toBeNull();
    expect(customDomainConfigCorrection("not a url", "me", "my-site")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rewriteConfigUrl — replace url+baseurl lines, preserve everything else
// ---------------------------------------------------------------------------

describe("rewriteConfigUrl", () => {
  it("replaces the url and baseurl lines and preserves the rest", () => {
    const body = [
      'title: "Site"',
      'url: "https://me.github.io"',
      'baseurl: "/my-site"',
      "include_demo_content: false",
    ].join("\n");
    const out = rewriteConfigUrl(body, "https://juancobo.com", "/my-site");
    expect(out).toContain('url: "https://juancobo.com"');
    expect(out).toContain('baseurl: "/my-site"');
    expect(out).toContain('title: "Site"');
    expect(out).toContain("include_demo_content: false");
    expect(out).not.toContain("me.github.io");
  });

  it("writes an empty baseurl as quoted empty string", () => {
    const body = ['url: "https://me.github.io"', 'baseurl: "/my-site"'].join("\n");
    const out = rewriteConfigUrl(body, "https://juancobo.com", "");
    expect(out).toContain('baseurl: ""');
  });

  it("preserves an inline comment on the url/baseurl line", () => {
    const body = [
      'url: "https://me.github.io" # canonical site URL',
      "baseurl: /my-site # repo path",
    ].join("\n");
    const out = rewriteConfigUrl(body, "https://juancobo.com", "/my-site");
    expect(out).toContain('url: "https://juancobo.com" # canonical site URL');
    expect(out).toContain('baseurl: "/my-site" # repo path');
    expect(out).not.toContain("me.github.io");
  });

  it("rewrites an unquoted value", () => {
    const body = ["url: https://me.github.io", "baseurl: /my-site"].join("\n");
    const out = rewriteConfigUrl(body, "https://juancobo.com", "/my-site");
    expect(out).toContain('url: "https://juancobo.com"');
    expect(out).toContain('baseurl: "/my-site"');
  });

  it("throws (does not silently no-op) when the url line is absent", () => {
    const body = ['baseurl: "/my-site"', "title: x"].join("\n");
    expect(() => rewriteConfigUrl(body, "https://juancobo.com", "/my-site")).toThrow();
  });

  it("throws when the baseurl line is absent", () => {
    const body = ['url: "https://me.github.io"', "title: x"].join("\n");
    expect(() => rewriteConfigUrl(body, "https://juancobo.com", "/my-site")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// commitBornCleanSite — orchestration
// ---------------------------------------------------------------------------

describe("commitBornCleanSite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const OWNER = "me";
  const NAME = "my-site";
  const INSTALL_TOKEN = "install-token";

  const ORCH_PROJECT = [
    "order,story_id,title,subtitle,byline,private",
    "orden,id_historia,titulo,subtitulo,firma,privada",
    "#,# Must match the tab name,Story title,Optional,Optional,If yes",
    "#,# Debe coincidir,Título,Subtítulo,Atribución,Si sí",
    "1,blank_template,replace me with your title,,,FALSE",
    "2,plantilla_en_blanco,reemplázame con tu título,,,FALSE",
    "",
  ].join("\n");

  const ORCH_GLOSSARY = [
    "term_id,title,definition",
    "id_término,titulo,definición",
    "# lower-case,# required,# panel content",
    'telar,Telar,"English paragraph about Telar.',
    "",
    'Párrafo en español sobre Telar."',
    "",
  ].join("\n");

  function b64(s: string): string {
    return Buffer.from(s, "utf-8").toString("base64");
  }
  function jsonRes(obj: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => "" };
  }

  type RouterOpts = {
    config?: string;
    dirFiles?: Array<{ type: string; path: string }>;
    dirStatus?: number;
    commitErrors?: boolean;
    pagesStatus?: number;
    dispatchStatus?: number;
    // Override the html_url GitHub returns for the Pages enable — used to
    // simulate an account that serves Pages from an inherited custom domain.
    pagesHtmlUrl?: string;
    // Simulate the new repo NOT being in the App installation (a "selected
    // repositories" install that doesn't yet include the freshly-created repo).
    notInInstallation?: boolean;
    // Force the scope pre-check's GET to error, to exercise fail-open behavior.
    scopeCheckStatus?: number;
    // Fail the Nth GraphQL CreateCommit (1-based) — used to simulate the
    // custom-domain correction re-commit failing while the first commit landed.
    failCommitOnCall?: number;
    // Number of leading 404s to serve on the _config.yml read before 200,
    // simulating GitHub's post-/generate contents-API propagation lag.
    configRead404Times?: number;
  };

  function bornCleanFetch(opts: RouterOpts = {}) {
    let configReads = 0;
    let commitCalls = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/contents/_config.yml")) {
        if (opts.configRead404Times && configReads++ < opts.configRead404Times) {
          return jsonRes({ message: "Not Found" }, 404);
        }
        return jsonRes({ content: b64(opts.config ?? TEMPLATE_CONFIG), encoding: "base64" });
      }
      if (url.includes("/contents/telar-content/spreadsheets/project.csv")) {
        return jsonRes({ content: b64(ORCH_PROJECT), encoding: "base64" });
      }
      if (url.includes("/contents/telar-content/spreadsheets/glossary.csv")) {
        return jsonRes({ content: b64(ORCH_GLOSSARY), encoding: "base64" });
      }
      if (url.includes("/contents/telar-content/texts/stories/")) {
        if (opts.dirStatus === 404) return jsonRes({}, 404);
        return jsonRes(
          opts.dirFiles ?? [
            { type: "file", path: "telar-content/texts/stories/plantilla_en_blanco/ejemplo-panel.md" },
          ],
        );
      }
      if (url.endsWith("/graphql")) {
        const body = JSON.parse((init!.body as string) ?? "{}");
        if (String(body.query).includes("GetHeadOid")) {
          return jsonRes({ data: { repository: { ref: { target: { oid: "head-oid" } } } } });
        }
        if (opts.commitErrors) return jsonRes({ errors: [{ message: "boom" }] });
        commitCalls++;
        if (opts.failCommitOnCall && commitCalls === opts.failCommitOnCall) {
          return jsonRes({ errors: [{ message: "boom" }] });
        }
        return jsonRes({ data: { createCommitOnBranch: { commit: { oid: "new-oid", url: "u" } } } });
      }
      if (url.includes("/installation/repositories")) {
        if (opts.scopeCheckStatus && opts.scopeCheckStatus >= 400) {
          return jsonRes({ message: "boom" }, opts.scopeCheckStatus);
        }
        return jsonRes({
          repositories: opts.notInInstallation ? [] : [{ full_name: `${OWNER}/${NAME}` }],
        });
      }
      if (url.includes("/pages")) {
        if (opts.pagesStatus === 403) return jsonRes({}, 403);
        return jsonRes({ html_url: opts.pagesHtmlUrl ?? "https://me.github.io/my-site/" });
      }
      if (url.includes("/dispatches")) {
        if (opts.dispatchStatus && opts.dispatchStatus >= 400) return jsonRes("err", opts.dispatchStatus);
        return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  function baseParams(over: Partial<Parameters<typeof commitBornCleanSite>[0]> = {}) {
    return {
      token: TOKEN,
      installationToken: INSTALL_TOKEN,
      owner: OWNER,
      name: NAME,
      locale: "en" as const,
      title: "My Site",
      description: "My Site",
      theme: "trama",
      ...over,
    };
  }

  function commitInput(fetchMock: ReturnType<typeof vi.fn>) {
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as [string, RequestInit];
      if (url.endsWith("/graphql")) {
        const body = JSON.parse((init.body as string) ?? "{}");
        if (String(body.query).includes("CreateCommit")) return body.variables.input;
      }
    }
    throw new Error("no CreateCommit call found");
  }
  function decodeAddition(input: { fileChanges: { additions: Array<{ path: string; contents: string }> } }, path: string): string {
    const add = input.fileChanges.additions.find((a) => a.path === path);
    if (!add) throw new Error(`no addition for ${path}`);
    return Buffer.from(add.contents, "base64").toString("utf-8");
  }
  function allCommitInputs(fetchMock: ReturnType<typeof vi.fn>) {
    const inputs: Array<{ message: { headline: string }; fileChanges: { additions: Array<{ path: string; contents: string }>; deletions: Array<{ path: string }> } }> = [];
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as [string, RequestInit];
      if (url.endsWith("/graphql")) {
        const body = JSON.parse((init.body as string) ?? "{}");
        if (String(body.query).includes("CreateCommit")) inputs.push(body.variables.input);
      }
    }
    return inputs;
  }

  it("round-trips accented title + author through the base64 commit without mojibake", async () => {
    // Guards the prior-incident bug class: user free-text fields are committed as
    // base64 blobs, and a decoder/encoder string-domain mismatch corrupts non-ASCII.
    // The user base is Colombian/Spanish, so accents must survive verbatim.
    const fetchMock = bornCleanFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(
      baseParams({
        title: "Crónicas de la Nueva Granada",
        description: "Cartografía y relación, siglo XVI",
        author: "José Martínez Muñoz",
      }),
    );
    expect(result.ok).toBe(true);

    const config = decodeAddition(commitInput(fetchMock), "_config.yml");
    expect(config).toContain('title: "Crónicas de la Nueva Granada"');
    expect(config).toContain('description: "Cartografía y relación, siglo XVI"');
    expect(config).toContain('author: "José Martínez Muñoz"');
    // Mojibake sentinel — a Latin-1/UTF-8 mismatch produces an "Ã" lead byte.
    expect(config).not.toContain("Ã");
  });

  it("retries a transient 404 on the config read (post-/generate propagation lag)", async () => {
    // GitHub's contents API 404s for a beat after template generation even
    // though waitForRepoReady already saw 200. readRepoFile must retry rather
    // than fail the whole born-clean commit.
    const fetchMock = bornCleanFetch({ configRead404Times: 1 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams({ fileReadRetryIntervalMs: 0 }));

    expect(result.ok).toBe(true);
    // The config still committed correctly after the retry.
    const config = decodeAddition(commitInput(fetchMock), "_config.yml");
    expect(config).toContain('url: "https://me.github.io"');
  });

  it("happy path (en): returns ok + pagesUrl, commits clean config + content, deletes the es story", async () => {
    const fetchMock = bornCleanFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams());

    expect(result.ok).toBe(true);
    expect(result.pagesUrl).toBe("https://me.github.io/my-site");

    const input = commitInput(fetchMock);
    const addedPaths = input.fileChanges.additions.map((a: { path: string }) => a.path);
    expect(addedPaths).toEqual([
      "_config.yml",
      "telar-content/spreadsheets/project.csv",
      "telar-content/spreadsheets/glossary.csv",
    ]);
    const deletedPaths = input.fileChanges.deletions.map((d: { path: string }) => d.path);
    expect(deletedPaths).toContain("telar-content/spreadsheets/plantilla_en_blanco.csv");
    expect(deletedPaths).toContain("telar-content/texts/stories/plantilla_en_blanco/ejemplo-panel.md");

    const config = decodeAddition(input, "_config.yml");
    expect(config).toContain('url: "https://me.github.io"');
    expect(config).toContain('baseurl: "/my-site"');
    expect(config).toContain("include_demo_content: false");
    expect(config).toMatch(/^\s*enabled:\s*false/m);

    const project = decodeAddition(input, "telar-content/spreadsheets/project.csv");
    expect(project).not.toContain("plantilla_en_blanco");
    const glossary = decodeAddition(input, "telar-content/spreadsheets/glossary.csv");
    expect(glossary).toContain("English paragraph about Telar");
    expect(glossary).not.toContain("Párrafo en español");
  });

  it("dispatches build.yml with force_iiif=true (clean first IIIF build), using the user token", async () => {
    const fetchMock = bornCleanFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await commitBornCleanSite(baseParams());

    const dispatchCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/dispatches"));
    expect(dispatchCall).toBeTruthy();
    expect(String(dispatchCall![0])).toContain("/actions/workflows/build.yml/dispatches");
    const body = JSON.parse((dispatchCall![1] as RequestInit).body as string);
    expect(body.inputs.force_iiif).toBe("true");
    const headers = (dispatchCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("commits with the user token, not the installation token", async () => {
    const fetchMock = bornCleanFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await commitBornCleanSite(baseParams());

    const commitCall = fetchMock.mock.calls.find(([u, i]) => {
      const init = i as RequestInit | undefined;
      return (
        String(u).endsWith("/graphql") &&
        String(JSON.parse((init?.body as string) ?? "{}").query).includes("CreateCommit")
      );
    });
    const headers = (commitCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("commit message carries no [skip ci]", async () => {
    const fetchMock = bornCleanFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await commitBornCleanSite(baseParams());
    const input = commitInput(fetchMock);
    expect(input.message.headline).not.toContain("[skip ci]");
  });

  it("es: deletes the en story and its sister dir, keeps the Spanish story", async () => {
    const fetchMock = bornCleanFetch({
      dirFiles: [{ type: "file", path: "telar-content/texts/stories/blank_template/example-panel.md" }],
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams({ locale: "es" }));
    expect(result.ok).toBe(true);
    const input = commitInput(fetchMock);
    const deletedPaths = input.fileChanges.deletions.map((d: { path: string }) => d.path);
    expect(deletedPaths).toContain("telar-content/spreadsheets/blank_template.csv");
    expect(deletedPaths).toContain("telar-content/texts/stories/blank_template/example-panel.md");
    const config = decodeAddition(input, "_config.yml");
    expect(config).toContain('telar_language: "es"');
  });

  it("missing sister dir (404) → deletes only the csv", async () => {
    const fetchMock = bornCleanFetch({ dirStatus: 404 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await commitBornCleanSite(baseParams());
    expect(result.ok).toBe(true);
    const input = commitInput(fetchMock);
    const deletedPaths = input.fileChanges.deletions.map((d: { path: string }) => d.path);
    expect(deletedPaths).toEqual(["telar-content/spreadsheets/plantilla_en_blanco.csv"]);
  });

  it("commit failure → ok:false, error:commit, no Pages call", async () => {
    const fetchMock = bornCleanFetch({ commitErrors: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await commitBornCleanSite(baseParams());
    expect(result).toEqual({ ok: false, error: "commit" });
    const pagesCalled = fetchMock.mock.calls.some(([u]) => String(u).endsWith("/pages"));
    expect(pagesCalled).toBe(false);
  });

  it("Pages-enable failure → ok:false, error:pages (commit already landed)", async () => {
    const fetchMock = bornCleanFetch({ pagesStatus: 403 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await commitBornCleanSite(baseParams());
    expect(result).toEqual({ ok: false, error: "pages" });
    const commitCalled = fetchMock.mock.calls.some(([u, i]) => {
      const init = i as RequestInit | undefined;
      return String(u).endsWith("/graphql") && String(JSON.parse((init?.body as string) ?? "{}").query).includes("CreateCommit");
    });
    expect(commitCalled).toBe(true);
  });

  it("dispatch failure → ok:false, error:dispatch, pagesUrl still returned", async () => {
    const fetchMock = bornCleanFetch({ dispatchStatus: 500 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await commitBornCleanSite(baseParams());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("dispatch");
    expect(result.pagesUrl).toBe("https://me.github.io/my-site");
  });

  it("github.io account: no custom-domain correction — exactly one commit, unchanged happy path", async () => {
    const fetchMock = bornCleanFetch(); // default html_url is me.github.io
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams());

    expect(result.ok).toBe(true);
    // Only the born-clean config+content commit — no second URL-correction commit.
    expect(allCommitInputs(fetchMock)).toHaveLength(1);
  });

  it("custom-domain account: re-commits corrected url+baseurl before dispatch, then dispatches", async () => {
    const fetchMock = bornCleanFetch({ pagesHtmlUrl: "https://juancobo.com/my-site/" });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams());

    expect(result.ok).toBe(true);
    expect(result.pagesUrl).toBe("https://juancobo.com/my-site");

    const commits = allCommitInputs(fetchMock);
    expect(commits).toHaveLength(2);
    // Second commit corrects the URL to the served custom domain.
    const corrected = decodeAddition(commits[1], "_config.yml");
    expect(corrected).toContain('url: "https://juancobo.com"');
    expect(corrected).toContain('baseurl: "/my-site"');
    expect(corrected).not.toContain("me.github.io");

    // The correction lands BEFORE the IIIF build dispatch so tiles bake the
    // real served base on the only build run.
    const calls = fetchMock.mock.calls.map(([u]) => String(u));
    const lastCommitIdx = calls.map((u, i) => (u.endsWith("/graphql") ? i : -1)).filter((i) => i >= 0).pop()!;
    const dispatchIdx = calls.findIndex((u) => u.includes("/dispatches"));
    expect(dispatchIdx).toBeGreaterThan(lastCommitIdx);
  });

  it("custom-domain correction commit failure → ok:false, error:url, pagesUrl returned, no dispatch", async () => {
    // First commit (born-clean) succeeds; the second (URL correction) fails.
    const fetchMock = bornCleanFetch({
      pagesHtmlUrl: "https://juancobo.com/my-site/",
      failCommitOnCall: 2,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("url");
    expect(result.pagesUrl).toBe("https://juancobo.com/my-site");
    const dispatched = fetchMock.mock.calls.some(([u]) => String(u).includes("/dispatches"));
    expect(dispatched).toBe(false);
  });

  it("enables Pages with the installation token, not the user token", async () => {
    const fetchMock = bornCleanFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await commitBornCleanSite(baseParams());
    const pagesCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/pages"));
    expect(pagesCall).toBeTruthy();
    const headers = (pagesCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${INSTALL_TOKEN}`);
  });

  it("checks installation scope (with the install token) BEFORE enabling Pages", async () => {
    const fetchMock = bornCleanFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await commitBornCleanSite(baseParams());

    const calls = fetchMock.mock.calls.map(([u]) => String(u));
    const scopeIdx = calls.findIndex((u) => u.includes("/installation/repositories"));
    const pagesIdx = calls.findIndex((u) => u.endsWith("/pages"));
    expect(scopeIdx).toBeGreaterThanOrEqual(0);
    expect(pagesIdx).toBeGreaterThan(scopeIdx);

    const scopeCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/installation/repositories"));
    const headers = (scopeCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${INSTALL_TOKEN}`);
  });

  it("repo not in installation → ok:false, error:scope, no Pages call, no dispatch", async () => {
    const fetchMock = bornCleanFetch({ notInInstallation: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams());

    expect(result).toEqual({ ok: false, error: "scope" });
    // The commit (user token) already landed; the doomed Pages call is skipped.
    const commitCalled = fetchMock.mock.calls.some(([u, i]) => {
      const init = i as RequestInit | undefined;
      return String(u).endsWith("/graphql") && String(JSON.parse((init?.body as string) ?? "{}").query).includes("CreateCommit");
    });
    expect(commitCalled).toBe(true);
    const pagesCalled = fetchMock.mock.calls.some(([u]) => String(u).endsWith("/pages"));
    expect(pagesCalled).toBe(false);
    const dispatched = fetchMock.mock.calls.some(([u]) => String(u).includes("/dispatches"));
    expect(dispatched).toBe(false);
  });

  it("idempotent retry: an already-born-clean config skips the re-commit but still enables Pages + dispatches", async () => {
    // Simulates retrying commitBornCleanSite after a commit that landed but
    // whose response was lost. commitFilesToRepo is one atomic commit, so a
    // config with google_sheets already disabled (the template ships it
    // enabled) means the whole born-clean commit already landed. Re-running the
    // transforms would throw (prune/glossary expect the pristine two-language
    // template) and re-deleting the sister files would be rejected — so the
    // re-commit must be skipped, while Pages-enable + dispatch still run.
    const cleanConfig = TEMPLATE_CONFIG.replace("enabled: true", "enabled: false");
    const fetchMock = bornCleanFetch({ config: cleanConfig });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams());

    expect(result.ok).toBe(true);
    // No new commit — the born-clean commit already landed.
    expect(allCommitInputs(fetchMock)).toHaveLength(0);
    // But Pages-enable + build dispatch still happen (those are what failed).
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/pages"))).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/dispatches"))).toBe(true);
  });

  it("scope pre-check error → fails open and still attempts Pages (no dead-end)", async () => {
    const fetchMock = bornCleanFetch({ scopeCheckStatus: 500 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await commitBornCleanSite(baseParams());

    // Scope check threw, but we fall through to Pages + dispatch and succeed.
    expect(result.ok).toBe(true);
    const pagesCalled = fetchMock.mock.calls.some(([u]) => String(u).endsWith("/pages"));
    expect(pagesCalled).toBe(true);
  });

  // Regression: born-clean reads template files from GitHub and re-commits them.
  // The read (atob) and the commit encoder (btoa(unescape(encodeURIComponent)))
  // must agree on the string domain, or every non-ASCII byte double-encodes into
  // mojibake — silently corrupting the committed Spanish glossary/story content
  // and the "(Español)" config comment. ASCII-only fixtures never caught this.
  it("preserves accented content through read→commit (es glossary + config comment)", async () => {
    const fetchMock = bornCleanFetch({
      dirFiles: [
        { type: "file", path: "telar-content/texts/stories/blank_template/example-panel.md" },
      ],
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await commitBornCleanSite(baseParams({ locale: "es" }));

    const input = commitInput(fetchMock);
    const glossary = decodeAddition(input, "telar-content/spreadsheets/glossary.csv");
    expect(glossary).toContain("Párrafo en español sobre Telar");
    expect(glossary).not.toContain("Ã"); // mojibake marker

    const config = decodeAddition(input, "_config.yml");
    expect(config).toContain('# Options: "en" (English), "es" (Español)');
  });
});
