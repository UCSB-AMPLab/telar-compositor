/**
 * The Compositor moves a site to `main` itself.
 *
 * `importOnMain` decides from GitHub, never from what the author was shown,
 * which of three cases the repository is in: no `main` (rename the default),
 * a `main` holding a Telar site (make it the default), or a `main` holding
 * none (change nothing). It then imports on `main` and, only after an import
 * that succeeded, moves a branch-deployed Pages site to the build workflow
 * when `main` carries it. Every call runs on the author's own token.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { importOnMain } from "~/lib/default-branch.server";
import { refusedImportResult } from "~/lib/import.server";
import type { ImportResult } from "~/lib/import.server";
import {
  BUILD_WORKFLOW,
  NON_DEPLOYING_WORKFLOW,
  TELAR_CONFIG,
  installRepoFake,
  repoFake,
  writes,
  type GitHubRepoFake,
} from "./helpers/github-branch-fake";

const TOKEN = "author-token";
const NO_WAIT = { attempts: 3, intervalMs: 0 };

const IMPORTED = { ...refusedImportResult({}), valid: true, projectId: 7 } as ImportResult;

let repo: GitHubRepoFake;
let importedOn: Array<string | null>;
let importSite: ReturnType<typeof vi.fn>;

function run(wait = NO_WAIT) {
  return importOnMain(TOKEN, "owner", "repo", importSite as () => Promise<ImportResult>, wait);
}

/** A repository whose default is `master`, holding the site, with `main` as given. */
function withMain(main: "absent" | "site" | "no-config" | "no-version") {
  repo.files.set("master-sha", { "_config.yml": TELAR_CONFIG, ".github/workflows/build.yml": BUILD_WORKFLOW });
  if (main === "absent") return;
  repo.branches.set("main", "main-sha");
  const config = main === "site" ? TELAR_CONFIG : main === "no-version" ? 'title: "Other"\n' : undefined;
  repo.files.set("main-sha", config === undefined ? { "README.md": "x" } : { "_config.yml": config });
}

beforeEach(() => {
  repo = repoFake();
  installRepoFake(repo);
  importedOn = [];
  importSite = vi.fn(async () => {
    importedOn.push(repo.defaultBranch);
    repo.log.push({ call: "IMPORT", auth: null, body: undefined });
    return IMPORTED;
  });
});

describe("importOnMain: no main branch", () => {
  it("renames the default to main with the author's token, then imports on main", async () => {
    withMain("absent");

    const result = await run();

    expect(result.valid).toBe(true);
    expect(writes(repo)).toEqual(["POST /branches/master/rename", "IMPORT"]);
    const rename = repo.log.find((entry) => entry.call === "POST /branches/master/rename");
    expect(rename?.auth).toBe(`Bearer ${TOKEN}`);
    expect(rename?.body).toEqual({ new_name: "main" });
    expect(importedOn).toEqual(["main"]);
  });

  it("treats a tag named main as no main branch, and renames", async () => {
    withMain("absent");
    repo.tags.set("main", "tag-sha");
    repo.files.set("tag-sha", { "_config.yml": TELAR_CONFIG });

    const result = await run();

    expect(result.valid).toBe(true);
    expect(writes(repo)).toEqual(["POST /branches/master/rename", "IMPORT"]);
  });
});

describe("importOnMain: main holds a Telar site", () => {
  it("makes main the default with the author's token, then imports", async () => {
    withMain("site");

    const result = await run();

    expect(result.valid).toBe(true);
    expect(writes(repo)).toEqual(["PATCH ", "IMPORT"]);
    const patch = repo.log.find((entry) => entry.call === "PATCH ");
    expect(patch?.auth).toBe(`Bearer ${TOKEN}`);
    expect(patch?.body).toEqual({ default_branch: "main" });
    expect(importedOn).toEqual(["main"]);
  });
});

