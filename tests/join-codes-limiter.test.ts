/**
 * join-codes-limiter.test.ts — the redemption limiter under concurrency.
 *
 * The limiter's own contract is not "the counter is accurate": an increment
 * that cannot be lost still admits every caller that read the count before
 * anybody wrote it. What the limit has to be is a decision the database
 * makes once per caller, in the same step that spends the caller's slot, so
 * that a burst of guesses arriving together is counted as a burst rather
 * than as one.
 *
 * The honest paths are pinned first and hardest, because a limiter that
 * refuses a student typing their class code for the first time would be a
 * far worse defect than the one it was written to close.
 *
 * The database is real — `tests/helpers/d1-memory.ts` replays the migration
 * chain into an in-memory SQLite — so the upsert is exercised as SQL.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import {
  users,
  projects,
  project_members,
  project_invites,
  code_redemption_attempts,
} from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import {
  REDEMPTION_LIMIT,
  REDEMPTION_WINDOW_MS,
  redeemAsStaff,
  redeemForSite,
} from "~/lib/join-codes.server";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();

let nextUser = 0;
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 5000 + nextUser,
      github_login: `limiter${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

let nextRepo = 0;
async function seedProject(
  ownerId: number,
  kind: "site" | "course" = "site",
): Promise<number> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/limiter${nextRepo}`,
      installation_id: 1,
      kind,
    })
    .returning({ id: projects.id });
  const projectId = rows[0].id;
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  return projectId;
}

/** A course carrying one class code and one staff code. */
async function seedCourse() {
  const convenor = await seedUser();
  const course = await seedProject(convenor, "course");
  await db.insert(project_invites).values([
    {
      project_id: course,
      token: "CLASSCODE7",
      conferred_role: "collaborator",
      expires_at: future(),
      created_by: convenor,
    },
    {
      project_id: course,
      token: "STAFFCODE9",
      conferred_role: "instructor",
      expires_at: future(),
      created_by: convenor,
    },
  ]);
  return { convenor, course };
}

async function attemptCount(userId: number): Promise<number> {
  const rows = await db
    .select()
    .from(code_redemption_attempts)
    .where(eq(code_redemption_attempts.user_id, userId))
    .limit(1);
  return rows[0]?.count ?? 0;
}

/** Put `userId` at `count` failed attempts in a window starting `ago` ms back. */
async function seedAttempts(userId: number, count: number, ago = 0) {
  await db.insert(code_redemption_attempts).values({
    user_id: userId,
    window_start: new Date(Date.now() - ago).toISOString(),
    count,
  });
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// The honest paths
// ---------------------------------------------------------------------------

describe("an honest redemption", () => {
  it("admits a first-time redeemer and costs them nothing", async () => {
    const { course } = await seedCourse();
    const owner = await seedUser();
    const child = await seedProject(owner);

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: owner,
    });

    expect(result.state).toBe("ok");
    expect(await attemptCount(owner)).toBe(0);
    expect(course).toBeGreaterThan(0);
  });

  it("admits a redeemer who is one short of the limit", async () => {
    await seedCourse();
    const owner = await seedUser();
    const child = await seedProject(owner);
    await seedAttempts(owner, REDEMPTION_LIMIT - 1);

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: owner,
    });

    expect(result.state).toBe("ok");
    // The successful redemption is refunded, so the count is where it was.
    expect(await attemptCount(owner)).toBe(REDEMPTION_LIMIT - 1);
  });

  it("still admits a redeemer after a long run of typos", async () => {
    await seedCourse();
    const owner = await seedUser();
    const child = await seedProject(owner);

    for (let i = 0; i < REDEMPTION_LIMIT - 1; i++) {
      const failed = await redeemForSite(db, {
        token: "NOSUCHCODE",
        childProjectId: child,
        userId: owner,
      });
      expect(failed.state).toBe("not_found");
    }
    expect(await attemptCount(owner)).toBe(REDEMPTION_LIMIT - 1);

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: owner,
    });
    expect(result.state).toBe("ok");
  });

  it("admits a staff redeemer and costs them nothing", async () => {
    await seedCourse();
    const ta = await seedUser();

    const result = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });

    expect(result.state).toBe("ok");
    expect(await attemptCount(ta)).toBe(0);
  });

  it("does not charge a redeemer for mis-stating their own site", async () => {
    await seedCourse();
    const owner = await seedUser();
    // A course cannot join a course: a refusal about the caller's own
    // project, not a guess at a token.
    const ownCourse = await seedProject(owner, "course");

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: ownCourse,
      userId: owner,
    });

    expect(result.state).toBe("not_a_site");
    expect(await attemptCount(owner)).toBe(0);
  });

  it("lets a lapsed window restore a caller who was at the limit", async () => {
    await seedCourse();
    const owner = await seedUser();
    const child = await seedProject(owner);
    await seedAttempts(owner, REDEMPTION_LIMIT, REDEMPTION_WINDOW_MS + 1000);

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: owner,
    });

    expect(result.state).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// The limit under concurrency
// ---------------------------------------------------------------------------

