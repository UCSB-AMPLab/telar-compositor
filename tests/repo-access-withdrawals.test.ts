/**
 * Every path that ends a membership records the repository access to withdraw
 * in the same batch as the removal, against the migration chain in memory: a
 * removal, a departure, an instructor leaving a course, a site detached from
 * its course, and a course deleted under a site. A removal that fails records
 * nothing; a collaborator's access is not tied to the course.
 *
 * @version v1.5.0-beta
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import {
  detachChildFromCourse,
  endMembership,
  fanOutStaffDeparture,
} from "~/lib/course-membership.server";
import type { CourseMembershipEnv } from "~/lib/course-membership.server";
import { deleteProjectCascade } from "~/lib/import.server";
import { unlinkProjectCascade } from "~/lib/project-unlink.server";

let memory: MemoryD1;
let nextWithdrawalUser = 0;

function withdrawalDb() {
  return drizzle(asD1(memory), { schema });
}

const quietEnv = {
  SESSION_SECRET: "test-secret",
  COLLABORATION: {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (req: Request) =>
        new URL(req.url).pathname === "/clear-course-markers" ? Response.json({ cleared: 0 }) : new Response("OK"),
    }),
  },
} as unknown as CourseMembershipEnv;

function seedWithdrawalUser(): number {
  nextWithdrawalUser += 1;
  const id = nextWithdrawalUser;
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${id}, ${9000 + id}, 'user${id}', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  return id;
}

function seedWithdrawalProject(id: number, ownerId: number, kind: "site" | "course", parent: number | null = null) {
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, kind, parent_project_id) VALUES (${id}, ${ownerId}, 'owner/p${id}', 1, '${kind}', ${parent ?? "NULL"})`,
  );
  joinWithdrawalProject(id, ownerId, "convenor");
}

function joinWithdrawalProject(projectId: number, userId: number, role: string) {
  memory.raw.exec(`INSERT INTO project_members (project_id, user_id, role, gh_add_state) VALUES (${projectId}, ${userId}, '${role}', 'sent')`);
}

/** A member who joined before the release: the App owes them no add and gave them no access. */
function markJoinedBeforeRelease(userId: number) {
  memory.raw.exec(`UPDATE project_members SET gh_add_owed = 0 WHERE user_id = ${userId}`);
}

/** The state of the App's add for a member, as the reconciler leaves it. */
function setAddState(userId: number, state: string | null) {
  memory.raw.exec(`UPDATE project_members SET gh_add_state = ${state === null ? "NULL" : `'${state}'`} WHERE user_id = ${userId}`);
}

/** The withdrawals recorded, as `project:user`. */
function recordedWithdrawals(): string[] {
  const rows = memory.raw.prepare("SELECT project_id, user_id FROM repo_access_withdrawals ORDER BY project_id, user_id").all() as Array<{
    project_id: number;
    user_id: number;
  }>;
  return rows.map((r) => `${r.project_id}:${r.user_id}`);
}

function recordedGitHubIds(): Array<number | null> {
  const rows = memory.raw.prepare("SELECT github_id FROM repo_access_withdrawals ORDER BY id").all() as Array<{ github_id: number | null }>;
  return rows.map((r) => r.github_id);
}

beforeEach(() => {
  memory = createMemoryD1();
  nextWithdrawalUser = 0;
});

afterEach(() => {
  memory.close();
});

