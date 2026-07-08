/**
 * GitHub API utilities for the Telar Compositor.
 *
 * All calls use the user's access token (OAuth user access token, not an
 * installation token). Endpoints used:
 *   - GET /user/installations
 *   - GET /user/installations/{id}/repositories
 *   - GET /repos/{owner}/{repo}
 *   - GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1
 *   - GET /repos/{owner}/{repo}/contents/{path}
 *   - GraphQL GetHeadOid (for getRepoHead)
 *
 * API version is pinned to 2022-11-28 via the X-GitHub-Api-Version header.
 */

const GITHUB_API = "https://api.github.com";

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
 */
export function decodeGitHubContent(base64Content: string): string {
  const cleaned = base64Content.replace(/\n/g, "");
  const binary = atob(cleaned);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
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
function parseNextLink(header: string | null): string | null {
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
 */
export async function getRepoTree(
  token: string,
  owner: string,
  repo: string,
): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub API error fetching tree: ${res.status}`);
  }
  return res.json() as Promise<{ tree: TreeEntry[]; truncated: boolean }>;
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
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}${query}`,
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
 *   - "absent": the file returned 404 — it legitimately did not exist at that
 *     commit (a domain whose base is empty, not a failure).
 *   - "error": any other non-ok status (5xx, 429, 403) or a thrown fetch — the
 *     read is unreliable, so the caller must not treat the base as known.
 */
export type FileAtRef =
  | { status: "ok"; content: string }
  | { status: "absent" }
  | { status: "error" };

/**
 * Reads a file at a specific commit/ref, distinguishing the three outcomes the
 * three-way sync diff must tell apart. Unlike getFileContent (which collapses
 * every non-ok status to null), this keeps "absent" (404 → empty base) apart
 * from "error" (transient failure → base unknown), so computeFullSyncDiff can
 * decide the whole diff's mode once instead of silently degrading one
 * sub-domain to two-way while the rest stay three-way.
 */
export async function getFileAtRef(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<FileAtRef> {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      { headers: githubHeaders(token) },
    );
    if (res.status === 404) return { status: "absent" };
    if (!res.ok) return { status: "error" };
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (data.encoding === "base64" && typeof data.content === "string") {
      return { status: "ok", content: decodeGitHubContent(data.content) };
    }
    // 200 with no base64 body (unexpected shape) — treat as an empty base
    // rather than an error; there is nothing to diff against.
    return { status: "absent" };
  } catch {
    return { status: "error" };
  }
}

// ---------------------------------------------------------------------------
// checkRepoAvailability
// ---------------------------------------------------------------------------

export type RepoAvailability = "available" | "unavailable" | "error";

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
 */
export async function checkRepoAvailability(
  token: string,
  owner: string,
  repo: string,
): Promise<RepoAvailability> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: githubHeaders(token),
    });
    if (res.ok) return "available";
    if (res.status === 404 || res.status === 403) return "unavailable";
    return "error";
  } catch {
    return "error";
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
  repository: { ref: { target: { oid: string } } };
}

/**
 * Fetches the current HEAD commit SHA (OID) for a repository branch.
 *
 * Uses the GitHub GraphQL API — same query as commitFilesToRepo uses
 * internally, extracted here as a standalone export so other callers
 * (e.g. _app.tsx loader for HEAD divergence detection) can use it
 * without importing commit.server.ts.
 *
 * Defaults to the "main" branch.
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
  return data.repository.ref.target.oid;
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

/**
 * Executes a GitHub GraphQL API request.
 *
 * Throws if the HTTP response is non-OK or if the response body contains a
 * top-level `errors` array (GraphQL errors are returned with HTTP 200).
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
  if (!res.ok) {
    throw new Error(`GitHub GraphQL error: ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors) {
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
 * Returns an empty array on error or if the query is too short.
 */
export async function searchGitHubUsers(
  token: string,
  query: string,
): Promise<Array<{ login: string; avatar_url: string }>> {
  if (!query || query.length < 2) return [];
  const url = `${GITHUB_API}/search/users?q=${encodeURIComponent(query)}+type:user&per_page=5`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    items: Array<{ login: string; avatar_url: string }>;
  };
  return data.items ?? [];
}
