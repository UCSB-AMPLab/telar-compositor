/**
 * `isPublishingRole` / `requirePublishingRole`, the shared gate
 * for publish, image upload, and upgrade.
 *
 * Written as an explicit membership test of
 * `{convenor, collaborator, instructor}` — never `role !== null` — so a
 * role added later has to be named here on purpose before it can reach
 * those actions. This file imports the real implementation, unmocked: no
 * `vi.mock("~/lib/membership.server", ...)` appears anywhere in it. The
 * route-level wiring of this gate (does the route call it, and does it
 * turn a refusal into the right response) is covered separately in
 * tests/publishing-role-matrix.test.ts, which mirrors this check against a
 * mock rather than importing it — the two together prove the policy is
 * correct AND that each route actually applies it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { isPublishingRole, requirePublishingRole } from "~/lib/membership.server";
import { isPublishingRole as sharedIsPublishingRole } from "~/lib/publishing-roles";

/** Asserts `promise` rejects with a 403 Response, checking the status itself
 *  rather than only that some Response was thrown. */
async function expectForbidden(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.fail("expected a 403 Response to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(403);
  }
}

/** A `db` whose only shape `getUserRole` needs: select({role}).from(...).where(...).limit(1). */
function fakeRoleDb(role: string | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (role === null ? [] : [{ role }]),
        }),
      }),
    }),
  } as never;
}

describe("isPublishingRole — explicit membership of {convenor, collaborator, instructor}", () => {
  it.each([
    ["convenor", true],
    ["collaborator", true],
    ["instructor", true],
    ["editor", false], // a role that does not exist yet
  ] as const)("role=%s -> %s", (role, expected) => {
    expect(isPublishingRole(role as never)).toBe(expected);
  });

  it("refuses null (no membership)", () => {
    expect(isPublishingRole(null)).toBe(false);
  });
});

describe("requirePublishingRole", () => {
  it("resolves for convenor", async () => {
    await expect(requirePublishingRole(fakeRoleDb("convenor"), 1, 1)).resolves.toBeUndefined();
  });

  it("resolves for collaborator", async () => {
    await expect(requirePublishingRole(fakeRoleDb("collaborator"), 1, 1)).resolves.toBeUndefined();
  });

  it("resolves for instructor", async () => {
    await expect(requirePublishingRole(fakeRoleDb("instructor"), 1, 1)).resolves.toBeUndefined();
  });

  it("throws 403 for no membership", async () => {
    await expectForbidden(requirePublishingRole(fakeRoleDb(null), 1, 1));
  });

  it("throws 403 for an unrecognised future role — a role added later must be named on purpose", async () => {
    await expectForbidden(requirePublishingRole(fakeRoleDb("editor"), 1, 1));
  });
});

// ---------------------------------------------------------------------------
// One table, both sides: the client predicate (useIsPublisher) and the
// server gate (requirePublishingRole) cannot drift apart because they are
// backed by the literal same function from ~/lib/publishing-roles, not two
// separately-written checks that happen to agree today.
// ---------------------------------------------------------------------------

describe("the client predicate and the server gate share one function", () => {
  it("membership.server's isPublishingRole IS ~/lib/publishing-roles's isPublishingRole (referential equality, not a re-implementation)", () => {
    expect(isPublishingRole).toBe(sharedIsPublishingRole);
  });

  it("~/hooks/use-role.ts's useIsPublisher imports isPublishingRole from the same shared module", () => {
    const useRoleSrc = readFileSync(
      join(__dirname, "..", "app", "hooks", "use-role.ts"),
      "utf-8",
    );
    expect(useRoleSrc).toContain('import { isPublishingRole } from "~/lib/publishing-roles"');
    expect(useRoleSrc).toContain("isPublishingRole(useRole())");
  });

  // The one table: every role a caller can present, checked once against the
  // one shared predicate both `useIsPublisher()` (client) and
  // `requirePublishingRole()` (server, via the referential-equality test
  // above) actually call.
  it.each([
    ["convenor", true],
    ["collaborator", true],
    ["instructor", true],
    [null, false],
    ["editor", false], // an unrecognised future role
  ] as const)("role=%s -> publisher=%s, agreed by both sides", (role, expected) => {
    expect(sharedIsPublishingRole(role)).toBe(expected);
    expect(isPublishingRole(role)).toBe(expected);
  });
});
