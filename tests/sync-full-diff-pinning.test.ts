/**
 * Every read of one full-sync check is at one HEAD commit.
 *
 * `computeFullSyncDiff` resolves HEAD once, first, and pins every HEAD read to
 * it: objects.csv and the repository tree, project.csv, _config.yml,
 * glossary.csv, and the story subtrees and files. The base reads stay at the
 * base. A commit that lands while the check runs is never read, and the diff
 * reports the commit it read (`headSha`) for the accept to pin to.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({
  reads: [] as Array<{ fn: string; path?: string; ref: unknown }>,
  /** File text by "<ref>:<path>"; absent unless set. */
  files: {} as Record<string, string>,
  /** Blob SHAs of each commit's story subtrees, by subtree path then file. */
  trees: null as null | Record<string, Record<string, Record<string, string>>>,
}));

vi.mock("~/lib/github.server", () => {
  let heads = 0;
  return {
    __reset: () => {
      heads = 0;
    },
    // A second commit lands after the first head read: the check must never
    // ask for, or read at, "head2".
    getRepoHead: vi.fn(async () => (heads++ === 0 ? "head1" : "head2")),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string) => {
      calls.reads.push({ fn: "getFileAtRef", path, ref });
      const content = calls.files[`${ref}:${path}`];
      return content === undefined ? { status: "absent" } : { status: "ok", content };
    }),
    getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref?: string) => {
      calls.reads.push({ fn: "getFileContent", path, ref });
      return null;
    }),
    getRepoTree: vi.fn(async (_t: string, _o: string, _r: string, ref: string) => {
      calls.reads.push({ fn: "getRepoTree", ref });
      return { tree: [], truncated: false };
    }),
    getSubtreeOids: vi.fn(async (_t: string, _o: string, _r: string, commits: string[]) => {
      for (const ref of commits) calls.reads.push({ fn: "getSubtreeOids", ref });
      const trees = calls.trees;
      return {
        ok: true,
        at: (commit: string, path: string) =>
          trees?.[commit]?.[path] ? { kind: "tree", oid: `${commit}|${path}` } : { kind: "absent" },
      };
    }),
    listSubtreeEntries: vi.fn(async (_t: string, _o: string, _r: string, oid: string) => {
      const [commit, path] = oid.split("|");
      return { files: new Map(Object.entries(calls.trees?.[commit]?.[path] ?? {})), dirs: new Set() };
    }),
    graphqlGitHub: vi.fn(),
    githubHeaders: vi.fn(() => ({})),
    decodeGitHubContent: vi.fn((s: string) => s),
  };
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as githubServer from "~/lib/github.server";
import { computeFullSyncDiff } from "~/lib/sync.server";
import { project_pages, projects } from "~/db/schema";
import { parsePageMarkdown } from "~/lib/import.server";
import { __clearStoryBlobCacheForTest } from "~/lib/story-files.server";

/** A D1 stand-in whose every query, however chained, answers no rows. */
function emptyDb(): never {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return (resolve: (v: unknown[]) => unknown) => resolve([]);
        return () => chain;
      },
    },
  );
  return chain as never;
}

/** A D1 stand-in answering `pages` for the project's pages and no rows for anything else. */
function dbWithPages(pages: unknown[], project: Record<string, unknown> = {}): never {
  let table: unknown;
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const rows = table === project_pages ? pages : table === projects ? [project] : [];
          table = undefined;
          return (resolve: (v: unknown[]) => unknown) => resolve(rows);
        }
        if (prop === "from") return (t: unknown) => { table = t; return chain; };
        return () => chain;
      },
    },
  );
  return chain as never;
}

beforeEach(() => {
  __clearStoryBlobCacheForTest();
  calls.reads.length = 0;
  calls.files = {};
  calls.trees = null;
  (githubServer as unknown as { __reset: () => void }).__reset();
});

describe("one full-sync check reads at one HEAD", () => {
  it("pins every HEAD read to the first head, and never reads a commit that landed after it", async () => {
    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", emptyDb(), "base");

    expect(githubServer.getRepoHead).toHaveBeenCalledTimes(1);
    expect(diff.headSha).toBe("head1");
    expect(calls.reads.some((r) => r.fn === "getFileContent")).toBe(false);
    const refs = new Set(calls.reads.map((r) => r.ref));
    expect([...refs].sort()).toEqual(["base", "head1"]);

    const headPaths = calls.reads.filter((r) => r.fn === "getFileAtRef" && r.ref === "head1").map((r) => r.path);
    // No sheet is there, so each is looked for under its Spanish name too.
    expect(headPaths.sort()).toEqual([
      "_config.yml",
      "telar-content/spreadsheets/glosario.csv",
      "telar-content/spreadsheets/glossary.csv",
      "telar-content/spreadsheets/objects.csv",
      "telar-content/spreadsheets/objetos.csv",
      "telar-content/spreadsheets/project.csv",
      "telar-content/spreadsheets/proyecto.csv",
    ]);
    expect(calls.reads.filter((r) => r.fn === "getRepoTree").map((r) => r.ref)).toEqual(["head1"]);
    // The story trees, then the pages folder, which is read whether or not a page is held.
    expect(calls.reads.filter((r) => r.fn === "getSubtreeOids").map((r) => r.ref)).toEqual(["base", "head1", "base", "head1"]);
  });

  it("names the project and the base it was computed for, with the head", async () => {
    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", emptyDb(), "base");
    expect([diff.projectId, diff.baseSha, diff.headSha]).toEqual([1, "base", "head1"]);
  });

  it("names no base when there was none", async () => {
    const diff = await computeFullSyncDiff(3, "tok", "owner", "repo", emptyDb(), null);
    expect([diff.projectId, diff.baseSha]).toEqual([3, null]);
  });

  it("with no base, reads HEAD only, at the one head", async () => {
    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", emptyDb(), null);
    expect(diff.headSha).toBe("head1");
    expect(new Set(calls.reads.map((r) => r.ref))).toEqual(new Set(["head1"]));
  });
});

