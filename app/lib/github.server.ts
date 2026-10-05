/**
 * GitHub API utilities for the Telar Compositor.
 *
 * Provides:
 *   - githubHeaders / decodeGitHubContent: request headers and Base64 body decoding
 *   - listUserInstallations / listInstallationRepos: the installations and repos
 *     a user can reach, the second paginated to the end of the Link chain
 *   - getRepoTree: the full recursive file tree for a repository
 *   - getFileContent: a file's decoded body, or null for anything but a 200
 *   - getFileAtRef: a file at one commit, keeping "absent" apart from "error"
 *   - commitExists: whether a commit exists, apart from a lookup that failed
 *   - checkRepoAvailability: whether a repository is still reachable
 *   - getRepoHead: the HEAD commit OID for a branch
 *   - NoSuchBranchError: the branch getRepoHead asked for does not exist
 *   - getDefaultBranchHead: the default branch's name and head commit OID
 *   - graphqlGitHub: the GraphQL request every mutation and probe travels on
 *   - GitHubTransientError: a 5xx on that request, distinguishable by class
 *   - searchGitHubUsers: username-prefix search for the collaborator picker
 *
 * All calls use the user's access token (OAuth user access token, not an
 * installation token). Endpoints used:
 *   - GET /user/installations
 *   - GET /user/installations/{id}/repositories
 *   - GET /repos/{owner}/{repo}
 *   - GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1 (ref defaults to HEAD)
 *   - GET /repos/{owner}/{repo}/contents/{path} (JSON, and raw for a file over 1 MB)
 *   - GET /repos/{owner}/{repo}/git/commits/{sha}
 *   - GET /search/users
 *   - GraphQL GetHeadOid (for getRepoHead)
 *   - GraphQL DefaultBranchHead (for getDefaultBranchHead)
 *
 * API version is pinned to 2022-11-28 via the X-GitHub-Api-Version header.
 *
 * @version v1.5.0-beta
 */

export const GITHUB_API = "https://api.github.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Installation {
  id: number;
  account: { login: string; avatar_url: string };
  target_type: "User" | "Organization";
}

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; avatar_url: string };
  private: boolean;
  description: string | null;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Telar-Compositor/1.0",
  };
}

/**
 * Decodes a Base64 string returned by the GitHub Contents API.
 *
 * GitHub embeds newline characters in the Base64 string (every 60 chars).
 * atob() fails if they are not stripped first. After decoding the binary
 * string, TextDecoder handles UTF-8 multi-byte sequences (e.g. accented
 * characters in Spanish content).
 *
 * `keepBom` leaves a leading byte-order mark in the returned string. Reading
 * a file to parse it wants the BOM gone, which is TextDecoder's default; a
 * caller that will write the file back needs the source's own bytes, because
 * dropping a BOM it never asked about is a change to the file.
 */
export function decodeGitHubContent(
  base64Content: string,
  options?: { keepBom?: boolean },
): string {
  return new TextDecoder("utf-8", { ignoreBOM: options?.keepBom }).decode(base64Bytes(base64Content));
}

/** The bytes of a Contents API base64 string, its embedded newlines dropped. */
function base64Bytes(base64Content: string): Uint8Array {
  const binary = atob(base64Content.replace(/\n/g, ""));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Lists all GitHub App installations accessible to the authenticated user.
 */
export async function listUserInstallations(
  token: string,
): Promise<{ installations: Installation[] }> {
  const res = await fetch(`${GITHUB_API}/user/installations`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`GitHub API error listing installations: ${res.status}`);
  }
  return res.json() as Promise<{ installations: Installation[] }>;
}

/**
 * Lists all repositories accessible within a specific GitHub App installation.
 */
