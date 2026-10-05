/**
 * The change check for page files: which pages are read,
 * how each is classified, and that a read that fails holds the check.
 *
 * `checkPageContent` runs against the real `github.server` module and a
 * stubbed `fetch` holding each commit's `telar-content/texts/pages`, so each
 * read is counted at the network. The page files are the template's own
 * (`fixtures/pages/telar/`), and each D1 page is the row the import stores
 * for its file (`parsePageMarkdown`).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkPageContent } from "~/lib/page-content.server";
import type { PageCheckD1Page, PageCheckInput, PageContentCheck } from "~/lib/page-content.server";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
import { parsePageMarkdown } from "~/lib/import.server";
import { pageRowsToCommitFiles } from "~/lib/publish.server";
import { cleanCommitContent } from "~/lib/commit.server";
import { __clearStoryBlobCacheForTest, gitBlobSha } from "~/lib/story-files.server";
import { hasDivergentChanges } from "~/lib/sync.server";
import type { FullSyncDiff } from "~/lib/sync.server";
import type { SheetWarning } from "~/lib/sheet-warnings";

const PAGES = "telar-content/texts/pages";
const FIXTURES = resolve(__dirname, "fixtures/pages");
const ABOUT = readFileSync(resolve(FIXTURES, "telar/about.md"), "utf8");
const ACERCA = readFileSync(resolve(FIXTURES, "telar/acerca.md"), "utf8");

// ---------------------------------------------------------------------------
// A repository of commits, at the network
// ---------------------------------------------------------------------------

interface Repo {
  /** Each commit's pages subtree oid, null when it has none. */
  commits: Record<string, string | null>;
  listings: Record<string, { truncated: boolean; tree: Array<{ path: string; sha: string; type: string; mode: string }> }>;
  /** File text by "<commit>:<path>". */
  files: Record<string, string>;
  /** "<commit>:<path>" reads that fail with a server error. */
  failing: Set<string>;
  /** "<commit>:<path>" files served as these bytes rather than their text's UTF-8. */
  bytes?: Record<string, Uint8Array>;
}

let repo: Repo;
let contentReads: string[];
let requests: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  requests++;
  const url = String(input);
  const parsed = new URL(url);
  const contents = /^\/repos\/owner\/repo\/contents\/(.+)$/.exec(parsed.pathname);
  if (contents) {
    const path = contents[1].split("/").map(decodeURIComponent).join("/");
    const key = `${parsed.searchParams.get("ref")}:${path}`;
    contentReads.push(key);
    if (repo.failing.has(key)) return json({ message: "boom" }, 500);
    const raw = repo.bytes?.[key];
    if (raw) return json({ encoding: "base64", content: Buffer.from(raw).toString("base64"), size: raw.length });
    const text = repo.files[key];
    return text === undefined
      ? json({ message: "Not Found" }, 404)
      : json({ encoding: "base64", content: Buffer.from(text, "utf8").toString("base64"), size: Buffer.byteLength(text, "utf8") });
  }
  if (url === "https://api.github.com/graphql") {
    const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
    const answer: Record<string, unknown> = {};
    for (const [name, expression] of Object.entries(variables)) {
      if (name === "owner" || name === "repo") continue;
      const [commit, path] = expression.split(":");
      const known = Object.hasOwn(repo.commits, commit);
      if (path === undefined) {
        answer[name] = known ? { __typename: "Commit" } : null;
        continue;
      }
      const oid = known && path === PAGES ? repo.commits[commit] : null;
      answer[name] = oid ? { __typename: "Tree", oid } : null;
    }
    return json({ data: { repository: answer } });
  }
  const tree = /\/repos\/owner\/repo\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
  if (tree) {
    const listing = repo.listings[decodeURIComponent(tree[1])];
    return listing ? json({ sha: tree[1], ...listing }) : json({ message: "Not Found" }, 404);
  }
  throw new Error(`unexpected request: ${url}`);
}