describe("a story deleted in the Compositor whose files changed on GitHub", () => {
  it("takes the restore / keep-deleted choice even when its project.csv row is unchanged", async () => {
    const project = "order,story_id,title\n1,gone,Gone\n";
    const csv = (answer: string) => `step,object,question,answer\n1,obj,Q,${answer}\n`;
    calls.files = {
      "base:telar-content/spreadsheets/project.csv": project,
      "head1:telar-content/spreadsheets/project.csv": project,
      "base:telar-content/spreadsheets/gone.csv": csv("before"),
      "head1:telar-content/spreadsheets/gone.csv": csv("after"),
    };
    calls.trees = {
      base: { "telar-content/spreadsheets": { "project.csv": "p", "gone.csv": "g1" } },
      head1: { "telar-content/spreadsheets": { "project.csv": "p", "gone.csv": "g2" } },
    };

    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", emptyDb(), "base");

    expect(diff.stories.newStories).toEqual([expect.objectContaining({ story_id: "gone", deletedInCompositor: true })]);
    expect(diff.stories.content).toMatchObject({
      conclusive: true,
      changes: [expect.objectContaining({ story_id: "gone", kind: "restore-choice" })],
    });
    expect(diff.hasConflicts).toBe(true);
  });

  it("stays suppressed when its files did not change either", async () => {
    const project = "order,story_id,title\n1,gone,Gone\n";
    calls.files = {
      "base:telar-content/spreadsheets/project.csv": project,
      "head1:telar-content/spreadsheets/project.csv": project,
    };
    calls.trees = {
      base: { "telar-content/spreadsheets": { "project.csv": "p", "gone.csv": "g1" } },
      head1: { "telar-content/spreadsheets": { "project.csv": "p", "gone.csv": "g1" } },
    };
    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", emptyDb(), "base");
    expect(diff.stories.newStories).toEqual([]);
  });
});

describe("the pages' files", () => {
  const PAGES = "telar-content/texts/pages";
  const about = readFileSync(resolve(__dirname, "fixtures/pages/telar/about.md"), "utf8");

  it("are compared at the check's HEAD and base, and listed on the diff", async () => {
    const page = { id: 5, slug: "about", frontmatter_source: null, ...parsePageMarkdown(about, "about") };
    calls.files = {
      [`base:${PAGES}/about.md`]: about,
      [`head1:${PAGES}/about.md`]: about.replace("# About Telar\n", "# About Telar\n\nEdited on GitHub.\n"),
    };
    calls.trees = { base: { [PAGES]: { "about.md": "a1" } }, head1: { [PAGES]: { "about.md": "a2" } } };
    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", dbWithPages([page]), "base");
    expect(diff.pages).toEqual({
      conclusive: true,
      suppressedEditorOnly: 0,
      changes: [expect.objectContaining({ pageId: 5, slug: "about", kind: "github-only", acceptByDefault: true })],
      files: [],
      additions: [],
      record: { commit: "head1", files: { "about.md": 5 } },
    });
    expect(diff.hasConflicts).toBe(false);
    const pageReads = calls.reads.filter((r) => r.path?.startsWith(`${PAGES}/`));
    expect(pageReads.map((r) => r.ref).sort()).toEqual(["base", "head1"]);
  });

  it("takes the record's commit as their base while no head is recorded, so a file unchanged since it is not offered", async () => {
    const page = { id: 5, slug: "about", frontmatter_source: null, ...parsePageMarkdown(about, "about"), body: "Edited here." };
    calls.files = { [`base:${PAGES}/about.md`]: about, [`head1:${PAGES}/about.md`]: about };
    calls.trees = { base: { [PAGES]: { "about.md": "a1" } }, head1: { [PAGES]: { "about.md": "a1" } } };
    const record = JSON.stringify({ commit: "base", files: { "about.md": 5 } });
    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", dbWithPages([page], { record }), null);
    expect(diff.pages).toMatchObject({ conclusive: true, changes: [], files: [], additions: [] });
  });

  it("marks a page conflict among the diff's conflicts", async () => {
    const page = { id: 5, slug: "about", frontmatter_source: null, ...parsePageMarkdown(about, "about"), body: "Edited here." };
    // A base file of the four the diff reads makes the check three-way.
    calls.files = {
      "base:telar-content/spreadsheets/project.csv": "order,story_id,title\n",
      [`base:${PAGES}/about.md`]: about,
      [`head1:${PAGES}/about.md`]: about.replace("# About Telar\n", "# About Telar\n\nEdited on GitHub.\n"),
    };
    calls.trees = { base: { [PAGES]: { "about.md": "a1" } }, head1: { [PAGES]: { "about.md": "a2" } } };
    const diff = await computeFullSyncDiff(1, "tok", "owner", "repo", dbWithPages([page]), "base");
    expect(diff.pages).toMatchObject({ conclusive: true, changes: [expect.objectContaining({ kind: "conflict" })] });
    expect(diff.hasConflicts).toBe(true);
  });
});
