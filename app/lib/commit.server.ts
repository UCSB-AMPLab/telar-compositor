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
): Promise<{ newHeadSha: string }> {
  // 1. Fetch current HEAD OID
  const headData = await graphqlGitHub<HeadOidData>(token, GET_HEAD_OID, {
    owner,
    repo,
    branch,
  });
  const expectedHeadOid = headData.repository.ref.target.oid;

  // 2. Base64-encode each file's content (UTF-8 safe)
  const additions = files.map((f) => ({
    path: f.path,
    contents: btoa(unescape(encodeURIComponent(f.content))),
  }));

  // 3. Create the commit
  try {
    const commitData = await graphqlGitHub<CreateCommitData>(token, CREATE_COMMIT, {
      input: {
        branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
        message: { headline: message },
        fileChanges: { additions },
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to enable GitHub Pages: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { html_url?: string };
  const rawUrl = (data.html_url ?? "").replace(/\/+$/, "");
  return { pagesUrl: rawUrl.replace(/^http:\/\//, "https://") };
}

// ---------------------------------------------------------------------------
// Actions polling
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

/**
 * Returns all workflow runs associated with a specific commit SHA.
 * Treat an empty array as "pending" (GitHub may not register the run yet).
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
  return data.workflow_runs;
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
