/**
 * A page's front matter at publish: a page never captured has its file read at
 * the publish's revision and its block carried into the file, never into the
 * hash; a page's hash takes its block only when it has one.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { filesAtRef, readPaths, reads } = vi.hoisted(() => ({
  filesAtRef: { current: {} as Record<string, { status: "ok"; content: string } | { status: "absent" } | { status: "error" }> },
  readPaths: [] as Array<{ path: string; ref: string; strict: boolean }>,
  reads: { inFlight: 0, most: 0 },
}));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string, options?: { strict?: boolean }) => {
      readPaths.push({ path, ref, strict: options?.strict === true });
      reads.inFlight += 1;
      reads.most = Math.max(reads.most, reads.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      reads.inFlight -= 1;
      return filesAtRef.current[path] ?? { status: "absent" as const };
    }),
  };
});

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve([]), chain);
      chain.limit = () => Promise.resolve([]);
      chain.orderBy = () => Promise.resolve([]);
      return chain;
    },
  }),
}));

import {
  buildEntityHashes,
  buildPageContentHashes,
  buildPublishFileSet,
  runPrePublishValidation,
  UnreadablePageError,
  UnwritablePageFrontmatterError,
  type PublishPageRow,
} from "~/lib/publish.server";
import { getDb } from "~/lib/db.server";

const ABOUT_PATH = "telar-content/texts/pages/about.md";
const ACERCA_PATH = "telar-content/texts/pages/acerca.md";

const ACERCA_FILE =
  "---\ntitle: Acerca de\nlocalized_for: about\nlanguage: es\ntitle_key: about_title\n---\n\nTexto.\n";

function page(slug: string, title: string, frontmatter: string | null, source: string | null = null): PublishPageRow {
  return { slug, title, body: `${title} body`, frontmatter, frontmatter_source: source, order: 0 };
}

function build(pages: PublishPageRow[]) {
  return buildPublishFileSet({
    token: "tok", owner: "o", repo: "r", ref: "publish-sha", projectId: 1, env: { DB: {} } as never,
    configYml: null, config: null, landing: null, pages,
  });
}

const fileAt = (files: Array<{ path: string; content: string }>, path: string) =>
  files.find((f) => f.path === path)?.content;

beforeEach(() => {
  filesAtRef.current = {};
  readPaths.length = 0;
  reads.inFlight = 0;
  reads.most = 0;
});

describe("a page never captured, at publish", () => {
  it("keeps its file's keys, localized_for and title_key among them", async () => {
    filesAtRef.current = { [ACERCA_PATH]: { status: "ok", content: ACERCA_FILE } };
    const files = await build([page("acerca", "Acerca de", null)]);
    expect(fileAt(files, ACERCA_PATH)).toBe(
      "---\ntitle: Acerca de\nlocalized_for: about\nlanguage: es\ntitle_key: about_title\n---\n\nAcerca de body\n",
    );
  });

  it("carries the keys forward under a title edited since the import", async () => {
    filesAtRef.current = { [ACERCA_PATH]: { status: "ok", content: ACERCA_FILE } };
    const files = await build([page("acerca", "Sobre el sitio", null)]);
    expect(fileAt(files, ACERCA_PATH)).toContain(
      '---\ntitle: "Sobre el sitio"\nlocalized_for: about\nlanguage: es\ntitle_key: about_title\n---\n',
    );
  });

  it("reads its file at the publish's revision, in the mode for a file it rewrites", async () => {
    filesAtRef.current = { [ACERCA_PATH]: { status: "ok", content: ACERCA_FILE } };
    await build([page("acerca", "Acerca de", null)]);
    expect(readPaths.filter((r) => r.path === ACERCA_PATH)).toEqual([
      { path: ACERCA_PATH, ref: "publish-sha", strict: true },
    ]);
  });

  it("is written as a new page when its file is absent", async () => {
    const files = await build([page("about", "About", null)]);
    const asNew = await build([page("about", "About", "")]);
    expect(fileAt(files, ABOUT_PATH)).toBe(fileAt(asNew, ABOUT_PATH));
    expect(fileAt(files, ABOUT_PATH)).toBe('---\ntitle: "About"\n---\n\nAbout body\n');
  });

  it("stops the publish when its file cannot be read", async () => {
    filesAtRef.current = { [ACERCA_PATH]: { status: "error" } };
    await expect(build([page("acerca", "Acerca de", null)])).rejects.toBeInstanceOf(UnreadablePageError);
  });

  it("is the only page whose file is read", async () => {
    await build([page("about", "About", "title: About"), page("blank", "Blank", ""), page("acerca", "Acerca de", null)]);
    expect(readPaths.map((r) => r.path).filter((p) => p.includes("/texts/pages/"))).toEqual([ACERCA_PATH]);
  });

  it("reads the file it was imported as when it has been renamed since", async () => {
    filesAtRef.current = { [ACERCA_PATH]: { status: "ok", content: ACERCA_FILE } };
    const files = await build([page("sobre", "Acerca de", null, "acerca")]);
    expect(readPaths.map((r) => r.path)).toContain(ACERCA_PATH);
    expect(fileAt(files, "telar-content/texts/pages/sobre.md")).toContain(
      "localized_for: about\nlanguage: es\ntitle_key: about_title\n---\n",
    );
  });

  it("reads its current slug when it has no source", async () => {
    filesAtRef.current = { [ACERCA_PATH]: { status: "ok", content: ACERCA_FILE } };
    await build([page("acerca", "Acerca de", null, null)]);
    expect(readPaths.map((r) => r.path).filter((p) => p.includes("/texts/pages/"))).toEqual([ACERCA_PATH]);
  });

  it("reads at most six files at a time", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => page(`p${i}`, `P${i}`, null));
    const files = await build(pages);
    expect(reads.most).toBe(6);
    expect(files.filter((f) => f.path.startsWith("telar-content/texts/pages/"))).toHaveLength(20);
  });

  it("stops the publish when its carried block cannot take its title", async () => {
    filesAtRef.current = {
      [ACERCA_PATH]: { status: "ok", content: "---\n{title: Acerca, language: es}\n---\n\nTexto.\n" },
    };
    await expect(build([page("acerca", "Sobre", null)])).rejects.toBeInstanceOf(UnwritablePageFrontmatterError);
  });

  it("records the same hashes on two publishes in a row, the carried block in neither", async () => {
    filesAtRef.current = { [ACERCA_PATH]: { status: "ok", content: ACERCA_FILE } };
    const captured = { pages: [page("acerca", "Acerca de", null)], config: null, landing: null };
    const first = await buildEntityHashes(getDb({} as never), 1, captured);
    await build(captured.pages);
    const second = await buildEntityHashes(getDb({} as never), 1, captured);
    expect(captured.pages[0].frontmatter).toBeNull();
    expect(second.pages).toEqual(first.pages);
    expect(first.pages.acerca).not.toContain("localized_for");
  });
});

describe("a page renamed since its block was carried forward", () => {
  const OVERVIEW_PATH = "telar-content/texts/pages/overview.md";
  const ABOUT_FILE = "---\ntitle: About\nlocalized_for: about\nlanguage: en\n---\n\nTexto.\n";
  const OVERVIEW_FILE = "---\ntitle: Overview\nlocalized_for: about\nlanguage: en\n---\n\nTexto.\n";

  it("reads its current slug once an earlier publish has carried the file there and deleted the one it was imported as", async () => {
    // First publish: still uncaptured, its file is the one it was imported
    // as (about.md). The carry-forward commit writes overview.md with the
    // block and deletes about.md.
    filesAtRef.current = { [ABOUT_PATH]: { status: "ok", content: ABOUT_FILE } };
    const captured = { pages: [page("overview", "Overview", null, "about")], config: null, landing: null };
    const first = await build(captured.pages);
    expect(fileAt(first, OVERVIEW_PATH)).toContain("localized_for: about");

    // Second publish: about.md is gone; the block now lives at the page's
    // current slug.
    filesAtRef.current = { [OVERVIEW_PATH]: { status: "ok", content: OVERVIEW_FILE } };
    const second = await build(captured.pages);
    expect(captured.pages[0].frontmatter).toBeNull();
    expect(fileAt(second, OVERVIEW_PATH)).toContain("localized_for: about");
  });

  it("writes the page as new when neither the file it was imported as nor its current slug has one", async () => {
    const files = await build([page("overview", "Overview", null, "about")]);
    expect(fileAt(files, OVERVIEW_PATH)).toBe('---\ntitle: "Overview"\n---\n\nOverview body\n');
  });

  it("stops the publish, naming the current slug, when the fallback read fails", async () => {
    filesAtRef.current = { [OVERVIEW_PATH]: { status: "error" } };
    const rejection = await build([page("overview", "Overview", null, "about")]).catch((e) => e);
    expect(rejection).toBeInstanceOf(UnreadablePageError);
    expect((rejection as UnreadablePageError).path).toBe(OVERVIEW_PATH);
  });

  it("never reads the current slug when the file it was imported as is present", async () => {
    filesAtRef.current = { [ABOUT_PATH]: { status: "ok", content: ABOUT_FILE } };
    await build([page("overview", "Overview", null, "about")]);
    expect(readPaths.map((r) => r.path)).not.toContain(OVERVIEW_PATH);
  });
});

describe("a page's hash", () => {
  const onMain = (title: string, body: string, slug: string) => JSON.stringify({ title, body, slug });

  it("is what main records for a page without front matter", () => {
    expect(buildPageContentHashes([page("about", "About", "")])).toEqual({
      about: onMain("About", "About body", "about"),
    });
  });

  it("is what main records for a page never captured", () => {
    expect(buildPageContentHashes([page("about", "About", null)])).toEqual({
      about: onMain("About", "About body", "about"),
    });
  });

  it("takes a stored block after the other keys", () => {
    expect(buildPageContentHashes([page("acerca", "Acerca de", "language: es")])).toEqual({
      acerca: JSON.stringify({ title: "Acerca de", body: "Acerca de body", slug: "acerca", frontmatter: "language: es" }),
    });
  });
});

describe("the checks, for a page whose block cannot take its title", () => {
  const check = (pages: Array<{ slug: string; title: string; frontmatter?: string | null }>) =>
    runPrePublishValidation({
      headSha: "h", currentRepoHead: "h", stories: [], steps: [], objects: [], glossary: [], pages,
    });

  it("block the publish, naming the page", () => {
    const result = check([{ slug: "acerca", title: "Sobre", frontmatter: "\n{title: Acerca, language: es}\n" }]);
    expect(result.blockers).toEqual([{
      code: "page_frontmatter_unwritable",
      message: "page_frontmatter_unwritable",
      entityId: "acerca",
      params: { page: "Sobre" },
    }]);
  });

  it("clear once the block is reset to the title alone", () => {
    expect(check([{ slug: "acerca", title: "Sobre", frontmatter: "" }]).blockers).toEqual([]);
  });

  it("say nothing of a block they cannot see", () => {
    expect(check([{ slug: "acerca", title: "Sobre", frontmatter: null }]).blockers).toEqual([]);
    expect(check([{ slug: "acerca", title: "Sobre" }]).blockers).toEqual([]);
  });
});
