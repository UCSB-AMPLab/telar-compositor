/**
 * This file is the server-side scaffolding for the "Create a new Telar
 * site" path of the onboarding wizard.
 *
 * It bundles the small set of GitHub REST calls that path needs —
 * checking whether the user's chosen repo name is available, generating
 * the new repo from the Telar template, polling until the new repo is
 * actually ready (template generation is asynchronous on GitHub's side),
 * confirming the GitHub App installation can see the new repo, and
 * patching the freshly-created repo's `_config.yml` with the user's
 * chosen language.
 *
 * Callers resolve the GitHub token themselves (user-to-server for most
 * operations, installation token for `isRepoInInstallation`) and pass it
 * in. Errors are thrown as typed subclasses so route handlers can branch
 * with `instanceof` rather than parsing error messages.
 *
 * Style mirrors `app/lib/github.server.ts`: raw fetch against
 * `https://api.github.com`, pinned API version header, throws on non-2xx.
 *
 * @version v1.2.0-beta
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

// ---------------------------------------------------------------------------
// patchSiteConfigLanguage
// ---------------------------------------------------------------------------

/**
 * Read the new repo's `_config.yml`, returning its decoded body and current SHA.
 * Helper for `patchSiteConfigLanguage`.
 */
async function readConfig(
  token: string,
  owner: string,
  name: string,
): Promise<{ sha: string; body: string }> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}/contents/_config.yml`,
    { method: "GET", headers: authHeaders(token) },
  );
  if (!res.ok) {
    const errBody = await safeJson(res);
    throw new GitHubError(`readConfig: status ${res.status}`, res.status, errBody);
  }
  const data = (await res.json()) as { content: string; sha: string; encoding: string };
  if (data.encoding !== "base64") {
    throw new GitHubError(`readConfig: unexpected encoding ${data.encoding}`);
  }
  // Workers V8 supports atob natively; strip the \n every 60 chars that GitHub inserts.
  const body = atob(data.content.replace(/\n/g, ""));
  return { sha: data.sha, body };
}

/**
 * Write the patched body back to `_config.yml`. Requires the original SHA;
 * GitHub returns 409 if it has moved (rare but possible if the user races us).
 */
async function putConfig(
  token: string,
  owner: string,
  name: string,
  newBody: string,
  sha: string,
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${encodeURIComponent(name)}/contents/_config.yml`,
    {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "compositor: seed telar_language from user locale",
        content: btoa(newBody),
        sha,
      }),
    },
  );
  if (!res.ok) {
    const errBody = await safeJson(res);
    throw new GitHubError(`putConfig: status ${res.status}`, res.status, errBody);
  }
}

/**
 * Seed `telar_language` in a newly-created site's `_config.yml` from the
 * authenticated user's `ui_locale`. Short-circuits for `"en"` (the template
 * default — no patch needed).
 *
 * Stability check: after `waitForRepoReady` returns, the file exists but its
 * body may briefly arrive without the `telar_language:` line populated. If the
 * line is absent on the first GET, sleep 1s and re-read once. If still absent,
 * throw `GitHubError` — the caller soft-fails to `langPatchFailed: true`.
 *
 * Regex: anchored line match preserving leading whitespace, normalising quote
 * style to double quotes, and preserving any trailing inline comment.
 * Threat-model gate: the token is never logged. Errors carry the
 * GitHub status + body only.
 */
export async function patchSiteConfigLanguage(
  token: string,
  owner: string,
  name: string,
  locale: "en" | "es",
): Promise<void> {
  if (locale === "en") return; // template default; no patch needed

  let { sha, body } = await readConfig(token, owner, name);
  if (!body.includes("telar_language:")) {
    await new Promise((r) => setTimeout(r, 1000));
    ({ sha, body } = await readConfig(token, owner, name));
    if (!body.includes("telar_language:")) {
      throw new GitHubError(
        "patchSiteConfigLanguage: _config.yml present but telar_language line not found after retry",
      );
    }
  }

  const patched = body.replace(
    /^(\s*telar_language:\s*)["']?([a-z]{2})["']?(\s*(?:#.*)?)$/m,
    `$1"${locale}"$3`,
  );
  if (patched === body) {
    throw new GitHubError(
      "patchSiteConfigLanguage: regex did not match telar_language line",
    );
  }

  await putConfig(token, owner, name, patched, sha);
}
