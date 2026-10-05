/**
 * The framework's developer-only files through the upgrade and the heal
 *, and the merge that never carries one path both ways.
 *
 * The 1.7.0 to 1.8.0 case runs on recorded trees and the generated test
 * manifest in `fixtures/upgrade-1.8.0/` (see NOTES.md there).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeUpgradeDiff,
  healMissingFrameworkFiles,
  mergeUpgradeChanges,
  FRAMEWORK_FILES,
} from "~/lib/upgrade.server";
import {
  DEV_ONLY_FILES_PATH,
  KNOWN_DEV_ONLY_FRAMEWORK_FILES,
  isDevOnlyPath,
  parseDevOnlyFiles,
  releaseDevOnlyEntries,
  type ReleaseFileRead,
} from "~/lib/dev-only-paths.server";
import { ReleaseFileUnreadableError } from "~/lib/upgrade-reads.server";
import { applyManifestChain } from "~/lib/manifest-runner.server";
import { validateManifest } from "~/lib/manifest-schema.server";
import type { TreeEntry } from "~/lib/github.server";

const FIXTURES = join(__dirname, "fixtures", "upgrade-1.8.0");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");
const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");

/** A `git ls-tree -r` listing as tree entries. */
function lsTree(text: string): TreeEntry[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, sha] = meta.split(" ");
      return { path, mode, type, sha } as TreeEntry;
    });
}

const DEV_ONLY_LIST = fixture("dev-only-files.txt");
const DEV_ONLY = parseDevOnlyFiles(DEV_ONLY_LIST);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });
const serverError = () => ({ ok: false, status: 500, json: async () => ({}) });
const content = (text: string) => ({ ok: true, status: 200, json: async () => ({ content: b64(text), encoding: "base64", size: Buffer.byteLength(text) }) });

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("isDevOnlyPath", () => {
  it("matches a file entry exactly and a directory entry by prefix", () => {
    expect(DEV_ONLY).toEqual(["tests/", "vitest.config.js", "pytest.ini", ".github/workflows/telar-tests.yml"]);
    expect(isDevOnlyPath("pytest.ini", DEV_ONLY)).toBe(true);
    expect(isDevOnlyPath(".github/workflows/telar-tests.yml", DEV_ONLY)).toBe(true);
    expect(isDevOnlyPath("tests/unit/test_x.py", DEV_ONLY)).toBe(true);
    expect(isDevOnlyPath("tests", DEV_ONLY)).toBe(false);
    expect(isDevOnlyPath("scripts/pytest.ini", DEV_ONLY)).toBe(false);
    expect(isDevOnlyPath(".github/workflows/build.yml", DEV_ONLY)).toBe(false);
  });

  it("never names the list itself, which stays with the site", () => {
    expect(isDevOnlyPath(DEV_ONLY_FILES_PATH, [DEV_ONLY_FILES_PATH, "scripts/"])).toBe(false);
  });
});

describe("releaseDevOnlyEntries", () => {
  it("reads a release without the list (404) as having no developer-only paths", async () => {
    expect(await releaseDevOnlyEntries(async () => ({ kind: "absent" }), "1.8.0")).toEqual([]);
  });

  it("parses the list a release ships", async () => {
    expect(await releaseDevOnlyEntries(async () => ({ kind: "found", content: DEV_ONLY_LIST }), "1.8.0")).toEqual(DEV_ONLY);
  });

  it("throws when the list cannot be read, rather than reading it as empty", async () => {
    await expect(releaseDevOnlyEntries(async () => ({ kind: "failed" }), "1.8.0")).rejects.toThrow(DEV_ONLY_FILES_PATH);
  });

  it("names the list and the release in the failure, for a failed read and for a read that throws", async () => {
    const reads: Array<() => Promise<ReleaseFileRead>> = [
      async () => ({ kind: "failed" }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const read of reads) {
      const err = await releaseDevOnlyEntries(read, "1.8.0").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ReleaseFileUnreadableError);
      expect((err as ReleaseFileUnreadableError).path).toBe(DEV_ONLY_FILES_PATH);
      expect((err as ReleaseFileUnreadableError).version).toBe("1.8.0");
    }
  });
});

