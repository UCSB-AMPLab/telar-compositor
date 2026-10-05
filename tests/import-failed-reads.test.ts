/**
 * The first import never takes a failed read for a missing file.
 *
 * The seeded project is what the next publish writes back, so a sheet, page or
 * layer file the import could not read, taken as missing, becomes a deletion
 * on the site. The import therefore resolves GitHub's head once, reads every
 * file and listing at it strictly, and refuses on any failed read before it
 * writes anything, naming the file. A 404 keeps its old meaning at each site.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getDefaultBranchHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileContent: vi.fn(),
    getFileAtRef: vi.fn(),
    getSubtreeOids: vi.fn(),
    listSubtreeEntries: vi.fn(),
  };
});

vi.mock("~/lib/sheets.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, discoverSheetTabs: vi.fn(), fetchSheetCsv: vi.fn() };
});

import { importRepo, scanRepoPages, scanRepoOrphanStoryIds } from "~/lib/import.server";
import {
  getFileAtRef,
  getFileContent,
  getRepoHead,
  getDefaultBranchHead,
  getRepoTree,
  getSubtreeOids,
  listSubtreeEntries,
  NoSuchBranchError,
} from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";

const HEAD = "head-sha";
const SHEETS = "telar-content/spreadsheets";
const CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';
const SHEETS_CONFIG =
  'title: "Site"\ntelar:\n  version: "1.0.0"\ngoogle_sheets:\n  enabled: true\n' +
  '  published_url: "https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pubhtml"\n';
const STORY_CSV = "step,object,x,y,zoom,question,answer,layer1_button,layer1_content\n1,bell,0.5,0.5,1,Q,A,More,panel.md\n";

/** A site that exercises every read the import makes. */
function siteFiles(): Record<string, string> {
  return {
    "_config.yml": CONFIG,
    "index.md": "---\ntitle: Home\n---\nWelcome.\n",
    "_data/themes/trama.yml": "name: Trama\n",
    [`${SHEETS}/objects.csv`]: "object_id,title\nbell,Bell\n",
    [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
    [`${SHEETS}/story-one.csv`]: STORY_CSV,
    [`${SHEETS}/old-story.csv`]: "step,object\n1,bell\n",
    "telar-content/texts/stories/panel.md": "---\ntitle: Panel\n---\nPanel text.\n",
    [`${SHEETS}/glossary.csv`]: "term_id,title,definition\nloom,Loom,A frame.\n",
    "telar-content/texts/pages/about.md": "---\ntitle: About\n---\nAbout body.\n",
    ".compositor-ignored": "old-story\n",
  };
}

let memory: MemoryD1;
let files: Record<string, string>;
let failing: Set<string>;

function count(table: string): number {
  return (memory.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function importNow() {
  return importRepo({
    token: "t",
    installationId: 1,
    repoFullName: "owner/repo",
    userId: 1,
    env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
  });
}

function expectNothingSeeded() {
  expect(count("projects")).toBe(0);
  expect(count("objects")).toBe(0);
  expect(count("stories")).toBe(0);
  expect(count("steps")).toBe(0);
  expect(count("project_pages")).toBe(0);
}

/** The story-file paths the import read, in order. */
function storyPathsRead(): string[] {
  const storyPaths = [`${SHEETS}/story-one.csv`, "_data/story-one.csv", "story-one.csv"];
  return vi.mocked(getFileAtRef).mock.calls.map((call) => call[3]).filter((path) => storyPaths.includes(path));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  files = siteFiles();
  failing = new Set();

  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "main", oid: HEAD });
  vi.mocked(getRepoTree).mockImplementation(async () => ({
    tree: Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob", sha: `sha-${path}` })),
    truncated: false,
  }));
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
    if (failing.has(path)) return { status: "error" };
    return path in files ? { status: "ok", content: files[path] } : { status: "absent" };
  });
  // A loose read answers null for any failure, the same as for a missing file.
  vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) =>
    failing.has(path) || !(path in files) ? null : files[path],
  );
  vi.mocked(getSubtreeOids).mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: "sheets-oid" }) });
  vi.mocked(listSubtreeEntries).mockImplementation(async () => {
    const names = Object.keys(files)
      .filter((path) => path.startsWith(`${SHEETS}/`))
      .map((path) => path.slice(SHEETS.length + 1));
    return { files: new Map(names.map((name) => [name, `sha-${name}`])), dirs: new Set<string>() };
  });
});

