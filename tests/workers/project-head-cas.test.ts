/**
 * `bumpProjectHeadFrom` against real D1: the compare-and-set lands only while
 * the row still holds the head the caller read, a null head included, which
 * SQL matches with IS NULL and never with `= NULL`. `headAdvancedFrom` is the
 * same compare-and-set as one column of a wider write, and the status refresh
 * writes the head through it.
 *
 * `objects_read_sha`, the last commit whose objects.csv D1 accounts
 * for, advances with the head only where it still holds the head being
 * replaced, and on its own through `bumpObjectsReadFrom`, compare-and-set.
 *
 * @version v1.5.0-beta
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";

import { getDb } from "~/lib/db.server";
import { eq } from "drizzle-orm";
import { projects } from "~/db/schema";
import {
  bumpObjectsReadFrom,
  bumpProjectHeadFrom,
  headAdvancedFrom,
  objectsReadAdvancedFrom,
  objectsReadFollowingHead,
  refreshGithubStatus,
} from "~/lib/github-status.server";
import { seedProject } from "./helpers/collaboration-client";

const READ = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "2222222222222222222222222222222222222222";

async function headOf(projectId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT head_sha FROM projects WHERE id = ?").bind(projectId).first<{ head_sha: string | null }>();
  return row!.head_sha;
}

async function readShaOf(projectId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT objects_read_sha FROM projects WHERE id = ?").bind(projectId).first<{ objects_read_sha: string | null }>();
  return row!.objects_read_sha;
}

/** A project at `head`, whose objects.csv was last read at `read` (the head, unless given). */
async function projectAt(label: string, head: string | null, read: string | null = head): Promise<number> {
  const { projectId } = await seedProject(label);
  await env.DB.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").bind(head, read, projectId).run();
  return projectId;
}

describe("bumpProjectHeadFrom against D1", () => {
  it("records the head over no head recorded", async () => {
    const id = await projectAt("cas-null", null);
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, null, READ)).toBe(true);
    expect(await headOf(id)).toBe(READ);
  });

  it("leaves a head another writer set first, when the caller read none", async () => {
    const id = await projectAt("cas-null-raced", OTHER);
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, null, READ)).toBe(false);
    expect(await headOf(id)).toBe(OTHER);
  });

  it("advances from the head read, and leaves one that moved", async () => {
    const id = await projectAt("cas-sha", OTHER);
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, "3333333333333333333333333333333333333333", READ)).toBe(false);
    expect(await headOf(id)).toBe(OTHER);
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, OTHER, READ)).toBe(true);
    expect(await headOf(id)).toBe(READ);
  });

  it("writes what it is also given only with the head", async () => {
    const synced = async (projectId: number) =>
      (await env.DB.prepare("SELECT last_synced_at FROM projects WHERE id = ?").bind(projectId).first<{ last_synced_at: string | null }>())!.last_synced_at;
    const id = await projectAt("cas-also", OTHER);
    const also = { last_synced_at: "2026-09-26T00:00:00.000Z" };
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, READ, READ, Date.now(), also)).toBe(false);
    expect(await synced(id)).toBeNull();
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, OTHER, READ, Date.now(), also)).toBe(true);
    expect(await synced(id)).toBe(also.last_synced_at);
  });
});

async function writeHead(projectId: number, from: string | null, to: string): Promise<void> {
  await getDb(env.DB)
    .update(projects)
    .set({ head_sha: headAdvancedFrom(from, to), objects_read_sha: objectsReadAdvancedFrom(from, to), gh_remote_head_sha: to })
    .where(eq(projects.id, projectId));
}

async function remoteHeadOf(projectId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT gh_remote_head_sha FROM projects WHERE id = ?").bind(projectId).first<{ gh_remote_head_sha: string | null }>();
  return row!.gh_remote_head_sha;
}

describe("headAdvancedFrom against D1", () => {
  it("advances a null head read as null, and writes the other columns", async () => {
    const id = await projectAt("adv-null", null);
    await writeHead(id, null, READ);
    expect(await headOf(id)).toBe(READ);
    expect(await remoteHeadOf(id)).toBe(READ);
  });

  it("keeps a head another writer set over a null read, and still writes the other columns", async () => {
    const id = await projectAt("adv-null-raced", OTHER);
    await writeHead(id, null, READ);
    expect(await headOf(id)).toBe(OTHER);
    expect(await remoteHeadOf(id)).toBe(READ);
  });

  it("advances from the head read, and keeps one that moved", async () => {
    const id = await projectAt("adv-sha", OTHER);
    await writeHead(id, "3333333333333333333333333333333333333333", READ);
    expect(await headOf(id)).toBe(OTHER);
    await writeHead(id, OTHER, READ);
    expect(await headOf(id)).toBe(READ);
  });

  it("keeps no head over a head read", async () => {
    const id = await projectAt("adv-sha-null", null);
    await writeHead(id, OTHER, READ);
    expect(await headOf(id)).toBeNull();
  });
});

