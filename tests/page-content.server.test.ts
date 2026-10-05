/**
 * The compare form of a page file.
 *
 * The fixtures are every page file this project owns (`fixtures/pages/NOTES.md`
 * names their sources). A page is imported through `scanRepoPages` with the
 * repository reads replaced by the fixture's bytes, so the row is the one the
 * import stores; the rest is what a publish of that row commits.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as github from "~/lib/github.server";
import { scanRepoPages } from "~/lib/import.server";
import { pageRowsToCommitFiles } from "~/lib/publish.server";
import { cleanCommitContent } from "~/lib/commit.server";
import { capturedFrontmatter } from "~/lib/page-frontmatter.server";
import {
  compositorPageFile,
  githubPageFile,
  pageDiffersFromGitHub,
} from "~/lib/page-content.server";
import type { ComparablePage } from "~/lib/page-content.server";

vi.mock("~/lib/github.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/github.server")>()),
  getRepoTree: vi.fn(),
  getFileAtRef: vi.fn(),
}));

const FIXTURES = resolve(__dirname, "fixtures/pages");

const REAL_PAGES = [
  "telar/about.md",
  "telar/acerca.md",
  "framework/about.md",
  "framework/acerca.md",
  "framework/image-fixture.md",
] as const;

function fixture(path: string): string {
  return readFileSync(resolve(FIXTURES, path), "utf8");
}

function slugOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** The row the import stores for `file` as `<slug>.md`, read as `scanRepoPages` reads it. */
async function imported(file: string, slug: string): Promise<ComparablePage> {
  const path = `telar-content/texts/pages/${slug}.md`;
  vi.mocked(github.getRepoTree).mockResolvedValue({
    tree: [{ path, type: "blob", mode: "100644", sha: "0" }] as never,
    truncated: false,
  });
  vi.mocked(github.getFileAtRef).mockResolvedValue({ status: "ok", content: file });
  const [page] = await scanRepoPages("token", "owner", "repo", "head");
  return { slug: page.slug, title: page.title, body: page.body, frontmatter: page.frontmatter };
}

/** What a publish of `page` commits, as the commit encodes it. */
async function published(page: ComparablePage): Promise<string> {
  const [file] = await pageRowsToCommitFiles([page]);
  return cleanCommitContent(file.path, file.content);
}

/** Each character of `text` between `from` and `to` replaced, one at a time. */
function eachByteChanged(text: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(text.slice(0, i) + (text[i] === "x" ? "y" : "x") + text.slice(i + 1));
  return out;
}

beforeEach(() => {
  vi.mocked(github.getRepoTree).mockReset();
  vi.mocked(github.getFileAtRef).mockReset();
});

describe("every real page file", () => {
  it.each(REAL_PAGES)("%s is published byte for byte as the import read it", async (path) => {
    const file = fixture(path);
    const page = await imported(file, slugOf(path));
    expect(await published(page)).toBe(file);
  });

  it.each(REAL_PAGES)("%s compares equal to the row imported from it, with no normalisation admitted", async (path) => {
    const file = fixture(path);
    const page = await imported(file, slugOf(path));
    expect(await compositorPageFile(page, file)).toBe(githubPageFile(file));
    expect(await pageDiffersFromGitHub(page, file)).toBe(false);
  });
});

describe("an edit on GitHub compares different", () => {
  const about = fixture("telar/about.md");
  const acerca = fixture("telar/acerca.md");

  it("the first body line indented", async () => {
    const page = await imported(about, "about");
    const edited = about.replace("\n# About Telar\n", "\n    # About Telar\n");
    expect(edited).not.toBe(about);
    expect(await pageDiffersFromGitHub(page, edited)).toBe(true);
  });

  it("a body line in the middle indented", async () => {
    const page = await imported(about, "about");
    const edited = about.replace("\nTelar (Spanish", "\n  Telar (Spanish");
    expect(edited).not.toBe(about);
    expect(await pageDiffersFromGitHub(page, edited)).toBe(true);
  });

  it("the final newline removed", async () => {
    const page = await imported(about, "about");
    expect(await pageDiffersFromGitHub(page, about.slice(0, -1))).toBe(true);
  });

  it("a second final newline added", async () => {
    const page = await imported(about, "about");
    expect(await pageDiffersFromGitHub(page, `${about}\n`)).toBe(true);
  });

  it("the whole block removed", async () => {
    const page = await imported(acerca, "acerca");
    const edited = acerca.replace(/^---\n[\s\S]*?\n---\n\n/, "");
    expect(edited.startsWith("# Acerca de Telar")).toBe(true);
    expect(await pageDiffersFromGitHub(page, edited)).toBe(true);
  });

  it("a block that no longer parses", async () => {
    const page = await imported(acerca, "acerca");
    const edited = acerca.replace("language: es\n", "language: [es\n");
    expect(edited).not.toBe(acerca);
    expect(await pageDiffersFromGitHub(page, edited)).toBe(true);
  });

  it("a title changed to a form the writer rewrites", async () => {
    const page = await imported(about, "about");
    const edited = about.replace("title: About\n", "title: [About]\n");
    expect(edited).not.toBe(about);
    expect(await pageDiffersFromGitHub(page, edited)).toBe(true);
  });

  it("any byte of the block other than the title line, the fences included", async () => {
    const page = await imported(acerca, "acerca");
    const titleLine = "title: Acerca de Telar\n";
    const titleAt = acerca.indexOf(titleLine);
    const blockEnd = acerca.indexOf("\n---\n") + "\n---\n".length;
    const edits = [
      ...eachByteChanged(acerca, 0, titleAt),
      ...eachByteChanged(acerca, titleAt + titleLine.length, blockEnd),
    ];
    expect(edits.length).toBe(blockEnd - titleLine.length);
    for (const edited of edits) expect(await pageDiffersFromGitHub(page, edited)).toBe(true);
  });
});