describe("ending a membership records its withdrawal", () => {
  it("a member removed from a site, or leaving it, is withdrawn from that site", async () => {
    const owner = seedWithdrawalUser();
    const member = seedWithdrawalUser();
    seedWithdrawalProject(1, owner, "site");
    joinWithdrawalProject(1, member, "collaborator");
    await endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: member });
    expect(recordedWithdrawals()).toEqual([`1:${member}`]);
  });

  it("an instructor leaving a course is withdrawn from the course and every site it was copied to, and nowhere they collaborate", async () => {
    const convenor = seedWithdrawalUser();
    const instructor = seedWithdrawalUser();
    const group = seedWithdrawalUser();
    seedWithdrawalProject(1, convenor, "course");
    joinWithdrawalProject(1, instructor, "instructor");
    seedWithdrawalProject(2, group, "site", 1);
    joinWithdrawalProject(2, instructor, "instructor");
    seedWithdrawalProject(3, group, "site", 1);
    joinWithdrawalProject(3, instructor, "collaborator");
    await endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: instructor });
    expect(recordedWithdrawals()).toEqual([`1:${instructor}`, `2:${instructor}`]);
  });

  it("records the person's GitHub account id with the withdrawal", async () => {
    const owner = seedWithdrawalUser();
    const member = seedWithdrawalUser();
    seedWithdrawalProject(1, owner, "site");
    joinWithdrawalProject(1, member, "collaborator");
    await endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: member });
    expect(recordedGitHubIds()).toEqual([9000 + member]);
  });

  it("a member who joined before the release is not withdrawn from a site", async () => {
    const owner = seedWithdrawalUser();
    const member = seedWithdrawalUser();
    seedWithdrawalProject(1, owner, "site");
    joinWithdrawalProject(1, member, "collaborator");
    markJoinedBeforeRelease(member);
    await endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: member });
    expect(recordedWithdrawals()).toEqual([]);
  });

  it("withdraws only access the App gave: an add GitHub took", async () => {
    const owner = seedWithdrawalUser();
    const sent = seedWithdrawalUser();
    const never = seedWithdrawalUser();
    const failed = seedWithdrawalUser();
    const revoked = seedWithdrawalUser();
    seedWithdrawalProject(1, owner, "site");
    for (const [user, state] of [[sent, "sent"], [never, null], [failed, "failed"], [revoked, "revoked"]] as const) {
      joinWithdrawalProject(1, user, "collaborator");
      setAddState(user, state);
      await endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: user });
    }
    expect(recordedWithdrawals()).toEqual([`1:${sent}`]);
  });

  it("withdraws a member whose add is sent and not yet answered", async () => {
    const owner = seedWithdrawalUser();
    const member = seedWithdrawalUser();
    seedWithdrawalProject(1, owner, "site");
    joinWithdrawalProject(1, member, "collaborator");
    setAddState(member, "sending");
    await endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: member });
    expect(recordedWithdrawals()).toEqual([`1:${member}`]);
  });

  it("unlinking or deleting a project records no withdrawal, even for an add in flight", async () => {
    const owner = seedWithdrawalUser();
    const member = seedWithdrawalUser();
    seedWithdrawalProject(1, owner, "site");
    joinWithdrawalProject(1, member, "collaborator");
    seedWithdrawalProject(2, owner, "site");
    joinWithdrawalProject(2, member, "collaborator");
    setAddState(member, "sending");
    await unlinkProjectCascade(withdrawalDb(), 1);
    await deleteProjectCascade(withdrawalDb(), 2);
    expect(recordedWithdrawals()).toEqual([]);
  });

  it("an instructor who joined before the release is withdrawn only where the App added them", async () => {
    const convenor = seedWithdrawalUser();
    const instructor = seedWithdrawalUser();
    const group = seedWithdrawalUser();
    seedWithdrawalProject(1, convenor, "course");
    joinWithdrawalProject(1, instructor, "instructor");
    seedWithdrawalProject(2, group, "site", 1);
    joinWithdrawalProject(2, instructor, "instructor");
    seedWithdrawalProject(3, group, "site", 1);
    joinWithdrawalProject(3, instructor, "instructor");
    memory.raw.exec(`UPDATE project_members SET gh_add_owed = 0 WHERE user_id = ${instructor} AND project_id IN (1, 2)`);
    await endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: instructor });
    expect(recordedWithdrawals()).toEqual([`3:${instructor}`]);
  });

  it("a removal that fails records nothing", async () => {
    const owner = seedWithdrawalUser();
    const member = seedWithdrawalUser();
    seedWithdrawalProject(1, owner, "site");
    joinWithdrawalProject(1, member, "collaborator");
    memory.raw.exec("CREATE TRIGGER refuse_member_delete BEFORE DELETE ON project_members BEGIN SELECT RAISE(ABORT, 'refused'); END");
    await expect(endMembership(withdrawalDb(), quietEnv, { projectId: 1, userId: member })).rejects.toThrow();
    expect(recordedWithdrawals()).toEqual([]);
  });

  it("a staff departure fanned out to the sites withdraws the instructor copies only", async () => {
    const convenor = seedWithdrawalUser();
    const instructor = seedWithdrawalUser();
    const group = seedWithdrawalUser();
    seedWithdrawalProject(1, convenor, "course");
    seedWithdrawalProject(2, group, "site", 1);
    joinWithdrawalProject(2, instructor, "instructor");
    seedWithdrawalProject(3, group, "site", 1);
    joinWithdrawalProject(3, instructor, "collaborator");
    await fanOutStaffDeparture(withdrawalDb(), quietEnv, { courseProjectId: 1, userId: instructor });
    expect(recordedWithdrawals()).toEqual([`2:${instructor}`]);
  });
});

describe("a site leaving its course withdraws the course's instructors from it", () => {
  it("detaching withdraws that course's instructors on that site, not its collaborators or other sites", async () => {
    const convenor = seedWithdrawalUser();
    const instructor = seedWithdrawalUser();
    const group = seedWithdrawalUser();
    const student = seedWithdrawalUser();
    seedWithdrawalProject(1, convenor, "course");
    joinWithdrawalProject(1, instructor, "instructor");
    seedWithdrawalProject(2, group, "site", 1);
    joinWithdrawalProject(2, convenor, "instructor");
    joinWithdrawalProject(2, instructor, "instructor");
    joinWithdrawalProject(2, student, "collaborator");
    seedWithdrawalProject(3, group, "site", 1);
    joinWithdrawalProject(3, instructor, "instructor");
    await detachChildFromCourse(withdrawalDb(), quietEnv, { courseProjectId: 1, childProjectId: 2 });
    expect(recordedWithdrawals()).toEqual([`2:${convenor}`, `2:${instructor}`]);
  });

  it("detaching leaves the access of an instructor who joined before the release", async () => {
    const convenor = seedWithdrawalUser();
    const instructor = seedWithdrawalUser();
    const group = seedWithdrawalUser();
    seedWithdrawalProject(1, convenor, "course");
    seedWithdrawalProject(2, group, "site", 1);
    joinWithdrawalProject(2, convenor, "instructor");
    joinWithdrawalProject(2, instructor, "instructor");
    markJoinedBeforeRelease(instructor);
    await detachChildFromCourse(withdrawalDb(), quietEnv, { courseProjectId: 1, childProjectId: 2 });
    expect(recordedWithdrawals()).toEqual([`2:${convenor}`]);
  });

  it("deleting a course withdraws the instructor rows it still held on a site", async () => {
    const convenor = seedWithdrawalUser();
    const group = seedWithdrawalUser();
    seedWithdrawalProject(1, convenor, "course");
    seedWithdrawalProject(2, group, "site", 1);
    joinWithdrawalProject(2, convenor, "instructor");
    await deleteProjectCascade(withdrawalDb(), 1);
    expect(recordedWithdrawals()).toEqual([`2:${convenor}`]);
  });
});
