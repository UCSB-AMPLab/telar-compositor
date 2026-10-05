/**
 * The status refresh and the page files, decided from trees.
 *
 * With a base, the refresh reads `telar-content/texts/pages` as a subtree at
 * both commits: a blob change to `<slug>.md` of a page the Compositor holds
 * marks the site divergent, and a tree it cannot read is divergent too. With
 * no base, it compares the git blob SHA of what a publish would commit for
 * each page with HEAD's tree. GitHub is the real `github.server` module
 * against a stubbed `fetch`, so every read is counted at the network. The
 * rest of the refresh's diff, `computeFullSyncDiff`, is stood in for, as in
 * tests/github-status-story-files.test.ts.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  computeFullSyncDiff: vi.fn(),
  hasDivergentChanges: vi.fn(),
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: mocks.computeFullSyncDiff,
  hasDivergentChanges: mocks.hasDivergentChanges,
}));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
// The objects lease is free and D1's compared rows are as the verdict read
// them; tests/github-status-record-lease.test.ts covers the other cases.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "refresh-lease"),
}));
vi.mock("~/lib/synced-rows-fingerprint.server", () => ({ syncedRowsFingerprint: vi.fn(async () => "as-compared") }));
// The site's framework version, which the diff matches objects by; the fake
// D1 below answers the page reads only.
vi.mock("~/lib/site-version.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readSiteTelarVersion: vi.fn(async () => "1.8.0"),
}));

import { refreshGithubStatus, deriveHeadDiverged } from "~/lib/github-status.server";
import { __clearStoryBlobCacheForTest, gitBlobSha } from "~/lib/story-files.server";
import { parsePageMarkdown } from "~/lib/import.server";
import { readableHeadWrite } from "./helpers/head-write";

const NOW = Date.parse("2026-09-28T12:00:00Z");
/** The objects lease a refresh records a head under. */
const LEASE = { env: {} as never, userId: 1 };
const PAGES = "telar-content/texts/pages";
const FIXTURES = resolve(__dirname, "fixtures/pages");
const ABOUT = readFileSync(resolve(FIXTURES, "telar/about.md"), "utf8");
const ACERCA = readFileSync(resolve(FIXTURES, "telar/acerca.md"), "utf8");

// ---------------------------------------------------------------------------
// GitHub, at the network
// ---------------------------------------------------------------------------

interface Listing {
  tree: Array<{ path: string; sha: string; type: "blob" | "tree" | "commit"; mode: string }>;
  truncated: boolean;
}

interface Repo {
  head: string;
  /** Subtree oids by "<commit>:<path>"; absent means no object there. */
  subtrees: Record<string, string>;
  /** Objects at "<commit>:<path>" that are not trees, by their GraphQL type. */
  objects?: Record<string, string>;
  /** Recursive listings by tree oid. */
  listings: Record<string, Listing>;
  /** File text by "<commit>:<path>". */
  files: Record<string, string>;
  /** "<commit>:<path>" reads that fail with a server error. */
  failing: Set<string>;
}

let repo: Repo;
let fileReads: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const parsed = new URL(url);
  const contents = /^\/repos\/owner\/repo\/contents\/(.+)$/.exec(parsed.pathname);
  if (contents) {
    const key = `${parsed.searchParams.get("ref")}:${contents[1].split("/").map(decodeURIComponent).join("/")}`;
    fileReads.push(key);
    if (repo.failing.has(key)) return json({ message: "boom" }, 500);
    const text = repo.files[key];
    return text === undefined
      ? json({ message: "Not Found" }, 404)
      : json({ encoding: "base64", content: Buffer.from(text, "utf8").toString("base64"), size: Buffer.byteLength(text, "utf8") });
  }
  if (url === "https://api.github.com/graphql") {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
    if (query.includes("GetHeadOid")) {
      return json({ data: { repository: { ref: { target: { oid: repo.head } } } } });
    }
    const answer: Record<string, unknown> = {};
    for (const [name, expression] of Object.entries(variables)) {
      if (name === "owner" || name === "repo") continue;
      if (!expression.includes(":")) {
        answer[name] = ["baseSha", "headSha"].includes(expression) ? { __typename: "Commit" } : null;
        continue;
      }
      const oid = repo.subtrees[expression];
      const other = repo.objects?.[expression];
      answer[name] = oid ? { __typename: "Tree", oid } : other ? { __typename: other } : null;
    }
    return json({ data: { repository: answer } });
  }
  const tree = /\/repos\/owner\/repo\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
  if (tree) {
    const listing = repo.listings[decodeURIComponent(tree[1])];
    return listing ? json({ sha: tree[1], ...listing }) : json({ message: "Not Found" }, 404);
  }
  if (url === "https://api.github.com/repos/owner/repo") return json({ full_name: "owner/repo" });
  throw new Error(`unexpected request: ${url}`);
}

