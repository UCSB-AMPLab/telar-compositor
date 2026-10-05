/**
 * Unit tests for upgrade.server.ts
 *
 * Covers: isFrameworkPath,
 * findMissingFrameworkFiles, buildYmlUsesNpmCi, updateTelarVersionInConfig,
 * categorizeFrameworkPath, buildUpgradeSummary, computeUpgradeDiff,
 * fetchLatestRelease, healMissingFrameworkFiles (via mocked GitHub API), and
 * collectFilesReferencedByChain. The version functions it also exercises
 * (parseTelarVersion, compareVersions, frameworkVersionForTag) live in
 * telar-version.ts.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  isFrameworkPath,
  findMissingFrameworkFiles,
  fetchLatestRelease,
  fetchAllReleases,
  fetchFrameworkFilesAtVersion,
  healMissingFrameworkFiles,
  buildYmlUsesNpmCi,
  updateTelarVersionInConfig,
  categorizeFrameworkPath,
  partitionWorkflowFiles,
  buildUpgradeSummary,
  computeUpgradeDiff,
  collectFilesReferencedByChain,
  deletionsPresentInTree,
  FRAMEWORK_PREFIXES,
  FRAMEWORK_FILES,
} from "~/lib/upgrade.server";
import {
  parseTelarVersion,
  compareVersions,
  MIN_SUPPORTED_VERSION,
  frameworkVersionForTag,
} from "~/lib/telar-version";
import type { CommitFile } from "~/lib/commit.server";
import { validateManifest, type Manifest, type Operation } from "~/lib/manifest-schema.server";
import type { TreeEntry } from "~/lib/github.server";
import { ReleaseFileUnreadableError, ReleaseTreeUnreadableError } from "~/lib/upgrade-reads.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRestFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

// ---------------------------------------------------------------------------
// parseTelarVersion
// ---------------------------------------------------------------------------

describe("parseTelarVersion", () => {
  it("Test 1: parses v0.9.0 into { major: 0, minor: 9, patch: 0, prerelease: null }", () => {
    expect(parseTelarVersion("v0.9.0")).toEqual({ major: 0, minor: 9, patch: 0, prerelease: null });
  });

  it("Test 2: parses v0.9.0-beta into { major: 0, minor: 9, patch: 0, prerelease: 'beta' }", () => {
    expect(parseTelarVersion("v0.9.0-beta")).toEqual({ major: 0, minor: 9, patch: 0, prerelease: "beta" });
  });

  it("Test 3: parses v1.2.3 into { major: 1, minor: 2, patch: 3, prerelease: null }", () => {
    expect(parseTelarVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it("Test 4: returns null for unparseable string 'invalid'", () => {
    expect(parseTelarVersion("invalid")).toBeNull();
  });

  it("Test 5: returns null for empty string", () => {
    expect(parseTelarVersion("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

describe("compareVersions", () => {
  it("Test 6: v0.9.0 vs v0.9.1 returns -1 (first is older)", () => {
    expect(compareVersions("v0.9.0", "v0.9.1")).toBe(-1);
  });

  it("Test 7: v0.9.1 vs v0.9.0 returns 1 (first is newer)", () => {
    expect(compareVersions("v0.9.1", "v0.9.0")).toBe(1);
  });

  it("Test 8: v0.9.0 vs v0.9.0 returns 0 (equal)", () => {
    expect(compareVersions("v0.9.0", "v0.9.0")).toBe(0);
  });

  it("Test 9: v0.9.0-beta vs v0.9.0 returns -1 (pre-release is older than release)", () => {
    expect(compareVersions("v0.9.0-beta", "v0.9.0")).toBe(-1);
  });

  it("Test 10: v0.9.0-beta vs v0.9.0-beta returns 0 (same pre-release)", () => {
    expect(compareVersions("v0.9.0-beta", "v0.9.0-beta")).toBe(0);
  });

  it("Test 11: v1.0.0 vs v0.9.9 returns 1 (major version bump)", () => {
    expect(compareVersions("v1.0.0", "v0.9.9")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isFrameworkPath
// ---------------------------------------------------------------------------

describe("isFrameworkPath", () => {
  it("Test 12: _layouts/default.html returns true", () => {
    expect(isFrameworkPath("_layouts/default.html")).toBe(true);
  });

  it("Test 13: _includes/header.html returns true", () => {
    expect(isFrameworkPath("_includes/header.html")).toBe(true);
  });

  it("Test 14: _sass/_main.scss returns true", () => {
    expect(isFrameworkPath("_sass/_main.scss")).toBe(true);
  });

  it("Test 15: assets/css/main.css returns true", () => {
    expect(isFrameworkPath("assets/css/main.css")).toBe(true);
  });

  it("Test 16: scripts/csv_to_json.py returns true", () => {
    expect(isFrameworkPath("scripts/csv_to_json.py")).toBe(true);
  });

  it("Test 17: .github/workflows/build.yml returns true", () => {
    expect(isFrameworkPath(".github/workflows/build.yml")).toBe(true);
  });

  it("Test 18: _data/languages/en.yml returns true", () => {
    expect(isFrameworkPath("_data/languages/en.yml")).toBe(true);
  });

  it("Test 19: _data/themes/default.yml returns true", () => {
    expect(isFrameworkPath("_data/themes/default.yml")).toBe(true);
  });

  it("Test 20: _data/navigation.yml returns true", () => {
    expect(isFrameworkPath("_data/navigation.yml")).toBe(true);
  });

  it("Test 21: CHANGELOG.md returns true", () => {
    expect(isFrameworkPath("CHANGELOG.md")).toBe(true);
  });

  it("Test 22: telar-content/spreadsheets/objects.csv returns false (user content)", () => {
    expect(isFrameworkPath("telar-content/spreadsheets/objects.csv")).toBe(false);
  });

  it("Test 23: _config.yml returns false (handled separately)", () => {
    expect(isFrameworkPath("_config.yml")).toBe(false);
  });

  it("Test 24: index.md returns false (user content)", () => {
    expect(isFrameworkPath("index.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateTelarVersionInConfig
// ---------------------------------------------------------------------------

describe("updateTelarVersionInConfig", () => {
  const fixture = readFileSync(
    join(__dirname, "fixtures/telar-config-with-telar-block.yml"),
    "utf-8"
  );

  it("Test 25: updates telar.version to the new value", () => {
    const result = updateTelarVersionInConfig(fixture, "0.9.1", "2026-03-15");
    expect(result).toContain('version: "0.9.1"');
  });

  it("Test 26: updates telar.release_date to the new value", () => {
    const result = updateTelarVersionInConfig(fixture, "0.9.1", "2026-03-15");
    expect(result).toContain('release_date: "2026-03-15"');
  });

  it("Test 27: preserves url value", () => {
    const result = updateTelarVersionInConfig(fixture, "0.9.1", "2026-03-15");
    expect(result).toContain('url: "https://museodelpacífico.github.io"');
  });

  it("Test 28: preserves baseurl value", () => {
    const result = updateTelarVersionInConfig(fixture, "0.9.1", "2026-03-15");
    expect(result).toContain('baseurl: "/coleccion"');
  });

  it("Test 29: preserves story_key value", () => {
    const result = updateTelarVersionInConfig(fixture, "0.9.1", "2026-03-15");
    expect(result).toContain('story_key: "historia"');
  });

  it("Test 30: preserves google_sheets block intact", () => {
    const result = updateTelarVersionInConfig(fixture, "0.9.1", "2026-03-15");
    expect(result).toContain("google_sheets:");
    expect(result).toContain("enabled: false");
  });

  it("Test 31: does not contain the old version string", () => {
    const result = updateTelarVersionInConfig(fixture, "0.9.1", "2026-03-15");
    // Old version was "0.9.0"
    expect(result).not.toContain('version: "0.9.0"');
  });
});

// ---------------------------------------------------------------------------
// FRAMEWORK_PREFIXES and FRAMEWORK_FILES constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("Test 32: MIN_SUPPORTED_VERSION is v0.9.0-beta", () => {
    expect(MIN_SUPPORTED_VERSION).toBe("v0.9.0-beta");
  });

  it("Test 33: FRAMEWORK_PREFIXES includes _layouts/, _includes/, _sass/, assets/, scripts/, .github/workflows/, _data/languages/, _data/themes/", () => {
    expect(FRAMEWORK_PREFIXES).toContain("_layouts/");
    expect(FRAMEWORK_PREFIXES).toContain("_includes/");
    expect(FRAMEWORK_PREFIXES).toContain("_sass/");
    expect(FRAMEWORK_PREFIXES).toContain("assets/");
    expect(FRAMEWORK_PREFIXES).toContain("scripts/");
    expect(FRAMEWORK_PREFIXES).toContain(".github/workflows/");
    expect(FRAMEWORK_PREFIXES).toContain("_data/languages/");
    expect(FRAMEWORK_PREFIXES).toContain("_data/themes/");
  });

  it("Test 34: FRAMEWORK_FILES includes _data/navigation.yml and CHANGELOG.md", () => {
    expect(FRAMEWORK_FILES).toContain("_data/navigation.yml");
    expect(FRAMEWORK_FILES).toContain("CHANGELOG.md");
  });

  it("FRAMEWORK_FILES includes README.md (added v1.3.0 ingest)", () => {
    expect(FRAMEWORK_FILES).toContain("README.md");
  });

  it("FRAMEWORK_FILES includes dependency manifests, incl. package-lock.json for npm ci", () => {
    expect(FRAMEWORK_FILES).toContain("package.json");
    expect(FRAMEWORK_FILES).toContain("package-lock.json");
    expect(FRAMEWORK_FILES).toContain("Gemfile.lock");
    expect(FRAMEWORK_FILES).toContain("requirements.txt");
  });

  it("FRAMEWORK_FILES includes _data/katex.yml (framework-owned KaTeX config, v1.6.0)", () => {
    expect(FRAMEWORK_FILES).toContain("_data/katex.yml");
  });

  it("FRAMEWORK_FILES includes _data/glossary_kinds.yml (the glossary's core kinds, v1.8.0)", () => {
    expect(FRAMEWORK_FILES).toContain("_data/glossary_kinds.yml");
    expect(isFrameworkPath("_data/glossary_kinds.yml")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// categorizeFrameworkPath
// ---------------------------------------------------------------------------

describe("categorizeFrameworkPath", () => {
  it("Test 35: _layouts/default.html categorizes as 'layouts'", () => {
    expect(categorizeFrameworkPath("_layouts/default.html")).toBe("layouts");
  });

  it("Test 36: _includes/nav.html categorizes as 'includes'", () => {
    expect(categorizeFrameworkPath("_includes/nav.html")).toBe("includes");
  });

  it("Test 37: _sass/_main.scss categorizes as 'stylesheets'", () => {
    expect(categorizeFrameworkPath("_sass/_main.scss")).toBe("stylesheets");
  });

  it("Test 38: scripts/csv_to_json.py categorizes as 'scripts'", () => {
    expect(categorizeFrameworkPath("scripts/csv_to_json.py")).toBe("scripts");
  });

  it("Test 39: .github/workflows/build.yml categorizes as 'workflows'", () => {
    expect(categorizeFrameworkPath(".github/workflows/build.yml")).toBe("workflows");
  });

  it("Test 40: _data/languages/en.yml categorizes as 'dataFiles'", () => {
    expect(categorizeFrameworkPath("_data/languages/en.yml")).toBe("dataFiles");
  });

  it("_data/katex.yml categorizes as 'dataFiles'", () => {
    expect(categorizeFrameworkPath("_data/katex.yml")).toBe("dataFiles");
  });

  it("_data/glossary_kinds.yml categorizes as 'dataFiles'", () => {
    expect(categorizeFrameworkPath("_data/glossary_kinds.yml")).toBe("dataFiles");
  });
});

// ---------------------------------------------------------------------------
// partitionWorkflowFiles
// ---------------------------------------------------------------------------

describe("partitionWorkflowFiles", () => {
  it("splits .github/workflows/ additions from everything else", () => {
    const additions: CommitFile[] = [
      { path: "_layouts/default.html", content: "a" },
      { path: ".github/workflows/build.yml", content: "b" },
      { path: "telar-content/spreadsheets/objects.csv", content: "c" },
      { path: ".github/workflows/telar-tests.yml", content: "d" },
    ];
    const result = partitionWorkflowFiles(additions, []);
    expect(result.workflowAdditions.map((a) => a.path)).toEqual([
      ".github/workflows/build.yml",
      ".github/workflows/telar-tests.yml",
    ]);
    expect(result.contentAdditions.map((a) => a.path)).toEqual([
      "_layouts/default.html",
      "telar-content/spreadsheets/objects.csv",
    ]);
  });

  it("splits workflow deletions from content deletions", () => {
    const deletions = [
      "_includes/old.html",
      ".github/workflows/legacy.yml",
      "assets/old.css",
    ];
    const result = partitionWorkflowFiles([], deletions);
    expect(result.workflowDeletions).toEqual([".github/workflows/legacy.yml"]);
    expect(result.contentDeletions).toEqual([
      "_includes/old.html",
      "assets/old.css",
    ]);
  });

  it("reports hasWorkflows false when nothing touches .github/workflows/", () => {
    const result = partitionWorkflowFiles(
      [{ path: "_config.yml", content: "x" }],
      ["index.md"],
    );
    expect(result.hasWorkflows).toBe(false);
    expect(result.workflowAdditions).toEqual([]);
    expect(result.workflowDeletions).toEqual([]);
  });

  it("reports hasWorkflows true when a workflow file is added OR deleted", () => {
    expect(
      partitionWorkflowFiles([{ path: ".github/workflows/build.yml", content: "x" }], [])
        .hasWorkflows,
    ).toBe(true);
    expect(
      partitionWorkflowFiles([], [".github/workflows/build.yml"]).hasWorkflows,
    ).toBe(true);
  });

  it("does NOT treat _config.yml or other .github/ files as workflows", () => {
    const additions: CommitFile[] = [
      { path: "_config.yml", content: "x" },
      { path: ".github/dependabot.yml", content: "y" },
    ];
    const result = partitionWorkflowFiles(additions, []);
    expect(result.hasWorkflows).toBe(false);
    expect(result.contentAdditions.map((a) => a.path)).toEqual([
      "_config.yml",
      ".github/dependabot.yml",
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildUpgradeSummary
// ---------------------------------------------------------------------------

describe("buildUpgradeSummary", () => {
  it("Test 41: counts files by category correctly", () => {
    const additions: CommitFile[] = [
      { path: "_layouts/default.html", content: "" },
      { path: "_layouts/story.html", content: "" },
      { path: "_sass/_main.scss", content: "" },
      { path: "scripts/build.py", content: "" },
    ];
    const deletions: string[] = ["_includes/old-component.html"];

    const summary = buildUpgradeSummary(additions, deletions);
    expect(summary.layouts).toBe(2);
    expect(summary.stylesheets).toBe(1);
    expect(summary.scripts).toBe(1);
    expect(summary.deletions).toBe(1);
    expect(summary.total).toBe(4); // additions only in total
  });

  it("Test 42: returns all-zero summary for empty arrays", () => {
    const summary = buildUpgradeSummary([], []);
    expect(summary.total).toBe(0);
    expect(summary.layouts).toBe(0);
    expect(summary.deletions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeUpgradeDiff (mocked GitHub API)
// ---------------------------------------------------------------------------

describe("computeUpgradeDiff", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const TOKEN = "test-token";
  const RELEASE_TAG = "v0.9.1";

  // Framework tree at the release tag (what the framework looks like in the new release)
  const RELEASE_TREE: TreeEntry[] = [
    { path: "_layouts/default.html", mode: "100644", type: "blob", sha: "sha-layout-new", size: 100 },
    { path: "_includes/header.html", mode: "100644", type: "blob", sha: "sha-header-same", size: 50 },
    { path: "_sass/_main.scss", mode: "100644", type: "blob", sha: "sha-sass-new", size: 200 },
    { path: "scripts/csv_to_json.py", mode: "100644", type: "blob", sha: "sha-script-same", size: 300 },
    // New file in release not in user repo
    { path: "_layouts/new-template.html", mode: "100644", type: "blob", sha: "sha-new-template", size: 80 },
  ];

  // User's repo tree (some files differ from release, one file absent from release)
  const USER_TREE: TreeEntry[] = [
    { path: "_layouts/default.html", mode: "100644", type: "blob", sha: "sha-layout-old", size: 90 },
    { path: "_includes/header.html", mode: "100644", type: "blob", sha: "sha-header-same", size: 50 },
    { path: "_sass/_main.scss", mode: "100644", type: "blob", sha: "sha-sass-old", size: 180 },
    { path: "scripts/csv_to_json.py", mode: "100644", type: "blob", sha: "sha-script-same", size: 300 },
    // Deprecated file in user repo, absent from release tree
    { path: "_layouts/deprecated.html", mode: "100644", type: "blob", sha: "sha-deprecated", size: 60 },
    // Non-framework file — should be ignored
    { path: "telar-content/spreadsheets/objects.csv", mode: "100644", type: "blob", sha: "sha-objects", size: 500 },
    { path: "index.md", mode: "100644", type: "blob", sha: "sha-index", size: 200 },
  ];

  it("Test 43: identical trees produce empty additions and deletions", async () => {
    const identicalTree: TreeEntry[] = [
      { path: "_layouts/default.html", mode: "100644", type: "blob", sha: "sha-same", size: 100 },
    ];
    // Mock: release tree fetch returns same SHA as user tree
    globalThis.fetch = makeRestFetch({ tree: identicalTree, truncated: false });

    const diff = await computeUpgradeDiff(TOKEN, identicalTree, RELEASE_TAG);

    expect(diff.additions).toHaveLength(0);
    expect(diff.deletions).toHaveLength(0);
  });

  it("Test 44: returns changed _layouts/default.html in additions when SHA differs", async () => {
    // Mock fetch: release tree + file content calls
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes("/git/trees/")) {
        return { ok: true, json: async () => ({ tree: RELEASE_TREE, truncated: false }) };
      }
      // Contents API for changed files
      return {
        ok: true,
        json: async () => ({
          encoding: "base64",
          content: btoa("new layout content"),
          size: Buffer.byteLength("new layout content"),
        }),
      };
    });

    const diff = await computeUpgradeDiff(TOKEN, USER_TREE, RELEASE_TAG);

    const changedPaths = diff.additions.map((f) => f.path);
    expect(changedPaths).toContain("_layouts/default.html");
  });

  it("Test 45: file present in user repo but absent in release tree is in deletions", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return { ok: true, json: async () => ({ tree: RELEASE_TREE, truncated: false }) };
      }
      return {
        ok: true,
        json: async () => ({
          encoding: "base64",
          content: btoa("file content"),
          size: Buffer.byteLength("file content"),
        }),
      };
    });

    const diff = await computeUpgradeDiff(TOKEN, USER_TREE, RELEASE_TAG);

    expect(diff.deletions).toContain("_layouts/deprecated.html");
  });

  it("Test 46: new file in release tree absent from user repo is in additions", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return { ok: true, json: async () => ({ tree: RELEASE_TREE, truncated: false }) };
      }
      return {
        ok: true,
        json: async () => ({
          encoding: "base64",
          content: btoa("new template content"),
          size: Buffer.byteLength("new template content"),
        }),
      };
    });

    const diff = await computeUpgradeDiff(TOKEN, USER_TREE, RELEASE_TAG);

    const addedPaths = diff.additions.map((f) => f.path);
    expect(addedPaths).toContain("_layouts/new-template.html");
  });

  it("Test 47: non-framework paths (objects.csv, index.md) are filtered from diff", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return { ok: true, json: async () => ({ tree: RELEASE_TREE, truncated: false }) };
      }
      return {
        ok: true,
        json: async () => ({
          encoding: "base64",
          content: btoa("file content"),
          size: Buffer.byteLength("file content"),
        }),
      };
    });

    const diff = await computeUpgradeDiff(TOKEN, USER_TREE, RELEASE_TAG);

    const allPaths = [
      ...diff.additions.map((f) => f.path),
      ...diff.deletions,
    ];
    expect(allPaths).not.toContain("telar-content/spreadsheets/objects.csv");
    expect(allPaths).not.toContain("index.md");
  });

  // The site's menu is its own once it has one: publish writes it
  // from the Compositor's navigation, and a local author edits it by hand.
  describe("the site's navigation", () => {
    const NAV = "_data/navigation.yml";
    const nav = (sha: string): TreeEntry => ({ path: NAV, mode: "100644", type: "blob", sha, size: 10 });
    const fetchRelease = (tree: TreeEntry[]) =>
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/git/trees/")) {
          return { ok: true, json: async () => ({ tree, truncated: false }) };
        }
        return { ok: true, json: async () => ({ encoding: "base64", content: btoa("menu: []"), size: Buffer.byteLength("menu: []") }) };
      });

    it("is not replaced when the site's copy differs from the release's", async () => {
      globalThis.fetch = fetchRelease([nav("sha-template-menu")]);
      const diff = await computeUpgradeDiff(TOKEN, [nav("sha-site-menu")], RELEASE_TAG);
      expect(diff.additions.map((f) => f.path)).not.toContain(NAV);
    });

    it("is delivered to a site that has none", async () => {
      globalThis.fetch = fetchRelease([nav("sha-template-menu")]);
      const diff = await computeUpgradeDiff(TOKEN, [], RELEASE_TAG);
      expect(diff.additions.map((f) => f.path)).toContain(NAV);
    });

    it("is not delivered when a truncated tree leaves its presence unknown", async () => {
      globalThis.fetch = fetchRelease([nav("sha-template-menu")]);
      const diff = await computeUpgradeDiff(TOKEN, [], RELEASE_TAG, { userTreeTruncated: true });
      expect(diff.additions.map((f) => f.path)).not.toContain(NAV);
    });

    it("is not deleted when a release stops shipping one", async () => {
      globalThis.fetch = fetchRelease([]);
      const diff = await computeUpgradeDiff(TOKEN, [nav("sha-site-menu")], RELEASE_TAG);
      expect(diff.deletions).not.toContain(NAV);
    });

    it("stays a framework path, so a site missing it is still healed", () => {
      expect(isFrameworkPath(NAV)).toBe(true);
    });
  });

  it("Test 48: same SHA files are not included in additions (no unnecessary fetches)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return { ok: true, json: async () => ({ tree: RELEASE_TREE, truncated: false }) };
      }
      return {
        ok: true,
        json: async () => ({
          encoding: "base64",
          content: btoa("content"),
          size: Buffer.byteLength("content"),
        }),
      };
    });

    const diff = await computeUpgradeDiff(TOKEN, USER_TREE, RELEASE_TAG);

    // _includes/header.html and scripts/csv_to_json.py have the same SHA in both trees
    const addedPaths = diff.additions.map((f) => f.path);
    expect(addedPaths).not.toContain("_includes/header.html");
    expect(addedPaths).not.toContain("scripts/csv_to_json.py");
  });
});

// ---------------------------------------------------------------------------
// computeUpgradeDiff: release reads that cannot be completed
// ---------------------------------------------------------------------------

describe("computeUpgradeDiff: a release read that fails stops the diff", () => {
  const TAG = "v1.8.0";
  const blob = (path: string, sha: string): TreeEntry => ({ path, mode: "100644", type: "blob", sha });
  const RELEASE_TREE = [blob("_layouts/default.html", "sha-new"), blob("_includes/header.html", "sha-new")];
  const USER_TREE = [blob("_layouts/default.html", "sha-old"), blob("_includes/header.html", "sha-old")];
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The release as GitHub answers it, with `layout` standing in for the layout's download. */
  function release(options: { truncated?: boolean; tree?: () => unknown; layout?: () => unknown } = {}) {
    return vi.fn(async (url: string) => {
      if (url.includes(`/git/trees/${TAG}`)) {
        return options.tree
          ? options.tree()
          : { ok: true, status: 200, json: async () => ({ tree: RELEASE_TREE, truncated: options.truncated ?? false }) };
      }
      if (url.includes("/contents/_layouts/default.html") && options.layout) return options.layout();
      return { ok: true, status: 200, json: async () => ({ encoding: "base64", content: btoa(`content of ${url}`), size: Buffer.byteLength(`content of ${url}`) }) };
    });
  }

  async function failure(run: Promise<unknown>): Promise<unknown> {
    try {
      await run;
    } catch (err) {
      return err;
    }
    throw new Error("expected the diff to fail");
  }

  it("fails on a truncated release tree, naming the release's version, with or without content", async () => {
    globalThis.fetch = release({ truncated: true }) as unknown as typeof fetch;
    for (const fetchContent of [true, false]) {
      const err = await failure(computeUpgradeDiff("tok", USER_TREE, TAG, { fetchContent }));
      expect(err).toBeInstanceOf(ReleaseTreeUnreadableError);
      expect((err as ReleaseTreeUnreadableError).version).toBe("1.8.0");
    }
  });

  it("fails on a release tree GitHub answers with a 500, naming the release's version", async () => {
    globalThis.fetch = release({ tree: () => ({ ok: false, status: 500, json: async () => ({}) }) }) as unknown as typeof fetch;
    const err = await failure(computeUpgradeDiff("tok", USER_TREE, TAG));
    expect(err).toBeInstanceOf(ReleaseTreeUnreadableError);
    expect((err as ReleaseTreeUnreadableError).version).toBe("1.8.0");
  });

  it("fails on a release file whose download answers 500, 404 or throws, naming the file and release", async () => {
    const answers: Array<() => unknown> = [
      () => ({ ok: false, status: 500, json: async () => ({}) }),
      () => ({ ok: false, status: 404, json: async () => ({}) }),
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const layout of answers) {
      globalThis.fetch = release({ layout }) as unknown as typeof fetch;
      const err = await failure(computeUpgradeDiff("tok", USER_TREE, TAG));
      expect(err).toBeInstanceOf(ReleaseFileUnreadableError);
      expect((err as ReleaseFileUnreadableError).path).toBe("_layouts/default.html");
      expect((err as ReleaseFileUnreadableError).version).toBe("1.8.0");
    }
  });

  it("delivers an empty release file as empty content", async () => {
    globalThis.fetch = release({
      layout: () => ({ ok: true, status: 200, json: async () => ({ type: "file", encoding: "base64", content: "", size: 0 }) }),
    }) as unknown as typeof fetch;
    const diff = await computeUpgradeDiff("tok", USER_TREE, TAG);
    expect(diff.additions.find((a) => a.path === "_layouts/default.html")).toEqual({
      path: "_layouts/default.html",
      content: "",
    });
  });

  it("fails on a file the Contents API answers without its content (over 1 MB)", async () => {
    globalThis.fetch = release({
      layout: () => ({ ok: true, status: 200, json: async () => ({ type: "file", encoding: "base64", content: "", size: 2000000 }) }),
    }) as unknown as typeof fetch;
    const err = await failure(computeUpgradeDiff("tok", USER_TREE, TAG));
    expect(err).toBeInstanceOf(ReleaseFileUnreadableError);
    expect((err as ReleaseFileUnreadableError).path).toBe("_layouts/default.html");
  });

  it("delivers every changed file when each download answers", async () => {
    globalThis.fetch = release() as unknown as typeof fetch;
    const diff = await computeUpgradeDiff("tok", USER_TREE, TAG);
    expect(diff.additions.map((a) => a.path).sort()).toEqual(["_includes/header.html", "_layouts/default.html"]);
  });
});