export async function listInstallationRepos(
  token: string,
  installationId: number,
): Promise<{ repositories: Repository[] }> {
  // Paginate through all repositories accessible to this installation.
  // GitHub's default page size is 30 — without pagination, accounts with
  // more repos than that get truncated lists and the onboarding search
  // cannot find repos beyond the first page. Use per_page=100 (the API
  // max) and follow Link: rel="next" headers until the last page.
  const repositories: Repository[] = [];
  let url: string | null =
    `${GITHUB_API}/user/installations/${installationId}/repositories?per_page=100`;
  while (url) {
    const res: Response = await fetch(url, { headers: githubHeaders(token) });
    if (!res.ok) {
      throw new Error(`GitHub API error listing repos: ${res.status}`);
    }
    const page = (await res.json()) as { repositories: Repository[] };
    repositories.push(...page.repositories);
    url = parseNextLink(res.headers.get("link"));
  }
  return { repositories };
}

/**
 * Parses a GitHub `Link` response header and returns the URL for rel="next",
 * or null if there is no next page. Link headers look like:
 *   <https://api.github.com/...&page=2>; rel="next", <...&page=10>; rel="last"
 */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetches the full recursive file tree for a repository.
 *
 * Uses a single API call (recursive=1) to avoid multiple round trips.
 * Check `truncated: true` in the response — repos with thousands of IIIF
 * tile files may exceed the 100,000 entry limit.
 *
 * `ref` (optional) pins the read to a commit SHA, branch or tag. A caller that
 * commits back against the same revision passes the SHA it captured, so the
 * tree it reasoned about and the tree it writes to are the same one. Omitting
 * it reads HEAD, which is what every single-step caller wants.
 */
export async function getRepoTree(
  token: string,
  owner: string,
  repo: string,
  ref?: string,
): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref ?? "HEAD")}?recursive=1`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub API error fetching tree: ${res.status}`);
  }
  return res.json() as Promise<{ tree: TreeEntry[]; truncated: boolean }>;
}

/** What sits at one path of one commit. */
export type SubtreeAt =
  | { kind: "tree"; oid: string }
  /** The commit resolves and has nothing at the path. */
  | { kind: "absent" }
  /** Something that is not a tree: a blob (a file or a symlink) or a submodule. */
  | { kind: "other"; type: string };

/**
 * What each commit has at each path, from one GraphQL request that reads
 * object ids and types only: no file content is fetched.
 *
 * The answer is conclusive only when the request confirms every commit
 * resolves and every field it asked for came back in the expected shape.
 * Otherwise it says why not: `unresolved` when a commit does not exist in the
 * repository (a path under it would otherwise read as absent), `malformed`
 * when a field is missing or has the wrong shape. A tree's oid is what a
 * caller hands to `getRepoTree` to list that subtree on its own, so an
 * image-heavy repository cannot truncate the listing of a small directory,
 * and two equal oids say the subtree is byte for byte the same.
 */
export async function getSubtreeOids(
  token: string,
  owner: string,
  repo: string,
  commits: readonly string[],
  paths: readonly string[],
): Promise<
  | { ok: true; at: (commit: string, path: string) => SubtreeAt }
  | { ok: false; reason: "unresolved" | "malformed" }
