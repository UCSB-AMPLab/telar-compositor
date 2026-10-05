/**
 * GitHub commit and Actions polling utilities for the Telar Compositor.
 *
 * Provides:
 *   - commitFilesToRepo: multi-file atomic commit via GraphQL createCommitOnBranch,
 *     with deletions narrowed to paths present at the expected head
 *   - cleanCommitContent: the text cleaning every commit primitive applies to
 *     an author file before encoding it
 *   - disableGoogleSheetsInConfig / isGoogleSheetsEnabled: safe _config.yml mutation
 *   - listWorkflowRunsBySha: Actions run status by commit SHA
 *   - getJobSteps: per-step status from an Actions run job
 *   - mapStepsToBuildPhases: maps workflow step names to 6 display phases
 *   - BUILD_PHASES: ordered list of display phase metadata
 *   - StaleHeadError: distinguishable error for stale expectedHeadOid failures
 *   - dispatchWorkflow: trigger a workflow_dispatch event for a specific workflow
 *   - getLatestWorkflowRun: fetch the most recently created run for a named workflow
 *   - getWorkflowRun: fetch one run by its id
 *
 * @version v1.5.0-beta
 */

import { getFileAtRef, graphqlGitHub, githubHeaders } from "~/lib/github.server";
import {
  mutateYamlBlock,
  readConfigScalar,
} from "~/lib/config-yaml-block.server";
import { isFrameworkPath } from "~/lib/framework-paths.server";
import { cleanText } from "~/lib/unsafe-text";
import { isGoogleSheetsOn, sameExceptSheetsEnabled } from "~/lib/pyyaml";

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

/**
 * Upper bound on paths probed per existence query. GraphQL aliases are cheap
 * but the query string grows with each one, so long deletion lists are split.
 */
const PATH_EXISTENCE_BATCH = 100;

interface PathExistenceData {
  repository: Record<string, { __typename: string } | null> | null;
}

/**
 * Returns the subset of `paths` that exist in the tree at `oid`.
 *
 * Probes each path as `<oid>:<path>` through aliased `object` fields, so one
 * round trip covers a whole batch. A path that resolves to null is absent.
 */
async function filterExistingPaths(
  token: string,
  owner: string,
  repo: string,
  oid: string,
  paths: string[],
): Promise<string[]> {
  const present: string[] = [];

  for (let start = 0; start < paths.length; start += PATH_EXISTENCE_BATCH) {
    const batch = paths.slice(start, start + PATH_EXISTENCE_BATCH);
    const varDefs = batch.map((_, i) => `$p${i}: String!`).join(", ");
    const fields = batch
      .map((_, i) => `p${i}: object(expression: $p${i}) { __typename }`)
      .join("\n          ");
    const query = `
      query CheckPaths($owner: String!, $repo: String!, ${varDefs}) {
        repository(owner: $owner, name: $repo) {
          ${fields}
        }
      }
    `;

    const variables: Record<string, string> = { owner, repo };
    batch.forEach((path, i) => {
      variables[`p${i}`] = `${oid}:${path}`;
    });

    const data = await graphqlGitHub<PathExistenceData>(token, query, variables);
    batch.forEach((path, i) => {
      if (data.repository?.[`p${i}`]) present.push(path);
    });
  }

  return present;
}

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

/**
 * A path the commit deletes when it is present at the expected head and none
 * of `unlessPresent` is. With `onlyIfUnreadable`, also only when its bytes
 * there are not valid UTF-8, as a strict read reports them (`lossy`). A read
 * of such a path that fails refuses the commit (`UnreadableOlderCopyError`);
 * a path gone by the time it is read is not deleted.
 */
export interface ConditionalDeletion {
  path: string;
  unlessPresent: string[];
  onlyIfUnreadable?: boolean;
}

/**
 * A file a commit would delete only if its bytes are not valid UTF-8 could
 * not be read, so nothing is committed: kept, it would never be selected
 * again once the commit wrote the file that replaces it.
 */
export class UnreadableOlderCopyError extends Error {
  constructor(readonly path: string) {
    super(`could not read ${path} to tell whether its bytes are valid UTF-8`);
    this.name = "UnreadableOlderCopyError";
  }
}

export interface CommitFile {
  /** Repository-relative path, e.g. "telar-content/spreadsheets/objects.csv" */
  path: string;
  /**
   * UTF-8 file content, base64-encoded before sending; with `encoding:
   * "base64"`, the file's bytes already in base64, sent as they are.
   */
  content: string;
  /** Set for a file that is not text, such as a framework image. */
  encoding?: "base64";
  /**
   * Set for text committed as it is, without `cleanCommitContent`: a sheet the
   * upgrade repairs is written as the framework's 1.8.0 migration writes it
   * (`Sheet.write` in scripts/migrations/v180_sheets.py), the edited text and
   * nothing else, so the repair changes no cell the author did not choose.
   */
  verbatim?: true;
}