/** Adds a commit whose pages folder holds `files`, by path relative to it. */
async function commit(name: string, files: Record<string, string>): Promise<void> {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    repo.commits[name] = null;
    return;
  }
  const tree = [];
  const dirs = new Set<string>();
  for (const [p] of entries) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const d of [...dirs].sort()) tree.push({ path: d, sha: `dir-${d}`, type: "tree", mode: "040000" });
  for (const [p, text] of entries) tree.push({ path: p, sha: await gitBlobSha(text), type: "blob", mode: "100644" });
  const oid = `tree-${await gitBlobSha(JSON.stringify(tree))}`;
  repo.listings[oid] = { truncated: false, tree };
  repo.commits[name] = oid;
  for (const [p, text] of entries) repo.files[`${name}:${PAGES}/${p}`] = text;
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

/** The row the import stores for `file` at `slug`. */
function imported(id: number, slug: string, file: string, overrides: Partial<PageCheckD1Page> = {}): PageCheckD1Page {
  const { title, body, frontmatter } = parsePageMarkdown(file, slug);
  return { id, slug, title, body, frontmatter, frontmatter_source: null, ...overrides };
}

/** What a publish of `page` commits for it. */
async function published(page: PageCheckD1Page, frontmatter = page.frontmatter): Promise<string> {
  const [file] = await pageRowsToCommitFiles([{ ...page, frontmatter }]);
  return cleanCommitContent(file.path, file.content);
}

function input(d1: PageCheckD1Page[], overrides: Partial<PageCheckInput> = {}): PageCheckInput {
  return { token: "tok", owner: "owner", repo: "repo", base: "base", head: "head", d1, ...overrides };
}

function conclusive(check: PageContentCheck) {
  if (!check.conclusive) throw new Error(`inconclusive: ${check.reason}`);
  return check;
}

const editedBody = (file: string, to: string) => file.replace(/^(# [^\n]*\n)/m, `$1\n${to}\n`);

beforeEach(() => {
  __clearStoryBlobCacheForTest();
  repo = { commits: {}, listings: {}, files: {}, failing: new Set() };
  contentReads = [];
  requests = 0;
  vi.stubGlobal("fetch", vi.fn(route));
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// The three classifications
// ---------------------------------------------------------------------------

describe("with a base, each page the Compositor holds", () => {
  it("unchanged on GitHub is neither read nor listed", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": ABOUT, "drafts/notes.md": "changed" });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)])));
    expect(check.changes).toEqual([]);
    expect(check.suppressedEditorOnly).toBe(0);
    expect(contentReads).toEqual([]);
  });

  it("changed on GitHub alone offers GitHub's version, taken by default", async () => {
    const page = imported(4, "about", ABOUT);
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([page])));
    expect(check.changes).toEqual([
      {
        pageId: 4,
        slug: "about",
        title: "About",
        kind: "github-only",
        acceptByDefault: true,
        expected: await pageRawHash(pageContentAsLoaded(page)),
      },
    ]);
  });

  it("changed on GitHub and in the Compositor is a conflict, kept by default", async () => {
    const page = { ...imported(4, "about", ABOUT), body: "Edited in the Compositor." };
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([page])));
    expect(check.changes).toEqual([
      expect.objectContaining({ pageId: 4, kind: "conflict", acceptByDefault: false, expected: await pageRawHash(pageContentAsLoaded(page)) }),
    ]);
  });

  it("changed on GitHub to what the Compositor already holds is nothing", async () => {
    const page = { ...imported(4, "about", ABOUT), title: "About us" };
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": await published(page) });
    const check = conclusive(await checkPageContent(input([page])));
    expect(check.changes).toEqual([]);
    expect(check.suppressedEditorOnly).toBe(0);
  });

  it("changed in the Compositor alone, with GitHub's file only re-encoded, is left out and counted", async () => {
    const page = { ...imported(4, "about", ABOUT), body: "Edited in the Compositor." };
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": `﻿${ABOUT.replace(/\n/g, "\r\n")}` });
    const check = conclusive(await checkPageContent(input([page])));
    expect(check.changes).toEqual([]);
    expect(check.suppressedEditorOnly).toBe(1);
  });

  it("reads each file once per blob, and not again on the next check", async () => {
    const page = imported(4, "about", ABOUT);
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    await checkPageContent(input([page]));
    expect(contentReads.sort()).toEqual([`base:${PAGES}/about.md`, `head:${PAGES}/about.md`]);
    contentReads = [];
    await checkPageContent(input([page]));
    expect(contentReads).toEqual([]);
  });

});

