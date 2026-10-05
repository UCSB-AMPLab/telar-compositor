/**
 * The join-code module — generation, resolution, and the two redemptions.
 *
 * `project_invites` now carries two artefacts: the legacy single-use invite
 * (a UUID in a link) and the reusable course join code (ten characters a
 * student copies). This suite pins the discriminator between them, the
 * resolution state machine including the ordering the states are decided
 * in, and the idempotence the two redemption paths owe a classroom — a
 * convenor who clicks twice, a site already attached to the course, a TA
 * who is already staff.
 *
 * The database is real: `tests/helpers/d1-memory.ts` replays the migration
 * chain into an in-memory SQLite and hands Drizzle a D1-shaped binding, so
 * the atomic parent compare-and-set, cap accounting over
 * `joined_via_invite_id` and the `used_at` consumed flag are exercised as
 * SQL rather than as assertions about SQL.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";

import * as schema from "~/db/schema";
import {
  users,
  projects,
  project_members,
  project_invites,
  code_redemption_attempts,
} from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import type { ResolveResult } from "~/lib/join-codes.server";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  REDEMPTION_LIMIT,
  REDEMPTION_WINDOW_MS,
  codeKind,
  normaliseToken,
  isLegacyInviteToken,
  createCode,
  resolveCode,
  redeemForSite,
  redeemAsStaff,
} from "~/lib/join-codes.server";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();
const past = () => new Date(Date.now() - HOUR).toISOString();

/** A legacy invite token: the UUID the current link flow issues. */
const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

let nextUser = 0;
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 1000 + nextUser,
      github_login: `user${nextUser}`,
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
      github_repo_full_name: `owner/repo${nextRepo}`,
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

async function seedInvite(values: {
  projectId: number;
  token: string;
  conferredRole?: "collaborator" | "instructor";
  expiresAt?: string | null;
  usedAt?: string | null;
  usedBy?: number | null;
  revokedAt?: string | null;
  createdBy?: number | null;
}): Promise<number> {
  const rows = await db
    .insert(project_invites)
    .values({
      project_id: values.projectId,
      token: values.token,
      conferred_role: values.conferredRole ?? "collaborator",
      expires_at: values.expiresAt === undefined ? future() : values.expiresAt,
      used_at: values.usedAt ?? null,
      used_by: values.usedBy ?? null,
      revoked_at: values.revokedAt ?? null,
      created_by: values.createdBy ?? null,
    })
    .returning({ id: project_invites.id });
  return rows[0].id;
}

async function inviteRow(id: number) {
  const rows = await db
    .select()
    .from(project_invites)
    .where(eq(project_invites.id, id))
    .limit(1);
  return rows[0];
}

async function memberRow(projectId: number, userId: number) {
  const rows = await db
    .select()
    .from(project_members)
    .where(
      and(
        eq(project_members.project_id, projectId),
        eq(project_members.user_id, userId),
      ),
    )
    .limit(1);
  return rows[0];
}

async function projectRow(id: number) {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0];
}

async function attemptRow(userId: number) {
  const rows = await db
    .select()
    .from(code_redemption_attempts)
    .where(eq(code_redemption_attempts.user_id, userId))
    .limit(1);
  return rows[0];
}

/**
 * Assert the state and narrow to it, so a test can go on to read the
 * fields that state carries.
 */
function expectState<S extends ResolveResult["state"]>(
  result: ResolveResult,
  state: S,
): Extract<ResolveResult, { state: S }> {
  expect(result.state).toBe(state);
  return result as Extract<ResolveResult, { state: S }>;
}