/**
 * Returns the content to commit at `path`: the text with the characters a
 * Telar build rejects cleaned out (`cleanText`), unless the path is a
 * framework path, which is committed byte for byte because the upgrade
 * compares it to the release by blob hash, or a dotfile such as
 * `.compositor-ignored` or `.gitignore`, whose lines are exact paths that a
 * cleaned character would no longer match. Never changes the path.
 *
 * Every primitive that encodes text for GitHub calls this just before
 * encoding, so a writer is covered without cleaning anything itself, and text
 * a writer carries forward from the repository is cleaned with the rest.
 */
export function cleanCommitContent(path: string, content: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return isFrameworkPath(path) || name.startsWith(".") ? content : cleanText(content);
}

interface HeadOidData {
  repository: { ref: { target: { oid: string } } };
}

interface CreateCommitData {
  createCommitOnBranch: { commit: { oid: string; url: string } };
}

/**
 * The deletions a commit at `oid` sends: each of `deletions` present there,
 * then each conditional deletion whose path is present and none of whose
 * `unlessPresent` is, and, where it asks, whose bytes are not valid UTF-8. One
 * existence probe answers the first two tests; a file is read only once they
 * select it, and a read that fails throws before anything is committed.
 */
async function deletionsAtHead(
  token: string,
  owner: string,
  repo: string,
  oid: string,
  deletions: string[],
  conditional: ConditionalDeletion[],
): Promise<string[]> {
  const probe = [...new Set([...deletions, ...conditional.flatMap((c) => [c.path, ...c.unlessPresent])])];
  if (probe.length === 0) return [];
  const present = new Set(await filterExistingPaths(token, owner, repo, oid, probe));
  const absent = deletions.filter((p) => !present.has(p));
  if (absent.length > 0) {
    console.warn(
      `[commitFilesToRepo] ${absent.length} deletion path(s) absent at ${oid}, skipping: ${absent.join(", ")}`,
    );
  }
  const kept = deletions.filter((p) => present.has(p));
  const selected = conditional.filter((c) => present.has(c.path) && !c.unlessPresent.some((p) => present.has(p)));
  const older = await filterAsync(selected, (c) => !c.onlyIfUnreadable || unreadableAt(token, owner, repo, oid, c.path));
  return [...new Set([...kept, ...older.map((c) => c.path)])];
}

/** The items `keep` answers true for, in order. */
async function filterAsync<T>(items: readonly T[], keep: (item: T) => boolean | Promise<boolean>): Promise<T[]> {
  const answers = await Promise.all(items.map(keep));
  return items.filter((_, i) => answers[i]);
}

/**
 * Whether `path` at `oid` holds bytes that are not valid UTF-8, by the strict
 * read the unreadable-characters warning is raised from. A file no longer
 * there answers false; a read that fails throws `UnreadableOlderCopyError`.
 */