> {
  const variables: Record<string, string> = { owner, repo };
  const params: string[] = [];
  const fields: string[] = [];
  commits.forEach((commit, c) => {
    variables[`c${c}`] = commit;
    params.push(`$c${c}: String!`);
    fields.push(`c${c}: object(expression: $c${c}) { __typename }`);
    paths.forEach((path, p) => {
      variables[`c${c}p${p}`] = `${commit}:${path}`;
      params.push(`$c${c}p${p}: String!`);
      fields.push(`c${c}p${p}: object(expression: $c${c}p${p}) { __typename ... on Tree { oid } }`);
    });
  });
  const query = `query SubtreeOids($owner: String!, $repo: String!, ${params.join(", ")}) {
    repository(owner: $owner, name: $repo) { ${fields.join("\n")} }
  }`;
  const data = await graphqlGitHub<{ repository?: Record<string, unknown> | null }>(token, query, variables);
  const repository = data?.repository;
  if (!repository || typeof repository !== "object") return { ok: false, reason: "malformed" };

  const answers = new Map<string, SubtreeAt>();
  for (const [c, commit] of commits.entries()) {
    const node = readNode(repository, `c${c}`);
    if (node === undefined) return { ok: false, reason: "malformed" };
    if (node === null || node.__typename !== "Commit") return { ok: false, reason: "unresolved" };
    for (const [p, path] of paths.entries()) {
      const at = readNode(repository, `c${c}p${p}`);
      if (at === undefined) return { ok: false, reason: "malformed" };
      if (at === null) answers.set(`${commit}:${path}`, { kind: "absent" });
      else if (at.__typename !== "Tree") answers.set(`${commit}:${path}`, { kind: "other", type: at.__typename });
      else if (typeof at.oid !== "string") return { ok: false, reason: "malformed" };
      else answers.set(`${commit}:${path}`, { kind: "tree", oid: at.oid });
    }
  }
  return { ok: true, at: (commit, path) => answers.get(`${commit}:${path}`) as SubtreeAt };
}

/**
 * One aliased field of a GraphQL answer: the object, null where GitHub
 * answered null, or undefined where the field is missing or is not an object
 * with a string `__typename`.
 */
function readNode(
  parent: Record<string, unknown>,
  alias: string,
): { __typename: string; oid?: unknown } | null | undefined {
  if (!Object.hasOwn(parent, alias)) return undefined;
  const node = parent[alias];
  if (node === null) return null;
  if (typeof node !== "object" || typeof (node as { __typename?: unknown }).__typename !== "string") return undefined;
  return node as { __typename: string; oid?: unknown };
}

/**
 * Whether one entry of a tree listing is one a story-file check accepts. The
 * complete set:
 * - a regular file: `type` "blob", `mode` "100644" or "100755", a non-empty
 *   `path` and a `sha`;
 * - a directory: `type` "tree", `mode` "040000", a non-empty `path`.
 * Nothing else is accepted: a symlink (120000), whose blob is its target path
 * so an edit to the target leaves it unchanged; a submodule (160000, type
 * "commit"), which is another repository; an unknown type; a missing or
 * unexpected mode; a missing path or blob sha.
 */
function isAcceptedEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const { type, mode, path, sha } = entry as Record<string, unknown>;
  if (typeof path !== "string" || path === "") return false;
  if (type === "blob") return (mode === "100644" || mode === "100755") && typeof sha === "string" && sha !== "";
  return type === "tree" && mode === "040000";
}

/**
 * A subtree's regular files by path relative to it, with their blob SHAs, or
 * null when the listing cannot be trusted as the subtree's content. A listing
 * (`git/trees/{oid}?recursive=1`) is usable only when it says
 * `truncated: false` explicitly and every entry is one `isAcceptedEntry`
 * accepts; anything else makes the check inconclusive.
 */
export async function listSubtreeFiles(
  token: string,
  owner: string,
  repo: string,
  oid: string,
): Promise<Map<string, string> | null> {
  return (await listSubtreeEntries(token, owner, repo, oid))?.files ?? null;
}

/**
 * The same listing as `listSubtreeFiles`, with its directories kept: the
 * paths of the directory entries, relative to the subtree.
 */
export async function listSubtreeEntries(
  token: string,
  owner: string,
  repo: string,
  oid: string,
): Promise<{ files: Map<string, string>; dirs: Set<string> } | null> {
  const listing = (await getRepoTree(token, owner, repo, oid)) as { tree?: unknown; truncated?: unknown };
  if (listing.truncated !== false || !Array.isArray(listing.tree)) return null;
  if (!listing.tree.every(isAcceptedEntry)) return null;
  const entries = listing.tree as TreeEntry[];
  return {
    files: new Map(entries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha])),
    dirs: new Set(entries.filter((e) => e.type === "tree").map((e) => e.path)),
  };
}

