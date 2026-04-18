import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  arrayBufferToBase64,
  validateUploadFile,
  commitBinaryFileWithCsv,
  commitMultipleBinaryFilesWithCsv,
  ACCEPTED_TYPES,
  MAX_SIZE_BYTES,
} from "~/lib/upload.server";
import { StaleHeadError } from "~/lib/commit.server";

const TOKEN = "test-token-xyz";
const OWNER = "testuser";
const REPO = "my-telar-site";
const BRANCH = "main";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

/**
 * Builds a sequential mock fetch that routes responses based on URL patterns.
 * Also tracks call order for verifying API sequence.
 */
function makeUploadFetch(options: { refStatus?: number } = {}) {
  const calls: string[] = [];

  // Track blob call count separately to distinguish first vs second blob call
  let blobCallCount = 0;

  const mockFetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
    calls.push(url);

    // GET /git/ref/heads/{branch}
    if (url.includes("/git/ref/") && (!opts?.method || opts.method === "GET")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: { sha: "head123" } }),
        text: async () => "",
      };
    }

    // GET /git/commits/head123 — fetch commit to get tree SHA
    if (url.includes("/git/commits/head123")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tree: { sha: "tree456" } }),
        text: async () => "",
      };
    }

    // POST /git/blobs — first call returns image blob SHA, second returns CSV blob SHA
    if (url.includes("/git/blobs") && opts?.method === "POST") {
      blobCallCount++;
      if (blobCallCount === 1) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ sha: "imgblob789" }),
          text: async () => "",
        };
      } else {
        return {
          ok: true,
          status: 201,
          json: async () => ({ sha: "csvblob012" }),
          text: async () => "",
        };
      }
    }

    // POST /git/trees
    if (url.includes("/git/trees") && opts?.method === "POST") {
      return {
        ok: true,
        status: 201,
        json: async () => ({ sha: "newtree345" }),
        text: async () => "",
      };
    }

    // POST /git/commits (create commit — not GET)
    if (url.includes("/git/commits") && opts?.method === "POST") {
      return {
        ok: true,
        status: 201,
        json: async () => ({ sha: "newcommit678" }),
        text: async () => "",
      };
    }

    // PATCH /git/refs/heads/{branch}
    if (url.includes("/git/refs/") && opts?.method === "PATCH") {
      const status = options.refStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ object: { sha: "newcommit678" } }),
        text: async () => status === 422 ? "Reference update failed" : "",
      };
    }

    // Fallback
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: "Not found" }),
      text: async () => "Not found",
    };
  });

  return { mockFetch, calls };
}

// ---------------------------------------------------------------------------
// arrayBufferToBase64 tests
// ---------------------------------------------------------------------------

