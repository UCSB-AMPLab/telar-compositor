/**
 * The repository-access state machine is a total function of the two GitHub
 * answers, has no default arm, and picks the commit token from the stage
 * alone. Every combination is named, the impossible ones included.
 *
 * @version v1.5.0-beta
 */

import { describe, expect, it } from "vitest";

import {
  RepoAccessContradiction,
  chooseCommitToken,
  deriveRepoAccess,
  stageFor,
  type InvitationReading,
  type RepoAccess,
  type RepoPermission,
  type Stage,
} from "~/lib/repo-access";

describe("deriveRepoAccess: the two readings", () => {
  type Expected = RepoAccess | "contradiction";
  const permissions: RepoPermission[] = ["admin", "maintain", "write", "triage", "read", "none"];
  const invitations: InvitationReading[] = ["none", "open", "expired"];
  const pushes = new Set<RepoPermission>(["admin", "maintain", "write"]);
  const byInvitation: Record<InvitationReading, Expected> = { none: "none", open: "pending", expired: "lapsed" };

  // Written out in full, not generated from deriveRepoAccess's own rule.
  const table: Array<[RepoPermission, InvitationReading, Expected]> = [
    ["admin", "none", "access"],
    ["admin", "open", "contradiction"],
    ["admin", "expired", "contradiction"],
    ["maintain", "none", "access"],
    ["maintain", "open", "contradiction"],
    ["maintain", "expired", "contradiction"],
    ["write", "none", "access"],
    ["write", "open", "contradiction"],
    ["write", "expired", "contradiction"],
    ["triage", "none", "none"],
    ["triage", "open", "pending"],
    ["triage", "expired", "lapsed"],
    ["read", "none", "none"],
    ["read", "open", "pending"],
    ["read", "expired", "lapsed"],
    ["none", "none", "none"],
    ["none", "open", "pending"],
    ["none", "expired", "lapsed"],
  ];

  it.each(table)("permission=%s, invitation=%s -> %s", (permission, invitation, expected) => {
    if (expected === "contradiction") {
      expect(() => deriveRepoAccess(permission, invitation)).toThrow(RepoAccessContradiction);
    } else {
      expect(deriveRepoAccess(permission, invitation)).toBe(expected);
    }
  });

  it("names every pair exactly once", () => {
    const want = permissions.flatMap((p) => invitations.map((i) => `${p}+${i}`)).sort();
    expect(table.map(([p, i]) => `${p}+${i}`).sort()).toEqual(want);
  });

  it("the table agrees with the rule it is written from", () => {
    for (const [p, i, e] of table) {
      expect(e).toBe(pushes.has(p) ? (i === "none" ? "access" : "contradiction") : byInvitation[i]);
    }
  });

  it("read access with no invitation is not access, so the installation token commits", () => {
    expect(chooseCommitToken(stageFor("member", deriveRepoAccess("read", "none"), true).stage)).toBe("installation");
  });

  it("throws on an answer outside the types rather than reading it as not yet", () => {
    expect(() => deriveRepoAccess("none", "revoked" as InvitationReading)).toThrow(RepoAccessContradiction);
    expect(() => deriveRepoAccess("owner" as RepoPermission, "none")).toThrow(RepoAccessContradiction);
  });
});

describe("stageFor", () => {
  const accesses: Array<RepoAccess | null> = ["access", "pending", "lapsed", "none", null];

  it("an invite is invited, whatever the flag", () => {
    expect(stageFor("invite", null, false)).toEqual({ stage: "invited" });
    expect(stageFor("invite", null, true)).toEqual({ stage: "invited" });
  });

  it.each(accesses.filter((a) => a !== null))("an invite with access %s is a contradiction", (a) => {
    expect(() => stageFor("invite", a, true)).toThrow(RepoAccessContradiction);
  });

  it("access and pending do not depend on the listing", () => {
    for (const confirmed of [false, true]) {
      expect(stageFor("member", "access", confirmed)).toEqual({ stage: "access" });
      expect(stageFor("member", "pending", confirmed)).toEqual({ stage: "pending" });
    }
  });

  it("lapsed and none read as one not-yet until the listing is confirmed", () => {
    expect(stageFor("member", "lapsed", false)).toEqual(stageFor("member", "none", false));
    expect(stageFor("member", "lapsed", false)).toEqual({ stage: "member", remedy: "add" });
  });

  it("a confirmed listing makes lapsed a reissue and leaves none an add", () => {
    expect(stageFor("member", "lapsed", true)).toEqual({ stage: "member", remedy: "reissue" });
    expect(stageFor("member", "none", true)).toEqual({ stage: "member", remedy: "add" });
  });

  it("a stored value outside the union throws instead of returning no stage", () => {
    expect(() => stageFor("member", "revoked" as RepoAccess, true)).toThrow(RepoAccessContradiction);
    expect(() => stageFor("owner" as "member", "access", true)).toThrow(RepoAccessContradiction);
  });

  it("a member never read is not yet, with the add remedy", () => {
    expect(stageFor("member", null, false)).toEqual({ stage: "member", remedy: "add" });
  });
});

describe("chooseCommitToken", () => {
  const stages: Array<[Stage["stage"], "member" | "installation"]> = [
    ["access", "member"],
    ["invited", "installation"],
    ["member", "installation"],
    ["pending", "installation"],
  ];

  it.each(stages)("%s commits on the %s token", (stage, token) => {
    expect(chooseCommitToken(stage)).toBe(token);
  });

  it("is reached from every derived stage", () => {
    const tokens = new Set<string>();
    for (const a of ["access", "pending", "lapsed", "none"] as const) {
      tokens.add(chooseCommitToken(stageFor("member", a, true).stage));
    }
    expect([...tokens].sort()).toEqual(["installation", "member"]);
  });
});