/**
 * The entries directly in `dir` at `commit`, with paths from the repository
 * root: none when the commit has no tree there. Read without recursion, so a
 * repository whose recursive tree is answered truncated can still have one
 * directory listed whole. Throws when either read fails, when the commit does
 * not resolve, and when the listing itself comes back truncated.
 */
export async function listDirectoryEntries(
  token: string,
  owner: string,
  repo: string,
  commit: string,
  dir: string,
): Promise<TreeEntry[]> {
  const found = await getSubtreeOids(token, owner, repo, [commit], [dir]);
  if (!found.ok) throw new Error(`could not look up ${dir} at ${commit}: ${found.reason}`);
  const at = found.at(commit, dir);
  if (at.kind !== "tree") return [];
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(at.oid)}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) throw new Error(`GitHub API error listing ${dir}: ${res.status}`);
  const listing = (await res.json()) as { tree?: TreeEntry[]; truncated?: unknown };
  if (listing.truncated !== false || !Array.isArray(listing.tree)) throw new Error(`the listing of ${dir} is incomplete`);
  return listing.tree.map((entry) => ({ ...entry, path: `${dir}/${entry.path}` }));
}

/** A blob's text by its SHA; for a symbolic link, the path it points to. Throws when it cannot be read. */
export async function getBlobText(token: string, owner: string, repo: string, sha: string): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) throw new Error(`GitHub API error reading blob ${sha}: ${res.status}`);
  const blob = (await res.json()) as { content?: unknown; encoding?: unknown };
  if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`blob ${sha} came back in an unexpected form`);
  return decodeGitHubContent(blob.content, { keepBom: true });
}

/**
 * A repository path as a Contents API URL carries it: each segment encoded,
 * the `/` between them kept. A filename is author text, and a raw `#`, `?` or
 * `%` in it is a URL delimiter, so `intro#notes.md?ref=<sha>` would reach
 * GitHub as the path `intro` with no ref, reading another file at the
 * default branch.
 */
export function encodeContentsPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Fetches a file's content from a repository via the Contents API.
 *
 * Returns the decoded UTF-8 string, or null if the file is not found (404).
 * GitHub returns content as Base64 with embedded newlines — decodeGitHubContent
 * handles the decoding correctly.
 *
 * `ref` (optional) pins the read to a branch, tag, or commit SHA via the
 * Contents API's `?ref=` query. Omitting it reads the repository's default
 * branch, so existing callers keep their behaviour unchanged. Base-commit reads
 * for the three-way sync diff go through getFileAtRef instead, which keeps
 * "absent" (404) distinct from "error" (transient) rather than collapsing both
 * to null.
 */
