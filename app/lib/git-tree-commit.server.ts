/**
 * One commit built from blobs already in the repository, text, and
 * deletions, fenced to the head it was planned on.
 *
 * The GraphQL `createCommitOnBranch` that `commitFilesToRepo` uses takes file
 * contents only, so moving an image through it re-sends the image. The Git
 * Data API names a blob by its SHA instead: a tree built on the parent's tree
 * (`base_tree`) places existing blobs at new paths by SHA, removes a path
 * with `sha: null`, and writes text by content, and the commit on that tree
 * moves the branch only from the parent it names.
 *
 * The fence is the ref update with `force: false`: GitHub refuses to move the
 * branch unless it points at the parent, answering 422, which is
 * thrown as `StaleHeadError` with nothing on the branch changed. Text is
 * cleaned as every primitive that encodes text for GitHub cleans it
 * (`cleanCommitContent`).
 *
 * @version v1.5.0-beta
 */

import { GITHUB_API, githubHeaders } from "~/lib/github.server";
import { StaleHeadError, cleanCommitContent } from "~/lib/commit.server";

/** A blob already in the repository, placed at `path`. */
export interface TreeBlobPlacement {
  path: string;
  sha: string;
  mode: string;
}

/** What one fenced commit writes. */
export interface TreeCommitRequest {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** The head every read was taken at; the commit's only parent. */
  parentSha: string;
  /** The commit message, sent as given. */
  message: string;
  placements: readonly TreeBlobPlacement[];
  texts: ReadonlyArray<{ path: string; content: string }>;
  /** Paths removed, each with the mode it had. */
  deletions: ReadonlyArray<{ path: string; mode: string }>;
}

/** A tree entry as the Git Data API's tree endpoint takes it. */
type TreeEntryInput =
  | { path: string; mode: string; type: "blob"; sha: string | null }
  | { path: string; mode: "100644"; type: "blob"; content: string };

/** The JSON a Git Data call answers, or an error naming the step that failed. */
async function gitDataJson<T>(response: Response, step: string): Promise<T> {
  if (!response.ok) throw new Error(`${step} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** The tree entries of a request: placements, then texts, then deletions. */
function treeEntriesOf(request: TreeCommitRequest): TreeEntryInput[] {
  return [
    ...request.placements.map((p) => ({ path: p.path, mode: p.mode, type: "blob" as const, sha: p.sha })),
    ...request.texts.map((t) => ({
      path: t.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: cleanCommitContent(t.path, t.content),
    })),
    ...request.deletions.map((d) => ({ path: d.path, mode: d.mode, type: "blob" as const, sha: null })),
  ];
}

/**
 * Commits the request on `branch` with `parentSha` as its parent and moves the
 * branch to it, answering the new commit's SHA. Throws `StaleHeadError` when
 * the branch does not point at `parentSha`, with nothing written to it, and
 * an `Error` for any other failure; after an `Error` from the ref update the
 * branch may or may not hold the commit.
 */
export async function commitTreeOnHead(request: TreeCommitRequest): Promise<{ commitSha: string }> {
  const base = `${GITHUB_API}/repos/${request.owner}/${request.repo}`;
  const headers = { ...githubHeaders(request.token), "Content-Type": "application/json" };

  const parent = await gitDataJson<{ tree: { sha: string } }>(
    await fetch(`${base}/git/commits/${request.parentSha}`, { headers }),
    "Reading the parent commit",
  );
  const tree = await gitDataJson<{ sha: string }>(
    await fetch(`${base}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: treeEntriesOf(request) }),
    }),
    "Creating the tree",
  );
  const commit = await gitDataJson<{ sha: string }>(
    await fetch(`${base}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: request.message, tree: tree.sha, parents: [request.parentSha] }),
    }),
    "Creating the commit",
  );

  const moved = await fetch(`${base}/git/refs/heads/${request.branch}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  if (moved.status === 422) throw new StaleHeadError("Repository HEAD has changed");
  await gitDataJson<unknown>(moved, "Updating the branch");
  return { commitSha: commit.sha };
}
