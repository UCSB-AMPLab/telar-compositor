/**
 * A story's files as a commit holds them: the step and layer subtrees listed
 * at each commit (`storyTrees`), a file's text read strictly and kept per
 * isolate by blob SHA (`readBlobText`), with whether its bytes were valid
 * UTF-8 (`readBlobAt`, `readReportedBlobText`), and the blob SHA a commit
 * gives a text (`gitBlobSha`). The change check (story-content.server.ts), the page
 * check and the publish read the repository through these.
 *
 * A tree reading that does not conclude says why (`TreesInconclusive`), with
 * one of two causes (`InconclusiveCause`): a structural one, which GitHub
 * gives again however often it is asked (a truncated listing, a symlink or
 * submodule, something other than a folder where a folder is), or a request
 * one, which asking again may answer. A commit GitHub does not hold is marked
 * `unresolved`, so a check with a base can read the head alone.
 *
 * @version v1.5.5-beta
 */

import { getFileAtRef, getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import type { SheetWarning, UnreadableRepair } from "~/lib/sheet-warnings";
import { pushUnreadable } from "~/lib/unreadable-characters.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";

export const SPREADSHEETS_DIR = "telar-content/spreadsheets";
export const STORY_TEXTS_DIR = "telar-content/texts/stories";

/** What a read of the repository needs. */
export interface RepoAccess {
  token: string;
  owner: string;
  repo: string;
}

/**
 * The git blob SHA of `content` as a commit stores it: SHA-1 over
 * `blob <length>\0` followed by the bytes, where the bytes are the text's
 * UTF-8 encoding, as the commit primitive sends it, and the length is their
 * count, not the string's UTF-16 length.
 */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A file's text by its blob SHA, per isolate. The text is what a read costs;
// what it parses to depends on the other files of its story (a step CSV's
// parse takes in the layer files it names), so the text is what is kept,
// with whether the bytes decoded lossily, which a later read of the same blob
// must still report.
//
// Bounded by bytes, measured as UTF-16 length × 2, against a Worker's 128 MB
// of memory: 8 MiB in all, the oldest entries dropped first past it, and no
// single file over 512 KiB kept (it is still read, just not cached), so the
// cache stays a small fraction of the memory a check has to work in.
const BLOB_TEXT_CACHE_BYTES = 8 * 1024 * 1024;
const BLOB_TEXT_MAX_FILE_BYTES = 512 * 1024;
/** A blob's text, and whether its bytes were not valid UTF-8. */
export interface BlobRead {
  text: string;
  lossy: boolean;
}

const blobText = new Map<string, BlobRead>();
let blobTextBytes = 0;

export function __clearStoryBlobCacheForTest(): void {
  blobText.clear();
  blobTextBytes = 0;
}

export function __storyBlobCacheForTest(): { entries: number; bytes: number } {
  return { entries: blobText.size, bytes: blobTextBytes };
}

function rememberBlob(sha: string, read: BlobRead): void {
  const bytes = read.text.length * 2;
  if (bytes > BLOB_TEXT_MAX_FILE_BYTES || blobText.has(sha)) return;
  blobText.set(sha, read);
  blobTextBytes += bytes;
  for (const [oldest, kept] of blobText) {
    if (blobTextBytes <= BLOB_TEXT_CACHE_BYTES) break;
    blobText.delete(oldest);
    blobTextBytes -= kept.text.length * 2;
  }
}

export interface CommitFiles {
  sheets: Map<string, string>;
  texts: Map<string, string>;
  /** The directories under texts/stories. */
  textDirs: Set<string>;
}

/**
 * Why a check of the repository's files did not conclude. `structure`: what
 * GitHub holds cannot be read as files, however often it is asked (a listing
 * GitHub cut short, a symlink or a submodule in it, something other than a
 * folder where a folder is). `request`: a request failed, came back malformed,
 * or named a commit GitHub does not hold, so asking again may answer it.
 */
export type InconclusiveCause = "structure" | "request";

/**
 * A tree reading that did not conclude: why, its cause, and the paths it
 * covers where they are known. `unresolved` marks a commit GitHub does not
 * hold, which a check with a base answers by reading the head alone.
 */
export interface TreesInconclusive {
  reason: string;
  cause: InconclusiveCause;
  paths?: string[];
  unresolved?: true;
}

/** Whether a tree reading did not conclude. */
export function isInconclusive<T>(trees: T | TreesInconclusive): trees is TreesInconclusive {
  return typeof trees === "object" && trees !== null && "cause" in trees && "reason" in trees;
}

/**
 * The two story subtrees at each commit, as blob SHAs by path relative to
 * the subtree, or why they cannot be trusted. Inconclusive: an unresolved or
 * malformed answer (a request cause), anything but a tree at a subtree path,
 * or a listing `listSubtreeFiles` does not accept (a structural cause). A
 * subtree confirmed absent at a commit that resolves is empty there, so a
 * subtree at one commit only reads as every file under it added or removed.
 * (The status refresh marks that case divergent without reading it, which is
 * right for the refresh.) A request that throws is the caller's to answer.
 */
export async function storyTrees(
  input: RepoAccess,
  commits: readonly string[],
): Promise<Map<string, CommitFiles> | TreesInconclusive> {
  const { token, owner, repo } = input;
  const trees = await getSubtreeOids(token, owner, repo, commits, [SPREADSHEETS_DIR, STORY_TEXTS_DIR]);
  if (!trees.ok) return treesUnanswered("story", trees.reason);
  const out = new Map<string, CommitFiles>();
  for (const commit of commits) out.set(commit, { sheets: new Map(), texts: new Map(), textDirs: new Set() });
  for (const [dir, key] of [[SPREADSHEETS_DIR, "sheets"], [STORY_TEXTS_DIR, "texts"]] as const) {
    const answers = commits.map((c) => trees.at(c, dir));
    for (const [i, at] of answers.entries()) {
      if (at.kind === "absent") continue;
      if (at.kind !== "tree") return { reason: `${dir} is not a tree at ${commits[i]}`, cause: "structure", paths: [dir] };
      const listing = await listSubtreeEntries(token, owner, repo, at.oid);
      if (listing === null) return { reason: `${dir} could not be listed completely`, cause: "structure", paths: [dir] };
      const files = out.get(commits[i])!;
      files[key] = listing.files;
      if (key === "texts") files.textDirs = listing.dirs;
    }
  }
  return out;
}

/** A subtree lookup GitHub did not answer: a request cause, `unresolved` when a commit does not resolve. */
export function treesUnanswered(what: string, reason: "unresolved" | "malformed"): TreesInconclusive {
  return {
    reason: `the ${what} trees came back ${reason}`,
    cause: "request",
    ...(reason === "unresolved" ? { unresolved: true as const } : {}),
  };
}

/**
 * A file's text at `commit`, from the cache when its blob was read before. A
 * failed read throws `SheetUnreadableError`. It holds the check
 * (`checkStoryContent` answers inconclusive) rather than listing the story as
 * unreadable: keeping the Compositor's version of an unreadable story records
 * the checked commit, which for a failed read acknowledges a change nobody
 * read. In the accept it refuses the apply, naming the file.
 */
export async function readBlobText(input: RepoAccess, commit: string, path: string, sha: string): Promise<string> {
  return (await readBlobAt(input, commit, path, sha)).text;
}

/**
 * `readBlobText` for a reader that shows warnings: a blob whose bytes are not
 * valid UTF-8 is named in `warnings` by its path, and handed to `onLossy`.
 */
export async function readReportedBlobText(
  input: RepoAccess,
  commit: string,
  path: string,
  sha: string,
  warnings: SheetWarning[] | undefined,
  repair?: UnreadableRepair,
  onLossy?: (path: string) => void,
): Promise<string> {
  const read = await readBlobAt(input, commit, path, sha);
  if (read.lossy) {
    pushUnreadable(warnings, path, repair);
    onLossy?.(path);
  }
  return read.text;
}

/** `readBlobText`, with whether the blob's bytes decoded lossily. */
export async function readBlobAt(input: RepoAccess, commit: string, path: string, sha: string): Promise<BlobRead> {
  const cached = blobText.get(sha);
  if (cached !== undefined) return cached;
  const read = await getFileAtRef(input.token, input.owner, input.repo, path, commit, { strict: true });
  if (read.status !== "ok") throw new SheetUnreadableError(path);
  const blob = { text: read.content, lossy: read.lossy === true };
  rememberBlob(sha, blob);
  return blob;
}