export async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}${query}`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.encoding === "base64" && data.content) {
    return decodeGitHubContent(data.content);
  }
  return null;
}

/**
 * Result of a base-commit file read for the three-way sync diff.
 *   - "ok": the file exists at the ref; `content` is its decoded UTF-8 body.
 *     `lossy` is set, by a strict read only, when the bytes are not valid
 *     UTF-8 and some decoded to U+FFFD; a clean read carries no such key.
 *   - "absent": the file returned 404 — it legitimately did not exist at that
 *     commit (a domain whose base is empty, not a failure).
 *   - "error": any other non-ok status (5xx, 429, 403) or a thrown fetch — the
 *     read is unreliable, so the caller must not treat the base as known.
 */
export type FileAtRef =
  | { status: "ok"; content: string; lossy?: true }
  | { status: "absent" }
  | { status: "error" };

/**
 * Reads a file at a specific commit/ref, distinguishing the three outcomes the
 * three-way sync diff must tell apart. Unlike getFileContent (which collapses
 * every non-ok status to null), this keeps "absent" (404 → empty base) apart
 * from "error" (transient failure → base unknown), so computeFullSyncDiff can
 * decide the whole diff's mode once instead of silently degrading one
 * sub-domain to two-way while the rest stay three-way.
 *
 * `strict` is the mode for a caller that will REWRITE the file it reads. Two
 * things follow from that. "Absent" narrows to an HTTP 404 alone: an empty
 * base costs a diff nothing, but a delete that reads a mangled 200 as "no CSV
 * here" would commit the object's files away and leave its row standing. And
 * the content is the file's bytes, a leading byte-order mark included, so a
 * caller that writes it back verbatim changes nothing; a caller that parses the
 * content strips a leading byte-order mark itself.
 *
 * A file too large for the JSON answer to carry is read again as raw content
 * at the same ref, in either mode (`isFileWithoutContent`).
 */
export async function getFileAtRef(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  options?: { strict?: boolean },
): Promise<FileAtRef> {
  const strict = options?.strict === true;
  try {
    const read = await contentsBytes(token, contentsUrl(owner, repo, path, ref), strict);
    return read.status === "ok" ? decodedRead(read.bytes, strict) : read;
  } catch {
    return { status: "error" };
  }
}

/** A file's bytes at a ref, or why they could not be had. */
export type BytesAtRef = { status: "ok"; bytes: Uint8Array } | { status: "absent" } | { status: "error" };

/**
 * A file's bytes at a ref, read as `getFileAtRef` reads strictly and left
 * undecoded, for a caller that decides for itself whether they are text.
 */
export async function getFileBytesAtRef(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<BytesAtRef> {
  try {
    return await contentsBytes(token, contentsUrl(owner, repo, path, ref), true);
  } catch {
    return { status: "error" };
  }
}

function contentsUrl(owner: string, repo: string, path: string, ref?: string): string {
  const query = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
  return `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}${query}`;
}

/**
 * A file on the repository's default branch, with "absent" (404) kept apart
 * from "error" (any other failed read, and a 200 whose body is not the whole
 * file), which `getFileContent` collapses to null. For a caller that must not read a failure as a file that is not there.
 */
export async function getFileOnDefaultBranch(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<FileAtRef> {
  try {
    const read = await contentsBytes(token, contentsUrl(owner, repo, path), true);
    return read.status === "ok" ? decodedRead(read.bytes, true) : read;
  } catch {
    return { status: "error" };
  }
}

/** The fields of a Contents API answer `contentsBytes` reads. */
interface ContentsAnswer {
  type?: string;
  content?: string;
  encoding?: string;
  size?: number;
}

/**
 * The bytes of the file at `url`. A strict read whose base64 body is not the
 * file's `size`, or whose answer carries no `size`, is an error: the content
 * cannot be shown to be the whole file. A 200 with no base64 body is an error
 * to a strict read and an empty base to a loose one, which has nothing to
 * diff against. A loose read takes a base64 body as it comes.
 */
async function contentsBytes(token: string, url: string, strict: boolean): Promise<BytesAtRef> {
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (res.status === 404) return { status: "absent" };
  if (!res.ok) return { status: "error" };
  const data = (await res.json()) as ContentsAnswer;
  if (isFileWithoutContent(data)) return await readRawFile(token, url, data.size as number);
  if (data.encoding !== "base64" || typeof data.content !== "string") return { status: strict ? "error" : "absent" };
  const bytes = base64Bytes(data.content);
  if (strict && bytes.length !== data.size) return { status: "error" };
  return { status: "ok", bytes };
}

/**
 * A file of 1 MB to 100 MB, whose JSON answer carries no content, read again
 * as `application/vnd.github.raw+json`, which returns the bytes. The body is
 * taken only when it is not JSON and its length is the answer's `size`;
 * anything else, a failed request included, is an error in either mode,
 * since the file is known to exist.
 */
async function readRawFile(token: string, url: string, size: number): Promise<BytesAtRef> {
  const raw = await fetch(url, { headers: { ...githubHeaders(token), Accept: "application/vnd.github.raw+json" } });
  if (!raw.ok) return { status: "error" };
  if ((raw.headers.get("content-type") ?? "").toLowerCase().includes("json")) return { status: "error" };
  const bytes = new Uint8Array(await raw.arrayBuffer());
  if (bytes.length !== size) return { status: "error" };
  return { status: "ok", bytes };
}

/**
 * The read's text. A strict read decodes fatally first, so that bytes which
 * are not valid UTF-8 are told apart from the valid encoding of U+FFFD,
 * which decodes to the same text; either way the text is the non-fatal
 * decode's. A loose read never carries the flag.
 */
function decodedRead(bytes: Uint8Array, strict: boolean): FileAtRef {
  if (strict) {
    try {
      return { status: "ok", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      return { status: "ok", content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), lossy: true };
    }
  }
  return { status: "ok", content: new TextDecoder("utf-8").decode(bytes) };
}

/**
 * Whether a Contents API answer is a file of non-zero size whose content it
 * does not carry: `encoding: "none"`, or an empty content. A directory
 * listing, a symlink or a submodule is none of these.
 */
function isFileWithoutContent(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const { type, content, encoding, size } = data as { type?: unknown; content?: unknown; encoding?: unknown; size?: unknown };
  if (type !== undefined && type !== "file") return false;
  if (typeof size !== "number" || size <= 0) return false;
  return encoding === "none" || content === "" || content === undefined;
}

/**
 * Whether a commit exists in the repository: "missing" only where GitHub
 * answers it has no such commit (404), "error" for anything else. A 409 is
 * answered for an unavailable repository as well as an empty one, and a 422
 * says GitHub would not resolve the request: neither says the commit is gone.
 */
export async function commitExists(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<"exists" | "missing" | "error"> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`, {
      headers: githubHeaders(token),
    });
    if (res.ok) return "exists";
    if (res.status === 404) return "missing";
    return "error";
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// checkRepoAvailability
// ---------------------------------------------------------------------------