// ---------------------------------------------------------------------------
// findMissingFrameworkFiles
// ---------------------------------------------------------------------------

describe("findMissingFrameworkFiles", () => {
  it("returns an empty array when every framework file is present", () => {
    const present = [...FRAMEWORK_FILES, "telar-content/spreadsheets/objects.csv"];
    expect(findMissingFrameworkFiles(present)).toEqual([]);
  });

  it("returns exactly the framework files absent from the tree", () => {
    const present = FRAMEWORK_FILES.filter(
      (p) => p !== "package-lock.json" && p !== "NOTICE",
    );
    const missing = findMissingFrameworkFiles([...present, "README-ish.md"]);
    expect(missing.sort()).toEqual(["NOTICE", "package-lock.json"].sort());
  });

  it("covers the root dotfiles, which no prefix can reach", () => {
    // Every FRAMEWORK_PREFIXES entry names a directory, so a root file whose
    // name begins with a dot is delivered only if it is listed by name. v1.7.0
    // shipped .ruby-version and a rewritten .gitattributes and neither reached
    // a Compositor-upgraded site until they were listed.
    for (const dotfile of [".ruby-version", ".gitattributes"]) {
      expect(FRAMEWORK_FILES).toContain(dotfile);
      expect(
        FRAMEWORK_PREFIXES.some((prefix) => dotfile.startsWith(prefix)),
      ).toBe(false);
      expect(isFrameworkPath(dotfile)).toBe(true);
    }
  });

  it("reports .ruby-version missing on a site upgraded before it was listed", () => {
    // The publish-time heal restores a listed file that is entirely absent, so
    // a site upgraded to v1.7.0 without .ruby-version gets it at its next
    // publish. A stale .gitattributes is present and so is not healed; only a
    // later upgrade refreshes it.
    const upgradedWithoutDotfiles = FRAMEWORK_FILES.filter(
      (p) => p !== ".ruby-version",
    );
    expect(findMissingFrameworkFiles([...upgradedWithoutDotfiles])).toEqual([
      ".ruby-version",
    ]);
  });

  it("returns all framework files for an empty tree", () => {
    expect(findMissingFrameworkFiles([]).sort()).toEqual([...FRAMEWORK_FILES].sort());
  });

  it("does not treat a user file that merely contains a framework name as present", () => {
    // "docs/package.json" must NOT satisfy "package.json"
    const missing = findMissingFrameworkFiles(["docs/package.json"]);
    expect(missing).toContain("package.json");
  });
});