async function unreadableAt(token: string, owner: string, repo: string, oid: string, path: string): Promise<boolean> {
  const read = await getFileAtRef(token, owner, repo, path, oid, { strict: true });
  if (read.status === "error") throw new UnreadableOlderCopyError(path);
  return read.status === "ok" && read.lossy === true;
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
  conditionalDeletions?: ConditionalDeletion[],
): Promise<{ newHeadSha: string }> {
  // 1. Resolve expectedHeadOid — prefer caller-supplied override (captured
  //    earlier in a multi-step pipeline to guard against TOCTOU), fall back
  //    to a fresh lookup to keep single-step callers backward-compatible.
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

  // 2. Narrow deletions to paths that are actually present at expectedHeadOid.
  //    createCommitOnBranch rejects the WHOLE commit if any deletion targets a
  //    path that is already absent, so an unfiltered list makes a commit
  //    un-retryable once part of it has landed.
  const presentDeletions = await deletionsAtHead(
    token, owner, repo, expectedHeadOid, deletions ?? [], conditionalDeletions ?? [],
  );

  // 3. Base64-encode each text file's content (UTF-8 safe); a file carried as
  //    bytes is already base64.
  const additions = files.map((f) => ({
    path: f.path,
    contents: f.encoding === "base64"
      ? f.content
      : btoa(unescape(encodeURIComponent(f.verbatim ? f.content : cleanCommitContent(f.path, f.content)))),
  }));

  // 4. Create the commit
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
          ...(presentDeletions.length > 0
            ? { deletions: presentDeletions.map((path) => ({ path })) }
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
 * Whether the build fetches Google Sheets for this _config.yml: read through
 * the PyYAML port as the build reads it, so `TRUE`, `yes`, `on` and a quoted
 * "True" count as on and a quoted "true" does not (`isGoogleSheetsOn`).
 */
export function isGoogleSheetsEnabled(configYmlContent: string): boolean {
  return isGoogleSheetsOn(configYmlContent);
}

/** A YAML 1.1 true spelling, or the quoted string "True" the build also reads as on, on an `enabled:` line. */
const ENABLED_TRUE_LINE = /^(\s+enabled:\s*)(?:true|True|TRUE|yes|Yes|YES|on|On|ON|"True"|'True')(?![\w-])/;
/** The same, inside a flow mapping: `{enabled: yes, ...}`. */
const ENABLED_TRUE_FLOW = /(\benabled\s*:\s*)(?:true|True|TRUE|yes|Yes|YES|on|On|ON)(?![\w-])/;

/** Thrown when a config reads as Google Sheets on and no safe rewrite turns it off. */
export class SheetsNotDisableableError extends Error {
  constructor() {
    super("google_sheets.enabled is on in a form that cannot be rewritten safely");
    this.name = "SheetsNotDisableableError";
  }
}

/** The text of a flow-style `google_sheets: {...}` mapping, which may span lines, and where it sits. */
function flowSheetsSpan(content: string): { start: number; end: number } | null {
  const header = /^google_sheets:\s*\{/m.exec(content);
  if (!header) return null;
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}" && --depth === 0) return { start, end: i };
  }
  return null;
}

function disableFlowSheets(content: string): string {
  const span = flowSheetsSpan(content);
  if (!span) return content;
  const inside = content.slice(span.start, span.end).replace(ENABLED_TRUE_FLOW, "$1false");
  return content.slice(0, span.start) + inside + content.slice(span.end);
}

/**
 * Replaces an unquoted true spelling (`true`, `yes`, `on`, in any case the
 * build reads as true) on `enabled:` in the google_sheets block of a
 * _config.yml string with `false`, in block or flow style, and a quoted
 * "True" in block style. Preserves all other
 * content including comments, formatting, and indentation.
 *
 * Idempotent: if already disabled, returns the content unchanged. Throws
 * `SheetsNotDisableableError` when the file still reads as Sheets on after the
 * rewrite (an anchor, an alias, a tag, or any other form it does not rewrite),
 * or when the rewrite changed anything else the build reads,
 * so a caller never goes on as though Sheets were off.
 */
export function disableGoogleSheetsInConfig(configYmlContent: string): string {
  if (!isGoogleSheetsOn(configYmlContent)) return configYmlContent;
  const rewritten = disableFlowSheets(
    mutateYamlBlock(configYmlContent, "google_sheets", (line) =>
      ENABLED_TRUE_LINE.test(line) ? line.replace(ENABLED_TRUE_LINE, "$1false") : null,
    ),
  );
  // The rewrite is line-based: it must have changed the setting and nothing
  // else the build reads, a quoted value containing `enabled: yes` included.
  if (isGoogleSheetsOn(rewritten) || !sameExceptSheetsEnabled(configYmlContent, rewritten)) {
    throw new SheetsNotDisableableError();
  }
  return rewritten;
}

// ---------------------------------------------------------------------------
// URL verification
// ---------------------------------------------------------------------------

export interface SiteUrlCheck {
  pagesEnabled: boolean;
  match: boolean;
  pagesUrl: string;
  configUrl: string;
  /**
   * The Pages read failed (a server error, a rate limit, a timeout), which
   * says nothing about whether Pages is on or the address matches. A 404, 401
   * or 403 is an answer and leaves this unset.
   */
  readFailed?: true;
  /** The Pages read was refused (401 or 403): no Pages URL exists to compare. */
  readRefused?: true;
}

/**
 * Whether the repository is private, or null when the question could not be
 * answered.
 *
 * The three states are the point. GitHub Pages does not serve a private
 * repository on a free plan, so a private repository is the likeliest cause of
 * a build that fails at the deploy step or of Pages refusing to switch on — but
 * only a definite `false` from GitHub licenses naming that cause to an author.
 * A failed probe returns null and the caller says nothing, because "the
 * repository is private" and "we could not ask" are different answers and only
 * one of them is about the author's repository.
 *
 * Call it on a failure path. Nothing here needs it when things are working.
 */
export async function isRepoPrivate(
  token: string,
  owner: string,
  repo: string,
): Promise<boolean | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: githubHeaders(token),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { private?: boolean };
    return typeof data.private === "boolean" ? data.private : null;
  } catch {
    return null;
  }
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
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<SiteUrlCheck> {
  // Extract url and baseurl from _config.yml via the shared scalar reader, so a
  // line carrying an inline `# comment` reads its value cleanly (the previous
  // anchored regex either failed the match outright on a quoted+commented line,
  // or folded the comment text into a bare value).
  const configUrl =
    (readConfigScalar(configYmlContent, "url") ?? "") +
    (readConfigScalar(configYmlContent, "baseurl") ?? "");

  // Opt-in Pages-settling backoff. Right after Pages is enabled, GET /pages
  // returns a transient 404 until the first deployment registers; a single read
  // would then wrongly report "Pages not enabled." Callers that run in that
  // window (the onboarding check-site-config on a degraded born-clean site) pass
  // attempts>1 to retry on a transient 404/5xx. Default attempts=1 keeps the
  // commit-hot-path callers (_app.objects.tsx) fast — a 404 is the normal
  // response for a genuinely Pages-less repo, so they must not eat the latency.
  const attempts = Math.max(1, opts.attempts ?? 1);
  const intervalMs = opts.intervalMs ?? 1500;
  let res!: Response;
  for (let attempt = 0; attempt < attempts; attempt++) {
    res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pages`,
      { headers: githubHeaders(token) },
    );
    if (res.ok) break;
    const transient = res.status === 404 || res.status >= 500;
    if (!transient || attempt === attempts - 1) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (!res.ok) {
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      return { pagesEnabled: false, match: false, pagesUrl: "", configUrl, readFailed: true };
    }
    // Pages not enabled or no permission
    const refused = res.status === 401 || res.status === 403;
    return { pagesEnabled: false, match: false, pagesUrl: "", configUrl, ...(refused ? { readRefused: true as const } : {}) };
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
 * A runId of 0 with empty URLs means the dispatch was accepted and the run was
 * not named — the 204 a GHES instance answers with, or a 2xx whose body could
 * not be read.
 */
export interface DispatchResult {
  runId: number;
  runUrl: string;
  htmlUrl: string;
}

/**
 * Triggers a workflow_dispatch event for a specific workflow file.
 *
 * Sends return_run_details: true, which asks GitHub to name the run it started
 * in the response body rather than leaving the caller to guess it from a
 * listing. Not every deployment honours that: a GHES instance answers 204 No
 * Content, and a body can fail to arrive, fail to parse, or parse to something
 * that is not an object. All of those are answered with { runId: 0, ... } rather
 * than a throw, because the dispatch itself succeeded and a caller told
 * otherwise would report a running build as a failure. Only a non-2xx status
 * throws.
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

  // 2xx with a JSON body — return_run_details supported. A body that cannot be
  // read, cannot be parsed, or does not parse to an object leaves the run
  // unnamed, which is the same answer as the 204 above: the dispatch was
  // accepted either way. `null` parses cleanly and is not an object, so the
  // shape has to be checked rather than only the parse — reading a field off it
  // would throw outside the catch and turn a running build into a failure.
  const unnamedRun: DispatchResult = { runId: 0, runUrl: "", htmlUrl: "" };
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return unnamedRun;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return unnamedRun;
  }
  const data = payload as Partial<{
    workflow_run_id: number;
    run_url: string;
    html_url: string;
  }>;
  return {
    runId: data.workflow_run_id ?? 0,
    runUrl: data.run_url ?? "",
    htmlUrl: data.html_url ?? "",
  };
}

/**
 * One GET against a repository's Actions API. The run and job readers below
 * differ only in the path they ask for and in what they make of a non-ok
 * answer, so the request itself is written once.
 */
function actionsApiGet(token: string, path: string): Promise<Response> {
  return fetch(`https://api.github.com/repos/${path}`, {
    headers: githubHeaders(token),
  });
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
  const res = await actionsApiGet(
    token,
    `${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs[0] ?? null;
}

/**
 * Returns one workflow run by its id, or null when GitHub does not answer with
 * the run — including the 404 a just-dispatched run gives while it is still
 * being registered, which callers distinguish by retrying rather than by the
 * status.
 */
export async function getWorkflowRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<WorkflowRun | null> {
  const res = await actionsApiGet(token, `${owner}/${repo}/actions/runs/${runId}`);
  if (!res.ok) return null;
  return (await res.json()) as WorkflowRun;
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
  /** Optional because the run listings this type also describes are consumed
   *  for status alone; the REST payload carries it on both shapes. */
  head_sha?: string;
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
  const res = await actionsApiGet(
    token,
    `${owner}/${repo}/actions/runs?head_sha=${headSha}`,
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
  const res = await actionsApiGet(token, `${owner}/${repo}/actions/runs/${runId}/jobs`);
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