describe("refreshGithubStatus against D1", () => {
  const REMOTE = "4444444444444444444444444444444444444444";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * GitHub answering the availability read and the head read, for a site with
   * no stories, and the subtree read with no pages folder at the head.
   */
  function stubGitHub(fullName: string) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/graphql")) {
        const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
        if (query.includes("GetHeadOid")) return Response.json({ data: { repository: { ref: { target: { oid: REMOTE } } } } });
        const answer: Record<string, unknown> = {};
        for (const [name, expression] of Object.entries(variables)) {
          if (name !== "owner" && name !== "repo") answer[name] = expression.includes(":") ? null : { __typename: "Commit" };
        }
        return Response.json({ data: { repository: answer } });
      }
      return Response.json({ full_name: fullName });
    });
  }

  async function project(label: string, head: string | null) {
    const id = await projectAt(label, head);
    // A site with no stories: the backfill needs no story tree read.
    await env.DB.prepare("DELETE FROM stories WHERE project_id = ?").bind(id).run();
    const row = await env.DB.prepare("SELECT github_repo_full_name FROM projects WHERE id = ?").bind(id).first<{ github_repo_full_name: string }>();
    return { id, fullName: row!.github_repo_full_name };
  }

  it("backfills the head it computed the verdict against", async () => {
    const { id, fullName } = await project("refresh-backfill", null);
    stubGitHub(fullName);
    await refreshGithubStatus({ id, head_sha: null, github_repo_full_name: fullName }, "tok", getDb(env.DB), Date.now(), { env, userId: 1 });
    expect(await headOf(id)).toBe(REMOTE);
    expect(await remoteHeadOf(id)).toBe(REMOTE);
  });

  it("backfills the head alone: the backfill compares rendered stories and reads no objects.csv", async () => {
    const { id, fullName } = await project("refresh-backfill-read", null);
    stubGitHub(fullName);
    await refreshGithubStatus({ id, head_sha: null, github_repo_full_name: fullName }, "tok", getDb(env.DB), Date.now(), { env, userId: 1 });
    expect(await headOf(id)).toBe(REMOTE);
    expect(await readShaOf(id)).toBeNull();
  });

  async function cacheOf(projectId: number) {
    return (await env.DB.prepare(
      "SELECT gh_checked_at, gh_diverged, gh_diverged_against_sha FROM projects WHERE id = ?",
    ).bind(projectId).first<{ gh_checked_at: string | null; gh_diverged: number | null; gh_diverged_against_sha: string | null }>())!;
  }

  it("stamps the verdict when the head is still the one it was computed against", async () => {
    const { id, fullName } = await project("refresh-stamp", null);
    stubGitHub(fullName);
    await refreshGithubStatus({ id, head_sha: null, github_repo_full_name: fullName }, "tok", getDb(env.DB), Date.parse("2026-09-26T12:00:00.000Z"), { env, userId: 1 });
    expect(await cacheOf(id)).toEqual({ gh_checked_at: "2026-09-26T12:00:00.000Z", gh_diverged: 0, gh_diverged_against_sha: REMOTE });
  });

  it("never stamps over an invalidation another writer made between the load and the write", async () => {
    // Loaded with no head. Before the refresh writes, a publish records OTHER
    // and nulls gh_checked_at, leaving the verdict it had.
    const { id, fullName } = await project("refresh-invalidated", null);
    await env.DB.prepare(
      "UPDATE projects SET head_sha = ?, gh_checked_at = NULL, gh_diverged = 1, gh_diverged_against_sha = ? WHERE id = ?",
    ).bind(OTHER, OTHER, id).run();
    stubGitHub(fullName);
    await refreshGithubStatus({ id, head_sha: null, github_repo_full_name: fullName }, "tok", getDb(env.DB), Date.now(), { env, userId: 1 });
    expect(await headOf(id)).toBe(OTHER);
    expect(await cacheOf(id)).toEqual({ gh_checked_at: null, gh_diverged: 1, gh_diverged_against_sha: OTHER });
    // What GitHub holds is a fact about GitHub, written either way.
    expect(await remoteHeadOf(id)).toBe(REMOTE);
  });

  it("keeps a head another writer recorded between the load and the write, and still writes the cache", async () => {
    // Loaded with no head; a publish records OTHER before the refresh writes.
    const { id, fullName } = await project("refresh-raced", OTHER);
    stubGitHub(fullName);
    await refreshGithubStatus({ id, head_sha: null, github_repo_full_name: fullName }, "tok", getDb(env.DB), Date.now(), { env, userId: 1 });
    expect(await headOf(id)).toBe(OTHER);
    expect(await remoteHeadOf(id)).toBe(REMOTE);
  });
});