/** Put `userId` at `count` failed attempts inside a window starting `ago` ms back. */
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
  vi.restoreAllMocks();
  memory.close();
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe("code generation", () => {
  it("uses a 32-character alphabet with no 0/O or 1/I/l", () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(new Set(CODE_ALPHABET).size).toBe(32);
    for (const banned of ["0", "O", "1", "I", "l"]) {
      expect(CODE_ALPHABET).not.toContain(banned);
    }
    expect(CODE_LENGTH).toBe(10);
  });

  it("mints a ten-character token drawn only from that alphabet", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner, "course");

    const created = await createCode(db, {
      projectId: course,
      role: "collaborator",
      expiresAt: future(),
      label: "Autumn term",
      createdBy: owner,
    });

    expect(created.token).toHaveLength(CODE_LENGTH);
    for (const char of created.token) expect(CODE_ALPHABET).toContain(char);

    const row = await inviteRow(created.id);
    expect(row.project_id).toBe(course);
    expect(row.conferred_role).toBe("collaborator");
    expect(row.label).toBe("Autumn term");
    expect(row.created_by).toBe(owner);
    expect(row.revoked_at).toBeNull();
    expect(row.used_at).toBeNull();
  });

  it("takes the caller's expiry rather than a hardcoded window", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner, "course");
    const expiresAt = new Date(Date.now() + 120 * 24 * HOUR).toISOString();

    const created = await createCode(db, {
      projectId: course,
      role: "instructor",
      expiresAt,
      label: null,
      createdBy: owner,
    });

    const row = await inviteRow(created.id);
    expect(row.expires_at).toBe(expiresAt);
    expect(row.conferred_role).toBe("instructor");
  });

  it("regenerates up to three times when the token collides", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner, "course");
    const taken = "AAAAAAAAAA";
    await seedInvite({ projectId: course, token: taken });

    // Three collisions, then a token that is free.
    let call = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      ((buffer: Uint8Array) => {
        call += 1;
        const char = call <= 3 ? "A" : "B";
        const index = CODE_ALPHABET.indexOf(char);
        buffer.fill(index);
        return buffer;
      }) as typeof crypto.getRandomValues,
    );

    const created = await createCode(db, {
      projectId: course,
      role: "collaborator",
      expiresAt: future(),
      label: null,
      createdBy: owner,
    });

    expect(created.token).toBe("BBBBBBBBBB");
    expect(call).toBe(4);
  });

  it("gives up after the third regeneration", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({ projectId: course, token: "AAAAAAAAAA" });

    let call = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      ((buffer: Uint8Array) => {
        call += 1;
        buffer.fill(CODE_ALPHABET.indexOf("A"));
        return buffer;
      }) as typeof crypto.getRandomValues,
    );

    await expect(
      createCode(db, {
        projectId: course,
        role: "collaborator",
          expiresAt: future(),
        label: null,
        createdBy: owner,
      }),
    ).rejects.toThrow();
    expect(call).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Kind derivation
// ---------------------------------------------------------------------------

describe("kind derivation", () => {
  it("reads a UUID token as a legacy invite whatever role it confers", () => {
    expect(isLegacyInviteToken(UUID)).toBe(true);
    expect(codeKind(UUID, "collaborator")).toBe("legacy_invite");
    expect(codeKind(UUID, "instructor")).toBe("legacy_invite");
    expect(codeKind(UUID.toUpperCase(), "collaborator")).toBe("legacy_invite");
  });

  it("reads a generated token by the role it confers", () => {
    expect(isLegacyInviteToken("K7M2PQRSTV")).toBe(false);
    expect(codeKind("K7M2PQRSTV", "collaborator")).toBe("site");
    expect(codeKind("K7M2PQRSTV", "instructor")).toBe("staff");
  });
});

// ---------------------------------------------------------------------------
// resolveCode
// ---------------------------------------------------------------------------

describe("a code is resolved as the row spells it", () => {
  /**
   * The alphabet is uppercase and omits `0`, `O`, `1`, `I` and `l` so a code
   * can be read off a slide and typed back. Someone typing it back lowercases
   * it about as often as not, and the column has no `NOCASE` collation — so a
   * correct code in lowercase resolved `not_found`, which to the person
   * holding it is indistinguishable from a code that was never issued.
   */
  it("resolves a class code typed in lowercase", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({ projectId: course, token: "REALCODE22" });

    const result = await resolveCode(db, "realcode22", {
      expectedKind: "site",
      userId: student,
    });
    expect(result.state).not.toBe("not_found");
  });

  it("resolves it in mixed case too, and still refuses a code that was never issued", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({ projectId: course, token: "REALCODE22" });

    expect(
      (await resolveCode(db, "ReAlCoDe22", { expectedKind: "site", userId: student })).state,
    ).not.toBe("not_found");
    expect(
      await resolveCode(db, "nosuchcode", { expectedKind: "site", userId: student }),
    ).toEqual({ state: "not_found" });
  });

  it("leaves a legacy invite's case alone, because its token is stored as minted", async () => {
    // Uppercasing a UUID stops it matching its own row. The discrimination
    // runs first and can: the UUID pattern is case-insensitive, and no
    // generated code can look like a UUID whatever its case — the alphabet
    // has no dashes.
    const owner = await seedUser();
    const holder = await seedUser();
    const project = await seedProject(owner, "site");
    const uuid = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071";
    await seedInvite({ projectId: project, token: uuid });

    expect(normaliseToken(uuid)).toBe(uuid);
    const result = await resolveCode(db, uuid, {
      expectedKind: "legacy_invite",
      userId: holder,
    });
    expect(result.state).not.toBe("not_found");
  });

  it("uppercases a generated code and nothing else", () => {
    expect(normaliseToken("realcode22")).toBe("REALCODE22");
    expect(normaliseToken("REALCODE22")).toBe("REALCODE22");
    // Lossless: the alphabet has no lowercase letter to collide with.
    for (const ch of CODE_ALPHABET) expect(ch.toUpperCase()).toBe(ch);
  });
});

