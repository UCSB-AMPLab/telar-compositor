/**
 * This file tests that every primitive that encodes file content for GitHub
 * cleans an author file of the characters a Telar build rejects, commits a
 * framework file byte for byte, and never changes a path. It also drives the
 * object deletion, a writer that carries repository text forward, through the
 * real primitive.
 *
 * Everything runs against a mocked global fetch, and the assertions decode the
 * content actually sent to GitHub.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { commitFilesToRepo, cleanCommitContent } from "~/lib/commit.server";
import { commitBinaryFileWithCsv, commitMultipleBinaryFilesWithCsv } from "~/lib/upload.server";
import { deleteObjectFromRepository } from "~/lib/object-repo-delete.server";

const TOKEN = "test-token";
const OWNER = "me";
const REPO = "my-site";
const CSV_PATH = "telar-content/spreadsheets/objects.csv";

/** Carries one removed member, one separating member and a lone surrogate. */
const DIRTY = "title\nMediterr\ufffeanean\u2028sea \ud800end\n";
const CLEANED = "title\nMediterranean sea \ufffdend\n";

/**
 * A framework file's unsafe characters. No lone surrogate: `encodeURIComponent`
 * throws on one, so a framework file carrying one cannot be committed at all.
 */
const FRAMEWORK_TEXT = "var s = '\ufffe\u2028\u0085';\n";

function decode(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf-8");
}

function jsonRes(obj: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => "" };
}

/** A GraphQL fetch that answers the head lookup, the deletion probe and the commit. */
function graphqlFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const query = String(body.query);
    if (query.includes("GetHeadOid")) {
      return jsonRes({ data: { repository: { ref: { target: { oid: "head-oid" } } } } });
    }
    if (query.includes("CheckPaths")) {
      const repository: Record<string, { __typename: string }> = {};
      for (const key of Object.keys(body.variables ?? {})) {
        if (/^p\d+$/.test(key)) repository[key] = { __typename: "Blob" };
      }
      return jsonRes({ data: { repository } });
    }
    return jsonRes({ data: { createCommitOnBranch: { commit: { oid: "new-oid", url: "u" } } } });
  });
}

function commitAdditions(fetchMock: ReturnType<typeof vi.fn>): Array<{ path: string; contents: string }> {
  for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
    if (!String(url).endsWith("/graphql")) continue;
    const body = JSON.parse((init.body as string) ?? "{}");
    if (String(body.query).includes("CreateCommit")) return body.variables.input.fileChanges.additions;
  }
  throw new Error("no CreateCommit call found");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("cleanCommitContent", () => {
  it("cleans a non-framework path and leaves a framework path alone", () => {
    expect(cleanCommitContent(CSV_PATH, DIRTY)).toBe(CLEANED);
    expect(cleanCommitContent("_config.yml", DIRTY)).toBe(CLEANED);
    expect(cleanCommitContent("_data/navigation.yml", FRAMEWORK_TEXT)).toBe(FRAMEWORK_TEXT);
    expect(cleanCommitContent("_layouts/story.html", FRAMEWORK_TEXT)).toBe(FRAMEWORK_TEXT);
  });

  it("leaves a dotfile alone, whose lines are exact paths", () => {
    const ignored = `telar-content/spreadsheets/a${"\ufffe"}b.csv\n`;
    expect(cleanCommitContent(".compositor-ignored", ignored)).toBe(ignored);
    expect(cleanCommitContent(".gitignore", ignored)).toBe(ignored);
    expect(cleanCommitContent("telar-content/.notes", ignored)).toBe(ignored);
  });
});

describe("commitFilesToRepo cleans author files only", () => {
  it("cleans each non-framework file, commits framework files byte for byte, and keeps every path", async () => {
    const fetchMock = graphqlFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const files = [
      { path: "telar-content/texts/stories/historia/paso-1.md", content: DIRTY },
      { path: "_config.yml", content: DIRTY },
      { path: "_data/navigation.yml", content: FRAMEWORK_TEXT },
      { path: "assets/js/telar.js", content: FRAMEWORK_TEXT },
    ];
    await commitFilesToRepo(TOKEN, OWNER, REPO, "main", files, "Publish");

    const additions = commitAdditions(fetchMock);
    expect(additions.map((a) => a.path)).toEqual(files.map((f) => f.path));
    expect(decode(additions[0].contents)).toBe(CLEANED);
    expect(decode(additions[1].contents)).toBe(CLEANED);
    expect(decode(additions[2].contents)).toBe(FRAMEWORK_TEXT);
    expect(decode(additions[3].contents)).toBe(FRAMEWORK_TEXT);
  });

  it("sends clean text unchanged", async () => {
    const fetchMock = graphqlFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const content = "object_id,title\r\nobj-001,Ánfora de terracota\r\n";

    await commitFilesToRepo(TOKEN, OWNER, REPO, "main", [{ path: CSV_PATH, content }], "Commit");

    expect(decode(commitAdditions(fetchMock)[0].contents)).toBe(content);
  });
});

