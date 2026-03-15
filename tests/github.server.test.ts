import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listUserInstallations,
  listInstallationRepos,
  getRepoTree,
  getFileContent,
  decodeGitHubContent,
} from "~/lib/github.server";

const TOKEN = "test-token-abc";

function makeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
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