afterEach(() => {
  memory.close();
});

describe("importRepo: a failed read refuses the import, naming the file, and seeds nothing", () => {
  it.each([
    "_config.yml",
    "index.md",
    "_data/themes/trama.yml",
    `${SHEETS}/objects.csv`,
    `${SHEETS}/project.csv`,
    `${SHEETS}/story-one.csv`,
    "telar-content/texts/stories/panel.md",
    `${SHEETS}/glossary.csv`,
    "telar-content/texts/pages/about.md",
    ".compositor-ignored",
  ])("%s", async (path) => {
    failing.add(path);

    await expect(importNow()).rejects.toMatchObject({ name: "SheetUnreadableError", path });

    expectNothingSeeded();
  });

  it("a story file absent at its first path and unreadable at its second", async () => {
    delete files[`${SHEETS}/story-one.csv`];
    files["_data/story-one.csv"] = STORY_CSV;
    failing.add("_data/story-one.csv");

    await expect(importNow()).rejects.toMatchObject({ name: "SheetUnreadableError", path: "_data/story-one.csv" });

    expect(storyPathsRead()).toEqual([`${SHEETS}/story-one.csv`, "_data/story-one.csv"]);
    expectNothingSeeded();
  });

  it("a story file absent at its first two paths and unreadable at the root", async () => {
    delete files[`${SHEETS}/story-one.csv`];
    files["story-one.csv"] = STORY_CSV;
    failing.add("story-one.csv");

    await expect(importNow()).rejects.toMatchObject({ name: "SheetUnreadableError", path: "story-one.csv" });

    expectNothingSeeded();
  });

  it("a story file unreadable at its first path is not looked for at the next", async () => {
    files["_data/story-one.csv"] = STORY_CSV;
    failing.add(`${SHEETS}/story-one.csv`);

    await expect(importNow()).rejects.toBeInstanceOf(SheetUnreadableError);

    expect(storyPathsRead()).toEqual([`${SHEETS}/story-one.csv`]);
  });

  it("a layer file the Sheets branch cannot read, rather than a Sheet it could not reach", async () => {
    files["_config.yml"] = SHEETS_CONFIG;
    failing.add("telar-content/texts/stories/panel.md");
    vi.mocked(discoverSheetTabs).mockResolvedValue([
      { name: "objects", gid: "1" },
      { name: "project", gid: "2" },
      { name: "story-one", gid: "3" },
    ]);
    vi.mocked(fetchSheetCsv).mockImplementation(async (_id, gid) =>
      gid === "1" ? "object_id,title\nbell,Bell\n" : gid === "2" ? "order,story_id,title\n1,story-one,First\n" : STORY_CSV,
    );

    await expect(importNow()).rejects.toMatchObject({
      name: "SheetUnreadableError",
      path: "telar-content/texts/stories/panel.md",
    });

    expectNothingSeeded();
  });

  it("an orphan scan whose listing cannot be trusted", async () => {
    vi.mocked(getSubtreeOids).mockResolvedValue({ ok: false, reason: "unresolved" });

    await expect(importNow()).rejects.toThrow(/spreadsheets/);

    expectNothingSeeded();
  });

  it("a head GitHub fails to resolve", async () => {
    vi.mocked(getDefaultBranchHead).mockRejectedValue(new Error("GitHub GraphQL error: 502"));

    await expect(importNow()).rejects.toThrow("502");

    expect(getFileAtRef).not.toHaveBeenCalled();
    expectNothingSeeded();
  });
});