// ---------------------------------------------------------------------------
// fetchFrameworkFilesAtVersion
// ---------------------------------------------------------------------------

describe("fetchFrameworkFilesAtVersion", () => {
  const TOKEN = "tok";
  const TAG = "v1.5.0";
  // btoa is a global in this repo's Node test env — the existing computeUpgradeDiff
  // tests in this same file use it unguarded and pass, so it is proven available.
  const b64 = (s: string) => btoa(s);
  // Direct `globalThis.fetch =` assignment is NOT undone by vi.restoreAllMocks()
  // (that only restores vi spies). Save and restore it so mocks don't leak into
  // other tests/files.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns CommitFiles for paths the framework has at the tag", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/contents/package-lock.json")) {
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64", size: Buffer.byteLength("LOCK") }) };
      }
      if (url.includes("/contents/NOTICE")) {
        return { ok: true, json: async () => ({ content: b64("NOTICE-TEXT"), encoding: "base64", size: Buffer.byteLength("NOTICE-TEXT") }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const files = await fetchFrameworkFilesAtVersion(
      TOKEN, ["package-lock.json", "NOTICE"], TAG,
    );
    expect(files).toEqual([
      { path: "package-lock.json", content: "LOCK" },
      { path: "NOTICE", content: "NOTICE-TEXT" },
    ]);
  });

  it("drops paths the framework does not have at the tag (404 → null)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/contents/package-lock.json")) {
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64", size: Buffer.byteLength("LOCK") }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const files = await fetchFrameworkFilesAtVersion(
      TOKEN, ["package-lock.json", "Gemfile.lock"], TAG,
    );
    expect(files).toEqual([{ path: "package-lock.json", content: "LOCK" }]);
  });

  // A site pinned to an old framework tag has no _data/katex.yml in the
  // framework repo at that tag, so the fetch 404s and getFrameworkFileContent
  // resolves null for it. fetchFrameworkFilesAtVersion must drop that path
  // while still returning a sibling _data file that does resolve — no throw,
  // no dropped sibling.
  it("drops _data/katex.yml when absent at an old tag (404 → null), keeping a resolving sibling", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/contents/_data/navigation.yml")) {
        return { ok: true, json: async () => ({ content: b64("NAV"), encoding: "base64", size: Buffer.byteLength("NAV") }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const files = await fetchFrameworkFilesAtVersion(
      TOKEN, ["_data/katex.yml", "_data/navigation.yml"], "v1.5.0",
    );
    expect(files).toEqual([{ path: "_data/navigation.yml", content: "NAV" }]);
  });

  it("returns [] for empty input without calling fetch", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const files = await fetchFrameworkFilesAtVersion(TOKEN, [], TAG);
    expect(files).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops a path whose fetch throws, keeping the others", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/contents/Gemfile.lock")) {
        throw new Error("network down");
      }
      if (url.includes("/contents/package-lock.json")) {
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64", size: Buffer.byteLength("LOCK") }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const files = await fetchFrameworkFilesAtVersion(
      TOKEN, ["Gemfile.lock", "package-lock.json"], TAG,
    );
    expect(files).toEqual([{ path: "package-lock.json", content: "LOCK" }]);
  });
});

