/**
 * The GitHub API helpers, driven against a fetch mock.
 *
 * Covers the installation and repo listings (including the Link-header
 * pagination that a single page would hide), the recursive tree read and the
 * revision a caller can pin it to, Base64 decoding of UTF-8 bodies, and the
 * repository availability probe.
 *
 * `getFileAtRef` gets its own block for strict mode, which is the contract a
 * caller that REWRITES the file it reads depends on: "absent" narrows to an
 * HTTP 404, and a 200 with no usable body is an error rather than an empty
 * file. The diff's reading of that same response is asserted alongside it, so
 * the two modes cannot drift into one.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listUserInstallations,
  listInstallationRepos,
  getRepoTree,
  getFileContent,
  getFileAtRef,
  decodeGitHubContent,
  checkRepoAvailability,
  commitExists,
  getRepoHead,
  getDefaultBranchHead,
  NoSuchBranchError,
  GitHubPermissionError,
  GitHubTransientError,
  graphqlGitHub,
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

  it("reads HEAD when no ref is given", async () => {
    globalThis.fetch = makeFetch({ tree: [], truncated: false });
    await getRepoTree(TOKEN, "owner", "repo");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/git/trees/HEAD?recursive=1");
  });

  it("reads the given revision, so a caller can pin its reads to one commit", async () => {
    globalThis.fetch = makeFetch({ tree: [], truncated: false });
    await getRepoTree(TOKEN, "owner", "repo", "captured-head-sha");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/git/trees/captured-head-sha?recursive=1");
  });
});

describe("getFileAtRef strict mode", () => {
  // The delete branch REWRITES objects.csv, so it needs "absent" to mean an
  // HTTP 404 and nothing else: a read it misjudges as an empty file would
  // commit the object's images away and leave its row standing.
  const CSV = "object_id,title\nplano,Plano\n";

  function contentsResponse(status: number, body: unknown) {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      headers: { get: () => null },
    });
  }

  it("returns the decoded content for a 200 carrying base64", async () => {
    globalThis.fetch = contentsResponse(200, { content: btoa(CSV), encoding: "base64", size: CSV.length });

    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({
      status: "ok",
      content: CSV,
    });
  });

  it("returns absent for a genuine 404", async () => {
    globalThis.fetch = contentsResponse(404, { message: "Not Found" });

    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({
      status: "absent",
    });
  });

  it("returns error for a rate-limited read rather than an empty file", async () => {
    globalThis.fetch = contentsResponse(429, { message: "Too Many Requests" });

    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({
      status: "error",
    });
  });

  // A directory at the path answers 200 with a listing, which is no file.
  const DIRECTORY = [{ type: "file", name: "a.csv", path: "p.csv/a.csv", size: 10 }];

  it("returns error for a 200 with no usable content", async () => {
    globalThis.fetch = contentsResponse(200, DIRECTORY);

    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({
      status: "error",
    });
  });

  it("leaves the diff's reading of that same 200 alone", async () => {
    // Without strict, an unexpected 200 shape is an empty base: there is
    // nothing to diff against, and the three-way sync says so.
    globalThis.fetch = contentsResponse(200, DIRECTORY);

    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha")).toEqual({
      status: "absent",
    });
  });
});

describe("getFileAtRef checks the base64 content against the file's size", () => {
  const CSV = "object_id,title\nplano,Plano de Santafé\n";
  const SIZE = new TextEncoder().encode(CSV).length;
  const b64 = Buffer.from(CSV, "utf8").toString("base64");

  function answer(size: number) {
    return vi.fn(async () => new Response(JSON.stringify({ type: "file", encoding: "base64", content: b64, size }), { status: 200 }));
  }

  it("reads content whose length is the file's size", async () => {
    globalThis.fetch = answer(SIZE) as unknown as typeof fetch;
    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({ status: "ok", content: CSV });
  });

  it("refuses a strict read whose decoded length differs from the size", async () => {
    globalThis.fetch = answer(SIZE + 5) as unknown as typeof fetch;
    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({ status: "error" });
  });

  it("refuses a strict read whose answer carries no size to check against", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ type: "file", encoding: "base64", content: b64 }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({ status: "error" });
  });

  it("leaves the loose read of that answer alone", async () => {
    globalThis.fetch = answer(SIZE + 5) as unknown as typeof fetch;
    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha")).toEqual({ status: "ok", content: CSV });
  });
});

describe("getFileAtRef on a file of over 1 MB", () => {
  // The Contents API answers a file of 1 MB to 100 MB with its metadata and
  // no content (`encoding: "none"`); the raw media type,
  // `application/vnd.github.raw+json`, returns its bytes (GitHub's REST docs,
  // "Get repository content", custom media types).
  const BIG_CSV = `\uFEFFobject_id,title\n${"plano,Plano de Santafé\n".repeat(60000)}`;
  const BIG_SIZE = new TextEncoder().encode(BIG_CSV).length;
  const LARGE_ANSWER = { type: "file", encoding: "none", content: "", size: BIG_SIZE, sha: "blob" };

  function largeFileFetch(raw: Response) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const accept = (init?.headers as Record<string, string>).Accept;
      if (accept === "application/vnd.github.raw+json") return raw;
      return new Response(JSON.stringify(LARGE_ANSWER), { status: 200 });
    });
  }

  it("reads the file again as raw content at the same ref, and its content matches", async () => {
    const fetchMock = largeFileFetch(new Response(new TextEncoder().encode(BIG_CSV), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(BIG_SIZE).toBeGreaterThan(1024 * 1024);

    expect(await getFileAtRef(TOKEN, "o", "r", "sheets/objects.csv", "sha1", { strict: true })).toEqual({
      status: "ok",
      content: BIG_CSV,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [jsonCall, rawCall] = fetchMock.mock.calls;
    expect(rawCall[0]).toBe(jsonCall[0]);
    expect(rawCall[0]).toContain("/contents/sheets/objects.csv?ref=sha1");
  });

  it("drops the byte-order mark for a reader that parses, as the base64 path does", async () => {
    globalThis.fetch = largeFileFetch(new Response(new TextEncoder().encode(BIG_CSV), { status: 200 })) as unknown as typeof fetch;

    expect(await getFileAtRef(TOKEN, "o", "r", "objects.csv", "sha1")).toEqual({
      status: "ok",
      content: BIG_CSV.replace(/^\uFEFF/, ""),
    });
  });

  it.each([true, false])("is a failed read when the raw read fails (strict %s)", async (strict) => {
    globalThis.fetch = largeFileFetch(new Response("boom", { status: 502 })) as unknown as typeof fetch;

    expect(await getFileAtRef(TOKEN, "o", "r", "objects.csv", "sha1", { strict })).toEqual({ status: "error" });
  });

  it.each([true, false])("refuses a JSON answer to the raw request (strict %s)", async (strict) => {
    const json = new Response(JSON.stringify(LARGE_ANSWER), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    globalThis.fetch = largeFileFetch(json) as unknown as typeof fetch;

    expect(await getFileAtRef(TOKEN, "o", "r", "objects.csv", "sha1", { strict })).toEqual({ status: "error" });
  });

  it.each([true, false])("refuses a raw body shorter than the file's size (strict %s)", async (strict) => {
    const short = new Response(new TextEncoder().encode(BIG_CSV.slice(0, 1000)), { status: 200 });
    globalThis.fetch = largeFileFetch(short) as unknown as typeof fetch;

    expect(await getFileAtRef(TOKEN, "o", "r", "objects.csv", "sha1", { strict })).toEqual({ status: "error" });
  });

  it("reads an empty file as empty, with no second read", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ type: "file", encoding: "base64", content: "", size: 0 }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await getFileAtRef(TOKEN, "o", "r", "objects.csv", "sha1", { strict: true })).toEqual({
      status: "ok",
      content: "",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getFileAtRef says when a strict read decoded lossily", () => {
  // Invalid UTF-8 and the valid encoding of U+FFFD decode to the same text;
  // only the flag tells them apart.
  const HEADER = new TextEncoder().encode("object_id,title\nplano,");
  const INVALID = Uint8Array.of(...HEADER, 0xff, 0x0a);
  const REPLACEMENT = Uint8Array.of(...HEADER, 0xef, 0xbf, 0xbd, 0x0a);
  const TEXT = "object_id,title\nplano,\uFFFD\n";

  function base64Answer(bytes: Uint8Array) {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(bytes).toString("base64"), size: bytes.length }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
  }

  it("flags invalid bytes read strictly, with the text of a non-fatal decode", async () => {
    globalThis.fetch = base64Answer(INVALID);
    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({
      status: "ok",
      content: TEXT,
      lossy: true,
    });
  });

  it("carries no flag for the valid encoding of U+FFFD", async () => {
    globalThis.fetch = base64Answer(REPLACEMENT);
    const read = await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true });
    expect(read).toEqual({ status: "ok", content: TEXT });
    expect(read).not.toHaveProperty("lossy");
  });

  it("keeps the ASCII byte after a sequence cut short", async () => {
    globalThis.fetch = base64Answer(Uint8Array.of(0xe2, 0x41));
    expect(await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true })).toEqual({
      status: "ok",
      content: "\uFFFDA",
      lossy: true,
    });
  });

  it("keeps a leading byte-order mark on clean bytes, with no flag", async () => {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b\n"));
    globalThis.fetch = base64Answer(bytes);
    const read = await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha", { strict: true });
    expect(read).toEqual({ status: "ok", content: "\uFEFFa,b\n" });
    expect(read).not.toHaveProperty("lossy");
  });

  it("never flags a loose read", async () => {
    globalThis.fetch = base64Answer(INVALID);
    const read = await getFileAtRef(TOKEN, "o", "r", "p.csv", "sha");
    expect(read).toEqual({ status: "ok", content: TEXT });
    expect(read).not.toHaveProperty("lossy");
  });

  describe("through the raw path, for a file over 1 MB", () => {
    const PAD = new TextEncoder().encode("plano,Plano de Santafé\n".repeat(60000));

    /** PAD followed by `tail`. */
    function padded(...tail: number[]): Uint8Array<ArrayBuffer> {
      const bytes = new Uint8Array(PAD.length + tail.length);
      bytes.set(PAD);
      bytes.set(tail, PAD.length);
      return bytes;
    }

    function rawAnswer(bytes: Uint8Array<ArrayBuffer>) {
      return vi.fn(async (_url: string, init?: RequestInit) => {
        const accept = (init?.headers as Record<string, string>).Accept;
        if (accept === "application/vnd.github.raw+json") return new Response(bytes, { status: 200 });
        return new Response(JSON.stringify({ type: "file", encoding: "none", content: "", size: bytes.length }), { status: 200 });
      }) as unknown as typeof fetch;
    }

    it("flags invalid bytes", async () => {
      globalThis.fetch = rawAnswer(padded(0xff));
      const read = await getFileAtRef(TOKEN, "o", "r", "objects.csv", "sha", { strict: true });
      expect(read).toMatchObject({ status: "ok", lossy: true });
      expect((read as { content: string }).content.endsWith("\uFFFD")).toBe(true);
    });

    it("carries no flag for the valid encoding of U+FFFD", async () => {
      globalThis.fetch = rawAnswer(padded(0xef, 0xbf, 0xbd));
      const read = await getFileAtRef(TOKEN, "o", "r", "objects.csv", "sha", { strict: true });
      expect(read).toMatchObject({ status: "ok" });
      expect(read).not.toHaveProperty("lossy");
      expect((read as { content: string }).content.endsWith("\uFFFD")).toBe(true);
    });
  });
});

