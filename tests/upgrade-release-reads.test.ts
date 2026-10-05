/**
 * A framework release file as the upgrade and the publish-time heal read it.
 *
 * A file the upgrade writes is the release's bytes, a leading byte-order mark
 * included, so its blob is the release's; a file prepare parses is read
 * without the mark. A file of 1 MB or more, whose JSON answer carries no
 * content, is read again as raw bytes. An answer whose bytes are not the
 * file's `size` is a failed read. The path and the tag reach GitHub encoded.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchFrameworkFile,
  computeUpgradeDiff,
  fetchFrameworkFilesAtVersion,
  mergeUpgradeChanges,
  healMissingFrameworkFiles,
  FRAMEWORK_FILES,
} from "~/lib/upgrade.server";
import { commitFilesToRepo, type CommitFile } from "~/lib/commit.server";
import { ReleaseFileUnreadableError } from "~/lib/upgrade-reads.server";

const TAG = "v1.8.0";
const BOM = "﻿";
const API = "https://api.github.com/repos/UCSB-AMPLab/telar";

afterEach(() => vi.unstubAllGlobals());

/** The UTF-8 bytes of `text`, a leading U+FEFF encoded as EF BB BF. */
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function base64Of(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The git blob hash of `bytes`, as a tree lists it. */
function blobShaOf(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** The base64 contents `commitFilesToRepo` sends for each path, from the mutation it posts. */
async function committedContents(files: CommitFile[]): Promise<Record<string, string>> {
  let input: { fileChanges: { additions: Array<{ path: string; contents: string }> } } | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      input = JSON.parse(String(init?.body)).variables.input;
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: "new-head" } } } });
    }),
  );
  await commitFilesToRepo("tok", "owner", "site", "main", files, "Upgrade", undefined, undefined, undefined, "head-oid");
  return Object.fromEntries((input?.fileChanges.additions ?? []).map((a) => [a.path, a.contents]));
}

/** A Contents API JSON answer for a file of `bytes`, as GitHub sends it. */
function contentsAnswer(bytes: Uint8Array): Response {
  return Response.json({ type: "file", encoding: "base64", content: base64Of(bytes), size: bytes.length });
}

/** The JSON answer for a file of 1 MB or more: no content, the real size. */
function largeFileAnswer(size: number): Response {
  return Response.json({ type: "file", encoding: "none", content: "", size });
}

function rawContentResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": "application/vnd.github.raw" } });
}

/** A fetch that answers each Contents URL from `files`, raw when asked for raw. */
function stubContents(files: Record<string, Uint8Array<ArrayBuffer>>, options: { large?: string[] } = {}) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const accept = (init?.headers as Record<string, string> | undefined)?.Accept ?? "";
      const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1] ?? "");
      const bytes = files[path];
      if (!bytes) return new Response("{}", { status: 404 });
      if (options.large?.includes(path)) {
        return accept.includes("raw") ? rawContentResponse(bytes) : largeFileAnswer(bytes.length);
      }
      return contentsAnswer(bytes);
    }),
  );
  return urls;
}