describe("resolveCode", () => {
  it("reports not_found for a token with no row, and carries no kind", async () => {
    const user = await seedUser();
    const result = await resolveCode(db, "ZZZZZZZZZZ", {
      expectedKind: "site",
      userId: user,
    });
    expect(result).toEqual({ state: "not_found" });
  });

  it("checks the limit first, so it cannot be used as a validity oracle", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({ projectId: course, token: "REALCODE22" });
    await seedAttempts(student, REDEMPTION_LIMIT);

    const real = await resolveCode(db, "REALCODE22", {
      expectedKind: "site",
      userId: student,
    });
    const fake = await resolveCode(db, "NOSUCHCODE", {
      expectedKind: "site",
      userId: student,
    });

    expect(real).toEqual({ state: "rate_limited" });
    expect(fake).toEqual({ state: "rate_limited" });
  });

  it("does not limit a user one short of the cap", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({ projectId: course, token: "REALCODE22" });
    await seedAttempts(student, REDEMPTION_LIMIT - 1);

    const result = await resolveCode(db, "REALCODE22", {
      expectedKind: "site",
      userId: student,
    });
    expect(result.state).toBe("ok");
  });

  it("lets a window older than an hour lapse", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({ projectId: course, token: "REALCODE22" });
    await seedAttempts(student, REDEMPTION_LIMIT, REDEMPTION_WINDOW_MS + 1000);

    const result = await resolveCode(db, "REALCODE22", {
      expectedKind: "site",
      userId: student,
    });
    expect(result.state).toBe("ok");
  });

  it("never writes — not the counter, not the row", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    const inviteId = await seedInvite({
      projectId: course,
      token: "REALCODE22",
    });
    const before = await inviteRow(inviteId);

    await resolveCode(db, "REALCODE22", { expectedKind: "site", userId: student });
    await resolveCode(db, "NOSUCHCODE", { expectedKind: "site", userId: student });
    await resolveCode(db, "REALCODE22", { expectedKind: "staff", userId: student });

    expect(await attemptRow(student)).toBeUndefined();
    expect(await inviteRow(inviteId)).toEqual(before);
  });

  it("reports wrong_kind with the code's real kind", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({
      projectId: course,
      token: "STAFFCODE9",
      conferredRole: "instructor",
    });
    await seedInvite({ projectId: course, token: UUID });

    const asSite = await resolveCode(db, "STAFFCODE9", {
      expectedKind: "site",
      userId: student,
    });
    expect(expectState(asSite, "wrong_kind").kind).toBe("staff");

    const legacyAsSite = await resolveCode(db, UUID, {
      expectedKind: "site",
      userId: student,
    });
    expect(expectState(legacyAsSite, "wrong_kind").kind).toBe("legacy_invite");
  });

  it("prefers revoked over expired", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({
      projectId: course,
      token: "REVOKEDXYZ",
      revokedAt: new Date().toISOString(),
      expiresAt: past(),
    });

    const result = await resolveCode(db, "REVOKEDXYZ", {
      expectedKind: "site",
      userId: student,
    });
    expect(expectState(result, "revoked").kind).toBe("site");
  });

  it("treats a null expiry as never expiring, not as the epoch", async () => {
    // `new Date(null)` is 1970-01-01, which is comfortably in the past, so
    // a coerced comparison would report every never-expiring code expired.
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({
      projectId: course,
      token: "FOREVERCD7",
      expiresAt: null,
    });

    const result = await resolveCode(db, "FOREVERCD7", {
      expectedKind: "site",
      userId: student,
    });

    expect(expectState(result, "ok").invite.expires_at).toBeNull();
  });

  it("mints a code with no expiry when the caller gives none", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner, "course");

    const created = await createCode(db, {
      projectId: course,
      role: "collaborator",
      expiresAt: null,
      label: "Autumn term",
      createdBy: owner,
    });

    expect((await inviteRow(created.id)).expires_at).toBeNull();
    const resolved = await resolveCode(db, created.token, {
      expectedKind: "site",
      userId: owner,
    });
    expect(resolved.state).toBe("ok");
  });

  it("redeems a never-expiring code on both surfaces", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({ projectId: course, token: "FOREVERCD7", expiresAt: null });
    await seedInvite({
      projectId: course,
      token: "FOREVERST8",
      conferredRole: "instructor",
      expiresAt: null,
    });

    const convenor = await seedUser();
    const child = await seedProject(convenor);
    expect(
      (
        await redeemForSite(db, {
          token: "FOREVERCD7",
          childProjectId: child,
          userId: convenor,
        })
      ).state,
    ).toBe("ok");

    const ta = await seedUser();
    expect(
      (await redeemAsStaff(db, { token: "FOREVERST8", userId: ta })).state,
    ).toBe("ok");
    expect(await attemptRow(convenor)).toBeUndefined();
    expect(await attemptRow(ta)).toBeUndefined();
  });

  it("reports expired past the expiry", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const course = await seedProject(owner, "course");
    await seedInvite({
      projectId: course,
      token: "STALECODE7",
      expiresAt: past(),
    });

    const result = await resolveCode(db, "STALECODE7", {
      expectedKind: "site",
      userId: student,
    });
    expect(expectState(result, "expired").kind).toBe("site");
  });

  it("keeps a consumed legacy invite consumed after its redeemer is deleted", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const project = await seedProject(owner);
    // used_by cleared by the redeemer's account deletion; used_at is never nulled.
    await seedInvite({
      projectId: project,
      token: UUID,
      usedAt: new Date().toISOString(),
      usedBy: null,
    });

    const result = await resolveCode(db, UUID, {
      expectedKind: "legacy_invite",
      userId: student,
    });
    expect(expectState(result, "consumed").kind).toBe("legacy_invite");
  });

  it("resolves an unconsumed legacy invite", async () => {
    const owner = await seedUser();
    const student = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: UUID });

    const result = await resolveCode(db, UUID, {
      expectedKind: "legacy_invite",
      userId: student,
    });
    const ok = expectState(result, "ok");
    expect(ok.kind).toBe("legacy_invite");
    expect(ok.invite.project_id).toBe(project);
  });

  it("resolves without a userId, and then never consults the limiter", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: UUID });

    const result = await resolveCode(db, UUID, { expectedKind: "legacy_invite" });
    expect(result.state).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// redeemForSite