// ---------------------------------------------------------------------------
// A page with no title
// ---------------------------------------------------------------------------

// A publish writes no file for a page whose title is blank, so the
// Compositor's side of it is no file: it differs from the base here, and a
// GitHub edit to its file is a conflict. Left out, the edit would be read as
// nothing, and restoring the title would let publish overwrite it unseen.
describe("a page whose title is blank", () => {
  const blank = () => imported(4, "about", ABOUT, { title: "  " });

  it("is offered as a conflict when GitHub edited its file", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([blank()])));
    expect(check.changes).toEqual([
      expect.objectContaining({ pageId: 4, slug: "about", kind: "conflict", acceptByDefault: false }),
    ]);
  });

  it("is neither read nor offered when GitHub left its file alone", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": ABOUT, "drafts/notes.md": "changed" });
    const check = conclusive(await checkPageContent(input([blank()])));
    expect(check.changes).toEqual([]);
    expect(contentReads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A page never captured
// ---------------------------------------------------------------------------

describe("a page whose block was never captured", () => {
  // A page at `sobre` imported as `acerca`: publish writes `sobre.md` with
  // the block of `acerca.md`, not of `sobre.md`. Here `sobre.md` carries a
  // block of its own, so which file the check carries from decides whether
  // the Compositor changed the page.
  const sobreFile = ACERCA.replace("language: es\n", "language: en\n");
  const sobre = () => imported(9, "sobre", ACERCA, { frontmatter: null, frontmatter_source: "acerca" });

  it("is compared with the block of the file its frontmatter_source names", async () => {
    await commit("base", { "acerca.md": ACERCA, "sobre.md": sobreFile });
    await commit("head", { "acerca.md": ACERCA, "sobre.md": editedBody(sobreFile, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([sobre()])));
    // Carried from acerca.md, the Compositor's sobre.md has `language: es`
    // where the base has `en`: both sides changed it.
    expect(check.changes).toEqual([expect.objectContaining({ pageId: 9, slug: "sobre", kind: "conflict" })]);
    expect(check.changes[0].expected).toBe(await pageRawHash(pageContentAsLoaded(sobre())));
  });

  it("takes its own file's block when the file its source names is absent", async () => {
    await commit("base", { "sobre.md": sobreFile });
    await commit("head", { "sobre.md": editedBody(sobreFile, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([sobre()])));
    expect(check.changes).toEqual([expect.objectContaining({ pageId: 9, kind: "github-only", acceptByDefault: true })]);
  });
});

// ---------------------------------------------------------------------------
// Page files on one side only
// ---------------------------------------------------------------------------

const pageHashOf = async (page: PageCheckD1Page) => pageRawHash(pageContentAsLoaded(page));
const pagesRecord = (files: Record<string, number | null>, at = "base") => ({ commit: at, files });

describe("a page GitHub deleted", () => {
  it("is offered for deletion, taken by default, when the Compositor left it alone", async () => {
    const page = imported(1, "about", ABOUT);
    await commit("base", { "about.md": ABOUT, "acerca.md": ACERCA });
    await commit("head", { "acerca.md": ACERCA });
    const check = conclusive(await checkPageContent(input([page, imported(2, "acerca", ACERCA)])));
    expect(check.changes).toEqual([]);
    expect(check.files).toEqual([{
      name: "about.md", pageId: 1, slug: "about", title: "About", kind: "deleted", acceptByDefault: true,
      expected: await pageHashOf(page),
    }]);
    expect(check.record).toEqual({ commit: "head", files: { "acerca.md": 2 } });
  });

  it("is a conflict, kept by default, when the Compositor edited it", async () => {
    const page = { ...imported(1, "about", ABOUT), body: "Edited in the Compositor." };
    await commit("base", { "about.md": ABOUT });
    await commit("head", {});
    const check = conclusive(await checkPageContent(input([page])));
    expect(check.files).toEqual([expect.objectContaining({ name: "about.md", kind: "deleted-conflict", acceptByDefault: false })]);
  });

  it("with no base and no record, is offered as not on GitHub and kept", async () => {
    await commit("head", { "acerca.md": ACERCA });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT), imported(2, "acerca", ACERCA)], { base: null })));
    expect(check.files).toEqual([expect.objectContaining({ name: "about.md", kind: "not-on-github", acceptByDefault: false })]);
    expect(check.additions).toEqual([]);
  });
});