const OWN = "5555555555555555555555555555555555555555";

describe("objects_read_sha advancing with the head, against D1", () => {
  it("advances with bumpProjectHeadFrom where it holds the head being replaced", async () => {
    const id = await projectAt("read-bump", OTHER);
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, OTHER, READ)).toBe(true);
    expect(await readShaOf(id)).toBe(READ);
  });

  it("is left where an objects commit advanced it on its own, while the head advances", async () => {
    const id = await projectAt("read-bump-own", OTHER, OWN);
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, OTHER, READ)).toBe(true);
    expect(await headOf(id)).toBe(READ);
    expect(await readShaOf(id)).toBe(OWN);
  });

  it("moves with neither when the head's compare-and-set fails", async () => {
    const id = await projectAt("read-bump-raced", OTHER);
    expect(await bumpProjectHeadFrom(getDb(env.DB), id, "3333333333333333333333333333333333333333", READ)).toBe(false);
    expect(await readShaOf(id)).toBe(OTHER);
  });

  it("advances a null record over a null head, and leaves a record set over a null head", async () => {
    const none = await projectAt("read-bump-null", null);
    expect(await bumpProjectHeadFrom(getDb(env.DB), none, null, READ)).toBe(true);
    expect(await readShaOf(none)).toBe(READ);
    const imported = await projectAt("read-bump-null-imported", null, OWN);
    expect(await bumpProjectHeadFrom(getDb(env.DB), imported, null, READ)).toBe(true);
    expect(await readShaOf(imported)).toBe(OWN);
  });

  it("advances with the head as one column of a wider write, and keeps a record that moved", async () => {
    const id = await projectAt("read-adv", OTHER);
    await writeHead(id, OTHER, READ);
    expect(await readShaOf(id)).toBe(READ);
    const own = await projectAt("read-adv-own", OTHER, OWN);
    await writeHead(own, OTHER, READ);
    expect(await headOf(own)).toBe(READ);
    expect(await readShaOf(own)).toBe(OWN);
  });

  it("keeps the record when the head it was written with does not land", async () => {
    // Another writer moved the head from OTHER to OWN, and the record with it.
    const id = await projectAt("read-adv-raced", OWN, OTHER);
    await writeHead(id, OTHER, READ);
    expect(await headOf(id)).toBe(OWN);
    expect(await readShaOf(id)).toBe(OTHER);
  });
});

describe("bumpObjectsReadFrom against D1", () => {
  it("advances from the record read, and leaves the head alone", async () => {
    const id = await projectAt("read-own", OTHER);
    expect(await bumpObjectsReadFrom(getDb(env.DB), id, OTHER, OWN)).toBe(true);
    expect(await readShaOf(id)).toBe(OWN);
    expect(await headOf(id)).toBe(OTHER);
  });

  it("leaves a record that moved since it was read", async () => {
    const id = await projectAt("read-own-raced", OTHER, READ);
    expect(await bumpObjectsReadFrom(getDb(env.DB), id, OTHER, OWN)).toBe(false);
    expect(await readShaOf(id)).toBe(READ);
  });

  it("records over no record, matched with IS NULL", async () => {
    const id = await projectAt("read-own-null", OTHER, null);
    expect(await bumpObjectsReadFrom(getDb(env.DB), id, null, OWN)).toBe(true);
    expect(await readShaOf(id)).toBe(OWN);
    const raced = await projectAt("read-own-null-raced", OTHER, READ);
    expect(await bumpObjectsReadFrom(getDb(env.DB), raced, null, OWN)).toBe(false);
    expect(await readShaOf(raced)).toBe(READ);
  });
});

describe("objectsReadFollowingHead against D1", () => {
  async function writeOver(projectId: number, to: string): Promise<void> {
    await getDb(env.DB)
      .update(projects)
      .set({ head_sha: to, objects_read_sha: objectsReadFollowingHead(to) })
      .where(eq(projects.id, projectId));
  }

  it("advances a record that is the head replaced", async () => {
    const id = await projectAt("follow", OTHER);
    await writeOver(id, READ);
    expect(await readShaOf(id)).toBe(READ);
  });

  it("leaves a record that is not the head replaced, a null head included", async () => {
    const own = await projectAt("follow-own", OTHER, OWN);
    await writeOver(own, READ);
    expect(await readShaOf(own)).toBe(OWN);
    const imported = await projectAt("follow-imported", null, OWN);
    await writeOver(imported, READ);
    expect(await readShaOf(imported)).toBe(OWN);
  });

  it("leaves no record over no head as no record", async () => {
    const id = await projectAt("follow-none", null, null);
    await writeOver(id, READ);
    expect(await headOf(id)).toBe(READ);
    expect(await readShaOf(id)).toBeNull();
  });
});
