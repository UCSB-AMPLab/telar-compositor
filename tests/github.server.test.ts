import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listUserInstallations,
  listInstallationRepos,
  getRepoTree,
  getFileContent,
  decodeGitHubContent,
  checkRepoAvailability,
} from "~/lib/github.server";

const TOKEN = "test-token-abc";

function makeFetch(body: unknown, status = 200, linkHeader: string | null = null) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === "link" ? linkHeader : null) },
  });
}

describe("listUserInstallations", () => {
  it("returns installations array from mocked fetch", async () => {
    const installations = [
      { id: 1, account: { login: "user1", avatar_url: "https://example.com/avatar.jpg" } },
    ];
    globalThis.fetch = makeFetch({ installations });

    const result = await listUserInstallations(TOKEN);
    expect(result.installations).toEqual(installations);
  });

  it("includes Authorization Bearer header", async () => {
    globalThis.fetch = makeFetch({ installations: [] });
    await listUserInstallations(TOKEN);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("includes X-GitHub-Api-Version header", async () => {
    globalThis.fetch = makeFetch({ installations: [] });
    await listUserInstallations(TOKEN);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

describe("listInstallationRepos", () => {
  it("returns repositories array with full_name field", async () => {
    const repositories = [
      {
        id: 101,
        name: "my-site",
        full_name: "user1/my-site",
        owner: { login: "user1", avatar_url: "" },
        private: false,
        description: "My Telar site",
      },
    ];
    globalThis.fetch = makeFetch({ repositories });

    const result = await listInstallationRepos(TOKEN, 1);
    expect(result.repositories[0].full_name).toBe("user1/my-site");
  });

  it("includes Authorization Bearer header", async () => {
    globalThis.fetch = makeFetch({ repositories: [] });
    await listInstallationRepos(TOKEN, 42);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("requests per_page=100 to maximise single-page yield", async () => {
    globalThis.fetch = makeFetch({ repositories: [] });
    await listInstallationRepos(TOKEN, 7);
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toContain("per_page=100");
  });

  it("returns only the first page when Link has no rel=next", async () => {
    const repositories = [
      { id: 1, name: "a", full_name: "u/a", owner: { login: "u", avatar_url: "" }, private: false, description: null },
    ];
    globalThis.fetch = makeFetch({ repositories });
    const result = await listInstallationRepos(TOKEN, 1);
    expect(result.repositories).toHaveLength(1);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("follows Link: rel=\"next\" headers across multiple pages and concatenates results", async () => {
    // Two pages. First has a next link to page 2; page 2 has no next link.
    const page1 = [
      { id: 1, name: "a", full_name: "u/a", owner: { login: "u", avatar_url: "" }, private: false, description: null },
    ];
    const page2 = [
      { id: 2, name: "b", full_name: "u/b", owner: { login: "u", avatar_url: "" }, private: false, description: null },
      { id: 3, name: "c", full_name: "u/c", owner: { login: "u", avatar_url: "" }, private: false, description: null },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ repositories: page1 }),
        headers: {
          get: (n: string) => (n.toLowerCase() === "link"
            ? '<https://api.github.com/user/installations/1/repositories?per_page=100&page=2>; rel="next", <https://api.github.com/user/installations/1/repositories?per_page=100&page=2>; rel="last"'
            : null),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ repositories: page2 }),
        headers: { get: () => null },
      });
    globalThis.fetch = fetchMock;

    const result = await listInstallationRepos(TOKEN, 1);
    expect(result.repositories.map((r) => r.full_name)).toEqual(["u/a", "u/b", "u/c"]);
    expect(fetchMock.mock.calls).toHaveLength(2);
    // Second call uses the URL from the Link header
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
  });
});

describe("getRepoTree", () => {
  it("returns tree entries array and truncated flag", async () => {
    const tree = [
      { path: "_config.yml", mode: "100644", type: "blob", sha: "abc123", size: 500 },
      { path: "iiif/objects", mode: "040000", type: "tree", sha: "def456" },
    ];
    globalThis.fetch = makeFetch({ tree, truncated: false });

    const result = await getRepoTree(TOKEN, "user1", "my-site");
    expect(result.tree).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("includes Authorization Bearer and X-GitHub-Api-Version headers", async () => {
    globalThis.fetch = makeFetch({ tree: [], truncated: false });
    await getRepoTree(TOKEN, "owner", "repo");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

describe("getFileContent", () => {
  it("decodes Base64 content correctly", async () => {
    // Base64 for "hello world"
    const base64Content = btoa("hello world");
    globalThis.fetch = makeFetch({
      content: base64Content + "\n",
      encoding: "base64",
    });

    const result = await getFileContent(TOKEN, "owner", "repo", "file.txt");
    expect(result).toBe("hello world");
  });

  it("decodes UTF-8 with accented characters", async () => {
    const text = "café résumé naïve";
    const bytes = new TextEncoder().encode(text);
    const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
    const base64Content = btoa(binary);

    globalThis.fetch = makeFetch({
      content: base64Content,
      encoding: "base64",
    });

    const result = await getFileContent(TOKEN, "owner", "repo", "file.txt");
    expect(result).toBe(text);
  });

  it("returns null for 404 response", async () => {
    globalThis.fetch = makeFetch({}, 404);

    const result = await getFileContent(TOKEN, "owner", "repo", "missing.txt");
    expect(result).toBeNull();
  });

  it("includes Authorization Bearer and X-GitHub-Api-Version headers", async () => {
    globalThis.fetch = makeFetch({ content: btoa("x"), encoding: "base64" });
    await getFileContent(TOKEN, "owner", "repo", "test.txt");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

describe("checkRepoAvailability", () => {
  it("returns 'available' on HTTP 200", async () => {
    globalThis.fetch = makeFetch({ full_name: "owner/repo" }, 200);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toBe("available");
  });

  it("returns 'unavailable' on HTTP 404 (deleted or inaccessible-private)", async () => {
    globalThis.fetch = makeFetch({ message: "Not Found" }, 404);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toBe("unavailable");
  });

  it("returns 'unavailable' on HTTP 403 (access removed)", async () => {
    globalThis.fetch = makeFetch({ message: "Forbidden" }, 403);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toBe("unavailable");
  });

  it("returns 'error' on HTTP 500 (transient — caller fails open)", async () => {
    globalThis.fetch = makeFetch({ message: "Server Error" }, 500);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toBe("error");
  });

  it("returns 'error' when fetch itself rejects (network)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toBe("error");
  });

  it("calls GET /repos/{owner}/{repo} with the Bearer token", async () => {
    globalThis.fetch = makeFetch({}, 200);
    await checkRepoAvailability(TOKEN, "owner", "repo");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.github.com/repos/owner/repo");
    expect((call[1].headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

describe("decodeGitHubContent", () => {
  it("strips newlines and decodes Base64 correctly", () => {
    const original = "line one\nline two";
    const bytes = new TextEncoder().encode(original);
    const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
    // Simulate GitHub's chunked base64 with embedded newlines
    const base64 = btoa(binary);
    const withNewlines = base64.slice(0, 20) + "\n" + base64.slice(20) + "\n";

    const result = decodeGitHubContent(withNewlines);
    expect(result).toBe(original);
  });

  it("handles UTF-8 content with accented characters", () => {
    const text = "título: descripción";
    const bytes = new TextEncoder().encode(text);
    const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
    const base64 = btoa(binary);

    const result = decodeGitHubContent(base64);
    expect(result).toBe(text);
  });
});
