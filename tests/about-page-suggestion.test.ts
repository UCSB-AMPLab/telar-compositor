/**
 * The Publish page's suggestion to make the template's About page the site's
 * own: one per untouched template page, only the page the site publishes when
 * both language versions are untouched, none once the body has been edited or
 * where the slug is not a template slug.
 *
 * The bodies are the compositor's own literals of what the template shipped,
 * the same ones tests/template-content.test.ts holds against the recorded
 * hashes. The bodies the template ships today are held only as hashes, so
 * they are read from the template's own files (`fixtures/pages/telar/`) and
 * stored the way the import stores a page: the body, without its front matter.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi } from "vitest";
import type { FileAtRef } from "~/lib/github.server";
import { aboutPageSuggestions, knownPageSlugs } from "~/lib/about-page-suggestion.server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { V121_BODIES, ACERCA_MD_FULL, splitFrontmatter } from "~/lib/v130-ingest.server";

const TEMPLATE_PAGES = resolve(__dirname, "fixtures/pages/telar");
const shipped = (file: string) => splitFrontmatter(readFileSync(resolve(TEMPLATE_PAGES, file), "utf8"));
const shippedBody = (file: string) => shipped(file).body;
/** acerca.md's block as the template ships it: `localized_for: about.md`, `language: es`. */
const ACERCA_BLOCK = shipped("acerca.md").frontmatter ?? "";

const ABOUT = V121_BODIES.about;
const ACERCA = ACERCA_MD_FULL.replace(/^---\n[\s\S]*?\n---\n/, "");

type Over = Partial<{ body: string; slug: string; title: string; frontmatter: string | null }>;
const about = (over: Over = {}) =>
  ({ id: 1, slug: "about", title: "About", body: ABOUT, frontmatter: null, ...over });
const acerca = (over: Over = {}) =>
  ({ id: 2, slug: "acerca", title: "Acerca de", body: ACERCA, frontmatter: ACERCA_BLOCK, ...over });

describe("aboutPageSuggestions", () => {
  it("suggests the untouched about page, naming its slug and current title", async () => {
    expect(await aboutPageSuggestions([about({ title: "About this site" })], "en")).toEqual([
      {
        code: "about_page_template",
        message: "about_page_template",
        entityId: "about",
        params: { title: "About this site" },
      },
    ]);
  });

  it("says nothing once the body has been edited", async () => {
    expect(await aboutPageSuggestions([about({ body: `${ABOUT}\n\nOur project.` })], "en")).toEqual([]);
  });

  it("says nothing for a slug the template does not use, even with the template's body", async () => {
    expect(await aboutPageSuggestions([about({ slug: "credits" })], "en")).toEqual([]);
  });

  it("names only acerca when both versions are untouched and the site is Spanish", async () => {
    const found = await aboutPageSuggestions([about(), acerca()], "es");
    expect(found.map((s) => s.entityId)).toEqual(["acerca"]);
  });

  it("names only about when both versions are untouched and the site is English", async () => {
    const found = await aboutPageSuggestions([about(), acerca()], "en");
    expect(found.map((s) => s.entityId)).toEqual(["about"]);
  });

  it("says nothing on an English site whose about is edited, though acerca is untouched, since acerca is not served", async () => {
    expect(await aboutPageSuggestions([about({ body: "Mine." }), acerca()], "en")).toEqual([]);
  });

  it("says nothing on a Spanish site whose acerca is edited, though about is untouched, since acerca is served in its place", async () => {
    expect(await aboutPageSuggestions([about(), acerca({ body: "Lo nuestro." })], "es")).toEqual([]);
  });

  it("matches the language exactly, as the framework does: es-MX serves about", async () => {
    const found = await aboutPageSuggestions([about(), acerca()], "es-MX");
    expect(found.map((s) => s.entityId)).toEqual(["about"]);
  });

  it("names a page of its own with the template's body, as the import leaves a site", async () => {
    const found = await aboutPageSuggestions([acerca({ frontmatter: null })], "es");
    expect(found.map((s) => s.entityId)).toEqual(["acerca"]);
  });

  it("recognises the about and acerca bodies the template ships today", async () => {
    const found = await aboutPageSuggestions(
      [about({ body: shippedBody("about.md") }), acerca({ body: shippedBody("acerca.md") })],
      "es",
    );
    expect(found.map((s) => s.entityId)).toEqual(["acerca"]);
    expect(await aboutPageSuggestions([about({ body: shippedBody("about.md") })], "en")).toHaveLength(1);
  });

  it.each(["v0.6.0-beta", "v0.9.0-beta", "v0.9.1-beta"])(
    "recognises the about body the template shipped in %s",
    async (tag) => {
      const body = splitFrontmatter(
        readFileSync(resolve(__dirname, `fixtures/pages/telar-pre-1.0/about-${tag}.md`), "utf8"),
      ).body;
      expect(await aboutPageSuggestions([about({ body })], "en")).toHaveLength(1);
    },
  );
});

