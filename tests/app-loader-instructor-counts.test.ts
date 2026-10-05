/**
 * The `/_app` shell loader's instructor-aware counting surfaces, run
 * against a real D1 database (via `createMemoryD1`) — the point being
 * verified is the actual number the loader returns, not just that a code
 * path was reached.
 *
 * Design §3: instructor rows are staff, not group size. Two counts this
 * loader computes are named in the census:
 *
 *   - `sidebarSeats.used` (the collaboration sidebar's seat figure) —
 *     convenor + collaborators against the display-only limit of five.
 *   - `allProjects[].collaboratorCount` (the header project switcher's
 *     per-project count, gating whether the role badge renders at all).
 *
 * @version v1.5.0-beta
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
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 7000 + nextUser,
      github_login: `user${nextUser}`,
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

describe("_app loader — sidebarSeats.used excludes instructor rows", () => {
  it("convenor + 1 collaborator + 1 instructor → used = 2, not 3", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    await addMember(site, await seedUser(), "collaborator");
    await addMember(site, await seedUser(), "instructor");
    sessionActiveProjectId = site;

    const data = (await runLoader(convenor)) as {
      sidebarSeats: { used: number; limit: number };
    };

    expect(data.sidebarSeats.used).toBe(2);
    expect(data.sidebarSeats.limit).toBe(5);
  });

  it("a solo convenor + only an instructor row → used = 1, not 2 (the seat display never counts staff)", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    await addMember(site, await seedUser(), "instructor");
    sessionActiveProjectId = site;

    const data = (await runLoader(convenor)) as {
      sidebarSeats: { used: number; limit: number };
    };

    expect(data.sidebarSeats.used).toBe(1);
  });
});

describe("_app loader — allProjects[].collaboratorCount (switcher) excludes instructor rows", () => {
  it("convenor + 1 collaborator + 1 instructor → collaboratorCount = 1, not 2", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    await addMember(site, await seedUser(), "collaborator");
    await addMember(site, await seedUser(), "instructor");
    sessionActiveProjectId = site;

    const data = (await runLoader(convenor)) as {
      allProjects: Array<{ id: number; collaboratorCount: number }>;
    };

    const row = data.allProjects.find((p) => p.id === site)!;
    expect(row.collaboratorCount).toBe(1);
  });

  it("a solo convenor + only an instructor row → collaboratorCount = 0 (role badge hides on this project)", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    await addMember(site, await seedUser(), "instructor");
    sessionActiveProjectId = site;

    const data = (await runLoader(convenor)) as {
      allProjects: Array<{ id: number; collaboratorCount: number }>;
    };

    const row = data.allProjects.find((p) => p.id === site)!;
    expect(row.collaboratorCount).toBe(0);
  });
});
