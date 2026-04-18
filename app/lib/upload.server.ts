/**
 * Binary image upload utilities for the Telar Compositor.
 *
 * Provides server-side infrastructure for committing binary image files to
 * GitHub repositories using the Git Data API REST flow. The Git Data API
 * creates blobs via separate API calls, keeping each request well within
 * the undocumented ~40MiB GraphQL payload limit.
 *
 * Exports:
 *   - arrayBufferToBase64: chunked ArrayBuffer → base64 string (safe for 25MB files)
 *   - validateUploadFile: checks MIME type and file size before upload
 *   - commitBinaryFileWithCsv: commits image + objects.csv via Git Data API (single image)
 *   - commitMultipleBinaryFilesWithCsv: commits N images + objects.csv in one Git commit
 *   - ACCEPTED_TYPES: Set of allowed MIME types (for client-side reuse)
 *   - MAX_SIZE_BYTES: maximum allowed file size (for client-side reuse)
 */

import { githubHeaders } from "~/lib/github.server";
import { StaleHeadError } from "~/lib/commit.server";

// ---------------------------------------------------------------------------
// Constants (exported for client-side reuse)
// ---------------------------------------------------------------------------

/**
 * Accepted image MIME types for upload.
 * Validated client-side before upload and server-side before commit.
 */
export const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/tiff"]);

/**
 * Maximum allowed file size in bytes (25MB).
 * A 25MB file encoded as base64 is ~33MB — within the 128MB CF Workers memory limit.
 */
export const MAX_SIZE_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// arrayBufferToBase64
// ---------------------------------------------------------------------------

/**
 * Converts an ArrayBuffer to a base64 string, safe for files up to 25MB.
 *
 * Uses a chunked loop (8192 bytes per chunk) to avoid the RangeError thrown by
 * `String.fromCharCode(...largeUint8Array)` when the array exceeds ~64KB.
 * This is the only safe pattern for large binary files in Cloudflare Workers.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Encodes a UTF-8 string to base64 without the deprecated `unescape()` global.
 * Uses TextEncoder + chunked String.fromCharCode (same pattern as arrayBufferToBase64).
 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// validateUploadFile
// ---------------------------------------------------------------------------

/**
 * Validates an upload candidate against the accepted types and size limit.
 *
 * Returns:
 *   - null if the file is valid
 *   - "invalid_format" if the MIME type is not in ACCEPTED_TYPES
 *   - "file_too_large" if the file size exceeds MAX_SIZE_BYTES
 */
export function validateUploadFile(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_TYPES.has(file.type)) {
    return "invalid_format";
  }
  if (file.size > MAX_SIZE_BYTES) {
    return "file_too_large";
  }
  return null;
}

// ---------------------------------------------------------------------------
// commitBinaryFileWithCsv
// ---------------------------------------------------------------------------

interface CommitBinaryParams {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** Repository-relative path, e.g. "telar-content/objects/my-image/my-image.jpg" */
  imagePath: string;
  /** Base64-encoded image content */
  imageBase64: string;
  /** Serialised objects.csv text content */
  csvContent: string;
  /** Commit message headline (will have " [skip ci]" appended) */
  commitMessage: string;
}

const GITHUB_API = "https://api.github.com";

/**
 * Commits a binary image file and the updated objects.csv to a GitHub repository
 * using the Git Data API REST flow.
 *
 * This bypasses the GraphQL `createCommitOnBranch` mutation to avoid the
 * undocumented ~40MiB payload limit. Each blob is created in a separate API call,
 * so even a 25MB image (33MB base64) stays within limits.
 *
 * API call sequence:
 *   1. GET /git/ref/heads/{branch} — fetch current HEAD SHA
 *   2. GET /git/commits/{headSha} — fetch current tree SHA
 *   3. POST /git/blobs — create image blob
 *   4. POST /git/blobs — create CSV blob
 *   5. POST /git/trees — create new tree with base_tree (CRITICAL: preserves existing files)
 *   6. POST /git/commits — create commit with [skip ci] in message
 *   7. PATCH /git/refs/heads/{branch} — advance branch pointer
 *
 * Throws StaleHeadError if the ref update returns 422 (HEAD has moved since step 1).
 * Returns { newHeadSha } matching the new commit SHA.
 */