// ---------------------------------------------------------------------------
// fetchLatestRelease
// ---------------------------------------------------------------------------

describe("fetchLatestRelease", () => {
  const TOKEN = "tok";
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function requestedUrl(): string {
    return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
  }

  it("asks for releases/latest when no tag is given", async () => {
    globalThis.fetch = makeRestFetch({
      tag_name: "v1.6.2",
      body: "notes",
      published_at: "2026-07-17T00:00:00Z",
    });

    const release = await fetchLatestRelease(TOKEN);

    expect(requestedUrl()).toContain("/releases/latest");
    expect(requestedUrl()).not.toContain("/releases/tags/");
    expect(release).toEqual({
      tagName: "v1.6.2",
      body: "notes",
      publishedAt: "2026-07-17T00:00:00Z",
    });
  });

  it("asks for the named tag's release, and returns it even as a prerelease", async () => {
    globalThis.fetch = makeRestFetch({
      tag_name: "v1.7.0-rc.1",
      body: "rc notes",
      published_at: "2026-09-01T00:00:00Z",
      prerelease: true,
    });

    const release = await fetchLatestRelease(TOKEN, "v1.7.0-rc.1");

    expect(requestedUrl()).toContain("/releases/tags/v1.7.0-rc.1");
    expect(release).toEqual({
      tagName: "v1.7.0-rc.1",
      body: "rc notes",
      publishedAt: "2026-09-01T00:00:00Z",
    });
  });

  it("percent-encodes the tag into the path", async () => {
    globalThis.fetch = makeRestFetch({
      tag_name: "release/1.7",
      body: "",
      published_at: "2026-09-01T00:00:00Z",
    });

    await fetchLatestRelease(TOKEN, "release/1.7");

    expect(requestedUrl()).toContain("/releases/tags/release%2F1.7");
  });

  it("treats an empty tag as no tag", async () => {
    globalThis.fetch = makeRestFetch({
      tag_name: "v1.6.2",
      body: "notes",
      published_at: "2026-07-17T00:00:00Z",
    });

    await fetchLatestRelease(TOKEN, "");

    expect(requestedUrl()).toContain("/releases/latest");
  });
});

