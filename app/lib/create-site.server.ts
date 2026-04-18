/**
 * Create-site server module for the Telar Compositor.
 *
 * Five pure server functions wrapping GitHub REST endpoints used by the
 * "Create a new Telar site" onboarding flow. Caller resolves the GitHub
 * token (user-to-server for most, installation token for
 * isRepoInInstallation) and passes it in. Errors are thrown as typed
 * Error subclasses so route handlers can branch with instanceof.
 *
 * This file is the initial skeleton:
 *   - TEMPLATE_OWNER / TEMPLATE_REPO constants
 *   - Typed error subclasses (RepoNameTakenError, PermissionDeniedError,
 *     GitHubError, RepoNotReadyError)
 *   - Fully implemented isValidRepoName
 *   - Async function stubs filled in by plans 19-02, 19-03, 19-04
 *
 * Style mirrors app/lib/github.server.ts: raw fetch against
 * https://api.github.com, pinned API version header, throws on failure.
 */

// Constants
export const TEMPLATE_OWNER = "ucsb-amplab";
export const TEMPLATE_REPO = "telar";

const GITHUB_API = "https://api.github.com";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "telar-compositor",
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// Typed error subclasses
export class RepoNameTakenError extends Error {
  constructor(message = "Repository name is already taken") {
    super(message);
    this.name = "RepoNameTakenError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message = "GitHub App lacks required permissions") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class GitHubError extends Error {
  status?: number;
  body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

export class RepoNotReadyError extends Error {
  lastStatus?: number;
  constructor(message = "Repository not ready within timeout", lastStatus?: number) {
    super(message);
    this.name = "RepoNotReadyError";
    this.lastStatus = lastStatus;
  }
}

// Public types
export type RepoNameAvailability = { available: boolean; reason?: "exists" | "invalid" };
export type CreateSiteResult = { repoUrl: string; defaultBranch: string };

// Implementations

/**
 * GitHub repo naming rules:
 * - 1–100 characters
 * - character class [a-z0-9._-] (lowercase only — Telar convention)
 * - must not start with '.' or '-'
 * - must not be exactly '.' or '..'
 */
export function isValidRepoName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > 100) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return /^[a-z0-9._-]+$/.test(name);
}

// Async stubs filled in by subsequent plans (19-02, 19-03, 19-04)

export async function checkRepoNameAvailable(
  token: string,
  owner: string,
  name: string,
): Promise<RepoNameAvailability> {
  if (!isValidRepoName(name)) {
    return { available: false, reason: "invalid" };
  }
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (res.status === 404) return { available: true };
  if (res.status === 200) return { available: false, reason: "exists" };
  const body = await safeJson(res);
  throw new GitHubError(
    `checkRepoNameAvailable: unexpected status ${res.status}`,
    res.status,
    body,
  );
}

export async function createSiteFromTemplate(
  token: string,
  owner: string,
  name: string,
): Promise<CreateSiteResult> {
  const res = await fetch(
    `${GITHUB_API}/repos/${TEMPLATE_OWNER}/${TEMPLATE_REPO}/generate`,
    {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        owner,
        name,
        description: "Created with Telar Compositor",
        private: false,
        include_all_branches: false,
      }),
    },
  );

  if (res.status >= 200 && res.status < 300) {
    const body = (await res.json()) as { html_url: string; default_branch: string };
    return { repoUrl: body.html_url, defaultBranch: body.default_branch };
  }

  const body = await safeJson(res);

  if (res.status === 422) {
    throw new RepoNameTakenError(
      `Repository name "${name}" is already taken on ${owner}`,
    );
  }
  if (res.status === 403) {
    throw new PermissionDeniedError(
      "GitHub App lacks Administration:Write — cannot create repo from template",
    );
  }
  throw new GitHubError(
    `createSiteFromTemplate: unexpected status ${res.status}`,
    res.status,
    body,
  );
}

/**
 * Polls `GET /repos/{owner}/{name}/contents/_config.yml` at a fixed 1s interval
 * until HTTP 200 or `timeoutMs` elapses. Existence of the file is enough;
 * the body is not decoded.
 *
 * Behaviour:
 * - Fixed 1000ms interval
 * - Default `timeoutMs = 15000`
 * - Throws `RepoNotReadyError` on timeout (carries `lastStatus` if one was observed)
 * - Transient 5xx or network errors mid-poll are swallowed and retried until timeout
 */
export async function waitForRepoReady(
  token: string,
  owner: string,
  name: string,
  timeoutMs = 15000,
): Promise<void> {
  const intervalMs = 1000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}/contents/_config.yml`,
        { method: "GET", headers: authHeaders(token) },
      );
      lastStatus = res.status;
      if (res.status === 200) return;
      // 404 (not yet populated) and 5xx (GitHub hiccup) both fall through to retry.
    } catch {
      // Network error — swallow and retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new RepoNotReadyError(
    `Repository ${owner}/${name} not ready within ${timeoutMs}ms`,
    lastStatus,
  );
}

/**
 * Checks whether the installation associated with `installationToken` can see
 * the repo `{owner}/{name}`. Paginates `GET /installation/repositories` at
 * per_page=100.
 *
 * Returns `false` when the target is absent across all pages.
 * Throws `GitHubError` on HTTP/network failure.
 */
export async function isRepoInInstallation(
  installationToken: string,
  owner: string,
  name: string,
): Promise<boolean> {
  const target = `${owner}/${name}`.toLowerCase();
  const perPage = 100;
  let page = 1;

  // Safety cap — a single installation very rarely exceeds 50k repos; 500 pages
  // is a defensive ceiling to avoid infinite loops on API quirks.
  const maxPages = 500;

  while (page <= maxPages) {
    const res = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=${perPage}&page=${page}`,
      { method: "GET", headers: authHeaders(installationToken) },
    );

    if (!res.ok) {
      const body = await safeJson(res);
      throw new GitHubError(
        `isRepoInInstallation: unexpected status ${res.status}`,
        res.status,
        body,
      );
    }

    const body = (await res.json()) as {
      total_count?: number;
      repositories?: Array<{ full_name: string }>;
    };

    const repos = body.repositories ?? [];
    for (const repo of repos) {
      if (repo.full_name.toLowerCase() === target) return true;
    }

    // Stop when the server returned a partial page (last page) or zero items.
    if (repos.length < perPage) return false;
    page += 1;
  }

  return false;
}