function blob(path: string, sha: string) {
  return { path, sha, type: "blob" as const, mode: "100644" };
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

interface PageRow {
  id: number;
  slug: string;
  title: string;
  body: string;
  frontmatter: string | null;
  frontmatter_source: string | null;
}

function makeD1(pages: PageRow[]) {
  const sets: Record<string, unknown>[] = [];
  return {
    sets,
    select: () => {
      let table = "";
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = String((t as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);
        return chain;
      };
      chain.where = () => Promise.resolve(table === "project_pages" ? pages : []);
      return chain;
    },
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        sets.push(readableHeadWrite(payload));
        return { where: () => Promise.resolve([]) };
      },
    }),
  };
}

function imported(id: number, slug: string, file: string, overrides: Partial<PageRow> = {}): PageRow {
  return { id, slug, frontmatter_source: null, ...parsePageMarkdown(file, slug), ...overrides };
}

const edited = (file: string) => file.replace("# About Telar\n", "# About Telar\n\nEdited on GitHub.\n");

beforeEach(() => {
  __clearStoryBlobCacheForTest();
  fileReads = [];
  mocks.computeFullSyncDiff.mockReset().mockResolvedValue({ stub: true });
  mocks.hasDivergentChanges.mockReset().mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn(route));
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// With a base
// ---------------------------------------------------------------------------

describe("with a base, the page files decided from the two trees", () => {
  const project = { id: 7, github_repo_full_name: "owner/repo", head_sha: "baseSha" };

  async function withBase(baseFiles: Record<string, string>, headFiles: Record<string, string>): Promise<Repo> {
    const listing = async (files: Record<string, string>): Promise<Listing> => ({
      truncated: false,
      tree: [
        ...(Object.keys(files).some((p) => p.startsWith("drafts/")) ? [{ path: "drafts", sha: "d", type: "tree" as const, mode: "040000" }] : []),
        ...(await Promise.all(Object.entries(files).map(async ([p, text]) => blob(p, await gitBlobSha(text))))),
      ],
    });
    return {
      head: "headSha",
      subtrees: { [`baseSha:${PAGES}`]: "pagesBase", [`headSha:${PAGES}`]: "pagesHead" },
      listings: { pagesBase: await listing(baseFiles), pagesHead: await listing(headFiles) },
      files: {},
      failing: new Set(),
    };
  }

  it("marks divergent when a page the Compositor holds changed, with no diff, no file read and no head advance", async () => {
    repo = await withBase({ "about.md": ABOUT }, { "about.md": edited(ABOUT) });
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "baseSha", gh_remote_head_sha: "headSha" });
    expect(fileReads).toEqual([]);
  });

  it("leaves a change to a file in a subfolder to the existing diff", async () => {
    repo = await withBase(
      { "about.md": ABOUT, "drafts/about.md": ABOUT },
      { "about.md": ABOUT, "drafts/about.md": edited(ABOUT) },
    );
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).toHaveBeenCalledOnce();
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  it("leaves a change to a page the Compositor does not hold to the existing diff", async () => {
    repo = await withBase({ "about.md": ABOUT, "acerca.md": ACERCA }, { "about.md": ABOUT, "acerca.md": `${ACERCA}\n` });
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).toHaveBeenCalledOnce();
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  it("marks divergent when GitHub edited the file of a page whose title is blank", async () => {
    repo = await withBase({ "about.md": ABOUT }, { "about.md": edited(ABOUT) });
    const db = makeD1([imported(1, "about", ABOUT, { title: "" })]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "baseSha" });
  });

  it("leaves a page whose title is blank to the existing diff when GitHub left its file alone", async () => {
    // The folder changes only below it, which the framework does not build.
    repo = await withBase({ "about.md": ABOUT }, { "about.md": ABOUT, "drafts/acerca.md": ACERCA });
    const db = makeD1([imported(1, "about", ABOUT, { title: "" })]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).toHaveBeenCalledOnce();
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  it("stays divergent when the pages listing comes back truncated", async () => {
    repo = await withBase({ "about.md": ABOUT }, { "about.md": ABOUT });
    repo.listings.pagesHead.truncated = true;
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("stays divergent when something other than a tree stands at the pages path", async () => {
    repo = await withBase({ "about.md": ABOUT }, { "about.md": ABOUT });
    delete repo.subtrees[`headSha:${PAGES}`];
    repo.objects = { [`headSha:${PAGES}`]: "Blob" };
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });
});

// ---------------------------------------------------------------------------
// With no base
// ---------------------------------------------------------------------------

describe("with a base, a page file added or removed", () => {
  const project = { id: 7, github_repo_full_name: "owner/repo", head_sha: "baseSha" };
  const folder = async (files: Record<string, string>): Promise<Listing> => ({
    truncated: false,
    tree: [
      ...(Object.keys(files).some((p) => p.startsWith("drafts/")) ? [{ path: "drafts", sha: "d", type: "tree" as const, mode: "040000" }] : []),
      ...(await Promise.all(Object.entries(files).map(async ([p, text]) => blob(p, await gitBlobSha(text))))),
    ],
  });
  async function pagesBetween(baseFiles: Record<string, string>, headFiles: Record<string, string>): Promise<Repo> {
    return {
      head: "headSha",
      subtrees: { [`baseSha:${PAGES}`]: "pagesBase", [`headSha:${PAGES}`]: "pagesHead" },
      listings: { pagesBase: await folder(baseFiles), pagesHead: await folder(headFiles) },
      files: {},
      failing: new Set(),
    };
  }

  it("marks divergent a file added directly in the folder, for a project holding no page", async () => {
    repo = await pagesBetween({}, { "acerca.md": ACERCA });
    const db = makeD1([]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "baseSha" });
  });

  it("marks divergent a held page's file GitHub removed", async () => {
    repo = await pagesBetween({ "about.md": ABOUT, "acerca.md": ACERCA }, { "acerca.md": ACERCA });
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("leaves a file added in a subfolder to the existing diff", async () => {
    repo = await pagesBetween({ "about.md": ABOUT }, { "about.md": ABOUT, "drafts/acerca.md": ACERCA });
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).toHaveBeenCalledOnce();
  });

  it("writes the record the diff's check gives with the silent bump, while the head is the one loaded", async () => {
    repo = await pagesBetween({ "about.md": ABOUT }, { "about.md": ABOUT, "drafts/acerca.md": ACERCA });
    mocks.computeFullSyncDiff.mockResolvedValue({
      pages: { conclusive: true, changes: [], suppressedEditorOnly: 0, record: { commit: "headSha", files: { "about.md": 1 } } },
    });
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({
      head_sha: "headSha",
      page_files_json: JSON.stringify({ commit: "headSha", files: { "about.md": 1 } }),
      page_files_json_while_head: "baseSha",
    });
  });
});

describe("with no base, the rendered page files against HEAD's tree", () => {
  const project = { id: 7, github_repo_full_name: "owner/repo", head_sha: null };

  async function headWith(files: Record<string, string>): Promise<Repo> {
    return {
      head: "headSha",
      subtrees: { [`headSha:${PAGES}`]: "pagesHead" },
      listings: {
        pagesHead: {
          truncated: false,
          tree: await Promise.all(Object.entries(files).map(async ([p, text]) => blob(p, await gitBlobSha(text)))),
        },
      },
      files: Object.fromEntries(Object.entries(files).map(([p, text]) => [`headSha:${PAGES}/${p}`, text])),
      failing: new Set(),
    };
  }

  it("backfills the head when every rendered page's blob matches, reading no file for a captured page", async () => {
    repo = await headWith({ "about.md": ABOUT });
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
    expect(fileReads).toEqual([]);
  });

  it("does not backfill when one rendered page differs by a byte, and marks divergent", async () => {
    repo = await headWith({ "about.md": `${ABOUT} `, "acerca.md": ACERCA });
    const db = makeD1([imported(1, "about", ABOUT), imported(2, "acerca", ACERCA)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: null });
    expect(deriveHeadDiverged(db.sets[0] as never, null)).toBe(true);
  });

  it("does not backfill over a page whose title is blank, which a publish writes no file for", async () => {
    repo = await headWith({ "about.md": ABOUT });
    const db = makeD1([imported(1, "about", ABOUT, { title: "" })]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: null });
  });

  it("does not backfill when HEAD holds a file no page holds, for a project holding no page too", async () => {
    repo = await headWith({ "about.md": ABOUT });
    const db = makeD1([]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("writes the held pages' files as the record with the backfill", async () => {
    repo = await headWith({ "about.md": ABOUT });
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({
      head_sha: "headSha",
      page_files_json: JSON.stringify({ commit: "headSha", files: { "about.md": 1 } }),
      page_files_json_while_head: null,
    });
  });

  it("does not backfill when a page's file is missing from HEAD", async () => {
    repo = await headWith({ "acerca.md": ACERCA });
    const db = makeD1([imported(1, "about", ABOUT), imported(2, "acerca", ACERCA)]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("renders a page never captured with the block of the file publish carries it from", async () => {
    // `sobre` imported as `about`: a publish writes sobre.md with about.md's
    // block, so HEAD holding exactly that matches. `about` is held too: a
    // file no page holds is an addition, and no match.
    repo = await headWith({ "about.md": ABOUT, "sobre.md": ABOUT });
    const sobre = imported(3, "sobre", ABOUT, { frontmatter: null, frontmatter_source: "about" });
    const db = makeD1([imported(1, "about", ABOUT), sobre]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
    expect(fileReads).toEqual([`headSha:${PAGES}/sobre.md`]);
  });

  it("does not backfill when the carried file cannot be read", async () => {
    repo = await headWith({ "acerca.md": ACERCA, "sobre.md": ACERCA });
    repo.failing.add(`headSha:${PAGES}/acerca.md`);
    const db = makeD1([imported(3, "sobre", ACERCA, { frontmatter: null, frontmatter_source: "acerca" })]);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });
});

describe("a pair of page files the project holds, which the one-language reduction would change", () => {
  const same = { id: 7, github_repo_full_name: "owner/repo", head_sha: "headSha" };
  const apart = { ...same, head_sha: "baseSha" };
  const noBlocks = { frontmatter: null };

  async function pagesAt(files: Record<string, string>, commits: string[]): Promise<Repo> {
    const tree = await Promise.all(Object.entries(files).map(async ([p, text]) => blob(p, await gitBlobSha(text))));
    return {
      head: "headSha",
      subtrees: Object.fromEntries(commits.map((c) => [`${c}:${PAGES}`, "pages"])),
      listings: { pages: { truncated: false, tree } },
      files: Object.fromEntries(commits.flatMap((c) => Object.entries(files).map(([p, text]) => [`${c}:${PAGES}/${p}`, text]))),
      failing: new Set(),
    };
  }

  it("reports the pages as changed when GitHub has not moved, from D1's blocks, reading nothing", async () => {
    repo = await pagesAt({ "about.md": ABOUT, "acerca.md": ACERCA }, ["headSha"]);
    const db = makeD1([imported(1, "about", ABOUT), imported(2, "acerca", ACERCA)]);
    await refreshGithubStatus(same, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "headSha" });
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(fileReads).toEqual([]);
  });

  it("reads the file of a page whose block D1 does not hold, and reports the pages as changed", async () => {
    repo = await pagesAt({ "about.md": ABOUT, "acerca.md": ACERCA }, ["headSha"]);
    const db = makeD1([imported(1, "about", ABOUT, noBlocks), imported(2, "acerca", ACERCA, noBlocks)]);
    await refreshGithubStatus(same, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "headSha" });
    expect(fileReads).toContain(`headSha:${PAGES}/acerca.md`);
  });

  it("reports the pages as changed with no base, instead of backfilling the head over a pair", async () => {
    repo = await pagesAt({ "about.md": ABOUT, "acerca.md": ACERCA }, ["headSha"]);
    const db = makeD1([imported(1, "about", ABOUT), imported(2, "acerca", ACERCA)]);
    await refreshGithubStatus({ ...same, head_sha: null }, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: null });
  });

  it("reports the pages as changed when a block it must read from GitHub cannot be read", async () => {
    repo = await pagesAt({ "about.md": ABOUT, "acerca.md": ACERCA }, ["headSha"]);
    repo.failing.add(`headSha:${PAGES}/acerca.md`);
    const db = makeD1([imported(1, "about", ABOUT, noBlocks), imported(2, "acerca", ACERCA, noBlocks)]);
    await refreshGithubStatus(same, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "headSha" });
  });

  it("leaves the site unchanged when it holds no pair, as when GitHub has not moved", async () => {
    repo = await pagesAt({ "about.md": ABOUT }, ["headSha"]);
    const db = makeD1([imported(1, "about", ABOUT)]);
    await refreshGithubStatus(same, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ gh_diverged: 0, gh_diverged_against_sha: "headSha" });
    expect(fileReads).toEqual([]);
  });

  it("reports the pages as changed when the heads differ and no page file did, without the diff", async () => {
    repo = await pagesAt({ "about.md": ABOUT, "acerca.md": ACERCA }, ["baseSha", "headSha"]);
    const db = makeD1([imported(1, "about", ABOUT), imported(2, "acerca", ACERCA)]);
    await refreshGithubStatus(apart, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "baseSha" });
  });
});
