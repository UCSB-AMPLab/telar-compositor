/**
 * Onboarding's commit writes the record of the page files the Compositor
 * answers for, in the same write as the head it records.
 *
 * The commit has no expected head, so the record is derived from the pages
 * folder at the new head and D1: each file a page holds maps to that page, a
 * file the replaced record lists that is still in the folder keeps its entry,
 * and over no record a file no page holds that the publish snapshot's
 * `page_slugs` names is recorded with no page. A folder that cannot be
 * read leaves the record as it was, and the head is recorded all the same.
 *
 * @version v1.5.0-beta
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asD1, createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/middleware/auth.server", () => ({ authMiddleware: vi.fn(), userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined), set: vi.fn() })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn(async () => {}) }));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getFileContent: vi.fn(async () => 'url: "https://wrong.example"\nbaseurl: "/repo"\n'),
    getSubtreeOids: vi.fn(),
    listSubtreeEntries: vi.fn(),
  };
});
vi.mock("~/lib/commit.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "onboarded" })) };
});
vi.mock("~/lib/import.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, importRepo: vi.fn() };
});
vi.mock("~/lib/upgrade.server", () => ({ checkTelarVersion: vi.fn() }));
vi.mock("~/lib/upgrade-gate.server", () => ({ siteNeedsUpgrade: vi.fn(async () => false) }));
vi.mock("~/lib/onboarding-create-site.server", () => ({ handleCreateSiteIntents: vi.fn(), importScopeRefusal: vi.fn() }));

import { action } from "~/routes/onboarding";
import { getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import { parsePageFilesRecord } from "~/lib/page-files-record";

let memory: MemoryD1;

/** The pages folder at the onboarding commit holds these files. */
function pagesFolderHolds(names: string[]): void {
  vi.mocked(getSubtreeOids).mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: "pages-tree" }) } as never);
  vi.mocked(listSubtreeEntries).mockResolvedValue({
    files: new Map(names.map((name) => [name, `blob-${name}`])),
    directories: [],
  } as never);
}

function seedOnboardingProject(project: { page_files_json?: string | null; publish_snapshot?: string | null }, pages: Array<[number, string]>): void {
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.prepare(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, page_files_json, publish_snapshot) VALUES (5, 1, 'owner/repo', 1, ?, ?)",
  ).run(project.page_files_json ?? null, project.publish_snapshot ?? null);
  memory.raw.exec("INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (5, 1, 'convenor', '2026-01-01')");
  for (const [id, slug] of pages) {
    memory.raw.prepare("INSERT INTO project_pages (id, project_id, title, slug, body) VALUES (?, 5, 'T', ?, '')").run(id, slug);
  }
}

async function fixUrlOnboarding(): Promise<unknown> {
  const form = new URLSearchParams({ intent: "fix-site-config", project_id: "5", fixUrl: "true", pagesUrl: "https://owner.github.io/repo/" });
  const request = new Request("https://compositor.telar.org/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const context = {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "enc" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "p", DB: asD1(memory) } },
  };
  return action({ request, context, params: {} } as never);
}

function onboardedProjectRow(): { head_sha: string | null; page_files_json: string | null } {
  return memory.raw.prepare("SELECT head_sha, page_files_json FROM projects WHERE id = 5").get() as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
});

afterEach(() => {
  memory.close();
});

describe("onboarding's record of the page files", () => {
  it("records each file in the folder a page holds at the new head, with the head", async () => {
    seedOnboardingProject({ page_files_json: '{"commit":"import","files":{"about.md":1}}' }, [[1, "about"]]);
    pagesFolderHolds(["about.md", "acerca.md", ".gitkeep", "sub/x.md"]);
    expect(await fixUrlOnboarding()).toEqual({ ok: true, intent: "fix-site-config" });
    expect(onboardedProjectRow().head_sha).toBe("onboarded");
    expect(parsePageFilesRecord(onboardedProjectRow().page_files_json)).toEqual({ commit: "onboarded", files: { "about.md": 1 } });
  });

  it("keeps the replaced record's entry for a page renamed here since the import", async () => {
    seedOnboardingProject({ page_files_json: '{"commit":"import","files":{"about.md":1}}' }, [[1, "credits"]]);
    pagesFolderHolds(["about.md"]);
    await fixUrlOnboarding();
    expect(parsePageFilesRecord(onboardedProjectRow().page_files_json)).toEqual({ commit: "onboarded", files: { "about.md": 1 } });
  });

  it("over no record, records a page_slugs file no page holds with no page", async () => {
    seedOnboardingProject(
      { publish_snapshot: JSON.stringify({ story_ids: [], object_ids: [], page_slugs: ["about"] }) },
      [[2, "credits"]],
    );
    pagesFolderHolds(["about.md", "credits.md", "acerca.md"]);
    await fixUrlOnboarding();
    expect(parsePageFilesRecord(onboardedProjectRow().page_files_json)).toEqual({
      commit: "onboarded",
      files: { "about.md": null, "credits.md": 2 },
    });
  });

  it("leaves the record as it was when the folder cannot be read, and records the head", async () => {
    const previous = '{"commit":"import","files":{"about.md":1}}';
    seedOnboardingProject({ page_files_json: previous }, [[1, "about"]]);
    vi.mocked(getSubtreeOids).mockResolvedValue({ ok: false, reason: "malformed" } as never);
    await fixUrlOnboarding();
    expect(onboardedProjectRow()).toEqual({ head_sha: "onboarded", page_files_json: previous });
  });
});