/** A Git Data API fetch that records each blob body and the tree it builds. */
function gitDataFetch(imageCount: number) {
  const blobBodies: Array<{ content: string; encoding: string }> = [];
  let treeBody: { tree: Array<{ path: string; sha: string }> } | null = null;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/git/ref/") && method === "GET") return jsonRes({ object: { sha: "head123" } });
    if (url.includes("/git/commits/head123")) return jsonRes({ tree: { sha: "tree456" } });
    if (url.includes("/git/blobs") && method === "POST") {
      blobBodies.push(JSON.parse(init!.body as string));
      const n = blobBodies.length;
      return jsonRes({ sha: n <= imageCount ? `imgblob${n}` : "csvblob" }, 201);
    }
    if (url.includes("/git/trees") && method === "POST") {
      treeBody = JSON.parse(init!.body as string);
      return jsonRes({ sha: "newtree" }, 201);
    }
    if (url.includes("/git/commits") && method === "POST") return jsonRes({ sha: "newcommit" }, 201);
    if (url.includes("/git/refs/") && method === "PATCH") return jsonRes({ object: { sha: "newcommit" } });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { fetchMock, blobBodies, tree: () => treeBody };
}

describe("upload commits clean the CSV and never the image", () => {
  const IMAGE_BASE64 = Buffer.from([0xff, 0xd8, 0xef, 0xbf, 0xbe, 0xc2, 0x85, 0x00]).toString("base64");

  it("commitBinaryFileWithCsv", async () => {
    const { fetchMock, blobBodies, tree } = gitDataFetch(1);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await commitBinaryFileWithCsv({
      token: TOKEN, owner: OWNER, repo: REPO, branch: "main",
      imagePath: "telar-content/objects/mapa/mapa.jpg",
      imageBase64: IMAGE_BASE64,
      csvPath: "telar-content/spreadsheets/objects.csv",
      csvContent: DIRTY,
      commitMessage: "Add image",
    });

    expect(blobBodies[0].content).toBe(IMAGE_BASE64);
    expect(decode(blobBodies[1].content)).toBe(CLEANED);
    expect(tree()!.tree.map((e) => e.path)).toEqual(["telar-content/objects/mapa/mapa.jpg", CSV_PATH]);
  });

  it("commitMultipleBinaryFilesWithCsv", async () => {
    const { fetchMock, blobBodies, tree } = gitDataFetch(2);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await commitMultipleBinaryFilesWithCsv({
      token: TOKEN, owner: OWNER, repo: REPO, branch: "main",
      images: [
        { imagePath: "telar-content/objects/uno/uno.jpg", imageBase64: IMAGE_BASE64 },
        { imagePath: "telar-content/objects/dos/dos.png", imageBase64: IMAGE_BASE64 },
      ],
      csvPath: "telar-content/spreadsheets/objects.csv",
      csvContent: DIRTY,
      commitMessage: "Add images",
    });

    expect(blobBodies[0].content).toBe(IMAGE_BASE64);
    expect(blobBodies[1].content).toBe(IMAGE_BASE64);
    expect(decode(blobBodies[2].content)).toBe(CLEANED);
    expect(tree()!.tree.map((e) => e.path)).toEqual([
      "telar-content/objects/uno/uno.jpg",
      "telar-content/objects/dos/dos.png",
      CSV_PATH,
    ]);
  });
});

describe("the object deletion cleans the rows it carries forward", () => {
  it("commits objects.csv without the unsafe characters another row held", async () => {
    const csv =
      "object_id,title\r\n" +
      "mapa-de-santafe,Mapa de Santaf\ufffeé\u000c1791\r\n" +
      "plano-de-tunja,Plano de Tunja\r\n";
    const graphql = graphqlFetch();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/graphql")) return graphql(url, init);
      if (url.includes("/git/trees/")) {
        return jsonRes({
          truncated: false,
          tree: [{ path: "telar-content/objects/plano-de-tunja/plano-de-tunja.jpg", type: "blob", mode: "100644", sha: "x" }],
        });
      }
      if (url.includes(`/contents/${CSV_PATH}`)) {
        return jsonRes({ content: Buffer.from(csv, "utf-8").toString("base64"), encoding: "base64", size: Buffer.byteLength(csv, "utf8") });
      }
      // The site's version, read at the same revision: none named, so D1's.
      if (url.includes("/contents/_config.yml")) return new Response("", { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await deleteObjectFromRepository({
      readToken: TOKEN, commitToken: TOKEN, owner: OWNER, repo: REPO, objectId: "plano-de-tunja",
    });

    expect(result).toEqual({ ok: true, headSha: "new-oid", parentSha: "head-oid" });
    const additions = graphql.mock.calls
      .map(([, init]) => JSON.parse((init?.body as string) ?? "{}"))
      .find((b) => String(b.query).includes("CreateCommit")).variables.input.fileChanges.additions;
    expect(additions.map((a: { path: string }) => a.path)).toEqual([CSV_PATH]);
    expect(decode(additions[0].contents)).toBe("object_id,title\r\nmapa-de-santafe,Mapa de Santafé 1791\r\n");
  });
});