describe("importRepo: a missing file keeps its meaning", () => {
  it("answers empty_repo when _config.yml is absent", async () => {
    delete files["_config.yml"];

    const result = await importNow();

    expect(result.valid).toBe(false);
    expect(result.validationError).toBe("empty_repo");
    expectNothingSeeded();
  });

  it("answers empty_repo for a repository with no default branch, reading nothing", async () => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue(null);

    const result = await importNow();

    expect(result.valid).toBe(false);
    expect(result.validationError).toBe("empty_repo");
    expect(getFileAtRef).not.toHaveBeenCalled();
    expectNothingSeeded();
  });

  it("tries the three story-file paths in order, taking the first present", async () => {
    delete files[`${SHEETS}/story-one.csv`];
    files["story-one.csv"] = STORY_CSV;

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(storyPathsRead()).toEqual([`${SHEETS}/story-one.csv`, "_data/story-one.csv", "story-one.csv"]);
    expect(count("steps")).toBe(1);
  });

  it("seeds the site without each optional file that is absent", async () => {
    for (const path of [
      "index.md",
      "_data/themes/trama.yml",
      "telar-content/texts/stories/panel.md",
      `${SHEETS}/glossary.csv`,
      "telar-content/texts/pages/about.md",
      ".compositor-ignored",
    ]) {
      delete files[path];
    }
    // The theme and page stay in the tree, as a file deleted between the
    // listing and the read would.
    vi.mocked(getRepoTree).mockResolvedValue({
      tree: [
        { path: "_data/themes/trama.yml", mode: "100644", type: "blob", sha: "t" },
        { path: "telar-content/texts/pages/about.md", mode: "100644", type: "blob", sha: "p" },
      ],
      truncated: false,
    });

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(result.themes.imported).toBe(0);
    expect(result.pages.imported).toBe(0);
    expect(result.glossary.imported).toBe(0);
    expect(result.orphanStoryIds).toEqual(["old-story"]);
    const layer = memory.raw.prepare("SELECT content FROM layers").get() as { content: string };
    expect(layer.content).toBe("panel.md");
  });
});