describe("a page the Compositor holds at a file the base does not have", () => {
  it("added on GitHub too with other content is a conflict, kept by default", async () => {
    await commit("base", {});
    await commit("head", { "about.md": editedBody(ABOUT, "Added on GitHub.") });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)])));
    expect(check.changes).toEqual([expect.objectContaining({ pageId: 1, kind: "conflict", acceptByDefault: false, addedBoth: true })]);
    expect(check.additions).toEqual([]);
  });

  it("added on GitHub too with the same content is nothing", async () => {
    await commit("base", {});
    await commit("head", { "about.md": ABOUT });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)])));
    expect(check.changes).toEqual([]);
    expect(check.record?.files).toEqual({ "about.md": 1 });
  });

  it("absent on GitHub is the Compositor's own addition, left out and counted", async () => {
    await commit("base", { "acerca.md": ACERCA });
    await commit("head", { "acerca.md": ACERCA });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT), imported(2, "acerca", ACERCA)])));
    expect(check.files).toEqual([]);
    expect(check.suppressedEditorOnly).toBe(1);
  });
});

describe("a file the record gives a page the Compositor renamed", () => {
  // The page imported as about.md is at `credits` now.
  const renamed = () => imported(1, "credits", ABOUT);

  it("deleted on GitHub is a conflict, kept by default", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", {});
    const check = conclusive(await checkPageContent(input([renamed()], { record: pagesRecord({ "about.md": 1 }) })));
    expect(check.files).toEqual([expect.objectContaining({ name: "about.md", pageId: 1, slug: "credits", kind: "deleted-renamed-here", acceptByDefault: false })]);
  });

  it("unchanged on GitHub is left out, and recorded for the next publish to delete", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": ABOUT, "drafts/x.md": "x" });
    const check = conclusive(await checkPageContent(input([renamed()], { record: pagesRecord({ "about.md": 1 }) })));
    expect(check.files).toEqual([]);
    expect(check.additions).toEqual([]);
    expect(check.record?.files).toEqual({ "about.md": 1 });
  });

  it("edited on GitHub is a conflict, kept by default", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([renamed()], { record: pagesRecord({ "about.md": 1 }) })));
    expect(check.files).toEqual([expect.objectContaining({ name: "about.md", pageId: 1, kind: "edited-renamed-here", acceptByDefault: false })]);
    expect(check.record?.files).toEqual({ "about.md": 1 });
  });

  it("with no record, an edit on GitHub after a rename here reads as an addition", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([renamed()])));
    expect(check.files).toEqual([]);
    expect(check.additions).toEqual([expect.objectContaining({ name: "about.md", slug: "about", title: "About" })]);
  });
});

describe("a file the record gives a page the Compositor deleted", () => {
  it("unchanged on GitHub is left out", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": ABOUT, "drafts/x.md": "x" });
    const check = conclusive(await checkPageContent(input([], { record: pagesRecord({ "about.md": 7 }) })));
    expect([check.files, check.additions]).toEqual([[], []]);
    expect(check.record?.files).toEqual({ "about.md": 7 });
  });

  it("edited on GitHub is offered for restoring, kept deleted by default", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([], { record: pagesRecord({ "about.md": 7 }) })));
    expect(check.files).toEqual([{
      name: "about.md", pageId: 7, slug: "about", title: "About", kind: "deleted-here-edited", acceptByDefault: false, expected: "",
    }]);
  });
});

