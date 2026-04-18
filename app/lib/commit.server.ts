/**
 * GitHub commit and Actions polling utilities for the Telar Compositor.
 *
 * Provides:
 *   - commitFilesToRepo: multi-file atomic commit via GraphQL createCommitOnBranch
 *   - disableGoogleSheetsInConfig / isGoogleSheetsEnabled: safe _config.yml mutation
 *   - listWorkflowRunsBySha: Actions run status by commit SHA
 *   - getJobSteps: per-step status from an Actions run job
 *   - mapStepsToBuildPhases: maps workflow step names to 6 display phases
 *   - BUILD_PHASES: ordered list of display phase metadata
 *   - StaleHeadError: distinguishable error for stale expectedHeadOid failures
 *   - dispatchWorkflow: trigger a workflow_dispatch event for a specific workflow
 *   - getLatestWorkflowRun: fetch the most recently created run for a named workflow
 */

import { graphqlGitHub, githubHeaders } from "~/lib/github.server";

// ---------------------------------------------------------------------------
// GraphQL query strings
// ---------------------------------------------------------------------------

const GET_HEAD_OID = `
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

const CREATE_COMMIT = `
  mutation CreateCommit($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit {
        oid
        url
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// StaleHeadError
// ---------------------------------------------------------------------------

/**
 * Thrown when a createCommitOnBranch mutation fails because the repo HEAD has
 * moved since the expectedHeadOid was fetched. Callers should prompt the user
 * to re-sync before retrying the commit.
 */
export class StaleHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleHeadError";
  }
}

// ---------------------------------------------------------------------------
// commitFilesToRepo
// ---------------------------------------------------------------------------

export interface CommitFile {
  /** Repository-relative path, e.g. "telar-content/spreadsheets/objects.csv" */
  path: string;
  /** UTF-8 file content — will be base64-encoded before sending */
  content: string;
}

interface HeadOidData {
  repository: { ref: { target: { oid: string } } };
}

interface CreateCommitData {
  createCommitOnBranch: { commit: { oid: string; url: string } };
}

/**
 * Commits one or more files to a repository branch in a single atomic commit
 * via the GitHub GraphQL createCommitOnBranch mutation.
 *
 * Fetches the current HEAD OID immediately before committing to minimise the
 * risk of stale OID errors. If the commit fails with "Expected HEAD" in the
 * error message, throws a StaleHeadError so callers can handle re-sync.
 *
 * Returns the new commit SHA on success.
 */
