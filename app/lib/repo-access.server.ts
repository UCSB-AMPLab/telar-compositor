/**
 * The GitHub calls behind the team page's repository access: who can push,
 * which invitations are open, adding, withdrawing and removing a collaborator,
 * and a member accepting their own invitation. Every status GitHub documents
 * for a call has an arm; the rest of the failures map as in graphqlGitHub
 * (5xx and a rate-limit 403 transient, a refused credential a permission
 * error, anything else a plain error).
 *
 * @version v1.5.0-beta
 */
import {
  GITHUB_API,
  GitHubPermissionError,
  GitHubTransientError,
  githubHeaders,
  isRateLimitRefusal,
  parseNextLink,
} from "~/lib/github.server";
import type { RepoPermission } from "~/lib/repo-access";

/** GitHub answered 422: validation failed, or the endpoint "has been spammed" (50 invitations per repository per 24 hours). */
export class GitHubUnprocessableError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "GitHubUnprocessableError";
  }
}

export interface RepoInvitation {
  id: number;
  inviteeLogin: string | null;
  inviteeId: number | null;
  inviterLogin: string | null;
  expired: boolean;
  htmlUrl: string;
}

async function refusal(res: Response, what: string): Promise<Error> {
  const message = `GitHub API error ${what}: ${res.status}`;
  if (res.status >= 500 || res.status === 429) return new GitHubTransientError(message, res.status);
  if (res.status === 403) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // No readable body: the headers alone decide.
    }
    if (isRateLimitRefusal(res.headers, body)) return new GitHubTransientError(message, res.status);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return new GitHubPermissionError(message, res.status);
  if (res.status === 422) return new GitHubUnprocessableError(message);
  return new Error(message);
}

function call(token: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(path.startsWith("https:") ? path : `${GITHUB_API}${path}`, {
    method,
    signal,
    headers: body === undefined ? githubHeaders(token) : { ...githubHeaders(token), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const repoPath = (owner: string, repo: string) => `/repos/${owner}/${repo}`;
const collaboratorPath = (owner: string, repo: string, username: string) =>
  `${repoPath(owner, repo)}/collaborators/${encodeURIComponent(username)}`;

/**
 * Installation token. docs.github.com/en/rest/collaborators/collaborators
 * (get repository permissions for a user): 200 with the legacy `permission`
 * (admin, write, read, none; maintain reads as write, triage as read), 404
 * for a user who is not a collaborator, read here as "none".
 */
export async function memberPermission(
  token: string,
  owner: string,
  repo: string,
  username: string,
  signal?: AbortSignal,
): Promise<RepoPermission> {
  const res = await call(token, "GET", `${collaboratorPath(owner, repo, username)}/permission`, undefined, signal);
  if (res.status === 404) return "none";
  if (!res.ok) throw await refusal(res, "reading a permission");
  return ((await res.json()) as { permission: RepoPermission }).permission;
}

/**
 * Installation token. docs.github.com/en/rest/users/users (get a user using
 * their ID): "takes their durable user ID instead of their login, which can
 * change over time"; 200 with the account's current `login`, 404 when no
 * account has the id, read here as null. The installation-token endpoint list
 * (docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens)
 * includes it.
 */
export async function accountLogin(token: string, githubId: number, signal?: AbortSignal): Promise<string | null> {
  const res = await call(token, "GET", `/user/${githubId}`, undefined, signal);
  if (res.status === 404) return null;
  if (!res.ok) throw await refusal(res, "reading an account");
  return ((await res.json()) as { login: string }).login;
}

/**
 * Installation token. docs.github.com/en/rest/collaborators/invitations (list
 * repository invitations): 200 with open invitations, `expired` marking the
 * lapsed ones; the invitee is null when the account is gone. The inviter of
 * an invitation the App's installation token sent is its bot account,
 * `<app slug>[bot]`.
 */
export async function listRepoInvitations(
  token: string,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<RepoInvitation[]> {
  const found: RepoInvitation[] = [];
  let url: string | null = `${repoPath(owner, repo)}/invitations?per_page=100`;
  while (url) {
    const res: Response = await call(token, "GET", url, undefined, signal);
    if (!res.ok) throw await refusal(res, "listing invitations");
    const page = (await res.json()) as Array<{
      id: number;
      invitee: { login: string; id: number } | null;
      inviter: { login: string } | null;
      expired: boolean;
      html_url: string;
    }>;
    for (const i of page) {
      found.push({
        id: i.id,
        inviteeLogin: i.invitee?.login ?? null,
        inviteeId: i.invitee?.id ?? null,
        inviterLogin: i.inviter?.login ?? null,
        expired: i.expired,
        htmlUrl: i.html_url,
      });
    }
    url = parseNextLink(res.headers.get("link"));
  }
  return found;
}

/**
 * Installation token. docs.github.com/en/rest/collaborators/collaborators
 * (add a repository collaborator): body `permission`, default `push`, sent
 * explicitly; 201 a new invitation, 204 the user already collaborates, 403
 * forbidden, 422 validation failed or "spammed" (50 invitations per
 * repository per 24 hours) and surfaced as GitHubUnprocessableError.
 */
export async function addCollaborator(
  token: string,
  owner: string,
  repo: string,
  username: string,
  signal?: AbortSignal,
): Promise<{ status: "invited"; invitationId: number; htmlUrl: string } | { status: "already" }> {
  const res = await call(token, "PUT", collaboratorPath(owner, repo, username), { permission: "push" }, signal);
  if (res.status === 204) return { status: "already" };
  if (res.status !== 201) throw await refusal(res, "adding a collaborator");
  const body = (await res.json()) as { id: number; html_url: string };
  return { status: "invited", invitationId: body.id, htmlUrl: body.html_url };
}

/**
 * Installation token. docs.github.com/en/rest/collaborators/invitations
 * (delete a repository invitation): 204. A 404 means no invitation under that
 * id and is a permission error like any other the credential cannot see.
 */
export async function deleteInvitation(token: string, owner: string, repo: string, id: number, signal?: AbortSignal): Promise<void> {
  const res = await call(token, "DELETE", `${repoPath(owner, repo)}/invitations/${id}`, undefined, signal);
  if (res.status !== 204) throw await refusal(res, "deleting an invitation");
}

/**
 * Installation token. docs.github.com/en/rest/collaborators/collaborators
 * (remove a repository collaborator): 204 removed, 403 forbidden, 422
 * validation failed or spammed. It does not withdraw an invitation sent to the
 * user; that is deleteInvitation.
 */
export async function removeCollaborator(token: string, owner: string, repo: string, username: string, signal?: AbortSignal): Promise<void> {
  const res = await call(token, "DELETE", collaboratorPath(owner, repo, username), undefined, signal);
  if (res.status !== 204) throw await refusal(res, "removing a collaborator");
}

export type AcceptResult = "accepted" | "unchanged" | "gone" | "conflict" | "blocked";

/**
 * The caller's own token only. docs.github.com/en/rest/collaborators/invitations
 * (accept a repository invitation): 204 accepted, 304 not modified, 403
 * forbidden, 404 not found, 409 conflict, 451 validation failed or spammed.
 */
export async function acceptInvitation(userToken: string, id: number): Promise<AcceptResult> {
  const res = await call(userToken, "PATCH", `/user/repository_invitations/${id}`);
  switch (res.status) {
    case 204:
      return "accepted";
    case 304:
      return "unchanged";
    case 404:
      return "gone";
    case 409:
      return "conflict";
    case 451:
      return "blocked";
  }
  throw await refusal(res, "accepting an invitation");
}