// ---------------------------------------------------------------------------
// fetchAllReleases
// ---------------------------------------------------------------------------

describe("fetchAllReleases", () => {
  const TOKEN = "tok";
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("excludes prereleases and drafts, keeps normal releases, sorted by version descending", async () => {
    globalThis.fetch = makeRestFetch([
      { tag_name: "v1.6.2-rc.1", body: "rc notes", published_at: "2026-07-15T00:00:00Z", prerelease: true, draft: false },
      { tag_name: "v1.6.1", body: "patch notes", published_at: "2026-07-11T00:00:00Z", prerelease: false, draft: false },
      { tag_name: "v1.7.0-draft", body: "draft notes", published_at: "2026-07-16T00:00:00Z", prerelease: false, draft: true },
      { tag_name: "v1.6.0", body: "release notes", published_at: "2026-07-10T00:00:00Z", prerelease: false, draft: false },
    ]);

    const releases = await fetchAllReleases(TOKEN);

    expect(releases).toEqual([
      { tagName: "v1.6.1", body: "patch notes", publishedAt: "2026-07-11T00:00:00Z" },
      { tagName: "v1.6.0", body: "release notes", publishedAt: "2026-07-10T00:00:00Z" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildYmlUsesNpmCi
// ---------------------------------------------------------------------------

describe("buildYmlUsesNpmCi", () => {
  it("returns true for a bare `npm ci` line", () => {
    expect(buildYmlUsesNpmCi("npm ci")).toBe(true);
  });

  it("returns true for an indented `npm ci` step", () => {
    expect(buildYmlUsesNpmCi("      - run: npm ci")).toBe(true);
  });

  it("returns true when `npm ci` appears among other build steps", () => {
    const yml = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - run: bundle install",
      "      - run: npm ci",
      "      - run: npm run build",
    ].join("\n");
    expect(buildYmlUsesNpmCi(yml)).toBe(true);
  });

  it("returns false for the `npm ci || npm install` fallback", () => {
    expect(buildYmlUsesNpmCi("      - run: npm ci || npm install")).toBe(false);
  });

  it("returns false for `npm install`", () => {
    expect(buildYmlUsesNpmCi("      - run: npm install")).toBe(false);
  });

  it("returns false when `npm ci` is only in a comment", () => {
    expect(buildYmlUsesNpmCi("      # npm ci")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(buildYmlUsesNpmCi("")).toBe(false);
  });

  it("does not match `npm cilantro` (word-boundary check)", () => {
    expect(buildYmlUsesNpmCi("      - run: npm cilantro")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// healMissingFrameworkFiles
// ---------------------------------------------------------------------------

describe("healMissingFrameworkFiles", () => {
  const TOKEN = "tok";
  const OWNER = "owner";
  const REPO = "repo";
  const TAG = "v1.5.0";
  const b64 = (s: string) => btoa(s);
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // A user tree missing package-lock.json (all other framework files present).
  const treeMissingLock = () => ({
    ok: true,
    json: async () => ({
      truncated: false,
      tree: FRAMEWORK_FILES
        .filter((p) => p !== "package-lock.json")
        .map((p) => ({ path: p, mode: "100644", type: "blob", sha: "x" })),
    }),
  });

  // A user tree missing only NOTICE (lockfile present, build.yml present).
  const treeMissingNotice = () => ({
    ok: true,
    json: async () => ({
      truncated: false,
      tree: FRAMEWORK_FILES
        .filter((p) => p !== "NOTICE")
        .map((p) => ({ path: p, mode: "100644", type: "blob", sha: "x" })),
    }),
  });

  it("delivers package-lock.json when the user's build.yml still uses `npm ci`", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return treeMissingLock();
      // USER repo build.yml fetch (Contents API, no ?ref=) — uses npm ci.
      if (url.includes("/contents/.github/workflows/build.yml")) {
        return { ok: true, json: async () => ({ content: b64("      - run: npm ci"), encoding: "base64", size: Buffer.byteLength("      - run: npm ci") }) };
      }
      // The stamped tag resolves, so the pin is never consulted.
      if (url.includes(`/releases/tags/${TAG}`)) {
        return { ok: true, json: async () => ({ tag_name: TAG }) };
      }
      // FRAMEWORK repo lockfile fetch (pinned tag via ?ref=).
      if (url.includes("/contents/package-lock.json")) {
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64", size: Buffer.byteLength("LOCK") }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN);
    expect(healed).toEqual([{ path: "package-lock.json", content: "LOCK" }]);
  });

  it("drops package-lock.json when the user's build.yml uses `npm install` (no lockfile fetch)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return treeMissingLock();
      if (url.includes("/contents/.github/workflows/build.yml")) {
        return { ok: true, json: async () => ({ content: b64("      - run: npm install"), encoding: "base64", size: Buffer.byteLength("      - run: npm install") }) };
      }
      if (url.includes("/contents/package-lock.json")) {
        throw new Error("must not fetch the lockfile when build.yml uses npm install");
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN);
    expect(healed).toEqual([]);
    // tree + build.yml only — the lockfile content fetch never happens.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("drops package-lock.json when build.yml is absent (fail-open, no lockfile fetch)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return treeMissingLock();
      // build.yml 404 → getFileContent returns null → can't confirm npm ci → drop.
      if (url.includes("/contents/.github/workflows/build.yml")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.includes("/contents/package-lock.json")) {
        throw new Error("must not fetch the lockfile when build.yml is unreadable");
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN);
    expect(healed).toEqual([]);
  });

  it("drops package-lock.json when the build.yml fetch throws (fail-open)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return treeMissingLock();
      if (url.includes("/contents/.github/workflows/build.yml")) {
        throw new Error("network blip reading build.yml");
      }
      if (url.includes("/contents/package-lock.json")) {
        throw new Error("must not fetch the lockfile when build.yml read throws");
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN);
    expect(healed).toEqual([]);
  });

  it("delivers a non-lockfile missing file without ever fetching build.yml", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
      if (url.includes("/contents/.github/workflows/build.yml")) {
        throw new Error("must not fetch build.yml when the lockfile is not among missing files");
      }
      if (url.includes(`/releases/tags/${TAG}`)) {
        return { ok: true, json: async () => ({ tag_name: TAG }) };
      }
      if (url.includes("/contents/NOTICE")) {
        return { ok: true, json: async () => ({ content: b64("NOTICE TEXT"), encoding: "base64", size: Buffer.byteLength("NOTICE TEXT") }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN);
    expect(healed).toEqual([{ path: "NOTICE", content: "NOTICE TEXT" }]);
  });

  it("returns [] when nothing is missing (no content fetches, no tag check, no warning)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) {
        return {
          ok: true,
          json: async () => ({
            truncated: false,
            tree: FRAMEWORK_FILES.map((p) => ({ path: p, mode: "100644", type: "blob", sha: "x" })),
          }),
        };
      }
      throw new Error("should not fetch content (or check any release tag) when nothing is missing");
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN, "v1.7.0-rc.3");
    expect(healed).toEqual([]);
    // Only the tree read — no content fetches, no release-tag check, when nothing is missing.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns [] (skips heal) when the repo tree is truncated", async () => {
    // A truncated tree may omit framework files that ARE present; treating them
    // as missing would re-commit them every publish. Must skip.
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) {
        return {
          ok: true,
          json: async () => ({
            truncated: true,
            tree: FRAMEWORK_FILES
              .filter((p) => p !== "package-lock.json")
              .map((p) => ({ path: p, mode: "100644", type: "blob", sha: "x" })),
          }),
        };
      }
      throw new Error("should not fetch content when the tree is truncated");
    });
    expect(await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN)).toEqual([]);
    // Only the tree read happened — the guard returned before any content fetch.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns [] (never throws) when the tree read fails", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    });

    await expect(
      healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG, TOKEN),
    ).resolves.toEqual([]);
  });

  it("returns [] without any fetch when the tag is empty/falsy", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    expect(await healMissingFrameworkFiles(TOKEN, OWNER, REPO, "", TOKEN)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  // The project-repo tree/build.yml reads and the
  // framework repository fetch must run on separately-named tokens — an
  // installation token scoped to the project repo cannot reach the
  // framework's separate public repo, so passing one token for both silently
  // breaks whichever read the token does not cover.
  it("routes the project-repo tree read on projectToken and the framework fetch on frameworkToken, never crossed", async () => {
    const PROJECT_TOKEN = "project-tok";
    const FRAMEWORK_TOKEN = "framework-tok";
    const authOf = (init?: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/trees/HEAD")) {
        expect(authOf(init)).toBe(`Bearer ${PROJECT_TOKEN}`);
        return treeMissingNotice();
      }
      if (url.includes(`/releases/tags/${TAG}`)) {
        expect(authOf(init)).toBe(`Bearer ${FRAMEWORK_TOKEN}`);
        return { ok: true, json: async () => ({ tag_name: TAG }) };
      }
      if (url.includes("/contents/NOTICE")) {
        expect(authOf(init)).toBe(`Bearer ${FRAMEWORK_TOKEN}`);
        return { ok: true, json: async () => ({ content: b64("NOTICE TEXT"), encoding: "base64", size: Buffer.byteLength("NOTICE TEXT") }) };
      }
      if (url.includes("/contents/scripts/dev-only-files.txt")) {
        expect(authOf(init)).toBe(`Bearer ${FRAMEWORK_TOKEN}`);
        return { ok: false, status: 404, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const healed = await healMissingFrameworkFiles(
      PROJECT_TOKEN,
      OWNER,
      REPO,
      TAG,
      FRAMEWORK_TOKEN,
    );
    expect(healed).toEqual([{ path: "NOTICE", content: "NOTICE TEXT" }]);
  });

  // The stamp-derived tag can name a tag that does not exist on the framework
  // repo (a release candidate stamps the release it is a candidate for, not
  // its own tag). The heal must try the stamped tag first, fall back to the
  // deployment's pinned TELAR_RELEASE_TAG — but only when the pin names the
  // same release as the stamp — and warn distinctly — never silently — when
  // neither resolves, or when the pin is for a different release entirely.
  describe("tag resolution", () => {
    const NONEXISTENT_STAMPED_TAG = "v1.8.0";
    // A pin for the SAME release the stamp names (frameworkVersionForTag
    // resolves both to "1.8.0") — the genuine release-candidate case: a
    // candidate stamps the release it is a candidate for, and its deployment
    // pins the candidate's own tag.
    const SAME_RELEASE_PIN = "v1.8.0-rc.1";
    // A pin that resolves but is for a DIFFERENT release ("1.7.0" vs "1.8.0")
    // — a real, existing tag that must never heal a site stamped for a
    // different release.
    const PINNED_TAG = "v1.7.0-rc.3";

    it("falls back to the pinned release tag when the stamped tag does not resolve and the pin is for the same release", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
        // Must be matched before NONEXISTENT_STAMPED_TAG below: "v1.8.0" is a
        // prefix of "v1.8.0-rc.1", so the stamped-tag URL substring is
        // present in the pin's URL too.
        if (url.includes(`/releases/tags/${SAME_RELEASE_PIN}`)) {
          return { ok: true, json: async () => ({ tag_name: SAME_RELEASE_PIN }) };
        }
        if (url.includes(`/releases/tags/${NONEXISTENT_STAMPED_TAG}`)) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        if (url.includes("/contents/NOTICE")) {
          // Must fetch the file at the PINNED tag, not the unresolved stamped one.
          expect(url).toContain(`ref=${SAME_RELEASE_PIN}`);
          return { ok: true, json: async () => ({ content: b64("NOTICE TEXT"), encoding: "base64", size: Buffer.byteLength("NOTICE TEXT") }) };
        }
        if (url.includes("/contents/scripts/dev-only-files.txt")) {
          // The developer-only list is the pinned release's too.
          expect(url).toContain(`ref=${SAME_RELEASE_PIN}`);
          return { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const healed = await healMissingFrameworkFiles(
        TOKEN, OWNER, REPO, NONEXISTENT_STAMPED_TAG, TOKEN, SAME_RELEASE_PIN,
      );
      expect(healed).toEqual([{ path: "NOTICE", content: "NOTICE TEXT" }]);
    });

    it("skips the heal and warns, naming both tags, when the pin resolves but is for a different release", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
        if (url.includes(`/releases/tags/${NONEXISTENT_STAMPED_TAG}`)) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        if (url.includes(`/releases/tags/${PINNED_TAG}`)) {
          // The pin is real — it resolves — just for the wrong release.
          return { ok: true, json: async () => ({ tag_name: PINNED_TAG }) };
        }
        throw new Error(
          `unexpected fetch (a mismatched pin must never be used to fetch content): ${url}`,
        );
      });

      const healed = await healMissingFrameworkFiles(
        TOKEN, OWNER, REPO, NONEXISTENT_STAMPED_TAG, TOKEN, PINNED_TAG,
      );
      expect(healed).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toContain(NONEXISTENT_STAMPED_TAG);
      expect(message).toContain(PINNED_TAG);
      expect(message).toContain("different release");
      warnSpy.mockRestore();
    });

    it("skips the heal and warns distinctly when the stamped tag doesn't resolve and no pin is set", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
        if (url.includes(`/releases/tags/${NONEXISTENT_STAMPED_TAG}`)) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error(`unexpected fetch (pin unset — must not check any other tag): ${url}`);
      });

      // Empty string, exactly what wrangler.staging.jsonc sets TELAR_RELEASE_TAG
      // to — must count as unset, same as omitting the argument entirely.
      const healed = await healMissingFrameworkFiles(
        TOKEN, OWNER, REPO, NONEXISTENT_STAMPED_TAG, TOKEN, "",
      );
      expect(healed).toEqual([]);

      // An empty result here is exactly what the bug already produced — the
      // assertion that actually establishes anything is on the warning.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toContain(NONEXISTENT_STAMPED_TAG);
      // Must be a distinct message — not the generic fail-open "skipping heal —"
      // used by the outer catch and the truncated-tree guard.
      expect(message).not.toBe("healMissingFrameworkFiles: skipping heal —");
      expect(message.startsWith("healMissingFrameworkFiles: skipping heal —")).toBe(false);
      warnSpy.mockRestore();
    });

    it("skips the heal and warns distinctly when neither the stamped tag nor a set pin resolves", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
        if (url.includes("/releases/tags/")) return { ok: false, status: 404, json: async () => ({}) };
        throw new Error(`unexpected fetch: ${url}`);
      });

      const healed = await healMissingFrameworkFiles(
        TOKEN, OWNER, REPO, NONEXISTENT_STAMPED_TAG, TOKEN, PINNED_TAG,
      );
      expect(healed).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toContain(NONEXISTENT_STAMPED_TAG);
      expect(message).toContain(PINNED_TAG);
      warnSpy.mockRestore();
    });

    it("ignores the pinned tag — never even checks it — when the stamped tag already resolves", async () => {
      const REAL_TAG = "v1.5.0";
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
        if (url.includes(`/releases/tags/${REAL_TAG}`)) {
          return { ok: true, json: async () => ({ tag_name: REAL_TAG }) };
        }
        if (url.includes(`/releases/tags/${PINNED_TAG}`)) {
          throw new Error("the pin must not be consulted when the stamped tag resolves");
        }
        if (url.includes("/contents/NOTICE")) {
          expect(url).toContain(`ref=${REAL_TAG}`);
          return { ok: true, json: async () => ({ content: b64("NOTICE TEXT"), encoding: "base64", size: Buffer.byteLength("NOTICE TEXT") }) };
        }
        if (url.includes("/contents/scripts/dev-only-files.txt")) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const healed = await healMissingFrameworkFiles(
        TOKEN, OWNER, REPO, REAL_TAG, TOKEN, PINNED_TAG,
      );
      expect(healed).toEqual([{ path: "NOTICE", content: "NOTICE TEXT" }]);
    });

    // frameworkTagExists must distinguish "no release published" (404) from a
    // transient GitHub error (5xx): only a 404 licenses falling through to
    // the pin. A 503 on the stamped tag's check must abort the heal outright
    // — the pin (even one for the same release) must never be consulted —
    // and the transient error must reach the log. This guards against
    // collapsing the check to `!res.ok`, which would treat the 503 the same
    // as "tag not found" and let the pin stand in for a stamp GitHub simply
    // failed to answer for.
    it("aborts on a transient error checking the stamped tag, without ever consulting the pin", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const TRANSIENT_TAG = "v1.7.0";
      // Same framework version as PINNED_TAG ("1.7.0"), so a version-mismatch
      // rejection cannot be what stops the pin from being used here — only
      // the 5xx-vs-404 distinction can.
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
        if (url.includes(`/releases/tags/${TRANSIENT_TAG}`)) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        throw new Error(
          `unexpected fetch (a transient error on the stamped tag must abort before the pin is checked): ${url}`,
        );
      });

      const healed = await healMissingFrameworkFiles(
        TOKEN, OWNER, REPO, TRANSIENT_TAG, TOKEN, PINNED_TAG,
      );
      expect(healed).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message, err] = warnSpy.mock.calls[0] as [string, unknown];
      expect(message).toBe("healMissingFrameworkFiles: skipping heal —");
      expect(String(err)).toContain("503");
      warnSpy.mockRestore();
    });
  });
});

