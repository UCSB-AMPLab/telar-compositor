/**
 * The status refresh and a story's step and layer files, decided from trees.
 *
 * `refreshGithubStatus` runs every 45 seconds while the heads differ, so it
 * never reads a file. With a base it compares the two trees under
 * `telar-content/spreadsheets` and `telar-content/texts/stories`; with no base
 * it compares the git blob SHAs of what a publish would commit for each D1
 * story with HEAD's tree. GitHub is the real `github.server` module against a
 * stubbed `fetch`, which fails any Contents or blob request, so the absence of
 * file reads is checked at the network, not inferred from which helpers ran.
 *
 * The file reads the refresh already made before this change, those of
 * `computeFullSyncDiff` for objects, project, config and glossary, are
 * outside it: that module is stood in for here.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Papa from "papaparse";

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
// D1 below answers the story reads only.
vi.mock("~/lib/site-version.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readSiteTelarVersion: vi.fn(async () => "1.8.0"),
}));

import { refreshGithubStatus, deriveHeadDiverged } from "~/lib/github-status.server";
import { renderStoryFiles } from "~/lib/publish.server";
import { gitBlobSha } from "~/lib/story-files.server";
import { importAsD1, storyFixtures } from "./story-canonical-fixtures";
import type { D1Story } from "./story-canonical-fixtures";
import { readableHeadWrite } from "./helpers/head-write";

const NOW = Date.parse("2026-09-26T12:00:00Z");
/** The objects lease a refresh records a head under. */
const LEASE = { env: {} as never, userId: 1 };
const SHEETS = "telar-content/spreadsheets";
const TEXTS = "telar-content/texts/stories";

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
  /** The commits that resolve; by default every commit a test names. */
  commits?: string[];
  /** A "<commit>:<path>" whose field the response leaves out. */
  dropField?: string;
  /** Recursive listings by tree oid. */
  listings: Record<string, Listing>;
  /** File contents the Contents API answers, by path; any other file read fails. */
  files?: Record<string, string>;
}

let repo: Repo;
let fileReads: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const contents = /\/repos\/owner\/repo\/contents\/([^?]+)\?ref=/.exec(url);
  const served = contents ? repo.files?.[decodeURIComponent(contents[1])] : undefined;
  if (served !== undefined) {
    const bytes = new TextEncoder().encode(served);
    return json({ encoding: "base64", content: btoa(String.fromCharCode(...bytes)), size: bytes.length });
  }
  if (/\/contents\/|\/git\/blobs\//.test(url)) {
    fileReads.push(url);
    throw new Error(`file read: ${url}`);
  }
  if (url === "https://api.github.com/graphql") {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    if (/\bBlob\b|\btext\b/.test(query)) {
      fileReads.push(`graphql: ${query}`);
      throw new Error("file read through GraphQL");
    }
    if (query.includes("GetHeadOid")) {
      return json({ data: { repository: { ref: { target: { oid: repo.head } } } } });
    }
    const answer: Record<string, unknown> = {};
    for (const [name, expression] of Object.entries(variables)) {
      if (name === "owner" || name === "repo" || expression === repo.dropField) continue;
      if (!expression.includes(":")) {
        const resolves = (repo.commits ?? ["baseSha", "headSha"]).includes(expression);
        answer[name] = resolves ? { __typename: "Commit" } : null;
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

interface FakeD1 {
  sets: Record<string, unknown>[];
  story: D1Story | null;
  select: () => unknown;
  update: () => unknown;
}

function eqValue(condition: unknown): { column: string; value: unknown } {
  const chunks = (condition as { queryChunks: unknown[] }).queryChunks;
  const column = chunks.find((c) => typeof (c as { name?: unknown }).name === "string" && "columnType" in (c as object)) as { name: string };
  const param = chunks.find((c) => (c as { constructor: { name: string } }).constructor.name === "Param") as { value: unknown };
  return { column: column.name, value: param.value };
}

function makeD1(story: D1Story | null): FakeD1 {
  const db: FakeD1 = {
    sets: [],
    story,
    select: () => {
      let table = "";
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = String((t as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);
        return chain;
      };
      chain.where = (condition: unknown) => {
        const { value } = eqValue(condition);
        const s = db.story;
        if (!s) return Promise.resolve([]);
        if (table === "stories") return Promise.resolve([{ ...s.story, project_id: value }]);
        if (table === "steps") return Promise.resolve(value === s.story.id ? s.stepRows : []);
        if (table === "layers") return Promise.resolve(s.layerRows.filter((l) => l.step_id === value));
        return Promise.resolve([]);
      };
      return chain;
    },
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        db.sets.push(readableHeadWrite(payload));
        return { where: () => Promise.resolve([]) };
      },
    }),
  };
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The demo story with CRLF-free multibyte text (’) in its answers. */
async function demoStory(): Promise<D1Story> {
  return importAsD1(storyFixtures()["allegorical-woman"]);
}

/** A repository whose HEAD holds `files` under the two story subtrees. */
function headWith(files: Array<{ path: string; sha: string }>): Repo {
  const sheets = files.filter((f) => f.path.startsWith(`${SHEETS}/`));
  const texts = files.filter((f) => f.path.startsWith(`${TEXTS}/`));
  return {
    head: "headSha",
    subtrees: { [`headSha:${SHEETS}`]: "sheetsHead", [`headSha:${TEXTS}`]: "textsHead" },
    listings: {
      sheetsHead: {
        truncated: false,
        tree: [blob("project.csv", "p1"), ...sheets.map((f) => blob(f.path.slice(SHEETS.length + 1), f.sha))],
      },
      textsHead: { truncated: false, tree: texts.map((f) => blob(f.path.slice(TEXTS.length + 1), f.sha)) },
    },
  };
}

/** `git hash-object` on each rendered file: the SHAs git itself gives them. */
function gitHashes(files: Array<{ path: string; content: string }>): Array<{ path: string; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tel364-"));
  return files.map((f, i) => {
    const file = join(dir, `f${i}`);
    writeFileSync(file, f.content, "utf8");
    return { path: f.path, sha: execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim() };
  });
}

const baseProject = { id: 7, github_repo_full_name: "owner/repo" };

beforeEach(() => {
  fileReads = [];
  mocks.computeFullSyncDiff.mockReset().mockResolvedValue({ stub: true });
  mocks.hasDivergentChanges.mockReset().mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn(route));
});