// ---------------------------------------------------------------------------
// The tree diff
// ---------------------------------------------------------------------------

describe("computeUpgradeDiff and the release's developer-only paths", () => {
  const TAG = "v1.8.0";
  const blob = (path: string, sha: string): TreeEntry => ({ path, mode: "100644", type: "blob", sha });

  const RELEASE_TREE: TreeEntry[] = [
    blob(DEV_ONLY_FILES_PATH, "sha-list"),
    blob("pytest.ini", "sha-pytest-new"),
    blob("vitest.config.js", "sha-vitest-new"),
    blob(".github/workflows/telar-tests.yml", "sha-tests-wf-new"),
    blob("_layouts/default.html", "sha-layout-new"),
  ];
  const USER_TREE: TreeEntry[] = [
    blob("pytest.ini", "sha-pytest-old"),
    blob(".github/workflows/telar-tests.yml", "sha-tests-wf-old"),
    blob("_layouts/default.html", "sha-layout-old"),
    // Listed as developer-only and gone from the release: the diff would
    // otherwise delete it.
    blob("scripts/dev-tool.py", "sha-dev-tool"),
  ];

  function releaseFetch(list: () => unknown, tree = RELEASE_TREE) {
    return vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(`/git/trees/${TAG}`)) return { ok: true, json: async () => ({ tree, truncated: false }) };
      if (url.includes(`/contents/${DEV_ONLY_FILES_PATH}`)) return list();
      return content(`content of ${url}`);
    });
  }

  it("neither adds nor deletes a developer-only path, and still delivers the list itself", async () => {
    globalThis.fetch = releaseFetch(() => content(`${DEV_ONLY_LIST}scripts/dev-tool.py\n`));
    const diff = await computeUpgradeDiff("tok", USER_TREE, TAG);
    expect(diff.additions.map((a) => a.path).sort()).toEqual(["_layouts/default.html", DEV_ONLY_FILES_PATH]);
    expect(diff.deletions).toEqual([]);
  });

  it("reads a release whose tree has no list as having none, without asking for it", async () => {
    const fetchMock = releaseFetch(
      () => {
        throw new Error("a release without the list is not asked for it");
      },
      RELEASE_TREE.filter((e) => e.path !== DEV_ONLY_FILES_PATH),
    );
    globalThis.fetch = fetchMock;
    const diff = await computeUpgradeDiff("tok", USER_TREE, TAG);
    expect(diff.additions.map((a) => a.path).sort()).toEqual([
      ".github/workflows/telar-tests.yml",
      "_layouts/default.html",
      "pytest.ini",
      "vitest.config.js",
    ]);
    expect(diff.deletions).toEqual(["scripts/dev-tool.py"]);
  });

  it("fails when the release's list cannot be read", async () => {
    globalThis.fetch = releaseFetch(serverError);
    await expect(computeUpgradeDiff("tok", USER_TREE, TAG)).rejects.toThrow(DEV_ONLY_FILES_PATH);
  });

  it("fails naming the list and the release on a 500", async () => {
    globalThis.fetch = releaseFetch(serverError);
    const err = await computeUpgradeDiff("tok", USER_TREE, TAG).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReleaseFileUnreadableError);
    expect((err as ReleaseFileUnreadableError).path).toBe(DEV_ONLY_FILES_PATH);
    expect((err as ReleaseFileUnreadableError).version).toBe("1.8.0");
  });
});

// ---------------------------------------------------------------------------
// The heal
// ---------------------------------------------------------------------------