describe("importRepo: the site's default branch must be main", () => {
  /** `main` as GitHub answers it: a branch with its own files, or none. */
  function mainBranch(main: { oid: string; files: Record<string, string> } | null, tag?: string) {
    vi.mocked(getRepoHead).mockImplementation(async (_t, _o, _r, name) => {
      if (name === "refs/heads/main" && main) return main.oid;
      // GitHub resolves a short name against tags as well as branches.
      if (name === "main" && (main || tag)) return main?.oid ?? (tag as string);
      throw new NoSuchBranchError(name ?? "main");
    });
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
      if (!main || ref !== main.oid) return { status: "absent" };
      if (failing.has(path)) return { status: "error" };
      return path in main.files ? { status: "ok", content: main.files[path] } : { status: "absent" };
    });
  }

  /** Nothing read at the default branch, no tree, nothing written: at most main's config. */
  function expectOnlyMainConfigRead(mainOid: string | null) {
    const reads = vi.mocked(getFileAtRef).mock.calls.map((call) => call.slice(3));
    expect(reads).toEqual(mainOid === null ? [] : [["_config.yml", mainOid, { strict: true }]]);
    expect(getRepoTree).not.toHaveBeenCalled();
    expectNothingSeeded();
  }

  it.each([
    ["the repository has no main branch", "master"],
    ["the default branch is named otherwise", "trunk"],
  ])("refuses with no_main_branch, main absent, when %s, reading and writing nothing", async (_label, branch) => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: branch, oid: "other-sha" });
    mainBranch(null);

    const result = await importNow();

    expect(result.valid).toBe(false);
    expect(result.validationError).toBe("no_main_branch");
    expect(result.defaultBranch).toBe(branch);
    expect(result.mainBranch).toBe("absent");
    expect(vi.mocked(getRepoHead).mock.calls.map((call) => call[3])).toEqual(["refs/heads/main"]);
    expectOnlyMainConfigRead(null);
  });

  it("takes a tag named main, with no branch, as no main branch", async () => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "master", oid: "other-sha" });
    mainBranch(null, "tag-sha");

    const result = await importNow();

    expect(result.validationError).toBe("no_main_branch");
    expect(result.mainBranch).toBe("absent");
    expectOnlyMainConfigRead(null);
  });

  it("reports a main branch beside the default that holds a Telar site, reading only its config", async () => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "master", oid: "other-sha" });
    mainBranch({ oid: "main-sha", files: { "_config.yml": CONFIG } });

    const result = await importNow();

    expect(result.validationError).toBe("no_main_branch");
    expect(result.defaultBranch).toBe("master");
    expect(result.mainBranch).toBe("site");
    expectOnlyMainConfigRead("main-sha");
  });

  it.each([
    ["no _config.yml", {}],
    ["a _config.yml without telar.version", { "_config.yml": 'title: "Other"\n' }],
    ["a _config.yml that does not parse", { "_config.yml": "telar: [\n" }],
  ])("reports a main branch with %s as holding no site", async (_label, mainFiles) => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "master", oid: "other-sha" });
    mainBranch({ oid: "main-sha", files: mainFiles as Record<string, string> });

    const result = await importNow();

    expect(result.validationError).toBe("no_main_branch");
    expect(result.mainBranch).toBe("not_site");
    expectOnlyMainConfigRead("main-sha");
  });

  it("answers main_unreadable, and no guess, when main's config cannot be read", async () => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "master", oid: "other-sha" });
    mainBranch({ oid: "main-sha", files: { "_config.yml": CONFIG } });
    failing.add("_config.yml");

    const result = await importNow();

    expect(result.valid).toBe(false);
    expect(result.validationError).toBe("main_unreadable");
    expect(result.mainBranch).toBeUndefined();
    expectOnlyMainConfigRead("main-sha");
  });

  it("answers main_unreadable when main's head cannot be looked up", async () => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "master", oid: "other-sha" });
    vi.mocked(getRepoHead).mockRejectedValue(new Error("GitHub GraphQL error: 502"));

    const result = await importNow();

    expect(result.validationError).toBe("main_unreadable");
    expectOnlyMainConfigRead(null);
  });

  it("imports a main default branch at its head", async () => {
    vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "main", oid: "main-sha" });

    const result = await importNow();

    expect(result.valid).toBe(true);
    for (const call of vi.mocked(getFileAtRef).mock.calls) expect(call[4]).toBe("main-sha");
    expect(count("projects")).toBe(1);
  });
});

describe("importRepo: one import reads at one head", () => {
  it("resolves the head once and reads every file, the tree, the orphan scan and the objects listing at it, strictly", async () => {
    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(result.orphanStoryIds).toEqual([]);
    expect(getDefaultBranchHead).toHaveBeenCalledTimes(1);
    expect(getRepoHead).not.toHaveBeenCalled();
    const reads = vi.mocked(getFileAtRef).mock.calls;
    expect(reads.map((call) => call[3]).sort()).toEqual(
      Object.keys(siteFiles()).filter((path) => path !== `${SHEETS}/old-story.csv`).sort(),
    );
    for (const call of reads) expect(call.slice(4)).toEqual([HEAD, { strict: true }]);
    expect(getRepoTree).toHaveBeenCalled();
    for (const call of vi.mocked(getRepoTree).mock.calls) expect(call[3]).toBe(HEAD);
    expect(vi.mocked(getSubtreeOids).mock.calls).toEqual([
      ["t", "owner", "repo", [HEAD], [SHEETS]],
      ["t", "owner", "repo", [HEAD], ["telar-content/objects"]],
    ]);
    expect(getFileContent).not.toHaveBeenCalled();
  });

  it("the orphan scan reads before the first write", async () => {
    let projectsWhenScanned = -1;
    vi.mocked(getSubtreeOids).mockImplementation(async () => {
      projectsWhenScanned = count("projects");
      return { ok: true, at: () => ({ kind: "tree", oid: "sheets-oid" }) };
    });

    await importNow();

    expect(projectsWhenScanned).toBe(0);
    expect(count("projects")).toBe(1);
  });
});