describe("commitExists", () => {
  function commitResponse(status: number) {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify({ sha: "abc" }), { status }));
  }

  it("says a commit GitHub holds exists, asking for that commit", async () => {
    globalThis.fetch = commitResponse(200);
    expect(await commitExists(TOKEN, "o", "r", "abc")).toBe("exists");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.github.com/repos/o/r/git/commits/abc");
  });

  // 404: no such commit.
  it.each([404])("says a commit GitHub answers %s for is missing", async (status) => {
    globalThis.fetch = commitResponse(status);
    expect(await commitExists(TOKEN, "o", "r", "abc")).toBe("missing");
  });

  // A 422 says GitHub would not resolve the request, and a 409 is answered for
  // an unavailable repository as well as an empty one: neither says the commit
  // is gone, so neither proves anything about the base.
  it.each([409, 422, 503, 403])("cannot say for a lookup GitHub answers %s", async (status) => {
    globalThis.fetch = commitResponse(status);
    expect(await commitExists(TOKEN, "o", "r", "abc")).toBe("error");
  });

  it("cannot say for a failed lookup", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network"));
    expect(await commitExists(TOKEN, "o", "r", "abc")).toBe("error");
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

describe("getRepoHead", () => {
  it("answers the branch's head commit", async () => {
    globalThis.fetch = makeFetch({ data: { repository: { ref: { target: { oid: "abc123" } } } } });

    expect(await getRepoHead(TOKEN, "owner", "repo", "main")).toBe("abc123");
  });

  // An empty repository has no branch: GitHub answers the ref as null, which
  // is not a failure to reach it.
  it("throws NoSuchBranchError when the branch does not exist", async () => {
    globalThis.fetch = makeFetch({ data: { repository: { ref: null } } });

    await expect(getRepoHead(TOKEN, "owner", "repo", "main")).rejects.toBeInstanceOf(NoSuchBranchError);
  });

  // `refs/heads/main` names only a branch; the short name also finds a tag.
  it("asks for a qualified ref by that name, and answers NoSuchBranchError when only a tag has it", async () => {
    globalThis.fetch = makeFetch({ data: { repository: { ref: null } } });

    await expect(getRepoHead(TOKEN, "owner", "repo", "refs/heads/main")).rejects.toMatchObject({
      name: "NoSuchBranchError",
      branch: "refs/heads/main",
    });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.variables).toEqual({ owner: "owner", repo: "repo", branch: "refs/heads/main" });
  });

  it("throws another error when GitHub fails", async () => {
    globalThis.fetch = makeFetch({ message: "Bad Gateway" }, 502);

    const read = getRepoHead(TOKEN, "owner", "repo", "main");
    await expect(read).rejects.toThrow("502");
    await expect(read).rejects.not.toBeInstanceOf(NoSuchBranchError);
  });
});

