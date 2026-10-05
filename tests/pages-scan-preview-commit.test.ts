/**
 * The Pages screen's preview lists what the import will read.
 *
 * `scan-repo-pages` scans at the commit `import-pages` reads: `head_sha` when
 * one is recorded, else the head of `main`. A page that exists only on a later
 * head of `main` is not listed when a head is recorded.
 *
 * @version v1.5.0-beta
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const AT_RECORDED = [{ slug: "about", title: "About", body: "A", frontmatter: "", order: 0 }];
const AT_MAIN = [...AT_RECORDED, { slug: "later", title: "Later", body: "L", frontmatter: "", order: 1 }];

function previewScan() {
  const request = new Request("https://compositor.telar.org/pages", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "scan-repo-pages", siteId: "5" }).toString(),
  });
  const env = { ENCRYPTION_KEY: "key", SESSION_SECRET: "secret", DB: {} };
  const context = { get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc" })), cloudflare: { env } };
  return action({ request, context, params: {} } as never) as Promise<{ pages: { slug: string }[] }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.head = null;
  scanRepoPages.mockImplementation(async (_t: string, _o: string, _r: string, commit?: string) =>
    commit === "recorded-head" ? AT_RECORDED : AT_MAIN,
  );
});

describe("scan-repo-pages reads the commit the import reads", () => {
  it("scans at head_sha when one is recorded, lists no page found only on main, and does not ask for main's head", async () => {
    state.head = "recorded-head";
    const answer = await previewScan();
    expect(scanRepoPages.mock.calls[0][3]).toBe("recorded-head");
    expect(answer.pages.map((p) => p.slug)).toEqual(["about"]);
    expect(getRepoHead).not.toHaveBeenCalled();
  });

  it("scans at the head of main when no head is recorded", async () => {
    const answer = await previewScan();
    expect(getRepoHead).toHaveBeenCalledWith("token", "owner", "repo", "main");
    expect(scanRepoPages.mock.calls[0][3]).toBe("main-head");
    expect(answer.pages.map((p) => p.slug)).toEqual(["about", "later"]);
  });
});
