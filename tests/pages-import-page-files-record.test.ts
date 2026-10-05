/**
 * The Pages screen's import and the record of the page files.
 *
 * `import-pages` reads at `head_sha` when one is recorded, else at the head of
 * `main`, and records an entry for each page it imports: the file mapped to
 * the id the ingest answered for the insert. The entries are merged into the
 * project's record, keeping its commit; with no record they start one at the
 * commit the scan read.
 *
 * @version v1.5.0-beta
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asD1, createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";

const state = vi.hoisted(() => ({ head: null as string | null }));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 5, github_repo_full_name: "owner/repo", head_sha: state.head },
    userRole: "convenor",
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({ resolveProjectToken: vi.fn(async () => "token") }));
const { scanRepoPages, getRepoHead } = vi.hoisted(() => ({
  scanRepoPages: vi.fn(),
  getRepoHead: vi.fn(async () => "main-head"),
}));
vi.mock("~/lib/import.server", () => ({ scanRepoPages }));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead };
});

import { action } from "~/routes/_app.pages";
import { parsePageFilesRecord } from "~/lib/page-files-record";

let memory: MemoryD1;
let ingestBodies: Array<{ pages: { insert: Array<{ slug: string; title: string; frontmatter: string; body: string }> } }> = [];

function importPagesRecorded(ingest: { applied?: Record<string, number>; insertedPages?: Record<string, number>; failed?: Record<string, string[]> }) {
  return importPagesRecordedFor({}, ingest);
}

function importPagesRecordedFor(
  fields: Record<string, string>,
  ingest: { applied?: Record<string, number>; insertedPages?: Record<string, number> },
) {
  const form = new URLSearchParams({ intent: "import-pages", siteId: "5", ...fields });
  const request = new Request("https://compositor.telar.org/pages", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "secret",
    DB: asD1(memory),
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          ingestBodies.push(JSON.parse(await req.text()));
          return new Response(JSON.stringify({ applied: {}, skipped: {}, failed: {}, ...ingest }), { status: 200 });
        },
      }),
    },
  };
  const context = { get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc" })), cloudflare: { env } };
  return action({ request, context, params: {} } as never);
}

function importedRecordText(): string | null {
  return (memory.raw.prepare("SELECT page_files_json FROM projects WHERE id = 5").get() as { page_files_json: string | null }).page_files_json;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.head = null;
  ingestBodies = [];
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (5, 1, 'owner/repo', 1)");
  scanRepoPages.mockResolvedValue([
    { slug: "about", title: "About", body: "A", frontmatter: "", order: 0 },
    { slug: "acerca", title: "Acerca", body: "B", frontmatter: "", order: 1 },
  ]);
});

afterEach(() => {
  memory.close();
});

describe("import-pages reads at the recorded head", () => {
  it("scans at head_sha when one is recorded, not at a later head of main", async () => {
    state.head = "recorded-head";
    await importPagesRecorded({ applied: { pageInsert: 2 }, insertedPages: { about: 11, acerca: 12 } });
    expect(scanRepoPages.mock.calls[0][3]).toBe("recorded-head");
    expect(getRepoHead).not.toHaveBeenCalled();
  });

  it("scans at the head of main when no head is recorded", async () => {
    await importPagesRecorded({ applied: { pageInsert: 2 }, insertedPages: { about: 11, acerca: 12 } });
    expect(getRepoHead).toHaveBeenCalledWith("token", "owner", "repo", "main");
    expect(scanRepoPages.mock.calls[0][3]).toBe("main-head");
  });
});

describe("import-pages records the pages it imports", () => {
  it("with no record, starts one at the scanned commit, each file mapped to the id the ingest answered", async () => {
    expect(await importPagesRecorded({ applied: { pageInsert: 2 }, insertedPages: { about: 11, acerca: 12 } }))
      .toMatchObject({ ok: true, imported: 2 });
    expect(parsePageFilesRecord(importedRecordText())).toEqual({ commit: "main-head", files: { "about.md": 11, "acerca.md": 12 } });
  });

  it("merges into the record it finds, keeping its commit", async () => {
    state.head = "recorded-head";
    memory.raw.exec(`UPDATE projects SET page_files_json = '{"commit":"import","files":{"old.md":3}}' WHERE id = 5`);
    await importPagesRecorded({ applied: { pageInsert: 1 }, insertedPages: { acerca: 12 }, skipped: { pageInsert: ["about"] } } as never);
    expect(parsePageFilesRecord(importedRecordText())).toEqual({ commit: "import", files: { "old.md": 3, "acerca.md": 12 } });
  });

  it("records nothing for a page the ingest did not insert", async () => {
    await importPagesRecorded({ applied: { pageInsert: 0 }, insertedPages: {}, failed: { pageInsert: ["about", "acerca"] } } as never);
    expect(importedRecordText()).toBeNull();
  });
});

describe("import-pages reduces the scan to one file per page", () => {
  const SISTER = "\ntitle: Acerca\nlocalized_for: about.md\nlanguage: es\n";

  beforeEach(() => {
    scanRepoPages.mockResolvedValue([
      { slug: "about", title: "About", body: "A", frontmatter: "\ntitle: About\n", order: 0 },
      { slug: "acerca", title: "Acerca", body: "B", frontmatter: SISTER, order: 1 },
    ]);
  });

  it("on a Spanish site imports about with acerca.md's text and records acerca.md with no page", async () => {
    memory.raw.exec("INSERT INTO project_config (project_id, lang) VALUES (5, 'es')");
    await importPagesRecorded({ applied: { pageInsert: 1 }, insertedPages: { about: 11 } });
    expect(ingestBodies[0].pages.insert.map((p) => [p.slug, p.title, p.frontmatter, p.body])).toEqual([
      ["about", "Acerca", "\ntitle: Acerca\n", "B"],
    ]);
    expect(parsePageFilesRecord(importedRecordText())).toEqual({ commit: "main-head", files: { "about.md": 11, "acerca.md": null } });
  });

  it("does not record the served file when the page it is served at was not inserted", async () => {
    memory.raw.exec("INSERT INTO project_config (project_id, lang) VALUES (5, 'es')");
    scanRepoPages.mockResolvedValue([
      { slug: "about", title: "About", body: "A", frontmatter: "\ntitle: About\n", order: 0 },
      { slug: "acerca", title: "Acerca", body: "B", frontmatter: SISTER, order: 1 },
      { slug: "credits", title: "Credits", body: "C", frontmatter: "\ntitle: Credits\n", order: 2 },
    ]);
    await importPagesRecorded({ applied: { pageInsert: 1 }, insertedPages: { credits: 13 }, failed: { pageInsert: ["about"] } } as never);
    expect(parsePageFilesRecord(importedRecordText())).toEqual({ commit: "main-head", files: { "credits.md": 13 } });
  });

  it("records the served file when its page is already held, though only another page was asked for", async () => {
    memory.raw.exec("INSERT INTO project_config (project_id, lang) VALUES (5, 'es')");
    await importPagesRecordedFor({ slugs: "about" }, { applied: { pageInsert: 0 }, skipped: { pageInsert: ["about"] } } as never);
    expect(parsePageFilesRecord(importedRecordText())).toEqual({ commit: "main-head", files: { "acerca.md": null } });
  });

  it("does not reduce when the site's language cannot be read", async () => {
    await importPagesRecorded({ applied: { pageInsert: 2 }, insertedPages: { about: 11, acerca: 12 } });
    expect(ingestBodies[0].pages.insert.map((p) => p.slug)).toEqual(["about", "acerca"]);
    expect(parsePageFilesRecord(importedRecordText())).toEqual({ commit: "main-head", files: { "about.md": 11, "acerca.md": 12 } });
  });
});
