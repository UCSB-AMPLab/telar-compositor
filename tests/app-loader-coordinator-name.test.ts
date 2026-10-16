/**
 * The `/_app` shell loader names the person who coordinates the site, for
 * everyone who cannot apply a review of the changes on GitHub: the
 * convenor's stored GitHub display name, else their GitHub login. Run
 * against a real D1 database (`createMemoryD1`).
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { users, projects, project_members } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let sessionActiveProjectId: number | undefined;

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn((key: string) =>
        key === "activeProjectId" ? sessionActiveProjectId : undefined,
      ),
      set: vi.fn(),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "token"),
}));

vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "sha"),
  checkRepoAvailability: vi.fn(async () => ({
    availability: "available" as const,
    canonicalFullName: null,
  })),
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: vi.fn(async () => ({})),
  hasDivergentChanges: vi.fn(() => false),
}));

vi.mock("~/lib/upgrade.server", async (importActual) => {
  const actual = await importActual<typeof import("~/lib/upgrade.server")>();
  return { ...actual, fetchLatestRelease: vi.fn(async () => ({ tagName: "v0.0.0" })) };
});

import { loader } from "~/routes/_app";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 48 * HOUR).toISOString();

let nextUser = 0;
async function seedUser(githubName: string | null = null): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 7000 + nextUser,
      github_login: `user${nextUser}`,
      github_name: githubName,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

async function seedProject(ownerId: number): Promise<number> {
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: "owner/site",
      installation_id: 1,
    })
    .returning({ id: projects.id });
  await db.insert(project_members).values({
    project_id: rows[0].id,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  return rows[0].id;
}

async function addMember(
  projectId: number,
  userId: number,
  role: "collaborator" | "instructor",
) {
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role,
    joined_at: new Date().toISOString(),
  });
}

async function runLoader(userId: number) {
  const env = {
    DB: asD1(memory),
    SESSION_SECRET: "secret",
    ENCRYPTION_KEY: "key",
  };
  return loader({
    request: new Request("https://compositor.telar.org/objects"),
    context: {
      get: () => ({ id: userId, encrypted_access_token: "enc" }),
      cloudflare: { env },
    },
    params: {},
  } as never);
}

beforeEach(async () => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
});

afterEach(() => {
  memory.close();
});

describe("_app loader — coordinatorName", () => {
  it("is the convenor's stored display name, for a collaborator's load", async () => {
    const convenor = await seedUser("Ana Pérez");
    const site = await seedProject(convenor);
    const collaborator = await seedUser("Someone Else");
    await addMember(site, collaborator, "collaborator");
    sessionActiveProjectId = site;
    const data = (await runLoader(collaborator)) as { coordinatorName: string | null };
    expect(data.coordinatorName).toBe("Ana Pérez");
  });

  it("is the convenor's GitHub login when no display name is stored", async () => {
    const convenor = await seedUser(null);
    const site = await seedProject(convenor);
    const instructor = await seedUser("Teacher");
    await addMember(site, instructor, "instructor");
    sessionActiveProjectId = site;
    const data = (await runLoader(instructor)) as { coordinatorName: string | null };
    expect(data.coordinatorName).toBe(`user${nextUser - 1}`);
  });
});