describe("fetchFrameworkFile", () => {
  it("keeps a leading byte-order mark for a file that is written", async () => {
    stubContents({ "_includes/head.html": utf8(`${BOM}<head></head>\n`) });
    const file = await fetchFrameworkFile("tok", "_includes/head.html", TAG, { write: true });
    expect(file).toEqual({ kind: "found", content: `${BOM}<head></head>\n` });
  });

  it("reads a file without its byte-order mark for a caller that parses it", async () => {
    stubContents({ "scripts/dev-only-files.txt": utf8(`${BOM}audit/\n`) });
    const file = await fetchFrameworkFile("tok", "scripts/dev-only-files.txt", TAG);
    expect(file).toEqual({ kind: "found", content: "audit/\n" });
  });

  it("reads a file of 1 MB or more as raw bytes", async () => {
    const big = utf8(`${BOM}${"x".repeat(1024 * 1024 + 5)}`);
    stubContents({ "assets/js/telar-story.js.map": big }, { large: ["assets/js/telar-story.js.map"] });
    const file = await fetchFrameworkFile("tok", "assets/js/telar-story.js.map", TAG, { write: true });
    expect(file.kind).toBe("found");
    expect(file.kind === "found" && file.content.length).toBe(big.length - 3 + 1);
    expect(file.kind === "found" && file.content.startsWith(BOM)).toBe(true);
  });

  it("fails a read whose bytes are fewer than the file's size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ type: "file", encoding: "base64", content: base64Of(utf8("part")), size: 4096 })),
    );
    expect(await fetchFrameworkFile("tok", "_layouts/default.html", TAG)).toEqual({ kind: "failed" });
  });

  it("reads bytes that are not UTF-8 as the file's bytes, for a caller that writes it", async () => {
    stubContents({ "assets/js/x.js": new Uint8Array([0x61, 0xff, 0x62]) });
    expect(await fetchFrameworkFile("tok", "assets/js/x.js", TAG, { write: true })).toEqual({
      kind: "found",
      content: base64Of(new Uint8Array([0x61, 0xff, 0x62])),
      encoding: "base64",
    });
  });

  it("fails bytes that are not UTF-8 for a caller that parses them", async () => {
    stubContents({ "assets/js/x.js": new Uint8Array([0x61, 0xff, 0x62]) });
    expect(await fetchFrameworkFile("tok", "assets/js/x.js", TAG)).toEqual({ kind: "failed" });
  });

  it("answers absent only for a 404", async () => {
    stubContents({});
    expect(await fetchFrameworkFile("tok", "_includes/gone.html", TAG)).toEqual({ kind: "absent" });
  });

  it.each([
    ["_includes/intro#notes.html", "_includes/intro%23notes.html"],
    ["_includes/a?b.html", "_includes/a%3Fb.html"],
    ["assets/50% off.css", "assets/50%25%20off.css"],
  ])("reads %s at its own path and the release tag", async (path, encoded) => {
    const urls = stubContents({ [path]: utf8("x") });
    const file = await fetchFrameworkFile("tok", path, "v1.8.0+build#1");
    expect(file).toEqual({ kind: "found", content: "x" });
    expect(urls).toEqual([`${API}/contents/${encoded}?ref=v1.8.0%2Bbuild%231`]);
    expect(new URL(urls[0]).searchParams.get("ref")).toBe("v1.8.0+build#1");
  });
});

describe("the upgrade's release downloads", () => {
  /**
   * The release at `tag`: its tree answers only at the tag's own encoded
   * path with `?recursive=1`, and every file's tree entry carries its blob.
   */
  function stubRelease(
    files: Record<string, Uint8Array<ArrayBuffer>>,
    options: { large?: string[]; tag?: string } = {},
  ) {
    const tag = options.tag ?? TAG;
    const tree = Object.entries(files).map(([path, bytes]) => ({ path, type: "blob", sha: blobShaOf(bytes), mode: "100644" }));
    const contents = stubContents(files, options);
    const contentsFetch = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/git/trees/")) {
          return url === `${API}/git/trees/${encodeURIComponent(tag)}?recursive=1`
            ? Response.json({ tree, truncated: false })
            : new Response("{}", { status: 404 });
        }
        return contentsFetch(input, init);
      }),
    );
    return contents;
  }

  it("reads the tree of a release whose tag holds a URL delimiter", async () => {
    stubRelease({ "_layouts/default.html": utf8("<html></html>\n") }, { tag: "v1.8.0+build#1" });
    const diff = await computeUpgradeDiff("tok", [], "v1.8.0+build#1");
    expect(diff.additions.map((f) => f.path)).toEqual(["_layouts/default.html"]);
  });

  it("delivers the framework's calib-square.png byte for byte, its blob the release's", async () => {
    const png = new Uint8Array(readFileSync(join(__dirname, "fixtures/upgrade-1.8.0/calib-square.png")));
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    stubRelease({ "assets/images/calib-square.png": png });
    const diff = await computeUpgradeDiff("tok", [], TAG);
    expect(diff.additions).toHaveLength(1);
    const [added] = diff.additions;
    expect(added.encoding).toBe("base64");
    expect(blobShaOf(Buffer.from(added.content, "base64"))).toBe("211d4337793aca24ba092c8424fc98af034e5f81");

    const sent = await committedContents([added]);
    expect(blobShaOf(Buffer.from(sent["assets/images/calib-square.png"], "base64"))).toBe(
      "211d4337793aca24ba092c8424fc98af034e5f81",
    );
  });

  it("commits a text file with a byte-order mark with its mark", async () => {
    const text = utf8(`${BOM}<html></html>\n`);
    stubRelease({ "_layouts/default.html": text });
    const diff = await computeUpgradeDiff("tok", [], TAG);
    const sent = await committedContents(diff.additions);
    expect(blobShaOf(Buffer.from(sent["_layouts/default.html"], "base64"))).toBe(blobShaOf(text));
  });

  it("keeps a binary release file binary through the merge with the manifest's files", () => {
    const merged = mergeUpgradeChanges(
      { additions: [{ path: "assets/images/a.png", content: "iVBORw==", encoding: "base64" }], deletions: [] },
      { files: new Map([["_config.yml", "title: x\n"]]), deletions: [] },
      { tree: [], truncated: false },
    );
    expect(merged.additions).toEqual([
      { path: "assets/images/a.png", content: "iVBORw==", encoding: "base64" },
      { path: "_config.yml", content: "title: x\n" },
    ]);
  });

  it("delivers a release file with its byte-order mark", async () => {
    stubRelease({ "_layouts/default.html": utf8(`${BOM}<html></html>\n`) });
    const diff = await computeUpgradeDiff("tok", [], TAG);
    expect(diff.additions).toEqual([{ path: "_layouts/default.html", content: `${BOM}<html></html>\n` }]);
  });

  it("delivers a release file of 1 MB or more", async () => {
    const big = utf8("y".repeat(1024 * 1024 + 1));
    stubRelease({ "assets/js/telar-story.js.map": big }, { large: ["assets/js/telar-story.js.map"] });
    const diff = await computeUpgradeDiff("tok", [], TAG);
    expect(diff.additions.map((f) => [f.path, f.content.length])).toEqual([
      ["assets/js/telar-story.js.map", big.length],
    ]);
  });

  it("stops on a release file answered short of its size", async () => {
    stubRelease({ "_layouts/default.html": utf8("<html></html>\n") });
    const inner = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/contents/")
          ? Response.json({ type: "file", encoding: "base64", content: base64Of(utf8("<ht")), size: 14 })
          : inner(input, init),
      ),
    );
    await expect(computeUpgradeDiff("tok", [], TAG)).rejects.toBeInstanceOf(ReleaseFileUnreadableError);
  });

  it("parses a developer-only list that starts with a byte-order mark", async () => {
    stubRelease({
      "scripts/dev-only-files.txt": utf8(`${BOM}scripts/audit.py\n`),
      "scripts/audit.py": utf8("print()\n"),
      "scripts/build.py": utf8("print()\n"),
    });
    const diff = await computeUpgradeDiff("tok", [], TAG);
    expect(diff.additions.map((f) => f.path)).not.toContain("scripts/audit.py");
    expect(diff.additions.map((f) => f.path)).toContain("scripts/build.py");
  });
});

