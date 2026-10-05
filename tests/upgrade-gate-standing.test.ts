/**
 * The release standing every repository write reads, end to end:
 * the real gate over a real D1 and the real tag cache, with only GitHub's
 * release endpoint stubbed.
 *
 * Three answers: current, needs an upgrade, unknown. A failed lookup is
 * unknown, a pinned release that cannot be fetched is unknown too, and a site
 * with no recorded version is current without a lookup.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { users, projects, project_config } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { __resetTagCacheForTest } from "~/lib/github-status.server";
import {
  readReleaseStanding,
  readRepoWriteGate,
  readRepoWriteRefusal,
  siteNeedsUpgrade,
} from "~/lib/upgrade-gate.server";

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
const realFetch = globalThis.fetch;

function releaseAnswers(status: number, tag = "v1.8.0") {
  globalThis.fetch = vi.fn(async () => ({
    ok: status === 200,
    status,
    headers: new Headers(),
    json: async () => ({ tag_name: tag, body: "", published_at: "2026-09-25T00:00:00Z" }),
  })) as unknown as typeof fetch;
}

function fetchUrls(): string[] {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
}

async function seedSite(telarVersion: string | null): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      github_id: 5001,
      github_login: "convenor",
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: "2099-01-01T00:00:00Z",
      refresh_token_expires_at: "2099-01-01T00:00:00Z",
    })
    .returning({ id: users.id });
  const [project] = await db
    .insert(projects)
    .values({ user_id: user.id, github_repo_full_name: "owner/site", installation_id: 1, kind: "site" })
    .returning({ id: projects.id });
  await db.insert(project_config).values({ project_id: project.id, telar_version: telarVersion });
  return project.id;
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  __resetTagCacheForTest();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetTagCacheForTest();
  memory.close();
});

describe("readReleaseStanding", () => {
  it("is needs_upgrade for a site behind the latest release", async () => {
    const projectId = await seedSite("1.7.0");
    releaseAnswers(200);

    expect(await readReleaseStanding(db, {}, { projectId, userToken: "t" })).toBe("needs_upgrade");
  });

  it("is current for a site on the latest release", async () => {
    const projectId = await seedSite("1.8.0");
    releaseAnswers(200);

    expect(await readReleaseStanding(db, {}, { projectId, userToken: "t" })).toBe("current");
  });

  it("is unknown when the lookup fails", async () => {
    const projectId = await seedSite("1.8.0");
    releaseAnswers(503);

    expect(await readReleaseStanding(db, {}, { projectId, userToken: "t" })).toBe("unknown");
  });

  it("is unknown when a pinned release cannot be fetched", async () => {
    const projectId = await seedSite("1.8.0");
    releaseAnswers(404);

    const standing = await readReleaseStanding(db, { TELAR_RELEASE_TAG: "v1.9.0-rc.1" }, { projectId, userToken: "t" });

    expect(standing).toBe("unknown");
    expect(fetchUrls()[0]).toContain("/releases/tags/v1.9.0-rc.1");
  });

  it("is current for a site with no recorded version, without a lookup", async () => {
    const projectId = await seedSite(null);
    releaseAnswers(503);

    expect(await readReleaseStanding(db, {}, { projectId, userToken: "t" })).toBe("current");
    expect(fetchUrls()).toEqual([]);
  });

  it("is unknown when D1 cannot answer", async () => {
    const broken = { select: () => { throw new Error("D1 down"); } } as unknown as typeof db;
    releaseAnswers(200);

    expect(await readReleaseStanding(broken, {}, { projectId: 1, userToken: "t" })).toBe("unknown");
  });
});

describe("readRepoWriteGate", () => {
  const behind = async () => {
    const projectId = await seedSite("1.7.0");
    releaseAnswers(200);
    return projectId;
  };

  it("names the convenor for a collaborator whose upgrade only the convenor can complete", async () => {
    const id = await behind();

    const gate = await readRepoWriteGate(db, {}, {
      project: { id, gh_workflows_write_missing: 1 },
      userRole: "collaborator",
      userToken: "t",
    });

    expect(gate).toBe("upgrade_awaits_convenor");
  });

  it("sends the convenor to the upgrade whatever the permission", async () => {
    const id = await behind();

    const gate = await readRepoWriteGate(db, {}, {
      project: { id, gh_workflows_write_missing: 1 },
      userRole: "convenor",
      userToken: "t",
    });

    expect(gate).toBe("upgrade_required");
  });

  it("is release_unknown when the lookup fails", async () => {
    const id = await seedSite("1.7.0");
    releaseAnswers(502);

    expect(await readRepoWriteRefusal(db, { ENCRYPTION_KEY: "k" }, {
      project: { id },
      userRole: "convenor",
      encryptedToken: "enc",
    })).toBe("release_unknown");
  });
});

describe("siteNeedsUpgrade", () => {
  it("keeps failing open for the callers that only steer a person somewhere", async () => {
    const projectId = await seedSite("1.7.0");
    releaseAnswers(503);

    expect(await siteNeedsUpgrade(db, {}, { projectId, userToken: "t" })).toBe(false);
  });
});