describe("the limit under a burst", () => {
  const BURST = REDEMPTION_LIMIT + 5;

  it("admits no more than the limit when the guesses arrive together", async () => {
    await seedCourse();
    const owner = await seedUser();
    const child = await seedProject(owner);

    // Started together, so every one of them reads the counter before any of
    // them writes it — which is the whole of the defect.
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        redeemForSite(db, {
          token: "NOSUCHCODE",
          childProjectId: child,
          userId: owner,
        }),
      ),
    );

    const admitted = results.filter((r) => r.state !== "rate_limited").length;
    const refused = results.filter((r) => r.state === "rate_limited").length;

    expect(admitted).toBe(REDEMPTION_LIMIT);
    expect(refused).toBe(BURST - REDEMPTION_LIMIT);
    expect(await attemptCount(owner)).toBe(REDEMPTION_LIMIT);
  });

  it("admits no more than the limit across the window rollover", async () => {
    await seedCourse();
    const owner = await seedUser();
    const child = await seedProject(owner);
    // At the limit, on a window that has just lapsed: every caller sees a
    // fresh window and none of them has counted yet.
    await seedAttempts(owner, REDEMPTION_LIMIT, REDEMPTION_WINDOW_MS + 1000);

    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        redeemForSite(db, {
          token: "NOSUCHCODE",
          childProjectId: child,
          userId: owner,
        }),
      ),
    );

    const admitted = results.filter((r) => r.state !== "rate_limited").length;
    expect(admitted).toBe(REDEMPTION_LIMIT);
    expect(await attemptCount(owner)).toBe(REDEMPTION_LIMIT);
  });

  it("admits no more than the limit through the staff path", async () => {
    await seedCourse();
    const ta = await seedUser();

    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        redeemAsStaff(db, { token: "NOSUCHCODE", userId: ta }),
      ),
    );

    const admitted = results.filter((r) => r.state !== "rate_limited").length;
    expect(admitted).toBe(REDEMPTION_LIMIT);
    expect(await attemptCount(ta)).toBe(REDEMPTION_LIMIT);
  });

  it("counts each caller once — one burst does not exhaust two users", async () => {
    await seedCourse();
    const first = await seedUser();
    const second = await seedUser();
    const firstChild = await seedProject(first);
    const secondChild = await seedProject(second);

    await Promise.all([
      ...Array.from({ length: BURST }, () =>
        redeemForSite(db, {
          token: "NOSUCHCODE",
          childProjectId: firstChild,
          userId: first,
        }),
      ),
      redeemForSite(db, {
        token: "CLASSCODE7",
        childProjectId: secondChild,
        userId: second,
      }),
    ]);

    expect(await attemptCount(first)).toBe(REDEMPTION_LIMIT);
    expect(await attemptCount(second)).toBe(0);
  });

  it("admits a double-click on a good code, and charges neither press", async () => {
    await seedCourse();
    const owner = await seedUser();
    const child = await seedProject(owner);

    // The same convenor clicking through twice: idempotent, and neither press
    // may be refused for want of a slot.
    const results = await Promise.all([
      redeemForSite(db, {
        token: "CLASSCODE7",
        childProjectId: child,
        userId: owner,
      }),
      redeemForSite(db, {
        token: "CLASSCODE7",
        childProjectId: child,
        userId: owner,
      }),
    ]);

    expect(results.map((r) => r.state)).toEqual(["ok", "ok"]);
    expect(await attemptCount(owner)).toBe(0);
  });

  it("admits every honest redemption a user makes one after another", async () => {
    await seedCourse();
    const owner = await seedUser();
    const children: number[] = [];
    for (let i = 0; i < BURST; i++) children.push(await seedProject(owner));

    // Well past the limit, because the slot each one spends is handed back
    // before the next is asked for. Sequential is the shape of real use: a
    // convenor enrolling their sites, one form submission at a time.
    for (const child of children) {
      const result = await redeemForSite(db, {
        token: "CLASSCODE7",
        childProjectId: child,
        userId: owner,
      });
      expect(result.state).toBe("ok");
    }
    expect(await attemptCount(owner)).toBe(0);
  });

  it("charges a slot per redemption in flight, which is what bounds it", async () => {
    await seedCourse();
    const owner = await seedUser();
    const children: number[] = [];
    for (let i = 0; i < BURST; i++) children.push(await seedProject(owner));

    // The cost of deciding the limit before knowing the answer: a caller with
    // more than `REDEMPTION_LIMIT` redemptions in flight at one instant sees
    // the surplus refused, because none of them has returned its slot yet.
    // Bounded and recoverable — nothing is spent, and a retry succeeds.
    const results = await Promise.all(
      children.map((child) =>
        redeemForSite(db, {
          token: "CLASSCODE7",
          childProjectId: child,
          userId: owner,
        }),
      ),
    );

    expect(results.filter((r) => r.state === "ok")).toHaveLength(REDEMPTION_LIMIT);
    expect(results.filter((r) => r.state === "rate_limited")).toHaveLength(
      BURST - REDEMPTION_LIMIT,
    );
    expect(await attemptCount(owner)).toBe(0);

    const retried = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: children[children.length - 1],
      userId: owner,
    });
    expect(retried.state).toBe("ok");
  });
});