describe("frameworkVersionForTag", () => {
  it("drops a release-candidate suffix so the version matches the manifest the tag ships", () => {
    expect(frameworkVersionForTag("v1.7.0-rc.1")).toBe("1.7.0");
    expect(frameworkVersionForTag("v1.7.0-rc.12")).toBe("1.7.0");
  });

  it("returns a plain release tag without its v", () => {
    expect(frameworkVersionForTag("v1.6.2")).toBe("1.6.2");
    expect(frameworkVersionForTag("1.6.2")).toBe("1.6.2");
  });

  it("keeps a suffix that is part of the version proper", () => {
    expect(frameworkVersionForTag("v0.9.0-beta")).toBe("0.9.0-beta");
    expect(frameworkVersionForTag("v1.0.0-alpha.2")).toBe("1.0.0-alpha.2");
  });
});

// ---------------------------------------------------------------------------
// collectFilesReferencedByChain
// ---------------------------------------------------------------------------

describe("collectFilesReferencedByChain", () => {
  const chainOf = (...operations: Operation[]): Manifest[] => [
    {
      schema_version: 1,
      from_version: "1.7.0",
      to_version: "1.8.0",
      description: "test",
      operations,
      manual_steps: { en: [], es: [] },
    },
  ];
  const SHEETS = ["telar-content/spreadsheets/project.csv", "telar-content/spreadsheets/proyecto.csv"];

  it("loads the file a yaml_list_add names", () => {
    const paths = collectFilesReferencedByChain(
      chainOf({ type: "yaml_list_add", file: "_data/extra.yml", key: "exclude", values: ["a"] }),
    );
    expect([...paths]).toEqual(["_data/extra.yml"]);
  });

  it("loads the file a regex_replace glob names literally, with the project sheets", () => {
    const paths = collectFilesReferencedByChain(
      chainOf({ type: "regex_replace", file_glob: "pages/glossary.md", search: "a", replace: "b" }),
    );
    expect([...paths].sort()).toEqual(["pages/glossary.md", ...SHEETS].sort());
  });

  it("loads only the project sheets for a glob with a wildcard, or one outside the scope allowlist", () => {
    for (const file_glob of ["**/*.md", "pages/*.md", "{index,about}.md", "../index.md", ".git/config.md", "Gemfile"]) {
      const paths = collectFilesReferencedByChain(chainOf({ type: "regex_replace", file_glob, search: "a", replace: "b" }));
      expect([...paths].sort()).toEqual([...SHEETS].sort());
    }
  });

  it("loads _config.yml and both built-in pages for the 1.8.0 manifest", () => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(__dirname, "fixtures/upgrade-1.8.0/migration.json"), "utf-8")),
    );
    const paths = collectFilesReferencedByChain([manifest]);
    expect(paths.has("_config.yml")).toBe(true);
    expect(paths.has("index.md")).toBe(true);
    expect(paths.has("pages/glossary.md")).toBe(true);
  });

  it("keeps what the other operations load", () => {
    const paths = collectFilesReferencedByChain(
      chainOf(
        { type: "config_add_field", key: "a", value: "b", after_key: "c" },
        { type: "file_delete", paths: ["old.js"] },
        { type: "gitignore_add", patterns: ["_site/"] },
        { type: "csv_add_column", file_glob: "**/project.csv", column: "x", default: "", after: "y" },
        { type: "create_directory", path: "x" },
      ),
    );
    expect([...paths].sort()).toEqual([".gitignore", "_config.yml", ...SHEETS].sort());
  });

  it("never loads a path a file_delete names, which the runner deletes without reading", () => {
    const paths = collectFilesReferencedByChain(chainOf({ type: "file_delete", paths: ["old.js", "tests/a.py"] }));
    expect([...paths]).toEqual([]);
  });

  it("loads none of the 1.8.0 manifest's file_delete paths", () => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(__dirname, "fixtures/upgrade-1.8.0/migration.json"), "utf-8")),
    );
    const deleted = manifest.operations.flatMap((op) => (op.type === "file_delete" ? op.paths : []));
    expect(deleted.length).toBeGreaterThan(200);
    const paths = collectFilesReferencedByChain([manifest]);
    expect(deleted.filter((p) => paths.has(p))).toEqual([]);
  });
});

describe("deletionsPresentInTree", () => {
  const blob = (path: string): TreeEntry => ({ path, mode: "100644", type: "blob", sha: "x" });
  const tree = [blob("pytest.ini"), blob("tests/a.py"), { path: "tests", mode: "040000", type: "tree", sha: "t" } as TreeEntry];

  it("keeps the deletions the site's tree has, in order, and drops the rest", () => {
    expect(deletionsPresentInTree(["tests/b.py", "tests/a.py", "tests", "pytest.ini"], tree, false)).toEqual([
      "tests/a.py",
      "pytest.ini",
    ]);
  });

  it("keeps every deletion when the tree is truncated, since it cannot show a path absent", () => {
    expect(deletionsPresentInTree(["tests/b.py", "pytest.ini"], tree, true)).toEqual(["tests/b.py", "pytest.ini"]);
  });
});
