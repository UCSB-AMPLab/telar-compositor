/**
 * `getFileOnDefaultBranch` keeps a file that is not there (404) apart from a
 * read that failed, where `getFileContent` answers null for both.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getFileOnDefaultBranch } from "~/lib/github.server";

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

const replyFromGitHub = (status: number, body: unknown = {}) =>
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("getFileOnDefaultBranch", () => {
  it.each([500, 503, 429, 403])("reads a %i as an error, not as absent", async (status) => {
    replyFromGitHub(status);
    expect(await getFileOnDefaultBranch("t", "o", "r", "_config.yml")).toEqual({ status: "error" });
  });

  it("reads a request that never completes as an error", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    expect(await getFileOnDefaultBranch("t", "o", "r", "_config.yml")).toEqual({ status: "error" });
  });

  it("reads a 404 as absent, and asks for no ref", async () => {
    replyFromGitHub(404);
    expect(await getFileOnDefaultBranch("t", "o", "r", "_config.yml")).toEqual({ status: "absent" });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://api.github.com/repos/o/r/contents/_config.yml");
  });

  it.each([
    ["no content", {}],
    ["a content that is not base64", { encoding: "utf-8", content: "text", size: 4 }],
    ["a content shorter than its size", { encoding: "base64", content: Buffer.from("ab").toString("base64"), size: 9 }],
    ["no size", { encoding: "base64", content: Buffer.from("ab").toString("base64") }],
  ])("reads a 200 with %s as an error, not as absent", async (_name, body) => {
    replyFromGitHub(200, body);
    expect(await getFileOnDefaultBranch("t", "o", "r", "_config.yml")).toEqual({ status: "error" });
  });

  it("returns the decoded text of a file it read", async () => {
    const text = "google_sheets:\n  enabled: yes\n";
    replyFromGitHub(200, { encoding: "base64", content: Buffer.from(text).toString("base64"), size: text.length });
    expect(await getFileOnDefaultBranch("t", "o", "r", "_config.yml")).toEqual({ status: "ok", content: text });
  });
});

describe("the objects page's commit dialog (text check)", () => {
  it("drops an earlier check's answer when the current one could not be made", () => {
    const page = readFileSync(join(__dirname, "../app/routes/_app.objects.tsx"), "utf8");
    expect(page).toMatch(/if \(preCheckFailed\) setCheckedSite\(null\);/);
  });
});