export type RepoAvailability = "available" | "unavailable" | "error";

export interface RepoAvailabilityResult {
  availability: RepoAvailability;
  /** Canonical `full_name` from the REST response body, present only on a
   *  200 (parsed regardless of whether it matches the requested owner/repo,
   *  so callers can detect a rename and heal their stored full_name). */
  canonicalFullName: string | null;
}

/**
 * Probes whether the user can still reach a repository via
 * GET /repos/{owner}/{repo}.
 *
 * Distinguishes "gone / no access" (404 or 403) from transient failures
 * (5xx, network). GitHub deliberately returns 404 for BOTH a deleted repo
 * and a private repo the caller can't see, so "unavailable" deliberately
 * conflates deleted / renamed / made-private / access-removed — callers
 * alert on it. "error" is for transient problems, so callers fail open and
 * never false-alarm on a GitHub blip.
 *
 * REST follows GitHub's rename redirect, so a 200 body's `full_name` is the
 * repo's CURRENT name — it may differ from the requested owner/repo when the
 * repo was renamed since it was stored. Callers use this to heal stale names.
 */
export async function checkRepoAvailability(
  token: string,
  owner: string,
  repo: string,
): Promise<RepoAvailabilityResult> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: githubHeaders(token),
    });
    if (res.ok) {
      const body = (await res.json()) as Pick<Repository, "full_name">;
      return { availability: "available", canonicalFullName: body.full_name ?? null };
    }
    if (res.status === 404 || res.status === 403) {
      return { availability: "unavailable", canonicalFullName: null };
    }
    return { availability: "error", canonicalFullName: null };
  } catch {
    return { availability: "error", canonicalFullName: null };
  }
}

// ---------------------------------------------------------------------------
// getRepoHead
// ---------------------------------------------------------------------------

const GET_HEAD_OID_QUERY = `
  query GetHeadOid($owner: String!, $repo: String!, $branch: String!) {
    repository(owner: $owner, name: $repo) {
      ref(qualifiedName: $branch) {
        target {
          oid
        }
      }
    }
  }
`;

interface HeadOidData {
  repository: { ref: { target: { oid: string } } | null };
}