describe("the publish-time heal's release downloads", () => {
  it("restores a binary release file as its bytes", async () => {
    const png = new Uint8Array(readFileSync(join(__dirname, "fixtures/upgrade-1.8.0/calib-square.png")));
    stubContents({ "assets/images/calib-square.png": png });
    const [file] = await fetchFrameworkFilesAtVersion("tok", ["assets/images/calib-square.png"], TAG);
    expect(file.encoding).toBe("base64");
    expect(blobShaOf(Buffer.from(file.content, "base64"))).toBe("211d4337793aca24ba092c8424fc98af034e5f81");
  });

  // The heal restores only the listed framework files, none of which is binary
  // in any release; the PNG's bytes stand in for one here, so the heal's
  // missing-file path is driven through to the commit with bytes that are not text.
  it("commits a restored binary file with the release's bytes", async () => {
    const png = new Uint8Array(readFileSync(join(__dirname, "fixtures/upgrade-1.8.0/calib-square.png")));
    const siteTree = FRAMEWORK_FILES.filter((path) => path !== "NOTICE").map((path) => ({
      path,
      type: "blob",
      sha: `sha-${path}`,
      mode: "100644",
    }));
    const contents = stubContents({ NOTICE: png });
    const contentsFetch = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/owner/site/git/trees/publish-sha?recursive=1") {
          return Response.json({ tree: siteTree, truncated: false });
        }
        if (url === `${API}/releases/tags/${TAG}`) return Response.json({ tag_name: TAG });
        return contentsFetch(input, init);
      }),
    );
    const healed = await healMissingFrameworkFiles("install-tok", "owner", "site", TAG, "tok", undefined, "publish-sha");
    expect(healed.map((f) => f.path)).toEqual(["NOTICE"]);
    expect(contents).toContain(`${API}/contents/NOTICE?ref=${TAG}`);

    const sent = await committedContents(healed);
    expect(blobShaOf(Buffer.from(sent.NOTICE, "base64"))).toBe("211d4337793aca24ba092c8424fc98af034e5f81");
  });

  it("restores a release file with its byte-order mark", async () => {
    stubContents({ NOTICE: utf8(`${BOM}NOTICE TEXT\n`) });
    expect(await fetchFrameworkFilesAtVersion("tok", ["NOTICE"], TAG)).toEqual([
      { path: "NOTICE", content: `${BOM}NOTICE TEXT\n` },
    ]);
  });
});
