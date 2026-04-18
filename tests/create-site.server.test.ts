/**
 * Unit tests for app/lib/create-site.server.ts.
 *
 * Initial test skeleton: full coverage for
 * isValidRepoName plus describe-block placeholders for the four async
 * exports. Uses the same
 * globalThis.fetch mocking pattern as tests/github.server.test.ts — no
 * MSW, no nock, no new dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isValidRepoName,
  checkRepoNameAvailable,
  createSiteFromTemplate,
  waitForRepoReady,
  isRepoInInstallation,
  TEMPLATE_OWNER,
  TEMPLATE_REPO,
  RepoNameTakenError,
  PermissionDeniedError,
  GitHubError,
  RepoNotReadyError,
} from "~/lib/create-site.server";

const TOKEN = "test-token-abc";

function makeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

// Export for later plans so they can reuse the helper shape.
export { makeFetch };

describe("TEMPLATE constants", () => {
  it("exports the locked template owner and repo", () => {
    expect(TEMPLATE_OWNER).toBe("ucsb-amplab");
    expect(TEMPLATE_REPO).toBe("telar");
  });
});

describe("isValidRepoName", () => {
  it("accepts simple valid name", () => {
    expect(isValidRepoName("my-site")).toBe(true);
  });
  it("accepts underscores, dots, hyphens, digits", () => {
    expect(isValidRepoName("my_site.1-x")).toBe(true);
  });
  it("rejects uppercase letters", () => {
    expect(isValidRepoName("My-Site")).toBe(false);
  });
  it("accepts single character name (1 char minimum)", () => {
    expect(isValidRepoName("a")).toBe(true);
  });
  it("accepts 100 character name (maximum)", () => {
    expect(isValidRepoName("a".repeat(100))).toBe(true);
  });
  it("rejects 101 character name (too long)", () => {
    expect(isValidRepoName("a".repeat(101))).toBe(false);
  });
  it("rejects empty string", () => {
    expect(isValidRepoName("")).toBe(false);
  });
  it("rejects leading dot", () => {
    expect(isValidRepoName(".hidden")).toBe(false);
  });
  it("rejects leading hyphen", () => {
    expect(isValidRepoName("-start")).toBe(false);
  });
  it("rejects single dot", () => {
    expect(isValidRepoName(".")).toBe(false);
  });
  it("rejects double dot", () => {
    expect(isValidRepoName("..")).toBe(false);
  });
  it("rejects space", () => {
    expect(isValidRepoName("has space")).toBe(false);
  });
  it("rejects slash", () => {
    expect(isValidRepoName("has/slash")).toBe(false);
  });
  it("rejects non-ASCII characters", () => {
    expect(isValidRepoName("emoji🎉")).toBe(false);
  });
});

describe("checkRepoNameAvailable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("short-circuits with reason:invalid for invalid name without calling fetch", async () => {
    const fetchMock = makeFetch({});
    globalThis.fetch = fetchMock;
    const result = await checkRepoNameAvailable(TOKEN, "me", ".bad");
    expect(result).toEqual({ available: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns available:true on HTTP 404", async () => {
    globalThis.fetch = makeFetch({ message: "Not Found" }, 404);
    const result = await checkRepoNameAvailable(TOKEN, "me", "my-site");
    expect(result).toEqual({ available: true });
  });

  it("returns available:false reason:exists on HTTP 200", async () => {
    globalThis.fetch = makeFetch({ id: 1 }, 200);
    const result = await checkRepoNameAvailable(TOKEN, "me", "my-site");
    expect(result).toEqual({ available: false, reason: "exists" });
  });

  it("throws GitHubError on HTTP 500", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    await expect(checkRepoNameAvailable(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      GitHubError,
    );
  });

  it("sends Authorization Bearer header", async () => {
    globalThis.fetch = makeFetch({}, 404);
    await checkRepoNameAvailable(TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

describe("createSiteFromTemplate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns {repoUrl, defaultBranch} on 201", async () => {
    globalThis.fetch = makeFetch(
      { html_url: "https://github.com/me/my-site", default_branch: "main" },
      201,
    );
    const result = await createSiteFromTemplate(TOKEN, "me", "my-site");
    expect(result).toEqual({ repoUrl: "https://github.com/me/my-site", defaultBranch: "main" });
  });

  it("POSTs to the ucsb-amplab/telar generate endpoint", async () => {
    globalThis.fetch = makeFetch(
      { html_url: "https://github.com/me/my-site", default_branch: "main" },
      201,
    );
    await createSiteFromTemplate(TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.github.com/repos/ucsb-amplab/telar/generate");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body as string);
    expect(body.owner).toBe("me");
    expect(body.name).toBe("my-site");
    expect(body.private).toBe(false);
  });

  it("throws RepoNameTakenError on 422", async () => {
    globalThis.fetch = makeFetch({ message: "name already exists" }, 422);
    await expect(createSiteFromTemplate(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      RepoNameTakenError,
    );
  });

  it("throws PermissionDeniedError on 403", async () => {
    globalThis.fetch = makeFetch({ message: "Resource not accessible" }, 403);
    await expect(createSiteFromTemplate(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("throws GitHubError on 500", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    await expect(createSiteFromTemplate(TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      GitHubError,
    );
  });

  it("GitHubError on 500 carries status", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    try {
      await createSiteFromTemplate(TOKEN, "me", "my-site");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubError);
      expect((err as GitHubError).status).toBe(500);
    }
  });
});

describe("waitForRepoReady", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when _config.yml exists on first poll", async () => {
    globalThis.fetch = makeFetch({}, 200);
    await expect(waitForRepoReady(TOKEN, "me", "my-site")).resolves.toBeUndefined();
  });

  it("resolves after several polls once _config.yml exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("swallows transient 5xx mid-poll and continues", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws RepoNotReadyError on 15s timeout", async () => {
    globalThis.fetch = makeFetch({}, 404);

    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    const assertion = expect(promise).rejects.toBeInstanceOf(RepoNotReadyError);
    await vi.advanceTimersByTimeAsync(16000);
    await assertion;
  });

  it("RepoNotReadyError carries lastStatus from most recent poll", async () => {
    globalThis.fetch = makeFetch({}, 404);
    const promise = waitForRepoReady(TOKEN, "me", "my-site");
    const assertion = promise.catch((err) => err);
    await vi.advanceTimersByTimeAsync(16000);
    const err = await assertion;
    expect(err).toBeInstanceOf(RepoNotReadyError);
    expect((err as RepoNotReadyError).lastStatus).toBe(404);
  });

  it("polls the _config.yml contents endpoint", async () => {
    globalThis.fetch = makeFetch({}, 200);
    await waitForRepoReady(TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(
      "https://api.github.com/repos/me/my-site/contents/_config.yml",
    );
  });
});

describe("isRepoInInstallation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const INST_TOKEN = "inst-token-xyz";
  const fullPage = (target?: string) => {
    const repos = Array.from({ length: 100 }, (_, i) => ({
      full_name: `owner/repo-${i}`,
    }));
    if (target) repos[50] = { full_name: target };
    return { total_count: 250, repositories: repos };
  };

  it("returns true when repo is on the first page", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        repositories: [{ full_name: "me/my-site" }],
      }),
    });
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(true);
  });

  it("returns true when repo is on a subsequent page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fullPage(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 150,
          repositories: [{ full_name: "me/my-site" }],
        }),
      });
    globalThis.fetch = fetchMock;
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call should request page=2
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall[0]).toContain("page=2");
  });

  it("returns false when repo is absent and page is not full", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        repositories: [{ full_name: "other/other-repo" }],
      }),
    });
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(false);
  });

  it("walks pages until an empty/short page is seen, then returns false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fullPage() })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 150, repositories: [{ full_name: "o/p" }] }),
      });
    globalThis.fetch = fetchMock;
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws GitHubError on HTTP 500", async () => {
    globalThis.fetch = makeFetch({ message: "boom" }, 500);
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).rejects.toBeInstanceOf(
      GitHubError,
    );
  });

  it("matches case-insensitively", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        repositories: [{ full_name: "Me/My-Site" }],
      }),
    });
    await expect(isRepoInInstallation(INST_TOKEN, "me", "my-site")).resolves.toBe(true);
  });

  it("sends Authorization Bearer header with installation token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ total_count: 0, repositories: [] }),
    });
    await isRepoInInstallation(INST_TOKEN, "me", "my-site");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${INST_TOKEN}`);
  });
});

void TOKEN;