/**
 * The repository has no branch of that name, as an empty repository has no
 * branch at all. GitHub answered: this is not a failure to reach it.
 */
export class NoSuchBranchError extends Error {
  readonly branch: string;

  constructor(branch: string) {
    super(`the repository has no branch ${branch}`);
    this.name = "NoSuchBranchError";
    this.branch = branch;
  }
}

/**
 * Fetches the current HEAD commit SHA (OID) for a repository branch.
 *
 * Uses the GitHub GraphQL API — same query as commitFilesToRepo uses
 * internally, extracted here as a standalone export so other callers
 * (e.g. _app.tsx loader for HEAD divergence detection) can use it
 * without importing commit.server.ts.
 *
 * Defaults to the "main" branch. GitHub resolves a short name against tags as
 * well as branches; a qualified name such as `refs/heads/main` names only the
 * branch. A branch that does not exist throws `NoSuchBranchError`; any other
 * failure throws what `graphqlGitHub` throws.
 */
export async function getRepoHead(
  token: string,
  owner: string,
  repo: string,
  branch: string = "main",
): Promise<string> {
  const data = await graphqlGitHub<HeadOidData>(token, GET_HEAD_OID_QUERY, {
    owner,
    repo,
    branch,
  });
  const ref = data.repository.ref;
  if (ref === null) throw new NoSuchBranchError(branch);
  return ref.target.oid;
}

const DEFAULT_BRANCH_HEAD_QUERY = `
  query DefaultBranchHead($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        name
        target {
          oid
        }
      }
    }
  }
`;

interface DefaultBranchHeadData {
  repository: { defaultBranchRef: { name: string; target: { oid: string } } | null };
}

/**
 * The repository's default branch, its name and head commit OID, from one
 * GraphQL query, so the two cannot come from different moments. Null where
 * the repository has no default branch, as an empty repository has none; any
 * failure throws what `graphqlGitHub` throws.
 */
export async function getDefaultBranchHead(
  token: string,
  owner: string,
  repo: string,
): Promise<{ name: string; oid: string } | null> {
  const data = await graphqlGitHub<DefaultBranchHeadData>(token, DEFAULT_BRANCH_HEAD_QUERY, { owner, repo });
  const ref = data.repository.defaultBranchRef;
  return ref === null ? null : { name: ref.name, oid: ref.target.oid };
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

/**
 * Thrown when the GraphQL endpoint answers with a server error (5xx) or a
 * rate-limit 403, which is GitHub failing or asking to wait rather than the
 * request being wrong. Callers that may retry
 * need to tell the two apart without reading message text, so the status
 * travels on the error. The message keeps the same
 * `GitHub GraphQL error: <status>` shape every existing consumer matches on.
 */
export class GitHubTransientError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubTransientError";
    this.status = status;
  }
}

/**
 * Thrown when the GraphQL endpoint refuses the caller (401, 403, 404): the
 * credential is not allowed to do this, or cannot see the repository. Nothing
 * a retry changes, and not a fault in the site, so a caller that tells the
 * author what happened needs it apart from every other rejection. The message
 * keeps the `GitHub GraphQL error: <status>` shape.
 */
export class GitHubPermissionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubPermissionError";
    this.status = status;
  }
}

/**
 * Whether a 403 is GitHub's rate limit rather than a refusal of the caller.
 * GitHub answers a primary or secondary rate limit with 403 (or 429) and says
 * so by a `retry-after` header, `x-ratelimit-remaining: 0`, or a message that
 * names the limit (docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).
 * The credential is still good and the request succeeds once the limit
 * lifts, so a caller tells it apart from a lost permission.
 */
export function isRateLimitRefusal(
  headers: { get(name: string): string | null } | undefined,
  body: string,
): boolean {
  if (headers?.get("retry-after") != null) return true;
  if (headers?.get("x-ratelimit-remaining") === "0") return true;
  return /rate limit/i.test(body);
}