describe("importOnMain: main holds no Telar site, or cannot be read", () => {
  it.each([
    ["no _config.yml", "no-config"],
    ["a _config.yml without telar.version", "no-version"],
  ] as const)("changes nothing and refuses when main has %s", async (_label, main) => {
    withMain(main);

    const result = await run();

    expect(result).toMatchObject({ valid: false, validationError: "no_main_branch", defaultBranch: "master", mainBranch: "not_site" });
    expect(writes(repo)).toEqual([]);
    expect(importSite).not.toHaveBeenCalled();
  });

  it("changes nothing and answers main_unreadable when main's config cannot be read", async () => {
    withMain("site");
    repo.failingCommits.add("main-sha");

    const result = await run();

    expect(result).toMatchObject({ valid: false, validationError: "main_unreadable" });
    expect(writes(repo)).toEqual([]);
    expect(importSite).not.toHaveBeenCalled();
  });

  it("changes nothing and answers main_unreadable when main's head cannot be looked up", async () => {
    withMain("site");
    repo.failHeadLookup = true;

    const result = await run();

    expect(result).toMatchObject({ valid: false, validationError: "main_unreadable" });
    expect(writes(repo)).toEqual([]);
  });
});

describe("importOnMain: the default is already main", () => {
  it("changes nothing and imports", async () => {
    repo.defaultBranch = "main";
    repo.branches = new Map([["main", "main-sha"]]);
    repo.files.set("main-sha", { "_config.yml": TELAR_CONFIG });

    const result = await run();

    expect(result.valid).toBe(true);
    expect(writes(repo)).toEqual(["IMPORT"]);
  });
});

describe("importOnMain: GitHub refuses the change", () => {
  it.each([
    ["the rename", "absent", "renameStatuses"],
    ["the default-branch change", "site", "patchStatuses"],
  ] as const)("answers branch_admin_required on a 403 from %s, and imports nothing", async (_label, main, statuses) => {
    withMain(main);
    repo[statuses].push(403);

    const result = await run();

    expect(result).toMatchObject({ valid: false, validationError: "branch_admin_required" });
    expect(importSite).not.toHaveBeenCalled();
    expect(repo.log.some((entry) => entry.call.includes("/pages"))).toBe(false);
  });

  it("classifies again on a 404 from the rename, and imports when the default has become main", async () => {
    withMain("absent");
    repo.renameStatuses.push(404);
    repo.onChange = (call) => {
      if (call !== "rename") return;
      repo.branches = new Map([["main", "master-sha"]]);
      repo.defaultBranch = "main";
    };

    const result = await run();

    expect(result.valid).toBe(true);
    expect(importedOn).toEqual(["main"]);
  });

  it("classifies again on a 422 from the rename, and makes main the default when main now holds the site", async () => {
    withMain("absent");
    repo.renameStatuses.push(422);
    repo.onChange = (call) => {
      if (call !== "rename") return;
      repo.branches.set("main", "main-sha");
      repo.files.set("main-sha", { "_config.yml": TELAR_CONFIG });
    };

    const result = await run();

    expect(result.valid).toBe(true);
    expect(writes(repo)).toEqual(["POST /branches/master/rename", "PATCH ", "IMPORT"]);
  });

  it("throws on a second 404, as a failed import does", async () => {
    withMain("absent");
    repo.renameStatuses.push(404, 404);

    await expect(run()).rejects.toThrow();
    expect(importSite).not.toHaveBeenCalled();
  });
});

describe("importOnMain: GitHub finishes a rename after answering it", () => {
  it("waits for the default to become main before importing", async () => {
    withMain("absent");
    repo.renameLag = 2;

    const result = await run({ attempts: 5, intervalMs: 0 });

    expect(result.valid).toBe(true);
    expect(importedOn).toEqual(["main"]);
  });

  it("answers rename_pending when the rename does not finish in time, and a second click imports", async () => {
    withMain("absent");
    // Three reads while the first click waits; the rename finishes on the next.
    repo.renameLag = 3;

    const first = await run({ attempts: 3, intervalMs: 0 });

    expect(first).toMatchObject({ valid: false, validationError: "rename_pending" });
    expect(importSite).not.toHaveBeenCalled();

    const second = await run({ attempts: 3, intervalMs: 0 });

    expect(second.valid).toBe(true);
    expect(importedOn).toEqual(["main"]);
    expect(writes(repo).filter((call) => call.includes("rename"))).toHaveLength(1);
  });
});