describe("getDefaultBranchHead", () => {
  it("answers the default branch's name and head commit, in one query", async () => {
    globalThis.fetch = makeFetch({
      data: { repository: { defaultBranchRef: { name: "master", target: { oid: "abc123" } } } },
    });

    expect(await getDefaultBranchHead(TOKEN, "owner", "repo")).toEqual({ name: "master", oid: "abc123" });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.query).toMatch(/defaultBranchRef\s*\{\s*name\s+target\s*\{\s*oid/);
    expect(body.variables).toEqual({ owner: "owner", repo: "repo" });
  });

  // An empty repository has no default branch; GitHub answers it as null.
  it("answers null for a repository with no default branch", async () => {
    globalThis.fetch = makeFetch({ data: { repository: { defaultBranchRef: null } } });

    expect(await getDefaultBranchHead(TOKEN, "owner", "repo")).toBeNull();
  });

  it("throws when GitHub fails", async () => {
    globalThis.fetch = makeFetch({ message: "Bad Gateway" }, 502);

    await expect(getDefaultBranchHead(TOKEN, "owner", "repo")).rejects.toThrow("502");
  });
});

describe("checkRepoAvailability", () => {
  it("returns 'available' on HTTP 200, with the body's canonical full_name", async () => {
    globalThis.fetch = makeFetch({ full_name: "owner/repo" }, 200);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toEqual({
      availability: "available",
      canonicalFullName: "owner/repo",
    });
  });

  it("returns the renamed full_name when it differs from the requested owner/repo", async () => {
    globalThis.fetch = makeFetch({ full_name: "owner/new-name" }, 200);
    expect(await checkRepoAvailability(TOKEN, "owner", "old-name")).toEqual({
      availability: "available",
      canonicalFullName: "owner/new-name",
    });
  });

  it("returns 'unavailable' on HTTP 404 (deleted or inaccessible-private)", async () => {
    globalThis.fetch = makeFetch({ message: "Not Found" }, 404);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toEqual({
      availability: "unavailable",
      canonicalFullName: null,
    });
  });

  it("returns 'unavailable' on HTTP 403 (access removed)", async () => {
    globalThis.fetch = makeFetch({ message: "Forbidden" }, 403);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toEqual({
      availability: "unavailable",
      canonicalFullName: null,
    });
  });

  it("returns 'error' on HTTP 500 (transient — caller fails open)", async () => {
    globalThis.fetch = makeFetch({ message: "Server Error" }, 500);
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toEqual({
      availability: "error",
      canonicalFullName: null,
    });
  });

  it("returns 'error' when fetch itself rejects (network)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await checkRepoAvailability(TOKEN, "owner", "repo")).toEqual({
      availability: "error",
      canonicalFullName: null,
    });
  });

  it("calls GET /repos/{owner}/{repo} with the Bearer token", async () => {
    globalThis.fetch = makeFetch({ full_name: "owner/repo" }, 200);
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

describe("graphqlGitHub — a refusal GitHub gives for who is asking", () => {
  it.each([401, 403, 404])("throws GitHubPermissionError for a %i", async (status) => {
    globalThis.fetch = makeFetch({}, status);

    const err = (await graphqlGitHub(TOKEN, "query { viewer { login } }", {}).catch((e: unknown) => e)) as GitHubPermissionError;

    expect(err).toBeInstanceOf(GitHubPermissionError);
    expect(err.status).toBe(status);
    expect(err.message).toBe(`GitHub GraphQL error: ${status}`);
  });

  it("throws GitHubPermissionError for a 403 that carries no rate-limit sign", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => "Resource not accessible by integration",
    });

    const err = (await graphqlGitHub(TOKEN, "query { viewer { login } }", {}).catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(GitHubPermissionError);
  });

  it.each([
    ["a retry-after header", { "retry-after": "60" }, ""],
    ["x-ratelimit-remaining of 0", { "x-ratelimit-remaining": "0" }, ""],
    ["a message naming the limit", {}, "You have exceeded a secondary rate limit."],
  ])("throws GitHubTransientError for a 403 with %s", async (_label, headers, text) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: (name: string) => (headers as Record<string, string>)[name.toLowerCase()] ?? null },
      text: async () => text,
    });

    const err = (await graphqlGitHub(TOKEN, "query { viewer { login } }", {}).catch((e: unknown) => e)) as GitHubTransientError;

    expect(err).toBeInstanceOf(GitHubTransientError);
    expect(err).not.toBeInstanceOf(GitHubPermissionError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("GitHub GraphQL error: 403");
  });

  it("leaves any other rejection a plain Error", async () => {
    globalThis.fetch = makeFetch({}, 422);

    const err = (await graphqlGitHub(TOKEN, "query { viewer { login } }", {}).catch((e: unknown) => e)) as GitHubPermissionError;

    expect(err).not.toBeInstanceOf(GitHubPermissionError);
    expect(err.message).toBe("GitHub GraphQL error: 422");
  });
});
