/**
 * Unit tests for upgrade.server.ts
 *
 * Covers: parseTelarVersion, compareVersions, isFrameworkPath,
 * findMissingFrameworkFiles, buildYmlUsesNpmCi, updateTelarVersionInConfig,
 * categorizeFrameworkPath, buildUpgradeSummary, computeUpgradeDiff, and
 * healMissingFrameworkFiles (via mocked GitHub API).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseTelarVersion,
  compareVersions,
  isFrameworkPath,
  findMissingFrameworkFiles,
  fetchFrameworkFilesAtVersion,
  healMissingFrameworkFiles,
  buildYmlUsesNpmCi,
  updateTelarVersionInConfig,
  categorizeFrameworkPath,
  buildUpgradeSummary,
  computeUpgradeDiff,
  MIN_SUPPORTED_VERSION,
  FRAMEWORK_PREFIXES,
  FRAMEWORK_FILES,
} from "~/lib/upgrade.server";
import type { CommitFile } from "~/lib/commit.server";
import type { TreeEntry } from "~/lib/github.server";

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
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64" }) };
      }
      if (url.includes("/contents/NOTICE")) {
        return { ok: true, json: async () => ({ content: b64("NOTICE-TEXT"), encoding: "base64" }) };
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
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const files = await fetchFrameworkFilesAtVersion(
      TOKEN, ["package-lock.json", "Gemfile.lock"], TAG,
    );
    expect(files).toEqual([{ path: "package-lock.json", content: "LOCK" }]);
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
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64" }) };
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
        return { ok: true, json: async () => ({ content: b64("      - run: npm ci"), encoding: "base64" }) };
      }
      // FRAMEWORK repo lockfile fetch (pinned tag via ?ref=).
      if (url.includes("/contents/package-lock.json")) {
        return { ok: true, json: async () => ({ content: b64("LOCK"), encoding: "base64" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG);
    expect(healed).toEqual([{ path: "package-lock.json", content: "LOCK" }]);
  });

  it("drops package-lock.json when the user's build.yml uses `npm install` (no lockfile fetch)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return treeMissingLock();
      if (url.includes("/contents/.github/workflows/build.yml")) {
        return { ok: true, json: async () => ({ content: b64("      - run: npm install"), encoding: "base64" }) };
      }
      if (url.includes("/contents/package-lock.json")) {
        throw new Error("must not fetch the lockfile when build.yml uses npm install");
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG);
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

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG);
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

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG);
    expect(healed).toEqual([]);
  });

  it("delivers a non-lockfile missing file without ever fetching build.yml", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return treeMissingNotice();
      if (url.includes("/contents/.github/workflows/build.yml")) {
        throw new Error("must not fetch build.yml when the lockfile is not among missing files");
      }
      if (url.includes("/contents/NOTICE")) {
        return { ok: true, json: async () => ({ content: b64("NOTICE TEXT"), encoding: "base64" }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG);
    expect(healed).toEqual([{ path: "NOTICE", content: "NOTICE TEXT" }]);
  });

  it("returns [] when nothing is missing (no content fetches)", async () => {
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
      throw new Error("should not fetch content when nothing is missing");
    });

    const healed = await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG);
    expect(healed).toEqual([]);
    // Only the tree read — no content fetches when nothing is missing.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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
    expect(await healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG)).toEqual([]);
    // Only the tree read happened — the guard returned before any content fetch.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns [] (never throws) when the tree read fails", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    });

    await expect(
      healMissingFrameworkFiles(TOKEN, OWNER, REPO, TAG),
    ).resolves.toEqual([]);
  });

  it("returns [] without any fetch when the tag is empty/falsy", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    expect(await healMissingFrameworkFiles(TOKEN, OWNER, REPO, "")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