describe("aboutPageSuggestions for a page never imported", () => {
  const FOLDER = "telar-content/texts/pages/";
  const rawOf = (file: string, over: Partial<{ body: string; title: string | null }> = {}) => {
    const text = readFileSync(resolve(TEMPLATE_PAGES, file), "utf8");
    if (over.body === undefined && over.title === undefined) return text;
    const { frontmatter, body } = splitFrontmatter(text);
    const block = over.title === undefined ? frontmatter : over.title === null
      ? (frontmatter ?? "").replace(/^title:.*\n?/m, "")
      : (frontmatter ?? "").replace(/^title:.*$/m, `title: ${over.title}`);
    return `---\n${block}\n---\n${over.body ?? body}`;
  };
  /** A repository holding these files, by name in the pages folder; any other path is absent. */
  const repoOf = (files: Record<string, FileAtRef>, knownSlugs: string[] = []) => {
    const readFile = vi.fn(async (path: string): Promise<FileAtRef> => files[path.slice(FOLDER.length)] ?? { status: "absent" });
    return { knownSlugs, readFile };
  };
  const ok = (content: string): FileAtRef => ({ status: "ok", content });

  it("does not read the repository while the project holds an About page", async () => {
    const repo = repoOf({ "about.md": ok(rawOf("about.md")) });
    expect(await aboutPageSuggestions([about({ body: "Mine." })], "en", repo)).toEqual([]);
    expect(repo.readFile).not.toHaveBeenCalled();
  });

  it("does not read the repository while the project holds an Acerca page", async () => {
    const repo = repoOf({ "about.md": ok(rawOf("about.md")) });
    await aboutPageSuggestions([acerca({ body: "Mia." })], "es", repo);
    expect(repo.readFile).not.toHaveBeenCalled();
  });

  it("reads nothing when no source is given", async () => {
    expect(await aboutPageSuggestions([], "en", null)).toEqual([]);
    expect(await aboutPageSuggestions([], "en")).toEqual([]);
  });

  it.each(["about", "acerca"])(
    "reads nothing when the Compositor has known %s, as when it was deleted and not yet published",
    async (slug) => {
      const repo = repoOf({ "about.md": ok(rawOf("about.md")) }, [slug]);
      expect(await aboutPageSuggestions([], "en", repo)).toEqual([]);
      expect(repo.readFile).not.toHaveBeenCalled();
    },
  );

  it("reads only the two files that can be the About page", async () => {
    const repo = repoOf({ "about.md": ok(rawOf("about.md")) }, ["credits", "team"]);
    await aboutPageSuggestions([], "en", repo);
    expect(repo.readFile.mock.calls.map(([path]) => path).sort()).toEqual([`${FOLDER}about.md`, `${FOLDER}acerca.md`]);
  });

  it("suggests the repository's template about page when the project holds none", async () => {
    const title = "About this site";
    const repo = repoOf({ "about.md": ok(rawOf("about.md", { title })) });
    expect(await aboutPageSuggestions([], "en", repo)).toEqual([
      {
        code: "about_page_template_unimported",
        message: "about_page_template_unimported",
        entityId: "about",
        params: { title },
      },
    ]);
  });

  it("falls back to the slug when the file has no title", async () => {
    const repo = repoOf({ "about.md": ok(rawOf("about.md", { title: null })) });
    const found = await aboutPageSuggestions([], "en", repo);
    expect(found[0].params).toEqual({ title: "about" });
  });

  it("says nothing when the repository's about body has been edited", async () => {
    const repo = repoOf({ "about.md": ok(rawOf("about.md", { body: "Our project." })) });
    expect(await aboutPageSuggestions([], "en", repo)).toEqual([]);
  });

  it("recognises the body the template shipped before 1.0", async () => {
    const content = readFileSync(resolve(__dirname, "fixtures/pages/telar-pre-1.0/about-v0.9.1-beta.md"), "utf8");
    const found = await aboutPageSuggestions([], "en", repoOf({ "about.md": ok(content) }));
    expect(found.map((s) => s.code)).toEqual(["about_page_template_unimported"]);
  });

  it("names acerca on a Spanish site with both files, and about on an English one", async () => {
    const files = { "about.md": ok(rawOf("about.md")), "acerca.md": ok(rawOf("acerca.md")) };
    expect((await aboutPageSuggestions([], "es", repoOf(files))).map((s) => s.entityId)).toEqual(["acerca"]);
    expect((await aboutPageSuggestions([], "en", repoOf(files))).map((s) => s.entityId)).toEqual(["about"]);
  });

  it("treats an absent file as not there: acerca alone is suggested when about is absent", async () => {
    const repo = repoOf({ "acerca.md": ok(`---\ntitle: Acerca de\n---\n${shippedBody("acerca.md")}`) });
    expect((await aboutPageSuggestions([], "es", repo)).map((s) => s.entityId)).toEqual(["acerca"]);
  });

  it("says nothing when the repository holds neither file", async () => {
    expect(await aboutPageSuggestions([], "en", repoOf({}))).toEqual([]);
  });

  it("says nothing when either read errors, though the other holds the template", async () => {
    const repo = repoOf({ "about.md": ok(rawOf("about.md")), "acerca.md": { status: "error" } });
    expect(await aboutPageSuggestions([], "en", repo)).toEqual([]);
  });

  it("says nothing, and does not throw, when a read throws", async () => {
    const repo = { knownSlugs: [], readFile: vi.fn(async () => { throw new Error("GitHub unreachable"); }) };
    expect(await aboutPageSuggestions([], "en", repo)).toEqual([]);
  });
});

describe("knownPageSlugs", () => {
  it("names the pages of the import's record, removed files included", () => {
    const record = JSON.stringify({ commit: "abc", files: { "about.md": 3, "acerca.md": null } });
    expect(knownPageSlugs(record, null).sort()).toEqual(["about", "acerca"]);
  });

  it("names the pages of the last publish snapshot", () => {
    expect(knownPageSlugs(null, JSON.stringify({ version: 1, pages: { about: "h" } }))).toEqual(["about"]);
  });

  it("names none for no record, no snapshot, or text that is not JSON", () => {
    expect(knownPageSlugs(null, null)).toEqual([]);
    expect(knownPageSlugs("nope", "{not json")).toEqual([]);
    expect(knownPageSlugs(undefined, JSON.stringify({ version: 1 }))).toEqual([]);
  });
});
