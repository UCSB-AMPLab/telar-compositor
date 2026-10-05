/**
 * The GitHub calls behind repository access: each documented status per call,
 * pagination, the rate-limit mapping and the 422.
 *
 * @version v1.5.0-beta
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubPermissionError, GitHubTransientError } from "~/lib/github.server";
import {
  GitHubUnprocessableError,
  acceptInvitation,
  accountLogin,
  addCollaborator,
  deleteInvitation,
  listRepoInvitations,
  memberPermission,
  removeCollaborator,
} from "~/lib/repo-access.server";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: h,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  } as unknown as Response;
}

function fetchSays(...answers: Response[]) {
  const mock = vi.fn(async () => answers.shift() as Response);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const call = (mock: ReturnType<typeof fetchSays>, n = 0) => ({
  url: String((mock.mock.calls[n] as unknown[])[0]),
  init: (mock.mock.calls[n] as unknown[])[1] as RequestInit,
});

describe("memberPermission", () => {
  it("reads the legacy permission field", async () => {
    const m = fetchSays(answer(200, { permission: "write" }));
    expect(await memberPermission("t", "o", "r", "ana")).toBe("write");
    expect(call(m).url).toBe("https://api.github.com/repos/o/r/collaborators/ana/permission");
  });
  it("reads a 404 as none", async () => {
    fetchSays(answer(404));
    expect(await memberPermission("t", "o", "r", "ana")).toBe("none");
  });
  it("maps a server error and a rate limit to transient, a refusal to permission", async () => {
    fetchSays(answer(502));
    await expect(memberPermission("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubTransientError);
    fetchSays(answer(403, "x", { "x-ratelimit-remaining": "0" }));
    await expect(memberPermission("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubTransientError);
    fetchSays(answer(403, "Resource not accessible"));
    await expect(memberPermission("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubPermissionError);
  });
});

describe("accountLogin", () => {
  it("reads the current login for a durable account id", async () => {
    const m = fetchSays(answer(200, { login: "ana-renamed", id: 42 }));
    expect(await accountLogin("t", 42)).toBe("ana-renamed");
    expect(call(m).url).toBe("https://api.github.com/user/42");
    expect(call(m).init.method).toBe("GET");
  });
  it("reads a 404 as no account", async () => {
    fetchSays(answer(404));
    expect(await accountLogin("t", 42)).toBeNull();
  });
  it("maps a server error to transient and a refusal to permission", async () => {
    fetchSays(answer(503));
    await expect(accountLogin("t", 42)).rejects.toBeInstanceOf(GitHubTransientError);
    fetchSays(answer(401));
    await expect(accountLogin("t", 42)).rejects.toBeInstanceOf(GitHubPermissionError);
  });
});

describe("the caller's deadline", () => {
  it("reaches fetch on every read and on the add", async () => {
    const signal = new AbortController().signal;
    const m = fetchSays(
      answer(200, { login: "ana" }),
      answer(200, { permission: "read" }),
      answer(200, []),
      answer(204),
    );
    await accountLogin("t", 1, signal);
    await memberPermission("t", "o", "r", "ana", signal);
    await listRepoInvitations("t", "o", "r", signal);
    await addCollaborator("t", "o", "r", "ana", signal);
    for (let n = 0; n < 4; n++) expect(call(m, n).init.signal).toBe(signal);
  });
});

describe("listRepoInvitations", () => {
  const inv = (id: number, login: string | null, expired = false) => ({
    id,
    invitee: login === null ? null : { login, id: 500 + id },
    inviter: { login: "telar-compositor[bot]", type: "Bot" },
    expired,
    html_url: `https://github.com/o/r/invitations/${id}`,
  });
  it("follows the Link header across pages and maps the fields", async () => {
    const m = fetchSays(
      answer(200, [inv(1, "ana")], { link: '<https://api.github.com/page2>; rel="next"' }),
      answer(200, [inv(2, null, true)]),
    );
    expect(await listRepoInvitations("t", "o", "r")).toEqual([
      { id: 1, inviteeLogin: "ana", inviteeId: 501, inviterLogin: "telar-compositor[bot]", expired: false, htmlUrl: "https://github.com/o/r/invitations/1" },
      { id: 2, inviteeLogin: null, inviteeId: null, inviterLogin: "telar-compositor[bot]", expired: true, htmlUrl: "https://github.com/o/r/invitations/2" },
    ]);
    expect(call(m, 0).url).toBe("https://api.github.com/repos/o/r/invitations?per_page=100");
    expect(call(m, 1).url).toBe("https://api.github.com/page2");
  });
  it("reads the invitee's account id and the inviter's login, a missing inviter as null", async () => {
    fetchSays(answer(200, [{ ...inv(3, "beto"), inviter: { login: "carla", type: "User" } }, { ...inv(4, "dora"), inviter: null }]));
    const [hand, noInviter] = await listRepoInvitations("t", "o", "r");
    expect(hand).toMatchObject({ inviteeLogin: "beto", inviteeId: 503, inviterLogin: "carla" });
    expect(noInviter).toMatchObject({ inviteeLogin: "dora", inviteeId: 504, inviterLogin: null });
  });
  it("throws on a failed page", async () => {
    fetchSays(answer(404));
    await expect(listRepoInvitations("t", "o", "r")).rejects.toBeInstanceOf(GitHubPermissionError);
  });
});

describe("addCollaborator", () => {
  it("sends permission push and returns the invitation on 201", async () => {
    const m = fetchSays(answer(201, { id: 7, html_url: "https://github.com/o/r/invitations" }));
    expect(await addCollaborator("t", "o", "r", "ana")).toEqual({
      status: "invited",
      invitationId: 7,
      htmlUrl: "https://github.com/o/r/invitations",
    });
    expect(call(m).init.method).toBe("PUT");
    expect(JSON.parse(String(call(m).init.body))).toEqual({ permission: "push" });
  });
  it("reads 204 as already a collaborator", async () => {
    fetchSays(answer(204));
    expect(await addCollaborator("t", "o", "r", "ana")).toEqual({ status: "already" });
  });
  it("surfaces 422 as its own error", async () => {
    fetchSays(answer(422, { message: "spammed" }));
    await expect(addCollaborator("t", "o", "r", "ana")).rejects.toBeInstanceOf(GitHubUnprocessableError);
  });
  it("maps 403 refusal, 403 rate limit, 429 and 5xx", async () => {
    fetchSays(answer(403, "Must have admin rights"));
    await expect(addCollaborator("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubPermissionError);
    fetchSays(answer(403, "x", { "retry-after": "30" }));
    await expect(addCollaborator("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubTransientError);
    fetchSays(answer(500));
    await expect(addCollaborator("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubTransientError);
    fetchSays(answer(429, "x", { "retry-after": "60" }));
    await expect(addCollaborator("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubTransientError);
  });
});

describe("deleteInvitation", () => {
  it("resolves on 204 against the invitation path", async () => {
    const m = fetchSays(answer(204));
    await deleteInvitation("t", "o", "r", 7);
    expect(call(m).url).toBe("https://api.github.com/repos/o/r/invitations/7");
    expect(call(m).init.method).toBe("DELETE");
  });
  it("throws on 404 and on a rate limit", async () => {
    fetchSays(answer(404));
    await expect(deleteInvitation("t", "o", "r", 7)).rejects.toBeInstanceOf(GitHubPermissionError);
    fetchSays(answer(403, "secondary rate limit"));
    await expect(deleteInvitation("t", "o", "r", 7)).rejects.toBeInstanceOf(GitHubTransientError);
  });
});

describe("removeCollaborator", () => {
  it("resolves on 204", async () => {
    const m = fetchSays(answer(204));
    await removeCollaborator("t", "o", "r", "ana");
    expect(call(m).url).toBe("https://api.github.com/repos/o/r/collaborators/ana");
    expect(call(m).init.method).toBe("DELETE");
  });
  it("maps 403 and 422", async () => {
    fetchSays(answer(403, "forbidden"));
    await expect(removeCollaborator("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubPermissionError);
    fetchSays(answer(422));
    await expect(removeCollaborator("t", "o", "r", "a")).rejects.toBeInstanceOf(GitHubUnprocessableError);
  });
});

describe("acceptInvitation", () => {
  it.each([
    [204, "accepted"],
    [304, "unchanged"],
    [404, "gone"],
    [409, "conflict"],
    [451, "blocked"],
  ])("reads %i as %s", async (status, expected) => {
    const m = fetchSays(answer(status));
    expect(await acceptInvitation("u", 7)).toBe(expected);
    expect(call(m).url).toBe("https://api.github.com/user/repository_invitations/7");
    expect(call(m).init.method).toBe("PATCH");
  });
  it("maps 403 to permission and a rate limit to transient", async () => {
    fetchSays(answer(403, "forbidden"));
    await expect(acceptInvitation("u", 7)).rejects.toBeInstanceOf(GitHubPermissionError);
    fetchSays(answer(403, "x", { "x-ratelimit-remaining": "0" }));
    await expect(acceptInvitation("u", 7)).rejects.toBeInstanceOf(GitHubTransientError);
  });
});
