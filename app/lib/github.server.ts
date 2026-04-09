/**
 * GitHub API utilities for the Telar Compositor.
 *
 * All calls use the user's access token (OAuth user access token, not an
 * installation token). Endpoints used:
 *   - GET /user/installations
 *   - GET /user/installations/{id}/repositories
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
  const res = await fetch(
    `${GITHUB_API}/user/installations/${installationId}/repositories`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub API error listing repos: ${res.status}`);
  }
  return res.json() as Promise<{ repositories: Repository[] }>;
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
 */
export async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
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