afterEach(() => {
  expect(fileReads).toEqual([]);
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The blob SHA
// ---------------------------------------------------------------------------

describe("gitBlobSha", () => {
  it("is the SHA `git hash-object` gives the same bytes, multibyte text included", async () => {
    const story = await demoStory();
    const files = await renderStoryFiles(story.story.story_id, story.stepRows, story.layerRows);
    expect(files.some((f) => /[^\x00-\x7f]/.test(f.content))).toBe(true);
    const expected = gitHashes(files);
    for (const [i, f] of files.entries()) expect(await gitBlobSha(f.content), f.path).toBe(expected[i].sha);
  });

  // printf 'caf\xc3\xa9\n' | git hash-object --stdin
  it("matches a SHA fixed from git", async () => {
    expect(await gitBlobSha("café\n")).toBe("572eb43fe8e34fb87d01c69e01151ff696022924");
  });
});

// ---------------------------------------------------------------------------
// With a base
// ---------------------------------------------------------------------------

describe("with a base, the story files decided from the two trees", () => {
  function withBase(overrides: Partial<Repo> = {}): Repo {
    return {
      head: "headSha",
      subtrees: {
        [`baseSha:${SHEETS}`]: "sheetsBase",
        [`headSha:${SHEETS}`]: "sheetsBase",
        [`baseSha:${TEXTS}`]: "textsBase",
        [`headSha:${TEXTS}`]: "textsBase",
      },
      listings: {
        sheetsBase: {
          truncated: false,
          tree: [blob("project.csv", "p1"), blob("allegorical-woman.csv", "s1"), blob("not-in-d1.csv", "x1")],
        },
        textsBase: { truncated: false, tree: [blob("allegorical-woman-a.md", "l1")] },
      },
      ...overrides,
    };
  }
  const project = { ...baseProject, head_sha: "baseSha" };

  it("marks divergent when a D1 story's step CSV blob changed, with no diff and no head advance", async () => {
    const r = withBase();
    r.subtrees[`headSha:${SHEETS}`] = "sheetsHead";
    r.listings.sheetsHead = {
      truncated: false,
      tree: [blob("project.csv", "p1"), blob("allegorical-woman.csv", "s2"), blob("not-in-d1.csv", "x1")],
    };
    repo = r;
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "baseSha", gh_remote_head_sha: "headSha" });
  });

  it("marks divergent when anything under texts/stories changed", async () => {
    const r = withBase();
    r.subtrees[`headSha:${TEXTS}`] = "textsHead";
    repo = r;
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  // Today's behaviour for a sheet D1 holds no story for: the refresh asks the
  // existing diff, and advances the head when it finds nothing.
  it("compatibility: leaves a change to a CSV no D1 story owns to the existing diff", async () => {
    const r = withBase();
    r.subtrees[`headSha:${SHEETS}`] = "sheetsHead";
    r.listings.sheetsHead = {
      truncated: false,
      tree: [blob("project.csv", "p1"), blob("allegorical-woman.csv", "s1"), blob("not-in-d1.csv", "x2")],
    };
    repo = r;
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).toHaveBeenCalledOnce();
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  it("asks the diff for the head it judged, so the head it records is one the diff read", async () => {
    const r = withBase();
    r.subtrees[`headSha:${SHEETS}`] = "sheetsHead";
    r.listings.sheetsHead = {
      truncated: false,
      tree: [blob("project.csv", "p1"), blob("allegorical-woman.csv", "s1"), blob("not-in-d1.csv", "x2")],
    };
    repo = r;
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    const call = mocks.computeFullSyncDiff.mock.calls[0] as unknown[];
    expect(call[6]).toMatchObject({ headRef: "headSha" });
  });

  it("compatibility: advances the head when nothing under the story subtrees changed and the diff finds nothing", async () => {
    repo = withBase();
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0, gh_diverged_against_sha: "headSha" });
  });

  it("stays divergent and does not advance when a subtree listing comes back truncated", async () => {
    const r = withBase();
    r.subtrees[`headSha:${SHEETS}`] = "sheetsHead";
    // The listing it did return shows the story's CSV unchanged: only the
    // truncation says the answer is not known.
    r.listings.sheetsHead = { truncated: true, tree: r.listings.sheetsBase.tree };
    repo = r;
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("reads the subtrees through their own tree SHAs, never the recursive whole-repository tree", async () => {
    const r = withBase();
    r.subtrees[`headSha:${SHEETS}`] = "sheetsHead";
    r.listings.sheetsHead = r.listings.sheetsBase;
    repo = r;
    await refreshGithubStatus(project, "tok", makeD1(await demoStory()) as never, NOW, LEASE);
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/git/trees/"))).toEqual(
      expect.arrayContaining([expect.stringContaining("/git/trees/sheetsBase"), expect.stringContaining("/git/trees/sheetsHead")]),
    );
    expect(urls.some((u) => /\/git\/trees\/(headSha|baseSha|HEAD)/.test(u))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the trees cannot settle
// ---------------------------------------------------------------------------

describe("with a base, a tree the refresh cannot conclude from", () => {
  const project = { ...baseProject, head_sha: "baseSha" };

  function unchanged(): Repo {
    return {
      head: "headSha",
      subtrees: {
        [`baseSha:${SHEETS}`]: "sheetsSame",
        [`headSha:${SHEETS}`]: "sheetsSame",
        [`baseSha:${TEXTS}`]: "textsSame",
        [`headSha:${TEXTS}`]: "textsSame",
      },
      listings: {
        sheetsSame: { truncated: false, tree: [blob("project.csv", "p1"), blob("allegorical-woman.csv", "s1"), blob("source.csv", "src1")] },
        textsSame: { truncated: false, tree: [blob("allegorical-woman-a.md", "l1")] },
      },
    };
  }

  async function expectInconclusive(r: Repo) {
    repo = r;
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(mocks.computeFullSyncDiff).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "baseSha" });
  }

  // A story CSV links to source.csv, and source.csv is edited. The link's
  // own blob is its target path, unchanged, so only the mode can say.
  it("a story CSV that is a symlink", async () => {
    const r = unchanged();
    r.subtrees[`headSha:${SHEETS}`] = "sheetsHead";
    const link = { path: "allegorical-woman.csv", sha: "s1", type: "blob" as const, mode: "120000" };
    r.listings.sheetsSame.tree[1] = link;
    r.listings.sheetsHead = { truncated: false, tree: [blob("project.csv", "p1"), link, blob("source.csv", "src2")] };
    await expectInconclusive(r);
  });

  // A layer file links outside texts/stories; its target changes while
  // the subtree's own oid does not.
  it("a layer file that is a symlink, with the subtree unchanged", async () => {
    const r = unchanged();
    r.listings.textsSame.tree.push({ path: "allegorical-woman-b.md", sha: "link", type: "blob", mode: "120000" });
    await expectInconclusive(r);
  });

  it("a submodule entry in a story subtree", async () => {
    const r = unchanged();
    r.listings.textsSame.tree.push({ path: "vendor", sha: "c1", type: "commit", mode: "160000" });
    await expectInconclusive(r);
  });

  // Two different symlinks at the subtree path itself were read as two
  // absent trees.
  it("an object at a subtree path that is not a tree", async () => {
    const r = unchanged();
    delete r.subtrees[`baseSha:${TEXTS}`];
    delete r.subtrees[`headSha:${TEXTS}`];
    r.objects = { [`baseSha:${TEXTS}`]: "Blob", [`headSha:${TEXTS}`]: "Blob" };
    await expectInconclusive(r);
  });

  // Compatibility check: 31f58aa7 also marked this divergent, as a change.
  it("compatibility: a subtree present at one commit and absent at the other", async () => {
    const r = unchanged();
    delete r.subtrees[`headSha:${TEXTS}`];
    await expectInconclusive(r);
  });

  it("a base that no longer resolves, with the story CSV missing at HEAD", async () => {
    const r = unchanged();
    r.commits = ["headSha"];
    // HEAD has no story subtrees at all, so the story's CSV is missing there.
    // Read as absent, the unresolved base would look the same, and the two
    // would compare as no change.
    for (const key of Object.keys(r.subtrees)) delete r.subtrees[key];
    await expectInconclusive(r);
  });

  it("a response missing a field it was asked for", async () => {
    const r = unchanged();
    // HEAD has no layer subtree; read as absent, the missing base field would
    // make both sides absent, which is no change.
    delete r.subtrees[`headSha:${TEXTS}`];
    r.dropField = `baseSha:${TEXTS}`;
    await expectInconclusive(r);
  });

  // Listings whose entries fall outside the accepted set.
  it("a blob entry with no mode", async () => {
    const r = unchanged();
    r.listings.textsSame.tree.push({ path: "allegorical-woman-b.md", sha: "l2", type: "blob" } as never);
    await expectInconclusive(r);
  });

  it("a commit entry with no mode", async () => {
    const r = unchanged();
    r.listings.textsSame.tree.push({ path: "vendor", sha: "c1", type: "commit" } as never);
    await expectInconclusive(r);
  });

  it("a listing with no truncated field", async () => {
    const r = unchanged();
    delete (r.listings.textsSame as { truncated?: boolean }).truncated;
    await expectInconclusive(r);
  });

  it("compatibility: a subtree absent at both commits is no change", async () => {
    const r = unchanged();
    delete r.subtrees[`baseSha:${TEXTS}`];
    delete r.subtrees[`headSha:${TEXTS}`];
    repo = r;
    const db = makeD1(await demoStory());
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });
});

// ---------------------------------------------------------------------------
// With no base
// ---------------------------------------------------------------------------

describe("with no base, the rendered story files against HEAD's tree", () => {
  const project = { ...baseProject, head_sha: null };

  async function renderedWithShas() {
    const story = await demoStory();
    const files = await renderStoryFiles(story.story.story_id, story.stepRows, story.layerRows);
    return { story, files, shas: gitHashes(files) };
  }

  it("compatibility: backfills the head when every rendered blob matches", async () => {
    const { story, shas } = await renderedWithShas();
    repo = headWith(shas);
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  // The publish writes a story's CSV in the file's own layout, so a project
  // whose file has another column order holds bytes the plain render does not.
  async function ownLayout(story: D1Story, files: Array<{ path: string; content: string }>) {
    const csv = files[0];
    const table = Papa.parse<string[]>(csv.content).data.map((row) => [...row].reverse());
    const reversed = Papa.unparse(table, { newline: "\n" });
    const published = await renderStoryFiles(story.story.story_id, story.stepRows, story.layerRows, "en", reversed);
    expect(published[0].content).not.toBe(csv.content);
    return published;
  }

  it("backfills when HEAD's step CSV is the render in the file's own column order", async () => {
    const { story, files } = await renderedWithShas();
    const published = await ownLayout(story, files);
    const r = headWith(gitHashes(published));
    r.files = { [published[0].path]: published[0].content };
    repo = r;
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  it("does not backfill when the own-layout CSV differs in content, not only in layout", async () => {
    const { story, files } = await renderedWithShas();
    const published = await ownLayout(story, files);
    const table = Papa.parse<string[]>(published[0].content).data;
    table[2][table[0].indexOf("question")] += " edited at the repository";
    const changed = { path: published[0].path, content: Papa.unparse(table, { newline: "\n" }) };
    expect(changed.content).not.toBe(published[0].content);
    const r = headWith(gitHashes([changed, ...published.slice(1)]));
    r.files = { [changed.path]: changed.content };
    repo = r;
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("does not backfill when the differing step CSV cannot be read", async () => {
    const { story, files } = await renderedWithShas();
    const published = await ownLayout(story, files);
    repo = headWith(gitHashes(published));
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
    // The verdict alone cannot tell a failed read from no read, since the
    // plain render differs from HEAD's blob either way.
    expect(fileReads).toHaveLength(1);
    expect(fileReads[0]).toContain(`/contents/${published[0].path}?ref=headSha`);
    fileReads.length = 0;
  });

  it("compatibility: backfills, as before, when D1 holds no story", async () => {
    repo = headWith([]);
    const db = makeD1(null);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  it.each([
    ["one differing byte", (shas: Array<{ path: string; sha: string }>, files: Array<{ path: string; content: string }>) =>
      shas.map((s, i) => (i === 1 ? gitHashes([{ path: s.path, content: files[i].content + " " }])[0] : s))],
    ["a missing layer file", (shas: Array<{ path: string; sha: string }>) => shas.filter((_, i) => i !== 1)],
    ["a missing step CSV", (shas: Array<{ path: string; sha: string }>) => shas.filter((_, i) => i !== 0)],
  ])("does not backfill with %s, and marks divergent", async (_case, alter) => {
    const { story, files, shas } = await renderedWithShas();
    repo = headWith(alter(shas, files));
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: null, gh_remote_head_sha: "headSha" });
    expect(deriveHeadDiverged(db.sets[0] as never, null)).toBe(true);
  });

  // An extra layer file: one HEAD's step CSV names that the render does not
  // produce. The CSV then differs from the rendered one, which is how it is
  // seen; a stray file no CSV names changes no story.
  it("does not backfill when HEAD's step CSV names an extra layer file", async () => {
    const { story, files, shas } = await renderedWithShas();
    const csv = files[0];
    const extra = `${TEXTS}/allegorical-woman-extra.md`;
    const table = Papa.parse<string[]>(csv.content).data;
    const header = table[0];
    table[2][header.indexOf("layer1_button")] = "More";
    table[2][header.indexOf("layer1_content")] = "allegorical-woman-extra.md";
    const withExtra = Papa.unparse(table, { newline: "\n" });
    expect(withExtra).not.toBe(csv.content);
    const [csvSha] = gitHashes([{ path: csv.path, content: withExtra }]);
    const r = headWith([csvSha, ...shas.slice(1), { path: extra, sha: "e1" }]);
    r.files = { [csv.path]: withExtra };
    repo = r;
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("compatibility: backfills when a stray file no step CSV names sits beside the story's files", async () => {
    const { story, shas } = await renderedWithShas();
    repo = headWith([...shas, { path: `${TEXTS}/allegorical-woman-old-title.md`, sha: "e1" }]);
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).toMatchObject({ head_sha: "headSha", gh_diverged: 0 });
  });

  it("does not backfill when a symlink stands where a rendered file should, with the same blob SHA", async () => {
    const { story, shas } = await renderedWithShas();
    const r = headWith(shas);
    const layerPath = shas[1].path.slice(TEXTS.length + 1);
    const entry = r.listings.textsHead.tree.find((e) => e.path === layerPath)!;
    entry.mode = "120000";
    repo = r;
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("does not backfill when the matching blobs have no mode", async () => {
    const { story, shas } = await renderedWithShas();
    const r = headWith(shas);
    for (const entry of [...r.listings.sheetsHead.tree, ...r.listings.textsHead.tree]) {
      delete (entry as { mode?: string }).mode;
    }
    repo = r;
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("does not backfill when HEAD does not resolve", async () => {
    const { story, shas } = await renderedWithShas();
    const r = headWith(shas);
    r.commits = [];
    repo = r;
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });

  it("stays divergent when a HEAD subtree listing is truncated", async () => {
    const { story, shas } = await renderedWithShas();
    const r = headWith(shas);
    r.listings.textsHead.truncated = true;
    repo = r;
    const db = makeD1(story);
    await refreshGithubStatus(project, "tok", db as never, NOW, LEASE);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1 });
  });
});
