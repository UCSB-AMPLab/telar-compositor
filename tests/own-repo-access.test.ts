/**
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readOwnRepoAccess } from "~/lib/own-repo-access.server";

function dbReturning(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  return { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })) };
}

afterEach(() => vi.unstubAllGlobals());

describe("readOwnRepoAccess", () => {
  it("reads the caller's own row from D1 and makes no network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const db = dbReturning([{ gh_access: "pending", gh_invitation_url: "https://github.com/o/r/invitations" }]);
    const own = await readOwnRepoAccess(db as never, 7, 42);
    expect(own).toEqual({ stage: "pending", invitationUrl: "https://github.com/o/r/invitations" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is null for a member with no recorded reading and for no row", async () => {
    expect(await readOwnRepoAccess(dbReturning([{ gh_access: null, gh_invitation_url: null }]) as never, 7, 42)).toBeNull();
    expect(await readOwnRepoAccess(dbReturning([]) as never, 7, 42)).toBeNull();
  });

  it("is null when the read fails, so the poll still answers", async () => {
    const db = { select: () => { throw new Error("D1 down"); } };
    expect(await readOwnRepoAccess(db as never, 7, 42)).toBeNull();
  });
});