/**
 * Whether a failure reading the repository is GitHub or the network failing
 * to answer, as against an answer that says why nothing can be read: a server
 * error or rate limit from either API, or a request that never completed. An
 * empty repository (no branch, or a tree that 404s or 409s) and a refused
 * credential are answers, not outages, and retrying them changes nothing.
 */
export function isTransientGitHubFailure(error: unknown): boolean {
  if (error instanceof GitHubTransientError) return true;
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return true;
  if (!(error instanceof Error)) return false;
  const tree = error.message.match(/GitHub API error fetching tree: (\d{3})$/);
  if (tree !== null) return Number(tree[1]) >= 500 || tree[1] === "429";
  const graphql = error.message.match(/^GitHub GraphQL error: (\d{3})$/);
  return graphql !== null && (graphql[1] === "429" || graphql[1] === "408");
}

/**
 * `type` values GitHub puts on an `errors` entry when it refuses the
 * credential on an HTTP 200. GitHub's reference pages do not enumerate these;
 * they are the values its GraphQL API returns for a token without the right
 * (FORBIDDEN, "Resource not accessible by ...") or scopes (INSUFFICIENT_SCOPES).
 * NOT_FOUND is left out: it also answers a name that does not exist.
 */
const PERMISSION_ERROR_TYPES = new Set(["FORBIDDEN", "INSUFFICIENT_SCOPES"]);

/**
 * The error for a non-OK GraphQL HTTP response: a 5xx or a rate-limited 403 is
 * GitHubTransientError, any other 401, 403 or 404 is GitHubPermissionError, and
 * everything else a plain Error.
 */
async function graphqlHttpFailure(res: Response): Promise<Error> {
  const message = `GitHub GraphQL error: ${res.status}`;
  if (res.status >= 500) return new GitHubTransientError(message, res.status);
  if (res.status === 403) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // No readable body: the headers alone decide.
    }
    if (isRateLimitRefusal(res.headers, body)) return new GitHubTransientError(message, res.status);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return new GitHubPermissionError(message, res.status);
  }
  return new Error(message);
}

/**
 * Executes a GitHub GraphQL API request.
 *
 * Throws if the HTTP response is non-OK or if the response body contains a
 * top-level `errors` array (GraphQL errors are returned with HTTP 200). A 5xx
 * or a 403 that is GitHub's rate limit throws GitHubTransientError, and any
 * other 401, 403 or 404 GitHubPermissionError, as does an `errors` entry of a
 * permission type on a 200;
 * every other failure throws a plain Error, so a request GitHub rejected is
 * never retried as though GitHub had stumbled.
 */
export async function graphqlGitHub<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Telar-Compositor/1.0",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw await graphqlHttpFailure(res);
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ type?: string; message: string }>;
  };
  if (json.errors) {
    if (json.errors.some((e) => e.type !== undefined && PERMISSION_ERROR_TYPES.has(e.type))) {
      throw new GitHubPermissionError(`GraphQL: ${json.errors.map((e) => e.message).join(", ")}`, 403);
    }
    throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  return json.data as T;
}

// ---------------------------------------------------------------------------
// User search
// ---------------------------------------------------------------------------

/**
 * Search GitHub users by username prefix.
 *
 * Uses the GitHub REST API search endpoint with the user's OAuth token.
 * Returns up to 5 matching users with login and avatar_url.
 * Returns an empty array if the query is too short, and throws when GitHub
 * does not answer the search, which is not the same as no one matching.
 */
export async function searchGitHubUsers(
  token: string,
  query: string,
): Promise<Array<{ login: string; avatar_url: string }>> {
  if (!query || query.length < 2) return [];
  const url = `${GITHUB_API}/search/users?q=${encodeURIComponent(query)}+type:user&per_page=5`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) throw new Error(`GitHub API error searching users: ${res.status}`);
  const data = (await res.json()) as {
    items: Array<{ login: string; avatar_url: string }>;
  };
  return data.items ?? [];
}
