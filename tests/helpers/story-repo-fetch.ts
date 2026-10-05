/**
 * A repository's story files at one or more commits, served at the network
 * as GitHub serves them to `storyFilesAt` and `readStoriesForAccept`: the
 * GraphQL subtree lookup, the recursive listing of each subtree, and the
 * Contents API with `size`, so a strict read can check it has the whole file.
 * Every Contents read is recorded as `<commit>:<path>`.
 *
 * @version v1.5.0-beta
 */

import { gitBlobSha } from "~/lib/story-files.server";

export const SHEETS = "telar-content/spreadsheets";
export const TEXTS = "telar-content/texts/stories";

export interface StoryRepo {
  commits: Record<string, { sheets: string | null; texts: string | null }>;
  listings: Record<string, { truncated: boolean; tree: Array<{ path: string; sha: string; type: string; mode: string }> }>;
  files: Record<string, string>;
  /** `<commit>:<path>` reads answered with a server error. */
  failing: Set<string>;
  /** Every Contents API read, as `<commit>:<path>`. */
  contentReads: string[];
}

export function emptyStoryRepo(): StoryRepo {
  return { commits: {}, listings: {}, files: {}, failing: new Set(), contentReads: [] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * The answer to one request against `repo`, or null for a request that is not
 * the repository's (so a caller can route it elsewhere).
 */
export async function storyRepoAnswer(
  repo: StoryRepo,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response | null> {
  const url = input instanceof Request ? input.url : String(input);
  const parsed = new URL(url);
  const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(parsed.pathname);
  if (contents) {
    const path = contents[1].split("/").map(decodeURIComponent).join("/");
    const key = `${parsed.searchParams.get("ref")}:${path}`;
    repo.contentReads.push(key);
    if (repo.failing.has(key)) return json({ message: "boom" }, 500);
    const text = repo.files[key];
    if (text === undefined) return json({ message: "Not Found" }, 404);
    return json({
      encoding: "base64",
      content: Buffer.from(text, "utf8").toString("base64"),
      size: Buffer.byteLength(text, "utf8"),
    });
  }
  if (url === "https://api.github.com/graphql") {
    const body = input instanceof Request ? await input.text() : String(init?.body);
    const { variables } = JSON.parse(body) as { variables: Record<string, string> };
    const answer: Record<string, unknown> = {};
    for (const [name, expression] of Object.entries(variables)) {
      if (name === "owner" || name === "repo") continue;
      const [commit, path] = expression.split(":");
      const c = repo.commits[commit];
      if (path === undefined) {
        answer[name] = c ? { __typename: "Commit" } : null;
        continue;
      }
      const oid = c ? (path === SHEETS ? c.sheets : path === TEXTS ? c.texts : null) : null;
      answer[name] = oid ? { __typename: "Tree", oid } : null;
    }
    return json({ data: { repository: answer } });
  }
  const tree = /\/repos\/[^/]+\/[^/]+\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
  if (tree) {
    const listing = repo.listings[decodeURIComponent(tree[1])];
    return listing ? json({ sha: tree[1], ...listing }) : json({ message: "Not Found" }, 404);
  }
  return null;
}

/** Adds a commit holding `files` (full paths) to `repo`. */
export async function addStoryCommit(repo: StoryRepo, name: string, files: Record<string, string>): Promise<void> {
  const listFor = async (dir: string) => {
    const entries = Object.entries(files).filter(([p]) => p.startsWith(`${dir}/`));
    if (entries.length === 0) return null;
    const tree = [];
    for (const [p, text] of entries) {
      tree.push({ path: p.slice(dir.length + 1), sha: await gitBlobSha(text), type: "blob", mode: "100644" });
    }
    const oid = `tree-${name}-${dir}`;
    repo.listings[oid] = { truncated: false, tree };
    return oid;
  };
  repo.commits[name] = { sheets: await listFor(SHEETS), texts: await listFor(TEXTS) };
  for (const [p, text] of Object.entries(files)) repo.files[`${name}:${p}`] = text;
}