export async function commitBinaryFileWithCsv(params: CommitBinaryParams): Promise<{ newHeadSha: string }> {
  const { token, owner, repo, branch, imagePath, imageBase64, csvContent, commitMessage } = params;
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;
  const headers = githubHeaders(token);
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };

  // Step 0: Fetch current HEAD SHA
  const refRes = await fetch(`${base}/git/ref/heads/${branch}`, { headers });
  if (!refRes.ok) {
    const body = await refRes.text();
    throw new Error(`Failed to fetch HEAD ref: ${refRes.status} ${body}`);
  }
  const refData = (await refRes.json()) as { object: { sha: string } };
  const headSha = refData.object.sha;

  // Step 0b: Fetch current tree SHA from the HEAD commit
  const commitDataRes = await fetch(`${base}/git/commits/${headSha}`, { headers });
  if (!commitDataRes.ok) {
    const body = await commitDataRes.text();
    throw new Error(`Failed to fetch commit data: ${commitDataRes.status} ${body}`);
  }
  const commitData = (await commitDataRes.json()) as { tree: { sha: string } };
  const treeSha = commitData.tree.sha;

  // Step 1: Create image blob
  const imageBlobRes = await fetch(`${base}/git/blobs`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ content: imageBase64, encoding: "base64" }),
  });
  if (!imageBlobRes.ok) {
    const body = await imageBlobRes.text();
    throw new Error(`Failed to create image blob: ${imageBlobRes.status} ${body}`);
  }
  const imageBlob = (await imageBlobRes.json()) as { sha: string };
  const imageBlobSha = imageBlob.sha;

  // Step 2: Create CSV blob
  // Encode UTF-8 CSV content as base64 for safe transmission
  const csvBase64 = utf8ToBase64(csvContent);
  const csvBlobRes = await fetch(`${base}/git/blobs`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ content: csvBase64, encoding: "base64" }),
  });
  if (!csvBlobRes.ok) {
    const body = await csvBlobRes.text();
    throw new Error(`Failed to create CSV blob: ${csvBlobRes.status} ${body}`);
  }
  const csvBlob = (await csvBlobRes.json()) as { sha: string };
  const csvBlobSha = csvBlob.sha;

  // Step 3: Create tree
  // CRITICAL: base_tree must be present — without it GitHub creates a tree
  // containing only these two files, silently deleting everything else in the repo.
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [
        { path: imagePath, mode: "100644", type: "blob", sha: imageBlobSha },
        { path: "telar-content/spreadsheets/objects.csv", mode: "100644", type: "blob", sha: csvBlobSha },
      ],
    }),
  });
  if (!treeRes.ok) {
    const body = await treeRes.text();
    throw new Error(`Failed to create tree: ${treeRes.status} ${body}`);
  }
  const tree = (await treeRes.json()) as { sha: string };
  const newTreeSha = tree.sha;

  // Step 4: Create commit
  // Always append [skip ci] to prevent full build workflow from firing.
  // The IIIF-only workflow is dispatched separately after commit.
  const newCommitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      message: `${commitMessage} [skip ci]`,
      tree: newTreeSha,
      parents: [headSha],
    }),
  });
  if (!newCommitRes.ok) {
    const body = await newCommitRes.text();
    throw new Error(`Failed to create commit: ${newCommitRes.status} ${body}`);
  }
  const newCommit = (await newCommitRes.json()) as { sha: string };
  const newCommitSha = newCommit.sha;

  // Step 5: Update ref
  const refUpdateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ sha: newCommitSha, force: false }),
  });

  if (refUpdateRes.status === 422) {
    throw new StaleHeadError("Repository HEAD has changed");
  }

  if (!refUpdateRes.ok) {
    const body = await refUpdateRes.text();
    throw new Error(`Failed to update ref: ${refUpdateRes.status} ${body}`);
  }

  return { newHeadSha: newCommitSha };
}

// ---------------------------------------------------------------------------
// commitMultipleBinaryFilesWithCsv
// ---------------------------------------------------------------------------

interface CommitMultipleBinaryParams {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** Array of images to commit — processed sequentially to stay within CF Worker CPU limits */
  images: Array<{ imagePath: string; imageBase64: string }>;
  /** Serialised objects.csv text content (merged, includes all new objects) */
  csvContent: string;
  /** Commit message headline (will have " [skip ci]" appended) */
  commitMessage: string;
}

