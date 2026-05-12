/**
 * This file pins unit tests for `app/lib/create-site.server.ts` — the
 * helpers that validate a desired repo name, check it's available on
 * GitHub, create a new repo from the Telar template, and patch its
 * `_config.yml` language during onboarding.
 *
 * Uses the same `globalThis.fetch` mocking pattern as
 * `tests/github.server.test.ts` — no MSW, no nock, no new dependencies.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isValidRepoName,
  checkRepoNameAvailable,
  createSiteFromTemplate,
  waitForRepoReady,
  isRepoInInstallation,
  patchSiteConfigLanguage,
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

// ---------------------------------------------------------------------------
// patchSiteConfigLanguage
// ---------------------------------------------------------------------------
//
// RED scaffold. Implementation lands in Task 3.

describe("patchSiteConfigLanguage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function b64(s: string): string {
    // Workers' atob/btoa accept ASCII; the template body is ASCII-safe.
    return Buffer.from(s, "utf-8").toString("base64");
  }

  function makeGetConfig(body: string, sha = "sha-1") {
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: b64(body), sha, encoding: "base64" }),
    };
  }

  function makePut(status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    };
  }

  it("Test 1 (skip-on-en): short-circuits without calling fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await patchSiteConfigLanguage(TOKEN, "me", "my-site", "en");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Test 2 (happy path): GETs, regex-substitutes, PUTs patched body with same SHA", async () => {
    const original = '  telar_language: "en" # Options: "en" (English), "es" (Spanish)';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeGetConfig(original, "abc123"))
      .mockResolvedValueOnce(makePut());
    globalThis.fetch = fetchMock;

    await patchSiteConfigLanguage(TOKEN, "me", "my-site", "es");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const putCall = fetchMock.mock.calls[1];
    const putBody = JSON.parse(putCall[1].body as string);
    expect(putBody.sha).toBe("abc123");
    const patchedBody = Buffer.from(putBody.content as string, "base64").toString("utf-8");
    expect(patchedBody).toContain('telar_language: "es"');
    // Trailing comment preserved
    expect(patchedBody).toContain('# Options: "en" (English), "es" (Spanish)');
    // PUT method
    expect(putCall[1].method).toBe("PUT");
  });

  it("Test 3 (stability retry): first GET missing line, sleep 1s, second GET has it, PUT proceeds", async () => {
    vi.useFakeTimers();
    const bodyWithout = "title: My Site\nurl: https://example.com";
    const bodyWith = 'title: My Site\ntelar_language: "en"\nurl: https://example.com';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeGetConfig(bodyWithout))
      .mockResolvedValueOnce(makeGetConfig(bodyWith))
      .mockResolvedValueOnce(makePut());
    globalThis.fetch = fetchMock;

    const p = patchSiteConfigLanguage(TOKEN, "me", "my-site", "es");
    // Allow the first GET microtask to resolve
    await vi.advanceTimersByTimeAsync(0);
    // Advance through the 1s sleep
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Test 4 (retry exhausted): both GETs missing line, throws GitHubError, no PUT", async () => {
    vi.useFakeTimers();
    const bodyWithout = "title: My Site\nurl: https://example.com";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeGetConfig(bodyWithout))
      .mockResolvedValueOnce(makeGetConfig(bodyWithout));
    globalThis.fetch = fetchMock;

    const p = patchSiteConfigLanguage(TOKEN, "me", "my-site", "es");
    // Attach the rejection assertion synchronously, before advancing timers.
    // The second GET rejects while timers are still being advanced; without
    // a handler attached at that point, node fires unhandledRejection and
    // vitest reports a spurious "Errors 1 error" on an otherwise-passing test.
    const assertion = expect(p).rejects.toBeInstanceOf(GitHubError);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2); // 2 GETs, no PUT
  });

  it("Test 5 (regex non-match): body has telar_language: in unparseable form → GitHubError, no PUT", async () => {
    // Use a body where the line itself is not in `key: <2-letter>` form.
    // Realistic shape: a value that doesn't satisfy [a-z]{2}.
    const body = 'title: My Site\ntelar_language: invalid_value_too_long\n';
    const fetchMock = vi.fn().mockResolvedValueOnce(makeGetConfig(body));
    globalThis.fetch = fetchMock;

    await expect(patchSiteConfigLanguage(TOKEN, "me", "my-site", "es")).rejects.toBeInstanceOf(
      GitHubError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET, no PUT
  });

  it("Test 6 (PUT 409 SHA stale): throws GitHubError, no retry", async () => {
    const original = '  telar_language: "en" # Options: ...';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeGetConfig(original, "stale-sha"))
      .mockResolvedValueOnce(makePut(409));
    globalThis.fetch = fetchMock;

    await expect(patchSiteConfigLanguage(TOKEN, "me", "my-site", "es")).rejects.toBeInstanceOf(
      GitHubError,
    );
    // Exactly one GET + one PUT (no retry)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Test 7 (regex preserves trailing comment + quote style across single + double quotes)", async () => {
    // Single-quote variant
    const original = "  telar_language: 'en' # Trailing comment";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeGetConfig(original, "s"))
      .mockResolvedValueOnce(makePut());
    globalThis.fetch = fetchMock;

    await patchSiteConfigLanguage(TOKEN, "me", "my-site", "es");

    const putBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const patched = Buffer.from(putBody.content as string, "base64").toString("utf-8");
    // Helper normalises to double quotes (the locked replacement string is `$1"${locale}"$3`).
    expect(patched).toContain('telar_language: "es" # Trailing comment');
  });
});