describe("healMissingFrameworkFiles and the release's developer-only paths", () => {
  const TAG = "v1.8.0";
  const MISSING = ["pytest.ini", "vitest.config.js", "NOTICE", "_data/glossary_kinds.yml", ".ruby-version"];

  function healFetch(list: () => unknown) {
    return vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/git/trees/HEAD")) {
        return {
          ok: true,
          json: async () => ({
            truncated: false,
            tree: FRAMEWORK_FILES.filter((p) => !MISSING.includes(p)).map((p) => ({
              path: p, mode: "100644", type: "blob", sha: "x",
            })),
          }),
        };
      }
      if (url.includes(`/releases/tags/${TAG}`)) return { ok: true, json: async () => ({ tag_name: TAG }) };
      if (url.includes(`/contents/${DEV_ONLY_FILES_PATH}`)) return list();
      const path = new URL(url).pathname.split("/contents/")[1];
      return content(`release copy of ${path}`);
    });
  }

  it("restores a missing framework file, _data/glossary_kinds.yml among them, but never a developer-only path", async () => {
    const fetchMock = healFetch(() => content(DEV_ONLY_LIST));
    globalThis.fetch = fetchMock;
    const healed = await healMissingFrameworkFiles("tok", "owner", "repo", TAG, "tok");
    expect(healed.map((f) => f.path).sort()).toEqual([".ruby-version", "NOTICE", "_data/glossary_kinds.yml"]);
    expect(healed.find((f) => f.path === "_data/glossary_kinds.yml")?.content).toBe(
      "release copy of _data/glossary_kinds.yml",
    );
    const fetched = fetchMock.mock.calls.map(([u]) => String(u));
    expect(fetched.some((u) => u.includes("/contents/pytest.ini"))).toBe(false);
    expect(fetched.some((u) => u.includes("/contents/vitest.config.js"))).toBe(false);
  });

  it("restores every missing file from a release that ships no list", async () => {
    globalThis.fetch = healFetch(notFound);
    const healed = await healMissingFrameworkFiles("tok", "owner", "repo", TAG, "tok");
    expect(healed.map((f) => f.path).sort()).toEqual([...MISSING].sort());
  });

  it("withholds only the known developer-only files when the release's list cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const list of [serverError, () => { throw new Error("network down"); }]) {
      globalThis.fetch = healFetch(list);
      const healed = await healMissingFrameworkFiles("tok", "owner", "repo", TAG, "tok");
      expect(healed.map((f) => f.path).sort()).toEqual([".ruby-version", "NOTICE", "_data/glossary_kinds.yml"]);
    }
  });

  it("knows exactly the framework files the recorded 1.8.0 list names", () => {
    const named = FRAMEWORK_FILES.filter((path) => isDevOnlyPath(path, DEV_ONLY));
    expect([...KNOWN_DEV_ONLY_FRAMEWORK_FILES].sort()).toEqual([...named].sort());
  });
});

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/** A site whose tree holds exactly `paths`, listed whole. */
const SITE_HAS = (paths: string[]) => ({
  tree: paths.map((path) => ({ path, mode: "100644", type: "blob", sha: "x" }) as TreeEntry),
  truncated: false,
});

describe("mergeUpgradeChanges", () => {
  it("deletes a path the manifest deletes rather than adding it, and lists each deletion once", () => {
    const merged = mergeUpgradeChanges(
      {
        additions: [
          { path: "scripts/telar_upgrade.py", content: "launcher" },
          { path: "_layouts/default.html", content: "layout" },
        ],
        deletions: ["_layouts/old.html"],
      },
      {
        files: new Map([["_config.yml", "config"]]),
        deletions: ["scripts/telar_upgrade.py", "_layouts/old.html"],
      },
      SITE_HAS(["_layouts/old.html", "scripts/telar_upgrade.py"]),
    );
    expect(merged.additions).toEqual([
      { path: "_layouts/default.html", content: "layout" },
      { path: "_config.yml", content: "config" },
    ]);
    expect(merged.deletions).toEqual(["_layouts/old.html", "scripts/telar_upgrade.py"]);
  });

  it("drops from the additions a path the manifest deletes that the site does not have, and deletes only what it has", () => {
    const merged = mergeUpgradeChanges(
      {
        additions: [
          { path: "scripts/telar_upgrade.py", content: "launcher" },
          { path: "scripts/telar_upgrade_common.py", content: "engine" },
        ],
        deletions: [],
      },
      { files: new Map(), deletions: ["scripts/telar_upgrade.py", "scripts/telar_upgrade_common.py"] },
      SITE_HAS(["scripts/telar_upgrade.py"]),
    );
    expect(merged.additions).toEqual([]);
    expect(merged.deletions).toEqual(["scripts/telar_upgrade.py"]);
  });

  it("keeps every deletion when the site's tree is truncated", () => {
    const merged = mergeUpgradeChanges(
      { additions: [], deletions: [] },
      { files: new Map(), deletions: ["a.js", "b.js"] },
      { tree: [], truncated: true },
    );
    expect(merged.deletions).toEqual(["a.js", "b.js"]);
  });

  it("lets the manifest's copy of a path overwrite the tree diff's", () => {
    const merged = mergeUpgradeChanges(
      { additions: [{ path: "_config.yml", content: "diff" }], deletions: [] },
      { files: new Map([["_config.yml", "manifest"]]), deletions: [] },
      SITE_HAS([]),
    );
    expect(merged.additions).toEqual([{ path: "_config.yml", content: "manifest" }]);
  });
});

