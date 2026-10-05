/**
 * Moves a site whose default branch is not `main` onto `main`, and imports it.
 *
 * The Compositor reads and commits every site on `main`, so the first import
 * refuses any other default branch (`importHead`). This is the author's way
 * past that refusal: the `fix_default_branch` onboarding intent. What to change
 * is decided here from GitHub, never from what the author was shown, since the
 * repository can change between the message and the click:
 *   - no `main` branch: the default is renamed to `main`;
 *   - a `main` holding a Telar site: `main` becomes the default;
 *   - a `main` holding none, or one that cannot be read: nothing changes, and
 *     the refusal is answered again. The only automatic fixes there would
 *     rename or overwrite someone's branch.
 * Then the import runs on `main`, and only after it has succeeded is a Pages
 * site that deploys from a branch moved to the framework's build workflow.
 *
 * Every call uses the author's own token, as the import does. GitHub lets
 * only a repository admin rename or change the default branch.
 *
 * Endpoints used:
 *   - POST /repos/{owner}/{repo}/branches/{branch}/rename
 *   - PATCH /repos/{owner}/{repo}
 *   - GET and PUT /repos/{owner}/{repo}/pages
 *
 * @version v1.5.0-beta
 */

import { load as loadYaml } from "js-yaml";

import { getDefaultBranchHead, getFileAtRef, githubHeaders } from "~/lib/github.server";
import { defaultBranchRefusal, mainBranchState, refusedImportResult } from "~/lib/import.server";
import type { ImportResult } from "~/lib/import.server";

const GITHUB_API = "https://api.github.com";

/** The framework's build workflow, which a workflow-deployed Pages site needs on `main`. */
const BUILD_WORKFLOW = ".github/workflows/build.yml";

/** How long to read the default branch for, after a rename, before answering `rename_pending`. */
export interface RenameWait {
  attempts: number;
  intervalMs: number;
}

export const RENAME_WAIT: RenameWait = { attempts: 5, intervalMs: 1000 };

/**
 * Puts the repository's default branch on `main` and imports the site.
 *
 * `importSite` is the import as the `import` intent runs it. A refusal it
 * answers leaves the branch change in place, which is what the author asked
 * for. A failure GitHub gives that is neither a refusal nor a repository that
 * changed under the call throws, as a failed import throws.
 */
export async function importOnMain(
  token: string,
  owner: string,
  repo: string,
  importSite: () => Promise<ImportResult>,
  wait: RenameWait = RENAME_WAIT,
): Promise<ImportResult> {
  const refusal = await settleOnMain(token, owner, repo, wait);
  if (refusal) return refusal;
  const result = await importSite();
  if (!result.valid) return result;
  const pagesBranch = await moveBranchPagesToWorkflow(token, owner, repo);
  return pagesBranch === null ? result : { ...result, pagesWarning: { branch: pagesBranch } };
}

/**
 * Makes `main` the default branch, or answers why it was not. A 404 or 422
 * says the repository changed under the call, so it is classified again once
 * and acted on as found; a 403 says the author is not an admin.
 */
async function settleOnMain(token: string, owner: string, repo: string, wait: RenameWait): Promise<ImportResult | null> {
  for (let pass = 0; ; pass++) {
    const branch = await getDefaultBranchHead(token, owner, repo);
    if (branch === null || branch.name === "main") return null;
    const main = await mainBranchState(token, owner, repo);
    if (main === "not_site" || main === "unreadable") return defaultBranchRefusal(branch.name, main);

    const res = main === "absent" ? await renameBranch(token, owner, repo, branch.name) : await setDefaultBranch(token, owner, repo);
    if (res.ok) {
      if (main === "site" || (await defaultBecomesMain(token, owner, repo, wait))) return null;
      return refusedImportResult({ validationError: "rename_pending" });
    }
    if (res.status === 403) return refusedImportResult({ validationError: "branch_admin_required" });
    if ((res.status !== 404 && res.status !== 422) || pass > 0) {
      throw new Error(`GitHub answered ${res.status} moving ${owner}/${repo} to main`);
    }
  }
}

/** Renames the branch to `main`. GitHub answers before the rename is finished. */
function renameBranch(token: string, owner: string, repo: string, branch: string): Promise<Response> {
  return fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/rename`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: "main" }),
  });
}

function setDefaultBranch(token: string, owner: string, repo: string): Promise<Response> {
  return fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    method: "PATCH",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ default_branch: "main" }),
  });
}

/** Whether the default branch reads as `main` within the wait. */
async function defaultBecomesMain(token: string, owner: string, repo: string, wait: RenameWait): Promise<boolean> {
  for (let attempt = 0; attempt < wait.attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, wait.intervalMs));
    if ((await getDefaultBranchHead(token, owner, repo))?.name === "main") return true;
  }
  return false;
}

/**
 * Moves a Pages site that deploys from a branch (`build_type` `legacy`) to the
 * build workflow, when `main` carries one that deploys to Pages; without it the
 * site would be left with no way to publish. Answers the branch Pages still publishes
 * from, as GitHub reports it, when it stays on a branch, and null otherwise:
 * no Pages site, one already on the workflow, or one moved. A Pages site that
 * cannot be read is left alone with no answer, since there is no branch to name.
 */
async function moveBranchPagesToWorkflow(token: string, owner: string, repo: string): Promise<string | null> {
  const pagesUrl = `${GITHUB_API}/repos/${owner}/${repo}/pages`;
  let pages: { build_type?: string; source?: { branch?: string } };
  try {
    const res = await fetch(pagesUrl, { headers: githubHeaders(token) });
    if (!res.ok) return null;
    pages = (await res.json()) as typeof pages;
  } catch {
    return null;
  }
  if (pages.build_type !== "legacy") return null;
  const source = pages.source?.branch ?? "";

  const workflow = await getFileAtRef(token, owner, repo, BUILD_WORKFLOW, "refs/heads/main");
  if (workflow.status !== "ok" || !deploysToPages(workflow.content)) return source;
  try {
    const res = await fetch(pagesUrl, {
      method: "PUT",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ build_type: "workflow" }),
    });
    return res.ok ? null : source;
  } catch {
    return source;
  }
}

/**
 * Whether a workflow has a job that deploys to Pages in the framework's shape:
 * a job with a runner and a step that uses the Pages deploy action. Read as
 * YAML, so a comment or any mention of the action outside a job's steps does
 * not count, and a workflow that does not parse does not deploy. This reads the
 * file, not a run: a workflow that passes and still cannot deploy has had the
 * framework's own workflow edited by hand, and a Compositor upgrade replaces
 * `.github/workflows/` whole.
 */
function deploysToPages(source: string): boolean {
  let doc: unknown;
  try {
    doc = loadYaml(source);
  } catch {
    return false;
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== "object") return false;
  return Object.values(jobs as Record<string, unknown>).some((job) => {
    const { steps, "runs-on": runner } = (job ?? {}) as { steps?: unknown; "runs-on"?: unknown };
    return runner != null && Array.isArray(steps) && steps.some((step) => {
      const uses = (step as { uses?: unknown } | null)?.uses;
      return typeof uses === "string" && uses.startsWith("actions/deploy-pages@");
    });
  });
}