describe("what compares equal", () => {
  const acerca = fixture("telar/acerca.md");

  it("a leading byte-order mark alone", async () => {
    const page = await imported(acerca, "acerca");
    expect(await pageDiffersFromGitHub(page, `﻿${acerca}`)).toBe(false);
  });

  it("line endings alone, as CRLF or CR", async () => {
    const page = await imported(acerca, "acerca");
    expect(await pageDiffersFromGitHub(page, acerca.replace(/\n/g, "\r\n"))).toBe(false);
    expect(await pageDiffersFromGitHub(page, acerca.replace(/\n/g, "\r"))).toBe(false);
  });

  it("a page imported from a CRLF file, against that file", async () => {
    const crlf = acerca.replace(/\n/g, "\r\n");
    const page = await imported(crlf, "acerca");
    expect(page.frontmatter).toContain("\r\n");
    expect(await pageDiffersFromGitHub(page, crlf)).toBe(false);
  });

  it("a page containing a character the commit removes, against its own published file", async () => {
    const page: ComparablePage = { slug: "bell", title: "Bell", body: "Ding\u0007 dong", frontmatter: "\ntitle: Bell\n" };
    const file = await published(page);
    expect(file).not.toContain("\u0007");
    expect(await pageDiffersFromGitHub(page, file)).toBe(false);
  });
});

describe("a page whose block was never captured", () => {
  const acerca = fixture("telar/acerca.md");
  const body = acerca.slice(acerca.indexOf("# Acerca de Telar")).trimEnd();
  const uncaptured: ComparablePage = { slug: "acerca", title: "Acerca de Telar", body, frontmatter: null };

  it("compares equal to GitHub's file when the block differs only in what publish carries through", async () => {
    const edited = acerca.replace(
      "language: es\n",
      "language: es  # the page's language\n'title_key': about_title\nnav:\n  - one\n  - two\n",
    );
    expect(edited).not.toBe(acerca);
    expect(await pageDiffersFromGitHub(uncaptured, edited)).toBe(false);
    expect(await pageDiffersFromGitHub(uncaptured, acerca)).toBe(false);
  });

  it("compares different when the writer would rewrite the title", async () => {
    const edited = acerca.replace("title: Acerca de Telar\n", "title: [Acerca de Telar]\n");
    expect(await pageDiffersFromGitHub(uncaptured, edited)).toBe(true);
  });

  it("compares different when GitHub's title is not the page's", async () => {
    const edited = acerca.replace("title: Acerca de Telar\n", "title: Acerca\n");
    expect(await pageDiffersFromGitHub(uncaptured, edited)).toBe(true);
  });

  it("compares different when GitHub's block does not parse, which publish replaces with the title alone", async () => {
    const edited = acerca.replace("language: es\n", "language: [es\n");
    expect(await pageDiffersFromGitHub(uncaptured, edited)).toBe(true);
  });

  it("takes GitHub's block with its byte-order mark removed", async () => {
    expect(await pageDiffersFromGitHub(uncaptured, `﻿${acerca}`)).toBe(false);
  });

  it("takes the block from the file publish carries it from, when that is another file", async () => {
    // A page at `sobre` imported as `acerca`, both files in the repository:
    // publish writes `sobre.md` with the block of `acerca.md`.
    const renamed: ComparablePage = { ...uncaptured, slug: "sobre" };
    const sobre = acerca.replace("language: es\n", "language: en\n");
    expect(await pageDiffersFromGitHub(renamed, sobre, acerca)).toBe(true);
    expect(await pageDiffersFromGitHub(renamed, acerca, acerca)).toBe(false);
    expect(await pageDiffersFromGitHub(renamed, sobre, sobre)).toBe(false);
  });

  it("ignores the carried file for a page whose block was captured", async () => {
    const captured: ComparablePage = { ...uncaptured, frontmatter: capturedFrontmatter(acerca) };
    const other = acerca.replace("language: es\n", "language: en\n");
    expect(await pageDiffersFromGitHub(captured, acerca, other)).toBe(false);
  });
});

describe("a page publish writes no file for", () => {
  it("has no Compositor side", async () => {
    const about = fixture("telar/about.md");
    const untitled: ComparablePage = { slug: "about", title: "  ", body: "x", frontmatter: "\ntitle: About\n" };
    expect(await compositorPageFile(untitled, about)).toBeNull();
  });
});
