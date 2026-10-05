/**
 * A repository on GitHub as the default-branch fix sees it, answered through
 * `fetch`: the default branch, its branches and tags, the files at each
 * branch's head, and the Pages source.
 *
 * A short ref name resolves against branches and tags alike, as GitHub's
 * `ref(qualifiedName:)` does, so a caller that looks `main` up by its short
 * name finds a tag of that name; `refs/heads/<name>` finds only a branch. A
 * rename answers at once and completes after `renameLag` reads of the default
 * branch, as GitHub finishes a rename after answering it.
 *
 * @version v1.5.0-beta
 */

import { vi } from "vitest";

export interface PagesSite {
  build_type: "legacy" | "workflow";
  source?: { branch: string; path: string };
}

export interface GitHubRepoFake {
  defaultBranch: string | null;
  /** Branch name to head commit. */
  branches: Map<string, string>;
  /** Tag name to commit. */
  tags: Map<string, string>;
  /** Files at a commit, keyed by the commit's oid. */
  files: Map<string, Record<string, string>>;
  pages: PagesSite | null;
  /** Default-branch reads a rename stays unfinished for. */
  renameLag: number;
  /** Statuses the next rename, repository PATCH or Pages PUT answer with in place of success. */
  renameStatuses: number[];
  patchStatuses: number[];
  pagesPutStatus: number | null;
  /** Commits whose contents reads fail with a 502. */
  failingCommits: Set<string>;
  /** GraphQL head lookups that fail with a 502. */
  failHeadLookup: boolean;
  /** Every request made, in order, as "METHOD path" with its token and body. */
  log: Array<{ call: string; auth: string | null; body: unknown }>;
  /** Called on a rename or PATCH that GitHub has answered, to model a change made meanwhile. */
  onChange?: (call: string) => void;
}

export function repoFake(overrides: Partial<GitHubRepoFake> = {}): GitHubRepoFake {
  return {
    defaultBranch: "master",
    branches: new Map([["master", "master-sha"]]),
    tags: new Map(),
    files: new Map(),
    pages: null,
    renameLag: 0,
    renameStatuses: [],
    patchStatuses: [],
    pagesPutStatus: null,
    failingCommits: new Set(),
    failHeadLookup: false,
    log: [],
    ...overrides,
  };
}

export const TELAR_CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';
/** A build workflow that publishes to Pages, as the framework's does. */
export const BUILD_WORKFLOW =
  "name: Build\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/deploy-pages@v5\n";
/** A workflow at the same path that builds and never deploys to Pages. */
export const NON_DEPLOYING_WORKFLOW = "name: Build\non: push\njobs:\n  test:\n    steps:\n      - run: npm test\n";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function utf8Base64(text: string): { content: string; size: number } {
  const bytes = new TextEncoder().encode(text);
  return { content: btoa(String.fromCharCode(...bytes)), size: bytes.length };
}

/** A commit a contents `ref` names: an oid, or `refs/heads/<branch>`. */
function commitFor(repo: GitHubRepoFake, ref: string): string | undefined {
  if (ref.startsWith("refs/heads/")) return repo.branches.get(ref.slice("refs/heads/".length));
  return repo.files.has(ref) ? ref : (repo.branches.get(ref) ?? repo.tags.get(ref));
}

function headLookup(repo: GitHubRepoFake, name: string): string | undefined {
  if (name.startsWith("refs/heads/")) return repo.branches.get(name.slice("refs/heads/".length));
  if (name.startsWith("refs/tags/")) return repo.tags.get(name.slice("refs/tags/".length));
  return repo.branches.get(name) ?? repo.tags.get(name);
}

let pendingRename: { from: string; readsLeft: number } | null = null;

function defaultBranchRead(repo: GitHubRepoFake): Response {
  if (pendingRename) {
    if (pendingRename.readsLeft <= 0) {
      const oid = repo.branches.get(pendingRename.from) as string;
      repo.branches.delete(pendingRename.from);
      repo.branches.set("main", oid);
      if (repo.defaultBranch === pendingRename.from) repo.defaultBranch = "main";
      pendingRename = null;
    } else {
      pendingRename.readsLeft -= 1;
    }
  }
  const name = repo.defaultBranch;
  const ref = name === null ? null : { name, target: { oid: repo.branches.get(name) } };
  return json({ data: { repository: { defaultBranchRef: ref } } });
}

/** Installs the fake as `globalThis.fetch` and returns the mock. */
export function installRepoFake(repo: GitHubRepoFake, owner = "owner", name = "repo") {
  pendingRename = null;
  const base = `https://api.github.com/repos/${owner}/${name}`;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.href.startsWith(base) ? url.pathname.slice(`/repos/${owner}/${name}`.length) : url.pathname;
    repo.log.push({ call: `${method} ${path}`, auth: headers.Authorization ?? null, body });

    if (url.href === "https://api.github.com/graphql") {
      const { query, variables } = body as { query: string; variables: Record<string, string> };
      if (/query DefaultBranchHead\b/.test(query)) return defaultBranchRead(repo);
      if (/query GetHeadOid\b/.test(query)) {
        if (repo.failHeadLookup) return json({ message: "Bad Gateway" }, 502);
        const oid = headLookup(repo, variables.branch);
        return json({ data: { repository: { ref: oid === undefined ? null : { target: { oid } } } } });
      }
      throw new Error(`unexpected GraphQL query: ${query}`);
    }

    if (method === "GET" && path.startsWith("/contents/")) {
      const filePath = decodeURIComponent(path.slice("/contents/".length));
      const commit = commitFor(repo, url.searchParams.get("ref") ?? "");
      if (commit !== undefined && repo.failingCommits.has(commit)) return json({ message: "Bad Gateway" }, 502);
      const text = commit === undefined ? undefined : repo.files.get(commit)?.[filePath];
      if (text === undefined) return json({ message: "Not Found" }, 404);
      return json({ type: "file", encoding: "base64", ...utf8Base64(text) });
    }

    const rename = /^\/branches\/(.+)\/rename$/.exec(path);
    if (method === "POST" && rename) {
      const from = decodeURIComponent(rename[1]);
      const override = repo.renameStatuses.shift();
      repo.onChange?.("rename");
      if (override !== undefined) return json({ message: "refused" }, override);
      if (!repo.branches.has(from)) return json({ message: "Not Found" }, 404);
      if (repo.branches.has(body.new_name)) return json({ message: "Validation Failed" }, 422);
      pendingRename = { from, readsLeft: repo.renameLag };
      return json({ name: body.new_name }, 201);
    }

    if (method === "PATCH" && path === "") {
      const override = repo.patchStatuses.shift();
      repo.onChange?.("patch");
      if (override !== undefined) return json({ message: "refused" }, override);
      if (!repo.branches.has(body.default_branch)) return json({ message: "Validation Failed" }, 422);
      repo.defaultBranch = body.default_branch;
      return json({ default_branch: body.default_branch });
    }

    if (path === "/pages" && method === "GET") {
      return repo.pages === null ? json({ message: "Not Found" }, 404) : json({ ...repo.pages, html_url: "https://owner.github.io/repo/" });
    }
    if (path === "/pages" && method === "PUT") {
      if (repo.pagesPutStatus !== null) return json({ message: "refused" }, repo.pagesPutStatus);
      if (repo.pages) repo.pages = { build_type: body.build_type };
      return empty(204);
    }

    throw new Error(`unexpected request: ${method} ${url.href}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The requests that change the repository, in order. */
export function writes(repo: GitHubRepoFake): string[] {
  return repo.log.map((entry) => entry.call).filter((call) => !call.startsWith("GET ") && call !== "POST /graphql");
}