describe("importOnMain: Pages, after the import", () => {
  it("switches a branch-deployed site to the workflow when main has the build workflow, after the import", async () => {
    withMain("absent");
    repo.pages = { build_type: "legacy", source: { branch: "master", path: "/" } };

    const result = await run();

    expect(result.valid).toBe(true);
    expect(result.pagesWarning).toBeUndefined();
    expect(writes(repo)).toEqual(["POST /branches/master/rename", "IMPORT", "PUT /pages"]);
    const put = repo.log.find((entry) => entry.call === "PUT /pages");
    expect(put?.body).toEqual({ build_type: "workflow" });
    expect(put?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("switches Pages after the import when the default was already main", async () => {
    repo.defaultBranch = "main";
    repo.branches = new Map([["main", "main-sha"]]);
    repo.files.set("main-sha", { "_config.yml": TELAR_CONFIG, ".github/workflows/build.yml": BUILD_WORKFLOW });
    repo.pages = { build_type: "legacy", source: { branch: "main", path: "/" } };

    await run();

    expect(writes(repo)).toEqual(["IMPORT", "PUT /pages"]);
  });

  it.each([
    ["already on the workflow", { build_type: "workflow" as const }],
    ["absent", null],
  ])("leaves Pages %s untouched, with no warning", async (_label, pages) => {
    withMain("absent");
    repo.pages = pages;

    const result = await run();

    expect(result.valid).toBe(true);
    expect(result.pagesWarning).toBeUndefined();
    expect(writes(repo)).toEqual(["POST /branches/master/rename", "IMPORT"]);
  });

  it("leaves a branch source alone when main has no build workflow, warning with Pages' own branch", async () => {
    withMain("absent");
    repo.files.set("master-sha", { "_config.yml": TELAR_CONFIG });
    repo.pages = { build_type: "legacy", source: { branch: "gh-pages", path: "/" } };

    const result = await run();

    expect(writes(repo)).not.toContain("PUT /pages");
    expect(result.valid).toBe(true);
    expect(result.pagesWarning).toEqual({ branch: "gh-pages" });
  });

  it.each([
    ["never names the deploy action", NON_DEPLOYING_WORKFLOW],
    ["names it only in a comment", "name: Build\non: push\njobs:\n  build:\n    steps:\n      - run: make\n      # - uses: actions/deploy-pages@v5\n"],
    ["names it outside any job's steps", "name: Build\n# actions/deploy-pages@v5\non: push\nenv:\n  NOTE: actions/deploy-pages@v5\njobs:\n  build:\n    steps:\n      - run: make\n"],
    ["does not parse", "jobs: [unclosed\n"],
    ["deploys from a job with no runner", "name: Build\non: push\njobs:\n  deploy:\n    steps:\n      - uses: actions/deploy-pages@v5\n"],
  ])("leaves a branch source alone when main's build.yml %s", async (_label, workflow) => {
    withMain("site");
    repo.files.set("main-sha", { "_config.yml": TELAR_CONFIG, ".github/workflows/build.yml": workflow });
    repo.pages = { build_type: "legacy", source: { branch: "gh-pages", path: "/" } };

    const result = await run();

    expect(writes(repo)).not.toContain("PUT /pages");
    expect(result.valid).toBe(true);
    expect(result.pagesWarning).toEqual({ branch: "gh-pages" });
  });

  it("warns with Pages' own branch when the switch fails", async () => {
    withMain("site");
    repo.files.set("main-sha", { "_config.yml": TELAR_CONFIG, ".github/workflows/build.yml": BUILD_WORKFLOW });
    repo.pages = { build_type: "legacy", source: { branch: "gh-pages", path: "/docs" } };
    repo.pagesPutStatus = 403;

    const result = await run();

    expect(result.valid).toBe(true);
    expect(result.pagesWarning).toEqual({ branch: "gh-pages" });
    expect(repo.pages).toEqual({ build_type: "legacy", source: { branch: "gh-pages", path: "/docs" } });
  });

  it("leaves Pages untouched when the import refuses", async () => {
    withMain("absent");
    repo.pages = { build_type: "legacy", source: { branch: "master", path: "/" } };
    importSite.mockImplementation(async () => refusedImportResult({ validationError: "not_telar" }));

    const result = await run();

    expect(result.validationError).toBe("not_telar");
    expect(repo.log.some((entry) => entry.call.includes("/pages"))).toBe(false);
  });
});
