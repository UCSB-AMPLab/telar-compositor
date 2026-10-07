/**
 * Setting up an outdated site hands over to ITS upgrade.
 *
 * The import action checked the site's version and, when it was behind,
 * redirected to `/upgrade?from=/config` there and then. That ran before
 * `complete-onboarding`, the only place that makes the new site the active
 * project, so `/upgrade` resolved whichever site was active before: someone
 * with site A importing an outdated site B was shown A's upgrade, or bounced
 * to A's settings if A was current. Leaving the wizard at that point also
 * discarded the course-join outcome the import had just produced, refusals
 * included.
 *
 * So the import returns its result whatever the version, and completion reads
 * the version from the recorded config and, for a site that is behind,
 * redirects in the same response that sets the session — so the cookie that
 * response carries is the one `/upgrade` resolves. These cases read that
 * cookie back through the real resolver rather than asserting on the
 * redirect alone.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { users, projects, project_members, project_config } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let latestTag: string | null = "v9.9.9";

vi.mock("~/lib/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/db.server")>();
  return { ...actual, getDb: () => db };
});
vi.mock("~/lib/crypto.server", () => ({ decrypt: async () => "user-token" }));
vi.mock("~/lib/github-status.server", () => ({
  getCachedLatestTag: async () => latestTag,
}));
// The import itself is not under test: it stands in as having written a
// project row, with whatever version the case says the site runs.
const importRepoMock = vi.fn();
vi.mock("~/lib/import.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/import.server")>();
  return { ...actual, importRepo: (...args: unknown[]) => importRepoMock(...args) };
});

// The installation reaches the repository; its check has its own suite.
vi.mock("~/lib/onboarding-create-site.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/onboarding-create-site.server")>();
  return { ...actual, importScopeRefusal: async () => null };
});

import { action } from "~/routes/onboarding";
import { userContext } from "~/middleware/auth.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { createSessionStorage } from "~/lib/session.server";

const SECRET = "test-secret";
const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

async function seedUser(): Promise<number> {
  const rows = await db
    .insert(users)
    .values({
      github_id: 4001,
      github_login: "convenor",
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

let nextRepo = 0;
async function seedSite(ownerId: number, telarVersion: string, onboarded: boolean) {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/site${nextRepo}`,
      installation_id: 1,
      kind: "site",
      onboarding_completed: onboarded,
    })
    .returning({ id: projects.id });
  const id = rows[0].id;
  await db.insert(project_members).values({
    project_id: id,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  await db.insert(project_config).values({ project_id: id, telar_version: telarVersion });
  return id;
}

/** A session cookie naming `projectId` as active, as the switcher writes one. */
async function sessionOn(projectId: number): Promise<string> {
  const storage = createSessionStorage(SECRET);
  const session = await storage.getSession();
  session.set("activeProjectId", projectId);
  return (await storage.commitSession(session)).split(";")[0];
}

function callAction(userId: number, fields: Record<string, string>, cookie: string) {
  const request = new Request("http://localhost:5173/onboarding", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
  });
  const env = { DB: asD1(memory), SESSION_SECRET: SECRET, ENCRYPTION_KEY: "key" };
  const context = {
    get: (key: unknown) =>
      key === userContext ? ({ id: userId, encrypted_access_token: "enc" } as AuthenticatedUser) : undefined,
    cloudflare: { env },
  };
  return action({ request, context, params: {} } as unknown as Parameters<typeof action>[0]);
}

/** Which project a request carrying `cookie` resolves to. */
async function resolvedWith(cookie: string, userId: number): Promise<number | null> {
  const request = new Request("http://localhost:5173/upgrade", { headers: { Cookie: cookie } });
  const resolved = await resolveActiveProjectFromRequest(
    request,
    { DB: asD1(memory), SESSION_SECRET: SECRET } as never,
    userId,
  );
  return resolved?.project.id ?? null;
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  nextRepo = 0;
  latestTag = "v9.9.9";
  importRepoMock.mockReset();
});

describe("finishing the setup of a site behind the latest release", () => {
  it("opens that site's upgrade, not the one that was active before", async () => {
    const convenor = await seedUser();
    const siteA = await seedSite(convenor, "9.9.9", true);
    const siteB = await seedSite(convenor, "1.0.0", false);

    const response = await callAction(
      convenor,
      { intent: "complete-onboarding", project_id: String(siteB) },
      await sessionOn(siteA),
    );

    expect(response).toBeInstanceOf(Response);
    const res = response as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/upgrade?from=/start");

    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
    expect(await resolvedWith(cookie, convenor)).toBe(siteB);
  });

  it("stays in the wizard for a site that is current", async () => {
    const convenor = await seedUser();
    const site = await seedSite(convenor, "9.9.9", false);

    const response = (await callAction(
      convenor,
      { intent: "complete-onboarding", project_id: String(site) },
      await sessionOn(site),
    )) as Response;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, intent: "complete-onboarding" });
  });

  it("stays in the wizard when the latest release cannot be read", async () => {
    // Fail open, as every version check does.
    latestTag = null;
    const convenor = await seedUser();
    const site = await seedSite(convenor, "1.0.0", false);

    const response = (await callAction(
      convenor,
      { intent: "complete-onboarding", project_id: String(site) },
      await sessionOn(site),
    )) as Response;

    expect(response.status).toBe(200);
  });
});

describe("importing a site behind the latest release", () => {
  it("returns the import result rather than leaving the wizard", async () => {
    // The redirect left the wizard before completion made the new site active,
    // and threw away the course-join outcome on the way.
    const convenor = await seedUser();
    const site = await seedSite(convenor, "1.0.0", false);
    importRepoMock.mockResolvedValue({ valid: true, projectId: site, telarVersion: "1.0.0" });

    const result = await callAction(
      convenor,
      { intent: "import", installation_id: "1", repo_full_name: "owner/site1" },
      await sessionOn(site),
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({ valid: true, projectId: site });
  });
});
