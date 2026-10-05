/**
 * A Contents API URL reaches the path it names, at the ref it names.
 *
 * A filename is author text, and `#`, `?` and `%` are URL delimiters: left
 * raw, `intro#notes.md?ref=head` reaches the server as the path `intro` with
 * no ref at all. Each path segment is encoded, the `/` between them kept.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { getFileAtRef, getFileContent } from "~/lib/github.server";
import { listRepoDir, readRepoFile } from "~/lib/create-site.server";

let urls: string[];

function stub() {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ encoding: "base64", content: btoa("x") }), { status: 200 });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

const CASES: Array<[string, string]> = [
  ["intro#notes.md", "intro%23notes.md"],
  ["a?b.md", "a%3Fb.md"],
  ["50% off.md", "50%25%20off.md"],
  ["café-ñandú.md", "caf%C3%A9-%C3%B1and%C3%BA.md"],
];

describe("Contents URLs", () => {
  it.each(CASES)("getFileAtRef reads %s at its own path and the pinned ref", async (name, encoded) => {
    stub();
    await getFileAtRef("tok", "owner", "repo", `telar-content/texts/stories/${name}`, "abc123", { strict: true });
    expect(urls).toEqual([
      `https://api.github.com/repos/owner/repo/contents/telar-content/texts/stories/${encoded}?ref=abc123`,
    ]);
    const parsed = new URL(urls[0]);
    expect(parsed.searchParams.get("ref")).toBe("abc123");
    expect(parsed.pathname.split("/").map(decodeURIComponent).pop()).toBe(name);
  });

  it.each(CASES)("getFileContent reads %s at its own path and the given ref", async (name, encoded) => {
    stub();
    await getFileContent("tok", "owner", "repo", `telar-content/texts/stories/${name}`, "abc123");
    expect(urls).toEqual([
      `https://api.github.com/repos/owner/repo/contents/telar-content/texts/stories/${encoded}?ref=abc123`,
    ]);
  });

  it.each(CASES)("site creation reads %s at its own path", async (name, encoded) => {
    stub();
    await readRepoFile("tok", "owner", "my site", `telar-content/texts/stories/${name}`);
    expect(urls).toEqual([
      `https://api.github.com/repos/owner/my%20site/contents/telar-content/texts/stories/${encoded}`,
    ]);
  });

  it.each(CASES)("site creation lists the directory %s at its own path", async (name, encoded) => {
    urls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response("[]", { status: 200 });
      }),
    );
    await listRepoDir("tok", "owner", "my site", `telar-content/texts/stories/${name}`);
    expect(urls).toEqual([
      `https://api.github.com/repos/owner/my%20site/contents/telar-content/texts/stories/${encoded}`,
    ]);
  });

  it("compatibility: keeps a plain path as it was", async () => {
    stub();
    await getFileContent("tok", "owner", "repo", "telar-content/spreadsheets/project.csv");
    expect(urls).toEqual(["https://api.github.com/repos/owner/repo/contents/telar-content/spreadsheets/project.csv"]);
  });
});