// ---------------------------------------------------------------------------

describe("redeemForSite", () => {
  async function courseWithCode() {
    const instructor = await seedUser();
    const course = await seedProject(instructor, "course");
    const inviteId = await seedInvite({
      projectId: course,
      token: "CLASSCODE7",
    });
    return { instructor, course, inviteId };
  }

  it("sets the parent and records the admission on the child's convenor row", async () => {
    const { course, inviteId } = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    expect(result.state).toBe("ok");
    expect((await projectRow(child)).parent_project_id).toBe(course);
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBe(inviteId);
    expect(await attemptRow(convenor)).toBeUndefined();
  });

  it("is idempotent for the same course — ok, no second record", async () => {
    const { course, inviteId } = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);

    await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });
    const again = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    expect(again.state).toBe("ok");
    expect((await projectRow(child)).parent_project_id).toBe(course);
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBe(inviteId);
    expect(
      (
        await resolveCode(db, "CLASSCODE7", {
          expectedKind: "site",
          userId: convenor,
        })
      ).state,
    ).toBe("ok");
  });

  it("refuses a child that already belongs to a different course", async () => {
    const first = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    const otherInstructor = await seedUser();
    const otherCourse = await seedProject(otherInstructor, "course");
    await seedInvite({
      projectId: otherCourse,
      token: "OTHERCODE8",
    });

    const result = await redeemForSite(db, {
      token: "OTHERCODE8",
      childProjectId: child,
      userId: convenor,
    });

    expect(result.state).toBe("already_enrolled");
    expect((await projectRow(child)).parent_project_id).toBe(first.course);
  });

  it("refuses a course as the child, distinctly from already_enrolled", async () => {
    await courseWithCode();
    const convenor = await seedUser();
    const otherCourse = await seedProject(convenor, "course");

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: otherCourse,
      userId: convenor,
    });

    expect(result.state).toBe("not_a_site");
    expect((await projectRow(otherCourse)).parent_project_id).toBeNull();
  });

  it("refuses a staff code entered on the site surface", async () => {
    const instructor = await seedUser();
    const course = await seedProject(instructor, "course");
    await seedInvite({
      projectId: course,
      token: "STAFFCODE9",
      conferredRole: "instructor",
    });
    const convenor = await seedUser();
    const child = await seedProject(convenor);

    const result = await redeemForSite(db, {
      token: "STAFFCODE9",
      childProjectId: child,
      userId: convenor,
    });

    expect(result.state).toBe("wrong_kind");
    expect((await projectRow(child)).parent_project_id).toBeNull();
  });

  it("leaves the admission record alone when a second code of the same course is redeemed", async () => {
    // Two places under A, one under B: the course's children are what both
    // caps count, so A must have room for the second site B already admitted.
    const { course, inviteId: codeA } = await courseWithCode();
    const codeB = await seedInvite({
      projectId: course,
      token: "CLASSCODE8",
    });
    const otherConvenor = await seedUser();
    const otherChild = await seedProject(otherConvenor);
    await redeemForSite(db, {
      token: "CLASSCODE8",
      childProjectId: otherChild,
      userId: otherConvenor,
    });

    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    // An already-enrolled site offered a sibling code asks it for nothing.
    const result = await redeemForSite(db, {
      token: "CLASSCODE8",
      childProjectId: child,
      userId: convenor,
    });

    expect(result).toMatchObject({ state: "ok", alreadyAttached: true });
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBe(codeA);
    expect((await projectRow(child)).parent_project_id).toBe(course);
    expect(codeB).toBeGreaterThan(0);
  });

  it("does not move the admission record to an uncapped sibling code either", async () => {
    const { inviteId: codeA } = await courseWithCode();
    const { course } = { course: (await inviteRow(codeA)).project_id };
    await seedInvite({ projectId: course, token: "CLASSCODE8" });
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    const result = await redeemForSite(db, {
      token: "CLASSCODE8",
      childProjectId: child,
      userId: convenor,
    });

    expect(result).toMatchObject({ state: "ok", alreadyAttached: true });
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBe(codeA);
  });

  it("throws for a caller who does not convene the child, writing nothing", async () => {
    await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    const outsider = await seedUser();

    await expect(
      redeemForSite(db, {
        token: "CLASSCODE7",
        childProjectId: child,
        userId: outsider,
      }),
    ).rejects.toThrow(/does not convene/);

    expect((await projectRow(child)).parent_project_id).toBeNull();
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBeNull();
    expect(await memberRow(child, outsider)).toBeUndefined();
  });

  it("throws for a collaborator on the child", async () => {
    await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    const collaborator = await seedUser();
    await db.insert(project_members).values({
      project_id: child,
      user_id: collaborator,
      role: "collaborator",
      joined_at: new Date().toISOString(),
    });

    await expect(
      redeemForSite(db, {
        token: "CLASSCODE7",
        childProjectId: child,
        userId: collaborator,
      }),
    ).rejects.toThrow(/does not convene/);
    expect((await projectRow(child)).parent_project_id).toBeNull();
  });

  it("reports the code's own state before it reports the child's", async () => {
    const instructor = await seedUser();
    const course = await seedProject(instructor, "course");
    await seedInvite({
      projectId: course,
      token: "STALECODE7",
      expiresAt: past(),
    });
    await seedInvite({
      projectId: course,
      token: "STAFFCODE9",
      conferredRole: "instructor",
    });
    const convenor = await seedUser();
    const otherCourse = await seedProject(convenor, "course");

    const expired = await redeemForSite(db, {
      token: "STALECODE7",
      childProjectId: otherCourse,
      userId: convenor,
    });
    expect(expired.state).toBe("expired");

    const wrongKind = await redeemForSite(db, {
      token: "STAFFCODE9",
      childProjectId: otherCourse,
      userId: convenor,
    });
    expect(wrongKind.state).toBe("wrong_kind");
  });

  it("keeps provenance the convenor row already carries", async () => {
    const { course } = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    // The convenor row was admitted by the child's own invite.
    const ownInvite = await seedInvite({
      projectId: child,
      token: "3f2504e0-4f89-11d3-9a0c-0305e82c3399",
      usedAt: new Date().toISOString(),
    });
    await db
      .update(project_members)
      .set({ joined_via_invite_id: ownInvite })
      .where(eq(project_members.project_id, child));

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    expect(result.state).toBe("ok");
    expect((await projectRow(child)).parent_project_id).toBe(course);
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBe(ownInvite);
  });

  it("counts token refusals against the limiter and situational ones not at all", async () => {
    const { course } = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);

    // already_enrolled: attach elsewhere first, then offer this course's code.
    const otherInstructor = await seedUser();
    const otherCourse = await seedProject(otherInstructor, "course");
    await db
      .update(projects)
      .set({ parent_project_id: otherCourse })
      .where(eq(projects.id, child));

    const enrolled = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });
    expect(enrolled.state).toBe("already_enrolled");
    expect(await attemptRow(convenor)).toBeUndefined();

    // not_a_site: a course offered as the child.
    const courseConvenor = await seedUser();
    const asChild = await seedProject(courseConvenor, "course");
    const notASite = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: asChild,
      userId: courseConvenor,
    });
    expect(notASite.state).toBe("not_a_site");
    expect(await attemptRow(courseConvenor)).toBeUndefined();
    expect(course).toBeGreaterThan(0);
  });

  it("counts a failed redemption against the limiter and a successful one not at all", async () => {
    await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);

    await redeemForSite(db, {
      token: "NOSUCHCODE",
      childProjectId: child,
      userId: convenor,
    });
    expect((await attemptRow(convenor)).count).toBe(1);

    await redeemForSite(db, {
      token: "NOSUCHCODE",
      childProjectId: child,
      userId: convenor,
    });
    expect((await attemptRow(convenor)).count).toBe(2);

    await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });
    expect((await attemptRow(convenor)).count).toBe(2);
  });

  it("restarts the window rather than compounding an hour-old count", async () => {
    await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await seedAttempts(convenor, REDEMPTION_LIMIT, REDEMPTION_WINDOW_MS + 1000);

    await redeemForSite(db, {
      token: "NOSUCHCODE",
      childProjectId: child,
      userId: convenor,
    });

    expect((await attemptRow(convenor)).count).toBe(1);
  });

  it("refuses a rate-limited caller without adding to the count", async () => {
    const { course } = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await seedAttempts(convenor, REDEMPTION_LIMIT);

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    expect(result.state).toBe("rate_limited");
    expect((await attemptRow(convenor)).count).toBe(REDEMPTION_LIMIT);
    expect((await projectRow(child)).parent_project_id).toBeNull();
    expect(course).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// redeemAsStaff
// ---------------------------------------------------------------------------

describe("redeemAsStaff", () => {
  async function courseWithStaffCode() {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const inviteId = await seedInvite({
      projectId: course,
      token: "STAFFCODE9",
      conferredRole: "instructor",
    });
    return { convenor, course, inviteId };
  }

  it("adds an instructor row on the course and records the admission", async () => {
    const { course, inviteId } = await courseWithStaffCode();
    const ta = await seedUser();

    const result = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });

    expect(result.state).toBe("ok");
    const row = await memberRow(course, ta);
    expect(row.role).toBe("instructor");
    expect(row.joined_via_invite_id).toBe(inviteId);
  });

  it("is idempotent on retry — no second row, no moved record", async () => {
    const { course, inviteId } = await courseWithStaffCode();
    const ta = await seedUser();

    await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });
    const again = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });

    expect(again.state).toBe("ok");
    const rows = await db
      .select()
      .from(project_members)
      .where(
        and(
          eq(project_members.project_id, course),
          eq(project_members.user_id, ta),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].joined_via_invite_id).toBe(inviteId);
  });

  it("returns ok for the course convenor without a second row or a record", async () => {
    const { convenor, course, inviteId } = await courseWithStaffCode();

    const result = await redeemAsStaff(db, {
      token: "STAFFCODE9",
      userId: convenor,
    });

    expect(result.state).toBe("ok");
    const row = await memberRow(course, convenor);
    expect(row.role).toBe("convenor");
    expect(row.joined_via_invite_id).toBeNull();
    expect(inviteId).toBeGreaterThan(0);
  });

  it("leaves a staff member admitted under another code alone", async () => {
    const { course } = await courseWithStaffCode();
    const firstInviteId = await seedInvite({
      projectId: course,
      token: "STAFFCODE1",
      conferredRole: "instructor",
    });
    const ta = await seedUser();
    await redeemAsStaff(db, { token: "STAFFCODE1", userId: ta });

    const result = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });

    expect(result.state).toBe("ok");
    expect((await memberRow(course, ta)).joined_via_invite_id).toBe(firstInviteId);
  });

  it("upgrades a collaborator row on the course and records the admission", async () => {
    const { course, inviteId } = await courseWithStaffCode();
    const ta = await seedUser();
    await db.insert(project_members).values({
      project_id: course,
      user_id: ta,
      role: "collaborator",
      joined_at: new Date().toISOString(),
    });

    const result = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });

    expect(result).toMatchObject({ state: "ok", alreadyStaff: false });
    const row = await memberRow(course, ta);
    expect(row.role).toBe("instructor");
    expect(row.joined_via_invite_id).toBe(inviteId);
  });

  it("refuses a staff code whose project is not a course", async () => {
    const owner = await seedUser();
    const site = await seedProject(owner);
    await seedInvite({
      projectId: site,
      token: "STAFFCODE9",
      conferredRole: "instructor",
    });
    const ta = await seedUser();

    const result = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });

    expect(result.state).toBe("wrong_kind");
    expect(await memberRow(site, ta)).toBeUndefined();
  });

  it("refuses a class code entered on the staff surface", async () => {
    const instructor = await seedUser();
    const course = await seedProject(instructor, "course");
    await seedInvite({ projectId: course, token: "CLASSCODE7" });
    const ta = await seedUser();

    const result = await redeemAsStaff(db, { token: "CLASSCODE7", userId: ta });

    expect(result.state).toBe("wrong_kind");
    expect(await memberRow(course, ta)).toBeUndefined();
  });

  describe("course access", () => {
    async function hasCourseAccess(userId: number): Promise<boolean> {
      const rows = await db.select({ a: users.course_access }).from(users).where(eq(users.id, userId));
      return rows[0].a;
    }

    it("is granted by a staff redemption, and again by a repeat", async () => {
      await courseWithStaffCode();
      const ta = await seedUser();
      expect(await hasCourseAccess(ta)).toBe(false);

      await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });
      expect(await hasCourseAccess(ta)).toBe(true);

      const again = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });
      expect(again.state).toBe("ok");
      expect(await hasCourseAccess(ta)).toBe(true);
    });

    it("is granted when the redeemer already held staff standing", async () => {
      const { convenor } = await courseWithStaffCode();
      expect(await hasCourseAccess(convenor)).toBe(false);

      const result = await redeemAsStaff(db, { token: "STAFFCODE9", userId: convenor });

      expect(result).toMatchObject({ state: "ok", alreadyStaff: true });
      expect(await hasCourseAccess(convenor)).toBe(true);
    });

    it("is not granted by a class-code redemption", async () => {
      const convenor = await seedUser();
      const course = await seedProject(convenor, "course");
      await seedInvite({ projectId: course, token: "CLASSCODE7" });
      const student = await seedUser();
      const child = await seedProject(student);

      const result = await redeemForSite(db, {
        token: "CLASSCODE7",
        childProjectId: child,
        userId: student,
      });

      expect(result.state).toBe("ok");
      expect(await hasCourseAccess(student)).toBe(false);
    });

    it("is not granted by a staff redemption that fails", async () => {
      const owner = await seedUser();
      const site = await seedProject(owner);
      await seedInvite({ projectId: site, token: "STAFFCODE9", conferredRole: "instructor" });
      const ta = await seedUser();

      const result = await redeemAsStaff(db, { token: "STAFFCODE9", userId: ta });
      const missing = await redeemAsStaff(db, { token: "NOSUCHCODE", userId: ta });

      expect(result.state).toBe("wrong_kind");
      expect(missing.state).toBe("not_found");
      expect(await hasCourseAccess(ta)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Seat claiming under contention
// ---------------------------------------------------------------------------

/**
 * The cap is decided by the statement that writes the admission record, so
 * these exercise the guarded write rather than the advisory count
 * `resolveCode` reports. Concurrency here is real interleaving: the memory
 * D1 runs each statement to completion but every `await` yields, so two
 * redemptions started together take their turns statement by statement —
 * which is exactly the window a read-then-write cap loses.
 */
describe("admission records", () => {
  async function courseWithCode(token = "CLASSCODE7") {
    const instructor = await seedUser();
    const course = await seedProject(instructor, "course");
    const inviteId = await seedInvite({ projectId: course, token });
    return { instructor, course, inviteId };
  }

  async function seats(inviteId: number) {
    return db
      .select()
      .from(project_members)
      .where(eq(project_members.joined_via_invite_id, inviteId));
  }

  it("records the missing attribution for a site already attached to this course", async () => {
    const { course, inviteId } = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });
    // The admission record goes missing — the partial failure R6 names.
    await db
      .update(project_members)
      .set({ joined_via_invite_id: null })
      .where(eq(project_members.project_id, child));

    const repair = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    expect(repair).toMatchObject({ state: "ok", alreadyAttached: true });
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBe(inviteId);
    expect((await projectRow(child)).parent_project_id).toBe(course);
    expect(await attemptRow(convenor)).toBeUndefined();
  });

  it("writes the attribution once when two sibling codes are offered at once", async () => {
    const { course, inviteId: codeA } = await courseWithCode();
    const codeB = await seedInvite({
      projectId: course,
      token: "CLASSCODE8",
    });
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await db
      .update(projects)
      .set({ parent_project_id: course })
      .where(eq(projects.id, child));

    // Attached with no record yet, two sibling codes offered at once. One
    // writes the attribution; the other finds it there and leaves it, and
    // neither is refused.
    const [a, b] = await Promise.all([
      redeemForSite(db, { token: "CLASSCODE7", childProjectId: child, userId: convenor }),
      redeemForSite(db, { token: "CLASSCODE8", childProjectId: child, userId: convenor }),
    ]);

    expect([a.state, b.state]).toEqual(["ok", "ok"]);
    expect(await attemptRow(convenor)).toBeUndefined();
    const seat = (await memberRow(child, convenor)).joined_via_invite_id;
    expect([codeA, codeB]).toContain(seat);
  });

  it("completes an attachment whose record was written but whose parent was not", async () => {
    const { course, inviteId } = await courseWithCode();
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    // The seat landed; the parent write never did.
    await db
      .update(project_members)
      .set({ joined_via_invite_id: inviteId })
      .where(eq(project_members.project_id, child));

    const result = await redeemForSite(db, {
      token: "CLASSCODE7",
      childProjectId: child,
      userId: convenor,
    });

    expect(result).toMatchObject({ state: "ok", alreadyAttached: false });
    expect((await projectRow(child)).parent_project_id).toBe(course);
    expect((await memberRow(child, convenor)).joined_via_invite_id).toBe(inviteId);
    expect(await attemptRow(convenor)).toBeUndefined();
  });

  it("reads a concurrent duplicate staff row as idempotent ok, not a full cap", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    await seedInvite({
      projectId: course,
      token: "STAFFCODE9",
      conferredRole: "instructor",
    });
    const ta = await seedUser();

    const [a, b] = await Promise.all([
      redeemAsStaff(db, { token: "STAFFCODE9", userId: ta }),
      redeemAsStaff(db, { token: "STAFFCODE9", userId: ta }),
    ]);

    expect([a.state, b.state]).toEqual(["ok", "ok"]);
    const rows = await db
      .select()
      .from(project_members)
      .where(
        and(
          eq(project_members.project_id, course),
          eq(project_members.user_id, ta),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("instructor");
    expect(await attemptRow(ta)).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// The failed-attempt counter
// ---------------------------------------------------------------------------

describe("failed-attempt counting", () => {
  it("accumulates concurrent failures rather than overwriting them", async () => {
    const convenor = await seedUser();
    const child = await seedProject(convenor);

    await Promise.all([
      redeemForSite(db, { token: "NOSUCHCODE", childProjectId: child, userId: convenor }),
      redeemForSite(db, { token: "NOSUCHCOD2", childProjectId: child, userId: convenor }),
      redeemForSite(db, { token: "NOSUCHCOD3", childProjectId: child, userId: convenor }),
    ]);

    expect((await attemptRow(convenor)).count).toBe(3);
  });

  it("accumulates onto a window already open", async () => {
    const convenor = await seedUser();
    const child = await seedProject(convenor);
    await seedAttempts(convenor, 3);

    await Promise.all([
      redeemForSite(db, { token: "NOSUCHCODE", childProjectId: child, userId: convenor }),
      redeemForSite(db, { token: "NOSUCHCOD2", childProjectId: child, userId: convenor }),
    ]);

    expect((await attemptRow(convenor)).count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Enrolment cap — site codes count children, not provenance
// ---------------------------------------------------------------------------

/**
 * A membership row holds ONE `joined_via_invite_id`, but a child site can be
 * a live candidate for two courses at once, so provenance can never count
 * site admissions correctly. For a `site` code the cap counts CHILDREN OF
 * THE COURSE, and it is enforced by the statement that creates the
 * enrolment — the parent compare-and-set — with the count re-derived inside
 * it. Over-admission is then impossible by construction.
 */
describe("enrolment cap", () => {
  async function childrenOf(courseId: number) {
    return db.select().from(projects).where(eq(projects.parent_project_id, courseId));
  }

  it("keeps two courses within their own caps when one child races both", async () => {
    const instructorA = await seedUser();
    const courseA = await seedProject(instructorA, "course");
    await seedInvite({ projectId: courseA, token: "COURSEACD7" });
    const instructorB = await seedUser();
    const courseB = await seedProject(instructorB, "course");
    await seedInvite({ projectId: courseB, token: "COURSEBCD8" });

    const convenor = await seedUser();
    const child = await seedProject(convenor);

    const [a, b] = await Promise.all([
      redeemForSite(db, { token: "COURSEACD7", childProjectId: child, userId: convenor }),
      redeemForSite(db, { token: "COURSEBCD8", childProjectId: child, userId: convenor }),
    ]);

    // Exactly one enrolment, and the loser reports the child's real state.
    expect([a.state, b.state].sort()).toEqual(["already_enrolled", "ok"]);
    const winner = (await projectRow(child)).parent_project_id;
    expect([courseA, courseB]).toContain(winner);
    expect(await childrenOf(winner as number)).toHaveLength(1);
  });

});