describe("scanRepoPages reads strictly", () => {
  it("lists and reads at the head it is given", async () => {
    const pages = await scanRepoPages("t", "owner", "repo", "given-head");

    expect(pages.map((p) => p.slug)).toEqual(["about"]);
    expect(getRepoHead).not.toHaveBeenCalled();
    expect(vi.mocked(getRepoTree).mock.calls[0][3]).toBe("given-head");
    expect(vi.mocked(getFileAtRef).mock.calls[0].slice(3)).toEqual([
      "telar-content/texts/pages/about.md",
      "given-head",
      { strict: true },
    ]);
  });

  it("resolves a head of its own when none is given", async () => {
    await scanRepoPages("t", "owner", "repo");

    expect(getRepoHead).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getRepoTree).mock.calls[0][3]).toBe(HEAD);
    expect(vi.mocked(getFileAtRef).mock.calls[0][4]).toBe(HEAD);
  });

  it("throws on a page it cannot read", async () => {
    failing.add("telar-content/texts/pages/about.md");

    await expect(scanRepoPages("t", "owner", "repo")).rejects.toMatchObject({
      name: "SheetUnreadableError",
      path: "telar-content/texts/pages/about.md",
    });
  });

  it("skips a page absent at the head, keeping the order of the rest", async () => {
    vi.mocked(getRepoTree).mockResolvedValue({
      tree: [
        { path: "telar-content/texts/pages/gone.md", mode: "100644", type: "blob", sha: "g" },
        { path: "telar-content/texts/pages/about.md", mode: "100644", type: "blob", sha: "a" },
      ],
      truncated: false,
    });

    const pages = await scanRepoPages("t", "owner", "repo");

    expect(pages.map((p) => [p.slug, p.order])).toEqual([["about", 1]]);
  });
});

describe("importRepo: a page in a subfolder of the pages folder", () => {
  it("is not imported, and is not read", async () => {
    files["telar-content/texts/pages/sub/x.md"] = "---\ntitle: Nested\n---\nNested body.\n";

    await importNow();

    const slugs = memory.raw.prepare("SELECT slug FROM project_pages ORDER BY slug").all() as { slug: string }[];
    expect(slugs.map((row) => row.slug)).toEqual(["about"]);
    expect(vi.mocked(getFileAtRef).mock.calls.map((call) => call[3])).not.toContain(
      "telar-content/texts/pages/sub/x.md",
    );
  });
});

describe("scanRepoOrphanStoryIds without a head, as the start screen calls it", () => {
  it("resolves a head and reads the ignore list strictly at it", async () => {
    expect(await scanRepoOrphanStoryIds("t", "owner", "repo", new Set(["story-one"]))).toEqual([]);

    expect(getRepoHead).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getSubtreeOids).mock.calls[0][3]).toEqual([HEAD]);
    expect(getFileAtRef).toHaveBeenCalledWith("t", "owner", "repo", ".compositor-ignored", HEAD, { strict: true });
    expect(getFileContent).not.toHaveBeenCalled();
    expect(getRepoTree).not.toHaveBeenCalled();
  });

  it("refuses a failed read of the ignore list rather than reading it as empty", async () => {
    failing.add(".compositor-ignored");

    await expect(scanRepoOrphanStoryIds("t", "owner", "repo", new Set(["story-one"]))).rejects.toMatchObject({
      name: "SheetUnreadableError",
      path: ".compositor-ignored",
    });
  });
});
