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

import { describe, it, expect } from "vitest";
import { aboutPageSuggestions } from "~/lib/about-page-suggestion.server";
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
});
