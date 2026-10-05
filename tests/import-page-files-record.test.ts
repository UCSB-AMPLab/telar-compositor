/**
 * The import records the page files it read.
 *
 * `projects.page_files_json` is the record of the page files the Compositor
 * answers for. The import writes it with the commit it read (`importHead`) and
 * each page file directly in the pages folder, mapped to the page inserted
 * from it, and leaves `head_sha` null: until a head is recorded, the record's
 * commit is the pages base. A file in a subfolder is not a page the framework
 * builds and is neither imported nor recorded.
 *
 * @version v1.5.0-beta
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getDefaultBranchHead: vi.fn(async () => ({ name: "main", oid: "import-head" })),
    getRepoTree: vi.fn(),
    getFileContent: vi.fn(),
    getFileAtRef: vi.fn(),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});

import { importRepo } from "~/lib/import.server";
import { getFileAtRef, getFileContent, getRepoTree } from "~/lib/github.server";
import { parsePageFilesRecord } from "~/lib/page-files-record";
import { recordedPageDeletions } from "~/lib/page-files-record.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";

const ABOUT = readFileSync(new URL("./fixtures/pages/telar/about.md", import.meta.url), "utf8");
const PAGES = "telar-content/texts/pages";
const FILES: Record<string, string> = {
  "_config.yml": 'title: "Site"\ntelar:\n  version: "1.0.0"\n',
  [`${PAGES}/about.md`]: ABOUT,
  [`${PAGES}/sub/x.md`]: "---\ntitle: X\n---\n\nIn a subfolder.\n",
};

let memory: MemoryD1;

function importForPageRecord() {
  return importRepo({
    token: "t",
    installationId: 1,
    repoFullName: "owner/repo",
    userId: 1,
    env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
  });
}

function importedProjectRow(): { head_sha: string | null; page_files_json: string | null } {
  return memory.raw.prepare("SELECT head_sha, page_files_json FROM projects").get() as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  vi.mocked(getRepoTree).mockResolvedValue({
    tree: Object.keys(FILES).map((path) => ({ path, type: "blob", sha: `sha-${path}`, mode: "100644" })),
    truncated: false,
  } as never);
  vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) => FILES[path] ?? null);
  vi.mocked(getFileAtRef).mockImplementation(
    strictReadsFromFileContent(vi.mocked(getFileContent), async () => ({ status: "absent" })) as never,
  );
});

afterEach(() => {
  memory.close();
});

describe("the import's record of the page files it read", () => {
  it("records the commit it read and each page file directly in the folder, mapped to its page, with no head", async () => {
    expect((await importForPageRecord()).valid).toBe(true);
    const pages = memory.raw.prepare("SELECT id, slug FROM project_pages").all() as Array<{ id: number; slug: string }>;
    expect(pages.map((p) => p.slug)).toEqual(["about"]);
    const row = importedProjectRow();
    expect(row.head_sha).toBeNull();
    expect(parsePageFilesRecord(row.page_files_json)).toEqual({
      commit: "import-head",
      files: { "about.md": pages[0].id },
    });
  });

  it("records a repository with no page files as a record with none", async () => {
    vi.mocked(getRepoTree).mockResolvedValue({
      tree: [{ path: "_config.yml", type: "blob", sha: "c", mode: "100644" }],
      truncated: false,
    } as never);
    expect((await importForPageRecord()).valid).toBe(true);
    expect(parsePageFilesRecord(importedProjectRow().page_files_json)).toEqual({ commit: "import-head", files: {} });
  });
});

describe("the import reduces the template's About page to one file", () => {
  const template = (
    JSON.parse(readFileSync(new URL("./fixtures/page-sisters/cases.json", import.meta.url), "utf8")) as {
      cases: Array<{ name: string; files: Record<string, string> }>;
    }
  ).cases.find((c) => c.name === "template, English site")!.files;

  function importInLanguage(lang: string) {
    const files: Record<string, string> = {
      "_config.yml": `title: "Site"\ntelar_language: ${lang}\ntelar:\n  version: "1.0.0"\n`,
      [`${PAGES}/about.md`]: template["about.md"],
      [`${PAGES}/acerca.md`]: template["acerca.md"],
    };
    vi.mocked(getRepoTree).mockResolvedValue({
      tree: Object.keys(files).map((path) => ({ path, type: "blob", sha: `sha-${path}`, mode: "100644" })),
      truncated: false,
    } as never);
    vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) => files[path] ?? null);
    return importForPageRecord();
  }

  function importedPagesWithText() {
    return memory.raw.prepare("SELECT id, slug, title, frontmatter, body FROM project_pages").all() as Array<{
      id: number; slug: string; title: string; frontmatter: string; body: string;
    }>;
  }

  it("on a Spanish site takes acerca.md's text into about, and records acerca.md with no page, which the next publish deletes", async () => {
    expect((await importInLanguage("es")).valid).toBe(true);
    const pages = importedPagesWithText();
    expect(pages.map((p) => [p.slug, p.title, p.frontmatter])).toEqual([["about", "Acerca de Telar", "\ntitle: Acerca de Telar\n"]]);
    expect(pages[0].body).toContain("# Acerca de Telar");
    const record = parsePageFilesRecord(importedProjectRow().page_files_json)!;
    expect(record.files).toEqual({ "about.md": pages[0].id, "acerca.md": null });
    expect(recordedPageDeletions(record, pages)).toEqual([`${PAGES}/acerca.md`]);
  });

  it("on an English site keeps about.md as it is and records acerca.md with no page", async () => {
    expect((await importInLanguage("en")).valid).toBe(true);
    const pages = importedPagesWithText();
    expect(pages.map((p) => [p.slug, p.title])).toEqual([["about", "About"]]);
    expect(parsePageFilesRecord(importedProjectRow().page_files_json)!.files).toEqual({ "about.md": pages[0].id, "acerca.md": null });
  });
});