// ---------------------------------------------------------------------------
// 1.7.0 to 1.8.0
// ---------------------------------------------------------------------------

describe("an upgrade from the 1.7.0 template tree to the 1.8.0 release", () => {
  const TAG = "v1.8.0";
  const userTree = lsTree(fixture("tree-v1.7.0.txt"));
  const releaseTree = lsTree(fixture("tree-0dd90d52-framework.txt"));
  const manifest = validateManifest(JSON.parse(fixture("migration.json")));

  async function prepare() {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(`/git/trees/${TAG}`)) {
        return { ok: true, json: async () => ({ tree: releaseTree, truncated: false }) };
      }
      if (url.includes(`/contents/${DEV_ONLY_FILES_PATH}`)) return content(DEV_ONLY_LIST);
      return content("release file");
    });
    const diff = await computeUpgradeDiff("tok", userTree, TAG);
    const files = new Map([["_config.yml", fixture("config-v1.7.0.yml")]]);
    const result = applyManifestChain([manifest], files, "en");
    // As the route composes them: the site's tree narrows the deletions.
    return mergeUpgradeChanges(diff, result, { tree: userTree, truncated: false });
  }

  it("adds none of the developer-only paths", async () => {
    const merged = await prepare();
    expect(merged.additions.filter((a) => isDevOnlyPath(a.path, DEV_ONLY))).toEqual([]);
    expect(merged.additions.map((a) => a.path)).toContain("_data/glossary_kinds.yml");
  });

  it("deletes each of the site's developer-only files once", async () => {
    const merged = await prepare();
    const siteDevOnly = userTree.map((e) => e.path).filter((p) => isDevOnlyPath(p, DEV_ONLY));
    expect(siteDevOnly).toContain("pytest.ini");
    expect(siteDevOnly).toContain(".github/workflows/telar-tests.yml");
    for (const path of siteDevOnly) {
      expect(merged.deletions.filter((d) => d === path)).toEqual([path]);
    }
    expect(new Set(merged.deletions).size).toBe(merged.deletions.length);
  });

  it("adds none of the launcher's engine files the release ships and the manifest deletes, whether or not the site has them", async () => {
    const launcher = [
      "scripts/telar_upgrade.py",
      "scripts/telar_upgrade_common.py",
      "scripts/telar_upgrade_regen.py",
      "scripts/telar_upgrade_report.py",
    ];
    const shipped = releaseTree.map((e) => e.path);
    for (const path of launcher) expect(shipped).toContain(path);
    expect(userTree.map((e) => e.path)).not.toContain("scripts/telar_upgrade_common.py");
    const merged = await prepare();
    const added = merged.additions.map((a) => a.path);
    expect(launcher.filter((path) => added.includes(path))).toEqual([]);
  });

  it("deletes the launcher the release still ships but a site does not need, and does not add it", async () => {
    expect(releaseTree.map((e) => e.path)).toContain("scripts/telar_upgrade.py");
    const merged = await prepare();
    expect(merged.deletions).toContain("scripts/telar_upgrade.py");
    expect(merged.additions.map((a) => a.path)).not.toContain("scripts/telar_upgrade.py");
    const added = new Set(merged.additions.map((a) => a.path));
    expect(merged.deletions.filter((d) => added.has(d))).toEqual([]);
  });
});