/**
 * Commits multiple binary image files and the updated objects.csv to a GitHub
 * repository in a single Git commit using the Git Data API REST flow.
 *
 * Image blobs are created sequentially (not in parallel) to stay within
 * Cloudflare Worker CPU time limits. The batch is capped at 10 images by the
 * calling action handler.
 *
 * API call sequence for N images:
 *   1. GET /git/ref/heads/{branch} — fetch current HEAD SHA
 *   2. GET /git/commits/{headSha} — fetch current tree SHA
 *   3–(N+2). POST /git/blobs — create one blob per image (sequential)
 *   N+3. POST /git/blobs — create CSV blob
 *   N+4. POST /git/trees — create new tree with base_tree (CRITICAL: preserves existing files)
 *   N+5. POST /git/commits — create commit with [skip ci] in message
 *   N+6. PATCH /git/refs/heads/{branch} — advance branch pointer
 *
 * For 2 images: 7 API calls total (matches commitBinaryFileWithCsv + 1 extra blob).
 * Throws StaleHeadError if the ref update returns 422 (HEAD has moved since step 1).
 */
export async function commitMultipleBinaryFilesWithCsv(
  params: CommitMultipleBinaryParams
): Promise<{ newHeadSha: string }> {
  const { token, owner, repo, branch, images, csvContent, commitMessage } = params;
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;
  const headers = githubHeaders(token);
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };

  // Step 0: Fetch current HEAD SHA
  const refRes = await fetch(`${base}/git/ref/heads/${branch}`, { headers });
  if (!refRes.ok) {
    const body = await refRes.text();
    throw new Error(`Failed to fetch HEAD ref: ${refRes.status} ${body}`);
  }
  const refData = (await refRes.json()) as { object: { sha: string } };
  const headSha = refData.object.sha;

  // Step 0b: Fetch current tree SHA from the HEAD commit
  const commitDataRes = await fetch(`${base}/git/commits/${headSha}`, { headers });
  if (!commitDataRes.ok) {
    const body = await commitDataRes.text();
    throw new Error(`Failed to fetch commit data: ${commitDataRes.status} ${body}`);
  }
  const commitData = (await commitDataRes.json()) as { tree: { sha: string } };
  const treeSha = commitData.tree.sha;

  // Step 1: Create image blobs sequentially (avoid parallel to stay within CF Worker CPU limits)
  const imageBlobEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const { imagePath, imageBase64 } of images) {
    const blobRes = await fetch(`${base}/git/blobs`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ content: imageBase64, encoding: "base64" }),
    });
    if (!blobRes.ok) {
      const body = await blobRes.text();
      throw new Error(`Failed to create image blob: ${blobRes.status} ${body}`);
    }
    const blob = (await blobRes.json()) as { sha: string };
    imageBlobEntries.push({ path: imagePath, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Step 2: Create CSV blob
  // Encode UTF-8 CSV content as base64 for safe transmission
  const csvBase64 = utf8ToBase64(csvContent);
  const csvBlobRes = await fetch(`${base}/git/blobs`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ content: csvBase64, encoding: "base64" }),
  });
  if (!csvBlobRes.ok) {
    const body = await csvBlobRes.text();
    throw new Error(`Failed to create CSV blob: ${csvBlobRes.status} ${body}`);
  }
  const csvBlob = (await csvBlobRes.json()) as { sha: string };

  // Step 3: Create tree
  // CRITICAL: base_tree must be present — without it GitHub creates a tree
  // containing only these files, silently deleting everything else in the repo.
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [
        ...imageBlobEntries,
        { path: "telar-content/spreadsheets/objects.csv", mode: "100644", type: "blob", sha: csvBlob.sha },
      ],
    }),
  });
  if (!treeRes.ok) {
    const body = await treeRes.text();
    throw new Error(`Failed to create tree: ${treeRes.status} ${body}`);
  }
  const tree = (await treeRes.json()) as { sha: string };

  // Step 4: Create commit
  // Always append [skip ci] to prevent full build workflow from firing.
  const newCommitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      message: `${commitMessage} [skip ci]`,
      tree: tree.sha,
      parents: [headSha],
    }),
  });
  if (!newCommitRes.ok) {
    const body = await newCommitRes.text();
    throw new Error(`Failed to create commit: ${newCommitRes.status} ${body}`);
  }
  const newCommit = (await newCommitRes.json()) as { sha: string };

  // Step 5: Update ref
  const refUpdateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });

  if (refUpdateRes.status === 422) {
    throw new StaleHeadError("Repository HEAD has changed");
  }

  if (!refUpdateRes.ok) {
    const body = await refUpdateRes.text();
    throw new Error(`Failed to update ref: ${refUpdateRes.status} ${body}`);
  }

  return { newHeadSha: newCommit.sha };
}