describe("arrayBufferToBase64", () => {
  it("Test 1: encodes a 0-byte buffer to empty string", () => {
    const buffer = new ArrayBuffer(0);
    expect(arrayBufferToBase64(buffer)).toBe("");
  });

  it("Test 2: encodes a small buffer [72, 101, 108, 108, 111] to 'SGVsbG8='", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    expect(arrayBufferToBase64(bytes.buffer)).toBe("SGVsbG8=");
  });

  it("Test 3: encodes a buffer larger than 8192 bytes correctly", () => {
    // Generate a 10000-byte buffer with predictable content
    const size = 10000;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256;
    }

    // Compute expected using same chunked approach manually
    const chunkSize = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    const expected = btoa(binary);

    expect(arrayBufferToBase64(bytes.buffer)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// validateUploadFile tests
// ---------------------------------------------------------------------------

describe("validateUploadFile", () => {
  it("Test 4: returns null for a valid JPEG file (1MB)", () => {
    expect(validateUploadFile({ type: "image/jpeg", size: 1 * 1024 * 1024 })).toBeNull();
  });

  it("Test 5: returns null for image/png", () => {
    expect(validateUploadFile({ type: "image/png", size: 1 * 1024 * 1024 })).toBeNull();
  });

  it("Test 6: returns null for image/tiff", () => {
    expect(validateUploadFile({ type: "image/tiff", size: 1 * 1024 * 1024 })).toBeNull();
  });

  it("Test 7: returns 'invalid_format' for image/gif", () => {
    expect(validateUploadFile({ type: "image/gif", size: 1024 })).toBe("invalid_format");
  });

  it("Test 8: returns 'invalid_format' for application/pdf", () => {
    expect(validateUploadFile({ type: "application/pdf", size: 1024 })).toBe("invalid_format");
  });

  it("Test 9: returns 'file_too_large' for a file with size 26MB", () => {
    expect(validateUploadFile({ type: "image/jpeg", size: 26 * 1024 * 1024 })).toBe("file_too_large");
  });

  it("Test 10: returns null for a file exactly 25MB (boundary)", () => {
    expect(validateUploadFile({ type: "image/jpeg", size: 25 * 1024 * 1024 })).toBeNull();
  });

  it("Test 11: ACCEPTED_TYPES set contains exactly jpeg, png, tiff", () => {
    expect(ACCEPTED_TYPES.has("image/jpeg")).toBe(true);
    expect(ACCEPTED_TYPES.has("image/png")).toBe(true);
    expect(ACCEPTED_TYPES.has("image/tiff")).toBe(true);
    expect(ACCEPTED_TYPES.has("image/gif")).toBe(false);
    expect(ACCEPTED_TYPES.size).toBe(3);
  });

  it("Test 12: MAX_SIZE_BYTES equals 25 * 1024 * 1024", () => {
    expect(MAX_SIZE_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// commitBinaryFileWithCsv tests
// ---------------------------------------------------------------------------

describe("commitBinaryFileWithCsv", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const BASE_PARAMS = {
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    imagePath: "telar-content/objects/my-image/my-image.jpg",
    imageBase64: "SGVsbG8=",
    csvContent: "object_id,title\nmy-image,My Image",
    commitMessage: "Add image via Telar Compositor",
  };

  it("Test 13: makes exactly 7 fetch calls in correct order (GET ref, GET commit, POST blob x2, POST tree, POST commit, PATCH ref)", async () => {
    const { mockFetch, calls } = makeUploadFetch();
    globalThis.fetch = mockFetch;

    await commitBinaryFileWithCsv(BASE_PARAMS);

    expect(calls).toHaveLength(7);
    expect(calls[0]).toContain("/git/ref/");
    expect(calls[1]).toContain("/git/commits/head123");
    expect(calls[2]).toContain("/git/blobs");
    expect(calls[3]).toContain("/git/blobs");
    expect(calls[4]).toContain("/git/trees");
    expect(calls[5]).toContain("/git/commits");
    expect(calls[6]).toContain("/git/refs/");
  });

  it("Test 14: tree creation body includes base_tree: 'tree456'", async () => {
    const { mockFetch } = makeUploadFetch();
    globalThis.fetch = mockFetch;

    await commitBinaryFileWithCsv(BASE_PARAMS);

    // Find the tree POST call (5th call, index 4)
    const treeCall = mockFetch.mock.calls[4];
    const treeBody = JSON.parse(treeCall[1].body);
    expect(treeBody.base_tree).toBe("tree456");
  });

  it("Test 15: commit message includes [skip ci]", async () => {
    const { mockFetch } = makeUploadFetch();
    globalThis.fetch = mockFetch;

    await commitBinaryFileWithCsv(BASE_PARAMS);

    // Find the commit POST call (6th call, index 5)
    const commitCall = mockFetch.mock.calls[5];
    const commitBody = JSON.parse(commitCall[1].body);
    expect(commitBody.message).toContain("[skip ci]");
  });

  it("Test 16: throws StaleHeadError when ref update returns 422", async () => {
    const { mockFetch } = makeUploadFetch({ refStatus: 422 });
    globalThis.fetch = mockFetch;

    await expect(commitBinaryFileWithCsv(BASE_PARAMS)).rejects.toBeInstanceOf(StaleHeadError);
  });

  it("Test 17: returns { newHeadSha: 'newcommit678' } on success", async () => {
    const { mockFetch } = makeUploadFetch();
    globalThis.fetch = mockFetch;

    const result = await commitBinaryFileWithCsv(BASE_PARAMS);
    expect(result.newHeadSha).toBe("newcommit678");
  });

  it("Test 18: tree contains both image and CSV entries with correct paths", async () => {
    const { mockFetch } = makeUploadFetch();
    globalThis.fetch = mockFetch;

    await commitBinaryFileWithCsv(BASE_PARAMS);

    const treeCall = mockFetch.mock.calls[4];
    const treeBody = JSON.parse(treeCall[1].body);
    const paths = treeBody.tree.map((entry: { path: string }) => entry.path);
    expect(paths).toContain(BASE_PARAMS.imagePath);
    expect(paths).toContain("telar-content/spreadsheets/objects.csv");
  });

  it("Test 19: tree entries use mode '100644' and type 'blob'", async () => {
    const { mockFetch } = makeUploadFetch();
    globalThis.fetch = mockFetch;

    await commitBinaryFileWithCsv(BASE_PARAMS);

    const treeCall = mockFetch.mock.calls[4];
    const treeBody = JSON.parse(treeCall[1].body);
    for (const entry of treeBody.tree) {
      expect(entry.mode).toBe("100644");
      expect(entry.type).toBe("blob");
    }
  });

  it("Test 20: commit parents array contains the HEAD SHA", async () => {
    const { mockFetch } = makeUploadFetch();
    globalThis.fetch = mockFetch;

    await commitBinaryFileWithCsv(BASE_PARAMS);

    const commitCall = mockFetch.mock.calls[5];
    const commitBody = JSON.parse(commitCall[1].body);
    expect(commitBody.parents).toContain("head123");
  });
});

// ---------------------------------------------------------------------------
// commitMultipleBinaryFilesWithCsv tests
// ---------------------------------------------------------------------------

/**
 * Builds a mock fetch for the multi-image commit flow.
 * Tracks blob call count separately to return unique SHAs per image + CSV.
 */
function makeMultiUploadFetch(options: { refStatus?: number; imageCount?: number } = {}) {
  const calls: string[] = [];
  const callDetails: Array<{ url: string; init?: RequestInit }> = [];
  const imageCount = options.imageCount ?? 2;
  let blobCallCount = 0;

  const mockFetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
    calls.push(url);
    callDetails.push({ url, init: opts });

    // GET /git/ref/heads/{branch}
    if (url.includes("/git/ref/") && (!opts?.method || opts.method === "GET")) {
      return {
        ok: true, status: 200,
        json: async () => ({ object: { sha: "head123" } }),
        text: async () => "",
      };
    }

    // GET /git/commits/head123 — fetch commit to get tree SHA
    if (url.includes("/git/commits/head123")) {
      return {
        ok: true, status: 200,
        json: async () => ({ tree: { sha: "tree456" } }),
        text: async () => "",
      };
    }

    // POST /git/blobs — image blobs first, then CSV blob
    if (url.includes("/git/blobs") && opts?.method === "POST") {
      blobCallCount++;
      // First N calls are image blobs, last call is CSV blob
      const sha = blobCallCount <= imageCount
        ? `imgblob${blobCallCount}`
        : "csvblob999";
      return {
        ok: true, status: 201,
        json: async () => ({ sha }),
        text: async () => "",
      };
    }

    // POST /git/trees
    if (url.includes("/git/trees") && opts?.method === "POST") {
      return {
        ok: true, status: 201,
        json: async () => ({ sha: "newtree345" }),
        text: async () => "",
      };
    }

    // POST /git/commits (create commit)
    if (url.includes("/git/commits") && opts?.method === "POST") {
      return {
        ok: true, status: 201,
        json: async () => ({ sha: "newcommit678" }),
        text: async () => "",
      };
    }

    // PATCH /git/refs/heads/{branch}
    if (url.includes("/git/refs/") && opts?.method === "PATCH") {
      const status = options.refStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ object: { sha: "newcommit678" } }),
        text: async () => (status === 422 ? "Reference update failed" : ""),
      };
    }

    return {
      ok: false, status: 404,
      json: async () => ({ message: "Not found" }),
      text: async () => "Not found",
    };
  });

  return { mockFetch, calls, callDetails };
}

describe("commitMultipleBinaryFilesWithCsv", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const TWO_IMAGE_PARAMS = {
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    images: [
      { imagePath: "telar-content/objects/image-one/image-one.jpg", imageBase64: "aW1hZ2Uх" },
      { imagePath: "telar-content/objects/image-two/image-two.png", imageBase64: "aW1hZ2V5" },
    ],
    csvContent: "object_id,title\nimage-one,Image One\nimage-two,Image Two",
    commitMessage: "Add image-one, image-two via Telar Compositor",
  };

  it("Test 21: makes exactly 8 fetch calls for 2 images (GET ref, GET commit, POST blob x2 images + x1 CSV, POST tree, POST commit, PATCH ref)", async () => {
    const { mockFetch, calls } = makeMultiUploadFetch({ imageCount: 2 });
    globalThis.fetch = mockFetch;

    await commitMultipleBinaryFilesWithCsv(TWO_IMAGE_PARAMS);

    // GET ref(1) + GET commit(2) + POST blob img1(3) + POST blob img2(4) + POST blob CSV(5) + POST tree(6) + POST commit(7) + PATCH ref(8) = 8
    expect(calls).toHaveLength(8);
    expect(calls[0]).toContain("/git/ref/");
    expect(calls[1]).toContain("/git/commits/head123");
    expect(calls[2]).toContain("/git/blobs");
    expect(calls[3]).toContain("/git/blobs");
    expect(calls[4]).toContain("/git/blobs");
    expect(calls[5]).toContain("/git/trees");
    expect(calls[6]).toContain("/git/commits");
    expect(calls[7]).toContain("/git/refs/");
  });

  it("Test 22: tree POST body contains base_tree, 2 image entries, and 1 CSV entry (3 tree entries total)", async () => {
    const { mockFetch } = makeMultiUploadFetch({ imageCount: 2 });
    globalThis.fetch = mockFetch;

    await commitMultipleBinaryFilesWithCsv(TWO_IMAGE_PARAMS);

    // Tree is the 6th call (index 5, after ref, commit, blob, blob, blob)
    const treeCallIdx = mockFetch.mock.calls.findIndex(
      (call: unknown[]) => {
        const [url, opts] = call as [string, RequestInit];
        return url.includes("/git/trees") && opts?.method === "POST";
      }
    );
    const treeBody = JSON.parse(mockFetch.mock.calls[treeCallIdx][1].body);

    expect(treeBody.base_tree).toBe("tree456");
    expect(treeBody.tree).toHaveLength(3); // 2 images + 1 CSV
    const paths = treeBody.tree.map((e: { path: string }) => e.path);
    expect(paths).toContain("telar-content/objects/image-one/image-one.jpg");
    expect(paths).toContain("telar-content/objects/image-two/image-two.png");
    expect(paths).toContain("telar-content/spreadsheets/objects.csv");
  });

  it("Test 23: commit message includes [skip ci]", async () => {
    const { mockFetch } = makeMultiUploadFetch({ imageCount: 2 });
    globalThis.fetch = mockFetch;

    await commitMultipleBinaryFilesWithCsv(TWO_IMAGE_PARAMS);

    const commitCallIdx = mockFetch.mock.calls.findIndex(
      (call: unknown[]) => {
        const [url, opts] = call as [string, RequestInit];
        return url.includes("/git/commits") && opts?.method === "POST";
      }
    );
    const commitBody = JSON.parse(mockFetch.mock.calls[commitCallIdx][1].body);
    expect(commitBody.message).toContain("[skip ci]");
  });

  it("Test 24: throws StaleHeadError when ref update returns 422", async () => {
    const { mockFetch } = makeMultiUploadFetch({ refStatus: 422, imageCount: 2 });
    globalThis.fetch = mockFetch;

    await expect(commitMultipleBinaryFilesWithCsv(TWO_IMAGE_PARAMS)).rejects.toBeInstanceOf(StaleHeadError);
  });

  it("Test 25: returns { newHeadSha: 'newcommit678' } on success", async () => {
    const { mockFetch } = makeMultiUploadFetch({ imageCount: 2 });
    globalThis.fetch = mockFetch;

    const result = await commitMultipleBinaryFilesWithCsv(TWO_IMAGE_PARAMS);
    expect(result.newHeadSha).toBe("newcommit678");
  });

  it("Test 26: 1-image batch makes exactly 7 fetch calls (GET ref, GET commit, POST blob x1 image + x1 CSV, POST tree, POST commit, PATCH ref)", async () => {
    const { mockFetch, calls } = makeMultiUploadFetch({ imageCount: 1 });
    globalThis.fetch = mockFetch;

    await commitMultipleBinaryFilesWithCsv({
      ...TWO_IMAGE_PARAMS,
      images: [{ imagePath: "telar-content/objects/solo/solo.jpg", imageBase64: "c29sbw==" }],
    });

    // GET ref(1) + GET commit(2) + POST blob img(3) + POST blob CSV(4) + POST tree(5) + POST commit(6) + PATCH ref(7) = 7
    expect(calls).toHaveLength(7);
  });

  it("Test 27: tree entries for 2-image batch all use mode '100644' and type 'blob'", async () => {
    const { mockFetch } = makeMultiUploadFetch({ imageCount: 2 });
    globalThis.fetch = mockFetch;

    await commitMultipleBinaryFilesWithCsv(TWO_IMAGE_PARAMS);

    const treeCallIdx = mockFetch.mock.calls.findIndex(
      (call: unknown[]) => {
        const [url, opts] = call as [string, RequestInit];
        return url.includes("/git/trees") && opts?.method === "POST";
      }
    );
    const treeBody = JSON.parse(mockFetch.mock.calls[treeCallIdx][1].body);
    for (const entry of treeBody.tree) {
      expect(entry.mode).toBe("100644");
      expect(entry.type).toBe("blob");
    }
  });
});
