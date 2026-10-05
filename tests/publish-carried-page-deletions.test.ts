/**
 * A publish deletes the page file a page's front matter was carried from
 * (`frontmatter_source`) when it writes the page under another slug and no
 * page the Compositor holds claims that file.
 *
 * The page is written at its own slug, so the file it was imported as is left
 * behind, still built as a page of the site, and a warning about that file
 * says the next publish repairs it. A held page claims a file by having its
 * slug, or by carrying from it while this publish does not write it (a page
 * with no title), since its block is still to be read from there.
 *
 * Once the publish that deleted a carried file has landed, each page carried
 * from it has `frontmatter_source` cleared, so no later publish names the
 * path again: a file someone creates there on GitHub afterwards is kept. The
 * page's block is then carried from its own file, which that publish wrote.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { carriedPageDeletions, clearCarriedPageSources } from "~/lib/publish.server";

const PAGES = "telar-content/texts/pages";

const heldPage = (slug: string, frontmatter_source: string | null, title = "Title") => ({ title, slug, frontmatter_source });

describe("carriedPageDeletions", () => {
  it("deletes the file a written page was imported as, under another slug", () => {
    expect(carriedPageDeletions([heldPage("acerca", "about")])).toEqual([`${PAGES}/about.md`]);
  });

  it("deletes nothing for a page carried from its own slug, or with no source", () => {
    expect(carriedPageDeletions([heldPage("about", "about"), heldPage("new", null), heldPage(" about ", "about")])).toEqual([]);
  });

  it("keeps a file a held page has as its slug", () => {
    expect(carriedPageDeletions([heldPage("acerca", "about"), heldPage("about", null)])).toEqual([]);
  });

  it("keeps a file a page this publish does not write still carries from", () => {
    expect(carriedPageDeletions([heldPage("acerca", "about"), heldPage("other", "about", " ")])).toEqual([]);
  });

  it("deletes nothing for a page this publish does not write", () => {
    expect(carriedPageDeletions([heldPage("acerca", "about", "")])).toEqual([]);
  });

  it("names a file two written pages carry from once, and ignores a blank source", () => {
    expect(carriedPageDeletions([heldPage("one", "about"), heldPage("two", "about"), heldPage("three", " ")])).toEqual([`${PAGES}/about.md`]);
  });
});

describe("clearCarriedPageSources, once the publish has landed", () => {
  let memory: MemoryD1;
  const PROJECT = 42;

  beforeEach(() => {
    memory = createMemoryD1();
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
        "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
    );
    memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT}, 7, 'o/r', 5)`);
    const insert = memory.raw.prepare(
      "INSERT INTO project_pages (id, project_id, title, slug, frontmatter_source) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(1, PROJECT, "Acerca", "acerca", "about");
    insert.run(2, PROJECT, "Contact", "contact", "contacto");
    insert.run(3, PROJECT, "Home", "home", null);
  });

  afterEach(() => {
    memory.close();
  });

  const db = () => drizzle(asD1(memory), { schema });

  function rows() {
    return memory.raw.prepare("SELECT id, title, slug, frontmatter_source FROM project_pages ORDER BY id").all() as Array<{
      id: number; title: string; slug: string; frontmatter_source: string | null;
    }>;
  }

  /** The pages as the publish captured them. */
  const capturedPages = () => rows().map((r) => ({ ...r }));

  it("clears the source of each page whose carried file the commit deleted, and no other", async () => {
    const pages = capturedPages();
    await clearCarriedPageSources(db(), PROJECT, pages, [`${PAGES}/about.md`]);
    expect(rows().map((r) => r.frontmatter_source)).toEqual([null, "contacto", null]);
  });

  it("leaves a source the next publish would name again for nothing: it asks no deletion, so a file created there later is kept", async () => {
    const pages = capturedPages();
    const deletions = carriedPageDeletions(pages);
    expect(deletions).toEqual([`${PAGES}/about.md`, `${PAGES}/contacto.md`]);
    await clearCarriedPageSources(db(), PROJECT, pages, deletions);
    expect(carriedPageDeletions(rows())).toEqual([]);
  });

  it("keeps a source changed since the capture", async () => {
    const pages = capturedPages();
    memory.raw.prepare("UPDATE project_pages SET frontmatter_source = 'about-us' WHERE id = 1").run();
    await clearCarriedPageSources(db(), PROJECT, pages, [`${PAGES}/about.md`]);
    expect(rows()[0].frontmatter_source).toBe("about-us");
  });

  it("keeps the source of a page whose carried file was claimed and so not deleted", async () => {
    const pages = [...capturedPages(), { id: 4, title: "About", slug: "about", frontmatter_source: null }];
    await clearCarriedPageSources(db(), PROJECT, pages, carriedPageDeletions(pages));
    expect(rows()[0].frontmatter_source).toBe("about");
  });

  it("logs and returns when the write fails, since the commit has landed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { update: () => { throw new Error("D1 down"); } } as never;
    await expect(clearCarriedPageSources(failing, PROJECT, capturedPages(), [`${PAGES}/about.md`])).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
