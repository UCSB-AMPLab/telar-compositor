/**
 * The record of the page files the Compositor answers for: its stored text, the deletions a publish takes from it, the record a
 * landed publish and onboarding write, and the Pages screen's import merging
 * its entries compare-and-set.
 *
 * The SQL is run against the migration chain in node:sqlite
 * (`createMemoryD1`), so a CASE or a compare-and-set that does not do what it
 * says fails here.
 *
 * @version v1.5.0-beta
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { projects } from "~/db/schema";
import { headAdvancedFrom } from "~/lib/github-status.server";
import {
  isRecordedPageFileName,
  mergedPageFilesRecord,
  parsePageFilesRecord,
  serialisePageFilesRecord,
} from "~/lib/page-files-record";
import {
  heldPagesRecord,
  onboardingPageFilesRecord,
  pageFilesRecordAdvancedFrom,
  recordImportedPages,
  recordedPageDeletions,
} from "~/lib/page-files-record.server";
import { asD1, createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";

const PAGES = "telar-content/texts/pages";

describe("the record's stored text", () => {
  it("parses what it serialises, its files in name order", () => {
    const text = serialisePageFilesRecord({ commit: "c1", files: { "b.md": null, "a.md": 3 } });
    expect(text).toBe('{"commit":"c1","files":{"a.md":3,"b.md":null}}');
    expect(parsePageFilesRecord(text)).toEqual({ commit: "c1", files: { "a.md": 3, "b.md": null } });
  });

  it.each([
    ["null", null],
    ["empty text", ""],
    ["text that is not JSON", "{not json"],
    ["an array", "[]"],
    ["a record with no commit", '{"files":{}}'],
    ["a blank commit", '{"commit":"","files":{}}'],
    ["files that are not an object", '{"commit":"c","files":[]}'],
    ["a file in a subfolder", '{"commit":"c","files":{"sub/x.md":1}}'],
    ["a file that is not .md", '{"commit":"c","files":{".gitkeep":null}}'],
    ["a page id that is not a positive integer", '{"commit":"c","files":{"a.md":0}}'],
    ["a page id given as text", '{"commit":"c","files":{"a.md":"3"}}'],
  ])("reads %s as no record", (_name, text) => {
    expect(parsePageFilesRecord(text)).toBeNull();
  });

  it("holds only .md names directly in the folder", () => {
    expect(isRecordedPageFileName("about.md")).toBe(true);
    expect(isRecordedPageFileName("sub/about.md")).toBe(false);
    expect(isRecordedPageFileName(".gitkeep")).toBe(false);
    expect(isRecordedPageFileName(".md")).toBe(false);
  });
});

describe("the publish's deletions from the record", () => {
  it("are the recorded files no captured page holds, and none for no record", () => {
    const record = { commit: "c", files: { "about.md": 1, "old.md": 2, "added.md": null } };
    const pages = [{ id: 1, slug: "about" }, { id: 2, slug: "renamed" }];
    expect(recordedPageDeletions(record, pages).sort()).toEqual([`${PAGES}/added.md`, `${PAGES}/old.md`]);
    expect(recordedPageDeletions(null, pages)).toEqual([]);
  });

  it("the landed record holds each page by its file, a blank slug and a subfolder slug left out", () => {
    expect(heldPagesRecord("new", [
      { id: 1, slug: " about " },
      { id: 2, slug: "" },
      { id: 3, slug: "sub/x" },
    ])).toEqual({ commit: "new", files: { "about.md": 1 } });
  });
});

describe("the record onboarding writes", () => {
  const pages = [{ id: 1, slug: "about" }, { id: 2, slug: "credits" }];
  const snapshot = { story_ids: [], object_ids: [], config_hash: "", landing_hash: "", page_slugs: ["about", "old"] };

  it("maps each file in the folder a page holds to that page, and leaves an unheld file out", () => {
    expect(onboardingPageFilesRecord({
      commit: "h", folder: ["about.md", "acerca.md", "sub/x.md", ".gitkeep"], pages, previous: null, snapshot: null,
    })).toEqual({ commit: "h", files: { "about.md": 1 } });
  });

  it("keeps an entry of the record it replaces for a file still in the folder", () => {
    // about.md imported as page 1, which was renamed here to credits; then credits.md
    // is the page's file and about.md stays the renamed page's old file.
    const previous = { commit: "import", files: { "about.md": 1, "gone.md": 4 } };
    expect(onboardingPageFilesRecord({
      commit: "h", folder: ["about.md", "acerca.md"], pages: [{ id: 1, slug: "credits" }], previous, snapshot,
    })).toEqual({ commit: "h", files: { "about.md": 1 } });
  });

  it("over no record, records with no page an unheld file the snapshot's page_slugs names", () => {
    expect(onboardingPageFilesRecord({
      commit: "h", folder: ["about.md", "old.md", "acerca.md"], pages: [{ id: 2, slug: "credits" }], previous: null, snapshot,
    })).toEqual({ commit: "h", files: { "about.md": null, "old.md": null } });
  });

  it("with no snapshot, or one without page_slugs, records no unheld file", () => {
    for (const shot of [null, { story_ids: [], object_ids: [], config_hash: "", landing_hash: "" }]) {
      expect(onboardingPageFilesRecord({
        commit: "h", folder: ["about.md"], pages: [], previous: null, snapshot: shot,
      })).toEqual({ commit: "h", files: {} });
    }
  });
});

describe("against the database", () => {
  let memory: MemoryD1;
  let projectId: number;

  beforeEach(() => {
    memory = createMemoryD1();
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
        "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
    );
    memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, head_sha) VALUES (5, 1, 'o/r', 1, 'h1')");
    projectId = 5;
  });

  afterEach(() => {
    memory.close();
  });

  function storedPageFilesText(): string | null {
    return (memory.raw.prepare("SELECT page_files_json FROM projects WHERE id = 5").get() as { page_files_json: string | null }).page_files_json;
  }

  it("the landed write lands with the head, and leaves another writer's record when the head moved", async () => {
    const db = drizzle(asD1(memory));
    const mine = serialisePageFilesRecord({ commit: "h2", files: { "about.md": 1 } });
    await db.update(projects).set({
      head_sha: headAdvancedFrom("h0", "h2"),
      page_files_json: pageFilesRecordAdvancedFrom("h0", mine),
    }).where(eq(projects.id, projectId));
    expect(storedPageFilesText()).toBeNull();
    await db.update(projects).set({
      head_sha: headAdvancedFrom("h1", "h2"),
      page_files_json: pageFilesRecordAdvancedFrom("h1", mine),
    }).where(eq(projects.id, projectId));
    expect(storedPageFilesText()).toBe(mine);
  });

  it("the Pages screen's import starts a record at the scanned commit when there is none", async () => {
    expect(await recordImportedPages(asD1(memory), projectId, "scan", { "about.md": 7 })).toBe(true);
    expect(parsePageFilesRecord(storedPageFilesText())).toEqual({ commit: "scan", files: { "about.md": 7 } });
  });

  it("merges into the record it finds, keeping its commit", async () => {
    memory.raw.exec(`UPDATE projects SET page_files_json = '{"commit":"import","files":{"about.md":1,"x.md":null}}' WHERE id = 5`);
    expect(await recordImportedPages(asD1(memory), projectId, "scan", { "acerca.md": 7 })).toBe(true);
    expect(parsePageFilesRecord(storedPageFilesText())).toEqual({ commit: "import", files: { "about.md": 1, "x.md": null, "acerca.md": 7 } });
  });

  it("a write that loses to another writer reads the record again and merges", async () => {
    const d1 = asD1(memory);
    const theirs = '{"commit":"theirs","files":{"theirs.md":9}}';
    let raced = false;
    const racing = {
      prepare(sql: string) {
        const stmt = d1.prepare(sql);
        if (raced || !sql.startsWith("UPDATE projects SET page_files_json")) return stmt;
        // Another writer records between this import's read and its write.
        raced = true;
        memory.raw.exec(`UPDATE projects SET page_files_json = '${theirs}' WHERE id = 5`);
        return stmt;
      },
    } as unknown as D1Database;
    expect(await recordImportedPages(racing, projectId, "scan", { "about.md": 7 })).toBe(true);
    expect(raced).toBe(true);
    expect(parsePageFilesRecord(storedPageFilesText())).toEqual({ commit: "theirs", files: { "theirs.md": 9, "about.md": 7 } });
  });

  it("writes nothing for no entries", async () => {
    const spy = vi.spyOn(memory, "prepare");
    expect(await recordImportedPages(asD1(memory), projectId, "scan", {})).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(storedPageFilesText()).toBeNull();
  });
});

describe("merging entries", () => {
  it("keeps the record's commit and drops names the record does not hold", () => {
    expect(mergedPageFilesRecord({ commit: "c", files: { "a.md": null } }, "scan", { "a.md": 2, "sub/b.md": 3 }))
      .toEqual({ commit: "c", files: { "a.md": 2 } });
  });

  it("adds a file with no page, but never over an entry the record holds", () => {
    expect(mergedPageFilesRecord({ commit: "c", files: { "a.md": 4 } }, "scan", { "a.md": null, "b.md": null }))
      .toEqual({ commit: "c", files: { "a.md": 4, "b.md": null } });
  });
});