describe("a file the record holds with no page", () => {
  it.each([["unchanged", ABOUT], ["edited on GitHub", editedBody(ABOUT, "Edited on GitHub.")]])("%s is nothing", async (_label, file) => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": file, "drafts/x.md": "x" });
    const check = conclusive(await checkPageContent(input([], { record: pagesRecord({ "about.md": null }) })));
    expect([check.files, check.additions]).toEqual([[], []]);
    expect(check.record?.files).toEqual({ "about.md": null });
  });
});

describe("a page GitHub added", () => {
  it("is taken, with the title of its file, and recorded with no page until an accept maps it", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": ABOUT, "acerca.md": ACERCA });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)], { record: pagesRecord({ "about.md": 1 }) })));
    expect(check.additions).toEqual([{ name: "acerca.md", slug: "acerca", title: "Acerca de Telar", frontmatter: expect.any(String) }]);
    expect(check.record).toEqual({ commit: "head", files: { "about.md": 1, "acerca.md": null } });
  });

  it("is taken when it was at the base too but the record does not list it, as a file the upgrade wrote", async () => {
    await commit("base", { "about.md": ABOUT, "acerca.md": ACERCA });
    await commit("head", { "about.md": ABOUT, "acerca.md": ACERCA });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)], { record: pagesRecord({ "about.md": 1 }) })));
    expect(check.additions?.map((a) => a.name)).toEqual(["acerca.md"]);
  });

  it("is taken with no base and no record", async () => {
    await commit("head", { "about.md": ABOUT, "acerca.md": ACERCA });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)], { base: null })));
    expect(check.additions?.map((a) => a.name)).toEqual(["acerca.md"]);
  });

  it("is read when the Compositor holds no page", async () => {
    await commit("base", {});
    await commit("head", { "about.md": ABOUT });
    const check = conclusive(await checkPageContent(input([])));
    expect(check.additions?.map((a) => a.name)).toEqual(["about.md"]);
    expect(requests).toBeGreaterThan(0);
  });

  it("is not a page with a blank title GitHub holds a file for", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT, { title: "" })])));
    expect(check.additions).toEqual([]);
    expect(check.changes).toEqual([expect.objectContaining({ pageId: 1, kind: "conflict" })]);
  });

  it("is never a file in a subfolder or one that is not .md, added or removed", async () => {
    await commit("base", { "about.md": ABOUT, ".gitkeep": "", "drafts/old.md": ABOUT });
    await commit("head", { "about.md": ABOUT, "notes.txt": "x", "drafts/new.md": ACERCA });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)], { record: pagesRecord({ "about.md": 1 }) })));
    expect([check.files, check.additions]).toEqual([[], []]);
    expect(check.record?.files).toEqual({ "about.md": 1 });
  });

  it("whose bytes are not valid UTF-8 is named, not taken, and not recorded", async () => {
    const lossy = editedBody(ACERCA, "Editado�");
    await commit("base", {});
    await commit("head", { "acerca.md": lossy });
    repo.bytes = { [`head:${PAGES}/acerca.md`]: Uint8Array.from(Buffer.from(lossy.replace("�", "\u0000"), "utf8").map((b) => (b === 0 ? 0xff : b))) };
    const unreadable: SheetWarning[] = [];
    const check = conclusive(await checkPageContent(input([], { unreadable })));
    expect(check.additions).toEqual([]);
    expect(check.record?.files).toEqual({});
    expect(unreadable).toEqual([expect.objectContaining({ code: "unreadable_characters", file: `${PAGES}/acerca.md` })]);
  });
});

describe("the old file of a page renamed or deleted here over no record", () => {
  it.each([["unchanged", ABOUT], ["edited on GitHub since", editedBody(ABOUT, "Edited on GitHub.")]])(
    "is not taken when the last publish named it, %s, and is recorded with no page",
    async (_label, file) => {
      await commit("base", { "about.md": ABOUT });
      await commit("head", { "about.md": file, "acerca.md": ACERCA });
      const check = conclusive(await checkPageContent(input([], { publishedSlugs: ["about"] })));
      expect(check.additions?.map((a) => a.name)).toEqual(["acerca.md"]);
      expect(check.record?.files).toEqual({ "about.md": null, "acerca.md": null });
    },
  );

  it("is taken when there is a record, whatever the snapshot names", async () => {
    await commit("base", {});
    await commit("head", { "about.md": ABOUT });
    const check = conclusive(await checkPageContent(input([], { publishedSlugs: ["about"], record: pagesRecord({}) })));
    expect(check.additions?.map((a) => a.name)).toEqual(["about.md"]);
  });
});