export async function commitFilesToRepo(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: CommitFile[],
  message: string,
  messageBody?: string,
  deletions?: string[],
  skipCi?: boolean,
  expectedHeadOidOverride?: string,
): Promise<{ newHeadSha: string }> {
  // 1. Resolve expectedHeadOid — prefer caller-supplied override (
  //    captured earlier in a multi-step pipeline to guard against TOCTOU), fall
  //    back to a fresh lookup to keep single-step callers backward-compatible.
  let expectedHeadOid: string;
  if (expectedHeadOidOverride) {
    expectedHeadOid = expectedHeadOidOverride;
  } else {
    const headData = await graphqlGitHub<HeadOidData>(token, GET_HEAD_OID, {
      owner,
      repo,
      branch,
    });
    expectedHeadOid = headData.repository.ref.target.oid;
  }

  // 2. Base64-encode each file's content (UTF-8 safe)
  const additions = files.map((f) => ({
    path: f.path,
    contents: btoa(unescape(encodeURIComponent(f.content))),
  }));

  // 3. Create the commit
  const headline = skipCi ? `${message} [skip ci]` : message;

  try {
    const commitData = await graphqlGitHub<CreateCommitData>(token, CREATE_COMMIT, {
      input: {
        branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
        message: messageBody
          ? { headline, body: messageBody }
          : { headline },
        fileChanges: {
          additions,
          ...(deletions && deletions.length > 0
            ? { deletions: deletions.map((path) => ({ path })) }
            : {}),
        },
        expectedHeadOid,
      },
    });

    return { newHeadSha: commitData.createCommitOnBranch.commit.oid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Expected HEAD") || msg.includes("expected head")) {
      throw new StaleHeadError(msg);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Google Sheets config helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the _config.yml content has a google_sheets block with
 * enabled: true.
 */
export function isGoogleSheetsEnabled(configYmlContent: string): boolean {
  const lines = configYmlContent.split("\n");
  let inGoogleSheets = false;
  for (const line of lines) {
    if (/^google_sheets:/.test(line)) {
      inGoogleSheets = true;
      continue;
    }
    if (inGoogleSheets) {
      // End of google_sheets block: a non-indented, non-comment, non-empty line
      if (/^[^\s#]/.test(line) && line.trim() !== "") {
        inGoogleSheets = false;
        continue;
      }
      if (/^\s+enabled:\s*(true|True)\b/.test(line)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Replaces `enabled: true` with `enabled: false` in the google_sheets block
 * of a _config.yml string. Preserves all other content including comments,
 * formatting, and indentation.
 *
 * Idempotent: if already disabled, returns the content unchanged.
 */
export function disableGoogleSheetsInConfig(configYmlContent: string): string {
  const lines = configYmlContent.split("\n");
  let inGoogleSheets = false;
  const result: string[] = [];

  for (const line of lines) {
    if (/^google_sheets:/.test(line)) {
      inGoogleSheets = true;
      result.push(line);
      continue;
    }

    if (inGoogleSheets) {
      // End of google_sheets block
      if (/^[^\s#]/.test(line) && line.trim() !== "") {
        inGoogleSheets = false;
      } else if (/^(\s+enabled:\s*)true\b/.test(line)) {
        result.push(line.replace(/^(\s+enabled:\s*)true\b/, "$1false"));
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// URL verification
// ---------------------------------------------------------------------------

export interface SiteUrlCheck {
  pagesEnabled: boolean;
  match: boolean;
  pagesUrl: string;
  configUrl: string;
}

/**
 * Checks GitHub Pages status and verifies that _config.yml url+baseurl matches
 * the deployment URL. Mismatched URLs produce IIIF manifests with wrong base paths.
 *
 * Uses the GitHub Pages API (requires `pages: read` permission on the GitHub App).
 */
export async function verifySiteUrl(
  token: string,
  owner: string,
  repo: string,
  configYmlContent: string,
): Promise<SiteUrlCheck> {
  // Extract url and baseurl from _config.yml
  const urlMatch = configYmlContent.match(/^url:\s*"?([^"\n]+)"?\s*$/m);
  const baseurlMatch = configYmlContent.match(/^baseurl:\s*"?([^"\n]*)"?\s*$/m);
  const configUrl = (urlMatch?.[1]?.trim() ?? "") + (baseurlMatch?.[1]?.trim() ?? "");

  // Fetch the Pages deployment URL
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pages`,
    { headers: githubHeaders(token) },
  );

  if (!res.ok) {
    // Pages not enabled or no permission
    return { pagesEnabled: false, match: false, pagesUrl: "", configUrl };
  }

  const data = (await res.json()) as { html_url?: string; https_enforced?: boolean };
  // GitHub Pages API may return http:// even when HTTPS is enforced — always normalise to https
  const rawUrl = (data.html_url ?? "").replace(/\/+$/, "");
  const pagesUrl = rawUrl.replace(/^http:\/\//, "https://");

  const normalizedConfig = configUrl.replace(/\/+$/, "");
  return {
    pagesEnabled: true,
    match: normalizedConfig === pagesUrl,
    pagesUrl,
    configUrl: normalizedConfig,
  };
}

/**
 * Enables GitHub Pages for a repository using GitHub Actions as the build source.
 * Requires `pages: write` permission on the GitHub App.
 */
export async function enableGitHubPages(
  token: string,
  owner: string,
  repo: string,
): Promise<{ pagesUrl: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pages`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        build_type: "workflow",
      }),
    },
  );

  // 409 = Pages already enabled — fetch the existing URL instead
  if (res.status === 409) {
    const getRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pages`,
      { headers: githubHeaders(token) },
    );
    if (getRes.ok) {
      const data = (await getRes.json()) as { html_url?: string };
      const rawUrl = (data.html_url ?? "").replace(/\/+$/, "");
      return { pagesUrl: rawUrl.replace(/^http:\/\//, "https://") };
    }
  }

  // 403 = insufficient permissions — likely missing pages:write on GitHub App
  if (res.status === 403) {
    throw new Error("pages_permission_denied");
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to enable GitHub Pages: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { html_url?: string };
  const rawUrl = (data.html_url ?? "").replace(/\/+$/, "");
  return { pagesUrl: rawUrl.replace(/^http:\/\//, "https://") };
}

// ---------------------------------------------------------------------------
// Workflow dispatch
// ---------------------------------------------------------------------------

/**
 * Result returned by dispatchWorkflow when the API supports return_run_details.
 * When the API responds with 204 (legacy/GHES fallback), runId is 0 and URLs are empty.
 */
export interface DispatchResult {
  runId: number;
  runUrl: string;
  htmlUrl: string;
}

/**
 * Triggers a workflow_dispatch event for a specific workflow file.
 * Sends return_run_details: true to request the workflow run ID directly from the
 * API response (GitHub API enhancement, February 2026). Returns DispatchResult with
 * the run ID and URLs. Falls back gracefully to { runId: 0, ... } for GHES instances
 * that respond with 204 No Content.
 */
export async function dispatchWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
  inputs?: Record<string, string>,
): Promise<DispatchResult> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: inputs ?? {}, return_run_details: true }),
    },
  );

  // 204 No Content — legacy/GHES fallback (return_run_details not supported)
  if (res.status === 204) {
    return { runId: 0, runUrl: "", htmlUrl: "" };
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`workflow_dispatch failed (${res.status}): ${body}`);
  }

  // 200 OK with JSON body — return_run_details supported
  const data = (await res.json()) as {
    workflow_run_id: number;
    run_url: string;
    html_url: string;
  };
  return {
    runId: data.workflow_run_id,
    runUrl: data.run_url,
    htmlUrl: data.html_url,
  };
}

/**
 * Returns the most recently created run for a named workflow file.
 * Use after dispatchWorkflow() with a short delay (~3s) to find the
 * dispatched run, then poll getJobSteps() for progress.
 */
export async function getLatestWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
): Promise<WorkflowRun | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs[0] ?? null;
}

// ---------------------------------------------------------------------------
// Actions polling
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

/** Workflow names to match for the deploy build (case-insensitive). */
const DEPLOY_WORKFLOW_NAMES = ["build and deploy telar site", "build and deploy", "build-and-deploy", "deploy"];

/**
 * Returns workflow runs associated with a specific commit SHA, filtered to
 * the deploy workflow. Falls back to all runs if no deploy workflow is found
 * (so polling still works for repos with non-standard workflow names).
 */
export async function listWorkflowRunsBySha(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
): Promise<WorkflowRun[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub Actions API error: ${res.status}`);
  }
  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  const deployRuns = data.workflow_runs.filter((r) =>
    DEPLOY_WORKFLOW_NAMES.includes(r.name.toLowerCase()),
  );
  return deployRuns.length > 0 ? deployRuns : data.workflow_runs;
}

export interface JobStep {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Returns the steps array from the first job of a workflow run.
 * The Telar build workflow has a single job (build-and-deploy).
 */
export async function getJobSteps(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<JobStep[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`GitHub Actions jobs API error: ${res.status}`);
  }
  const data = (await res.json()) as {
    jobs: Array<{ steps: JobStep[] }>;
  };
  return data.jobs[0]?.steps ?? [];
}

// ---------------------------------------------------------------------------
// Build phase mapping
// ---------------------------------------------------------------------------

/**
 * The 6 display phases shown in the build progress UI.
 * Order matches the workflow execution order.
 */
export const BUILD_PHASES = [
  { id: "setup", label: "Setup" },
  { id: "build-js", label: "Build JS" },
  { id: "process-data", label: "Process data" },
  { id: "build-site", label: "Build site" },
  { id: "iiif", label: "IIIF tiles" },
  { id: "deploy", label: "Deploy" },
] as const;

/**
 * Maps each GitHub Actions workflow step name to a display phase ID.
 * The "Fetch data from Google Sheets" step is intentionally omitted —
 * it is always skipped when the compositor is active.
 */
const BUILD_STEP_TO_PHASE: Record<string, string> = {
  "Checkout repository": "setup",
  "Set up Ruby": "setup",
  "Set up Python": "setup",
  "Install libvips (for fast IIIF tile generation)": "setup",
  "Install Python dependencies": "setup",
  "Set up Node.js": "setup",
  "Build JavaScript bundle": "build-js",
  // "Fetch data from Google Sheets (if enabled)" — intentionally omitted
  "Convert CSV to JSON": "process-data",
  "Generate Jekyll collections": "process-data",
  "Generate search data": "process-data",
  "Build Jekyll site": "build-site",
  "Restore IIIF tiles from cache": "iiif",
  "Detect if IIIF regeneration is needed": "iiif",
  "Generate IIIF tiles into _site": "iiif",
  "Copy generated IIIF tiles to cache directory": "iiif",
  "Save IIIF tiles to cache": "iiif",
  "Restore IIIF tiles from cache to _site (when skipping regeneration)": "iiif",
  "Upload artifact": "deploy",
  "Deploy to GitHub Pages": "deploy",
  // Lightweight workflow step mappings (objects-only, story-only)
  "Convert story CSV to JSON": "process-data",
  "Commit updated data files": "deploy",
  "Generate IIIF tiles": "iiif",
  "Commit generated tiles": "deploy",
};

export interface BuildPhaseStatus {
  id: string;
  label: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "skipped" | null;
}

/**
 * Maps raw workflow step statuses to the 6 display phases.
 *
 * Phase status rules:
 *   - "completed" if all mapped steps are completed
 *   - "in_progress" if any mapped step is in_progress
 *   - "queued" otherwise
 *
 * Phase conclusion rules (only when status is "completed"):
 *   - "failure" if any step has conclusion "failure"
 *   - "skipped" if all steps have conclusion "skipped"
 *   - "success" otherwise
 */
export function mapStepsToBuildPhases(steps: JobStep[]): BuildPhaseStatus[] {
  // Group steps by phase
  const phaseSteps: Record<string, JobStep[]> = {};
  for (const phase of BUILD_PHASES) {
    phaseSteps[phase.id] = [];
  }

  for (const step of steps) {
    const phaseId = BUILD_STEP_TO_PHASE[step.name];
    if (phaseId && phaseSteps[phaseId]) {
      phaseSteps[phaseId].push(step);
    }
    // Unmapped steps (including Google Sheets) are silently skipped
  }

  return BUILD_PHASES.map((phase) => {
    const stepsForPhase = phaseSteps[phase.id];

    if (stepsForPhase.length === 0) {
      return { id: phase.id, label: phase.label, status: "queued", conclusion: null };
    }

    // Determine status
    const anyInProgress = stepsForPhase.some((s) => s.status === "in_progress");
    const allCompleted = stepsForPhase.every((s) => s.status === "completed");
    const status: BuildPhaseStatus["status"] = allCompleted
      ? "completed"
      : anyInProgress
        ? "in_progress"
        : "queued";

    // Determine conclusion
    let conclusion: BuildPhaseStatus["conclusion"] = null;
    if (allCompleted) {
      if (stepsForPhase.some((s) => s.conclusion === "failure")) {
        conclusion = "failure";
      } else if (stepsForPhase.every((s) => s.conclusion === "skipped")) {
        conclusion = "skipped";
      } else {
        conclusion = "success";
      }
    }

    return { id: phase.id, label: phase.label, status, conclusion };
  });
}