// ---------------------------------------------------------------------------
// Reads that fail
// ---------------------------------------------------------------------------

describe("a read that fails holds the check rather than reading as no change", () => {
  const changed = async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
  };

  it("the file at HEAD", async () => {
    await changed();
    repo.failing.add(`head:${PAGES}/about.md`);
    const check = await checkPageContent(input([imported(1, "about", ABOUT)]));
    expect(check.conclusive).toBe(false);
  });

  it("the file at the base", async () => {
    await changed();
    repo.failing.add(`base:${PAGES}/about.md`);
    expect((await checkPageContent(input([imported(1, "about", ABOUT)]))).conclusive).toBe(false);
  });

  it("the file a page never captured is carried from", async () => {
    const sobreFile = ACERCA.replace("language: es\n", "language: en\n");
    await commit("base", { "acerca.md": ACERCA, "sobre.md": sobreFile });
    await commit("head", { "acerca.md": ACERCA, "sobre.md": editedBody(sobreFile, "Edited on GitHub.") });
    repo.failing.add(`head:${PAGES}/acerca.md`);
    const page = imported(9, "sobre", ACERCA, { frontmatter: null, frontmatter_source: "acerca" });
    expect((await checkPageContent(input([page]))).conclusive).toBe(false);
  });

  it("a listing that comes back truncated", async () => {
    await changed();
    repo.listings[repo.commits.head!].truncated = true;
    expect((await checkPageContent(input([imported(1, "about", ABOUT)]))).conclusive).toBe(false);
  });

  it("a base that does not resolve", async () => {
    await changed();
    delete repo.commits.base;
    expect((await checkPageContent(input([imported(1, "about", ABOUT)]))).conclusive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// With no base
// ---------------------------------------------------------------------------

describe("with no base", () => {
  it("offers any difference as a conflict, kept by default", async () => {
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)], { base: null })));
    expect(check.changes).toEqual([expect.objectContaining({ pageId: 1, kind: "conflict", acceptByDefault: false })]);
  });

  it("offers nothing for a page GitHub holds as the Compositor would publish it", async () => {
    await commit("head", { "about.md": ABOUT });
    const check = conclusive(await checkPageContent(input([imported(1, "about", ABOUT)], { base: null })));
    expect(check.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A page file whose bytes are not valid UTF-8
// ---------------------------------------------------------------------------

describe("a page file read lossily at HEAD", () => {
  const R = "\uFFFD";
  const LOSSY = editedBody(ABOUT, `Edited on GitHub${R}`);

  /** `text` as UTF-8, with every U+FFFD written as the invalid byte FF. */
  function invalidBytes(text: string): Uint8Array {
    return Uint8Array.from(Buffer.from(text.split(R).join("\u0000"), "utf8").map((b) => (b === 0 ? 0xff : b)));
  }

  function serveLossy(commitName: string, name: string, text: string) {
    repo.bytes = { ...(repo.bytes ?? {}), [`${commitName}:${PAGES}/${name}`]: invalidBytes(text) };
  }

  const unreadable = (warnings: SheetWarning[]) => warnings.filter((w) => w.code === "unreadable_characters");

  it("is named by its path when it changed", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": LOSSY });
    serveLossy("head", "about.md", LOSSY);
    const warnings: SheetWarning[] = [];
    await checkPageContent(input([imported(4, "about", ABOUT)], { warnings }));
    expect(unreadable(warnings)).toEqual([
      { code: "unreadable_characters", file: `${PAGES}/about.md`, effect: "build_stops", repair: "publish" },
    ]);
  });

  it("says to give a page with a blank title a title first", async () => {
    await commit("base", { "about.md": ABOUT });
    await commit("head", { "about.md": LOSSY });
    serveLossy("head", "about.md", LOSSY);
    const warnings: SheetWarning[] = [];
    await checkPageContent(input([imported(4, "about", ABOUT, { title: "  " })], { warnings }));
    expect(unreadable(warnings)).toEqual([
      { code: "unreadable_characters", file: `${PAGES}/about.md`, effect: "build_stops", repair: "title_then_publish" },
    ]);
  });

  it("names the file a page never captured is carried from", async () => {
    const carried = "acerca.md";
    const page = imported(4, "about", ABOUT, { frontmatter: null, frontmatter_source: "acerca" });
    const lossyCarried = editedBody(ACERCA, `Editado${R}`);
    await commit("base", { "about.md": ABOUT, [carried]: ACERCA });
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub."), [carried]: lossyCarried });
    serveLossy("head", carried, lossyCarried);
    const warnings: SheetWarning[] = [];
    await checkPageContent(input([page], { warnings }));
    expect(unreadable(warnings)).toEqual([
      { code: "unreadable_characters", file: `${PAGES}/${carried}`, effect: "build_stops", repair: "publish" },
    ]);
  });

  it("is not named when lossy only at the base", async () => {
    await commit("base", { "about.md": LOSSY });
    serveLossy("base", "about.md", LOSSY);
    await commit("head", { "about.md": editedBody(ABOUT, "Edited on GitHub.") });
    const warnings: SheetWarning[] = [];
    await checkPageContent(input([imported(4, "about", ABOUT)], { warnings }));
    expect(contentReads).toContain(`base:${PAGES}/about.md`);
    expect(unreadable(warnings)).toEqual([]);
  });

  it("is neither read nor named when its blob is unchanged since the base", async () => {
    await commit("base", { "about.md": LOSSY });
    await commit("head", { "about.md": LOSSY, "drafts/notes.md": "changed" });
    serveLossy("base", "about.md", LOSSY);
    serveLossy("head", "about.md", LOSSY);
    const warnings: SheetWarning[] = [];
    await checkPageContent(input([imported(4, "about", ABOUT)], { warnings }));
    expect(contentReads).toEqual([]);
    expect(unreadable(warnings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

describe("hasDivergentChanges counts the pages", () => {
  const diff = (pages: PageContentCheck | undefined) =>
    ({
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
      stories: { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, changes: [], suppressedEditorOnly: 0 } },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], changed: [], removed: [] },
      hasConflicts: false,
      classification: "three-way",
      suppressedEditorOnly: 0,
      unreadableFiles: [],
      ...(pages ? { pages } : {}),
    }) as unknown as FullSyncDiff;

  it("a page change is divergent", () => {
    expect(hasDivergentChanges(diff({
      conclusive: true, suppressedEditorOnly: 0,
      changes: [{ pageId: 1, slug: "about", title: "About", kind: "github-only", acceptByDefault: true, expected: "h" }],
    }))).toBe(true);
  });

  it("an inconclusive page check is divergent", () => {
    expect(hasDivergentChanges(diff({ conclusive: false, reason: "the page tree came back truncated" }))).toBe(true);
  });

  it("a page file on one side only, or a page GitHub added, is divergent", () => {
    const deleted = { name: "about.md", pageId: 1, slug: "about", title: "About", kind: "deleted" as const, acceptByDefault: true, expected: "h" };
    expect(hasDivergentChanges(diff({ conclusive: true, changes: [], suppressedEditorOnly: 0, files: [deleted] }))).toBe(true);
    expect(hasDivergentChanges(diff({
      conclusive: true, changes: [], suppressedEditorOnly: 0, additions: [{ name: "acerca.md", slug: "acerca", title: "Acerca" }],
    }))).toBe(true);
  });

  it("a concluded check with nothing to offer is not", () => {
    expect(hasDivergentChanges(diff({ conclusive: true, changes: [], suppressedEditorOnly: 2 }))).toBe(false);
  });
});
