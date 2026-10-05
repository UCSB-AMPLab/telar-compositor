/**
 * This file is the one place a `project_invites` token is turned into a
 * decision. Two artefacts share that table: the legacy single-use invite
 * (a UUID inside a link, resolved by `/invite/:token`) and the course join
 * code (ten characters an instructor writes on a slide and a student
 * copies into a field). `resolveCode` reads either and reports a state;
 * `redeemForSite` and `redeemAsStaff` do the two writes a redemption can
 * mean — attaching a site to a course, and joining a person to a course's
 * staff.
 *
 * Resolution is read-only and the rate limit is checked before the token is
 * looked up: an over-limit user gets `rate_limited` whether or not the
 * token exists, so the limiter cannot be turned into an oracle for which
 * ten-character strings are real. Only a failed *redemption* costs the
 * counter — a loader render or a revalidation must never spend a user's
 * attempts.
 *
 * A redemption spends the slot before it knows what the code is worth, and
 * hands it back if the answer was not a guess at a token. The order is
 * forced: a count read first and incremented afterwards admits every caller
 * of a burst, because all of them read before any of them wrote, and a
 * limit that a burst walks straight through is not a limit. So the two are
 * one statement — an upsert whose own WHERE refuses the increment past the
 * limit, and which reports back whether it ran. The window rollover is in
 * the same statement for the same reason: it is a burst at the rollover
 * that would otherwise be counted twice against a window that no longer
 * exists.
 *
 * Handing the slot back rather than never spending it is what keeps the
 * limiter off honest users. A student redeems a class code once, and a
 * convenor a handful of times; charging those against a limit meant for
 * guessing would refuse people who did nothing wrong.
 *
 * There is no use cap. A code admits anyone holding it until it is revoked
 * or expires, and `project_members.joined_via_invite_id` is attribution
 * alone — which code let this member in — counted by nothing and gating
 * nothing.
 *
 * Expiry is optional: `expires_at` NULL means the code never expires, which
 * is what a class code handed out at the start of a semester wants. The
 * check is explicit against NULL rather than coerced, because
 * `new Date(null)` is the epoch and would read as long expired.
 *
 * A legacy invite is still spent exactly once. `used_at` is its permanent
 * consumed flag — `used_by` is `ON DELETE SET NULL`, so a redeemer's
 * account deletion would otherwise reopen an invite that was spent — and a
 * spent one resolves `consumed`.
 *
 * Writes that must not double up are still settled by the database, not by
 * a prior read: the parent compare-and-set attaches a child only while it
 * has no parent, and the staff upsert admits a person only once. Each
 * re-reads what it failed to change, because a zero-row result there means
 * a concurrent redemption already did the work — an idempotent success,
 * not a refusal.
 *
 * `redeemForSite` enforces the child-convenor requirement itself (design
 * §5 — joining is the child convenor's act) and throws on a violation, so
 * callers need no gate of their own but must treat a throw as a
 * programmer error, not a user-facing state.
 *
 * Preconditions this module does not check and callers must:
 *   - `createCode` callers gate instructor-role codes to the course
 *     convenor and class codes to any course staff member (design §5).
 *
 * @version v1.5.0-beta
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { code_redemption_attempts, project_invites, project_members, projects, users } from "~/db/schema";

type DbInstance = ReturnType<typeof getDb>;

export type InviteRow = typeof project_invites.$inferSelect;

/**
 * `site` and `staff` are the two codes a course issues; `legacy_invite` is
 * the single-use project invitation that predates them. A surface declares
 * which one it expects, and anything else resolves to `wrong_kind`.
 */
export type CodeKind = "site" | "staff" | "legacy_invite";

export type ResolveState =
  | "ok"
  | "not_found"
  | "expired"
  | "revoked"
  /** A legacy single-use invite that has already been redeemed. */
  | "consumed"
  | "wrong_kind"
  | "rate_limited";

export type ResolveResult =
  | { state: "not_found" }
  | { state: "rate_limited" }
  | { state: "expired"; kind: CodeKind; invite: InviteRow }
  | { state: "revoked"; kind: CodeKind; invite: InviteRow }
  | { state: "consumed"; kind: CodeKind; invite: InviteRow }
  | { state: "wrong_kind"; kind: CodeKind; invite: InviteRow }
  | { state: "ok"; kind: CodeKind; invite: InviteRow };

/** Refusals a redemption adds to the resolution states. */
export type RedeemState = ResolveState | "already_enrolled" | "not_a_site";

// `inviteId` on an `ok` result names the code that was RESOLVED, not the
// invite the admission record ends up naming: the record is written only
// over a NULL, so a row that already carries one keeps it. Callers must not
// read it as "the admission record".
export type RedeemForSiteResult =
  | {
      state: "ok";
      courseProjectId: number;
      inviteId: number;
      /** True when this site was already attached to this course. */
      alreadyAttached: boolean;
    }
  | { state: Exclude<RedeemState, "ok">; kind?: CodeKind };

export type RedeemAsStaffResult =
  | {
      state: "ok";
      courseProjectId: number;
      inviteId: number;
      /** True when the redeemer already held staff standing on the course. */
      alreadyStaff: boolean;
    }
  | { state: Exclude<RedeemState, "ok">; kind?: CodeKind };

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Thirty-two characters, so one byte of entropy maps onto one character
 * without bias, and none of them can be misread aloud or off a slide:
 * `0`/`O` and `1`/`I`/`l` are all absent, and the alphabet is uppercase, so
 * a lowercase `l` never arises.
 */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Ten characters over a 32-symbol alphabet — 50 bits. */
export const CODE_LENGTH = 10;

/** One initial attempt plus this many regenerations before createCode gives up. */
export const CODE_COLLISION_RETRIES = 3;

function generateToken(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let token = "";
  // 256 is a whole multiple of 32, so the modulo is uniform.
  for (const byte of bytes) token += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return token;
}

/**
 * Drizzle wraps a driver error in its own, so the constraint text sits on
 * the cause chain rather than the outermost message.
 */
function isUniqueCollision(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/UNIQUE constraint failed/i.test(message)) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

/**
 * Mint a join code on a project. Expiry is the caller's — a 48-hour
 * invitation, a term-long class code, and one that never expires all come
 * from the same function.
 */
export async function createCode(
  db: DbInstance,
  values: {
    projectId: number;
    role: "collaborator" | "instructor";
    /** Null means the code never expires. */
    expiresAt: string | null;
    label: string | null;
    createdBy: number | null;
  },
): Promise<{ id: number; token: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CODE_COLLISION_RETRIES; attempt += 1) {
    const token = generateToken();
    try {
      const rows = await db
        .insert(project_invites)
        .values({
          project_id: values.projectId,
          token,
          created_by: values.createdBy,
          expires_at: values.expiresAt,
          conferred_role: values.role,
          label: values.label,
        })
        .returning({ id: project_invites.id });
      return { id: rows[0].id, token };
    } catch (error) {
      if (!isUniqueCollision(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `Could not mint a unique join code after ${CODE_COLLISION_RETRIES + 1} attempts`,
    { cause: lastError },
  );
}

// ---------------------------------------------------------------------------
// Kind derivation
// ---------------------------------------------------------------------------

const UUID_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The discriminator between the two artefacts is the token's shape. Every
 * invite minted before the generalisation is a `crypto.randomUUID()`, and
 * no generated code can be one: the code alphabet has no dashes and no
 * lowercase. Conferred role cannot do this job on its own — a legacy invite
 * and a class code both confer `collaborator`.
 */
export function isLegacyInviteToken(token: string): boolean {
  return UUID_TOKEN.test(token);
}

export function codeKind(token: string, conferredRole: string): CodeKind {
  if (isLegacyInviteToken(token)) return "legacy_invite";
  return conferredRole === "instructor" ? "staff" : "site";
}

/**
 * A typed code as the row that holds it spells it.
 *
 * The alphabet is uppercase and omits `0`, `O`, `1`, `I` and `l` precisely so
 * that a code can be read off a slide and typed back, and someone typing it
 * back lowercases it about as often as not. The column has no `NOCASE`
 * collation, so `=` is case-sensitive and a correct code typed in lowercase
 * resolved `not_found` — indistinguishable, to the person holding it, from a
 * code that was never issued.
 *
 * Uppercasing is lossless for a generated code: the alphabet has no lowercase
 * letter for it to collide with. It is NOT lossless for a legacy invite, whose
 * token is a lowercase UUID stored as it was minted — uppercase that and it
 * stops matching its own row. So the discrimination runs first. It can: the
 * UUID pattern is case-insensitive, and no generated code can look like a UUID
 * whatever its case, because the alphabet has no dashes.
 */
export function normaliseToken(token: string): string {
  return isLegacyInviteToken(token) ? token : token.toUpperCase();
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Failed redemptions allowed per user per window. */
export const REDEMPTION_LIMIT = 10;

/** The fixed window, restarted once `window_start` is older than this. */
export const REDEMPTION_WINDOW_MS = 60 * 60 * 1000;

async function attemptsInWindow(
  db: DbInstance,
  userId: number,
): Promise<{ count: number; windowStart: string } | null> {
  const rows = await db
    .select({
      count: code_redemption_attempts.count,
      window_start: code_redemption_attempts.window_start,
    })
    .from(code_redemption_attempts)
    .where(eq(code_redemption_attempts.user_id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const started = Date.parse(row.window_start);
  if (!Number.isFinite(started) || Date.now() - started >= REDEMPTION_WINDOW_MS) {
    return null;
  }
  return { count: row.count, windowStart: row.window_start };
}

/**
 * A slot spent by a redemption in progress, named by the window it was
 * spent in so it can only ever be handed back to that same window.
 */
type AttemptSlot =
  | { admitted: false }
  | { admitted: true; windowStart: string };

/**
 * Spend one attempt and report whether the caller was inside the limit —
 * the two in one statement, which is the only way the answer can stay true
 * of more than one caller at a time.
 *
 * The upsert's own WHERE is the limit: it declines the increment when the
 * window is live and already at the cap, and a declined upsert changes no
 * row, so RETURNING yields nothing and the caller is refused. Callers that
 * arrive together are thereby serialised by the database into the order it
 * applied them, and exactly `REDEMPTION_LIMIT` of them are admitted.
 *
 * Whether the window has lapsed is decided in the same statement, by string
 * comparison — `window_start` is always an ISO-8601 UTC timestamp, whose
 * lexical order is its chronological order — so a burst arriving at the
 * rollover restarts the window once rather than once per caller.
 *
 * Written only by the redemption paths. A resolution, which is what loaders
 * and revalidations perform, never reaches this.
 */
async function reserveAttempt(db: DbInstance, userId: number): Promise<AttemptSlot> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - REDEMPTION_WINDOW_MS).toISOString();
  const lapsed = sql`${code_redemption_attempts.window_start} <= ${cutoff}`;

  const rows = await db.all<{ window_start: string }>(sql`
    INSERT INTO ${code_redemption_attempts} (user_id, window_start, count)
    VALUES (${userId}, ${now}, 1)
    ON CONFLICT (user_id) DO UPDATE SET
      window_start = CASE WHEN ${lapsed} THEN ${now}
                          ELSE ${code_redemption_attempts.window_start} END,
      count        = CASE WHEN ${lapsed} THEN 1
                          ELSE ${code_redemption_attempts.count} + 1 END
    WHERE ${lapsed} OR ${code_redemption_attempts.count} < ${REDEMPTION_LIMIT}
    RETURNING window_start
  `);

  const row = rows[0];
  return row ? { admitted: true, windowStart: row.window_start } : { admitted: false };
}

/**
 * Hand a spent slot back. Called for every outcome that was not a guess at
 * a token — a successful redemption, and a refusal about the caller's own
 * project — so what the limiter counts is guessing and nothing else.
 *
 * Bound to the window the slot was spent in: a slot spent in a window that
 * has since rolled over belongs to nothing, and returning it would credit
 * the current window with an attempt nobody made.
 *
 * A window that falls back to nought is removed rather than kept at zero.
 * The table holds people who are guessing; a row per user who has only ever
 * redeemed successfully would be a row for every member of every class.
 * Removal is conditional on the count actually being nought, so a
 * concurrent reservation that has already claimed the window survives it.
 */
async function releaseAttempt(
  db: DbInstance,
  userId: number,
  windowStart: string,
): Promise<void> {
  await db.run(sql`
    UPDATE ${code_redemption_attempts}
    SET count = ${code_redemption_attempts.count} - 1
    WHERE ${code_redemption_attempts.user_id} = ${userId}
      AND ${code_redemption_attempts.window_start} = ${windowStart}
      AND ${code_redemption_attempts.count} > 0
  `);
  await db.run(sql`
    DELETE FROM ${code_redemption_attempts}
    WHERE ${code_redemption_attempts.user_id} = ${userId}
      AND ${code_redemption_attempts.window_start} = ${windowStart}
      AND ${code_redemption_attempts.count} <= 0
  `);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Read a token and report what it is worth to this user, writing nothing.
 *
 * `userId` is optional because one surface is pre-authentication: the
 * legacy invite link's loader renders a project name to whoever holds the
 * UUID, as it always has. With no user there is no per-user limiter to
 * consult, and a 122-bit UUID is not the artefact the limiter defends.
 *
 * When it is given, the limit is READ and nothing is spent — a resolution
 * writes nothing, so a loader or a revalidation cannot cost a user their
 * attempts. That is why the redemption paths do not pass it: they have
 * already spent a slot on the caller's behalf, and a read here would see
 * their own increment and refuse the attempt it had just admitted.
 */
export async function resolveCode(
  db: DbInstance,
  token: string,
  options: { expectedKind: CodeKind; userId?: number | null },
): Promise<ResolveResult> {
  const { expectedKind, userId } = options;

  // First, before the token is even looked up — otherwise the difference
  // between "rate_limited" and "not_found" tells an attacker which guesses
  // were real.
  if (userId != null) {
    const live = await attemptsInWindow(db, userId);
    if (live !== null && live.count >= REDEMPTION_LIMIT) {
      return { state: "rate_limited" };
    }
  }

  const rows = await db
    .select()
    .from(project_invites)
    .where(eq(project_invites.token, normaliseToken(token)))
    .limit(1);

  const invite = rows[0];
  if (!invite) return { state: "not_found" };

  const kind = codeKind(invite.token, invite.conferred_role);
  if (kind !== expectedKind) return { state: "wrong_kind", kind, invite };

  if (invite.revoked_at !== null) return { state: "revoked", kind, invite };

  // Explicitly against NULL, never coerced: `new Date(null)` is the epoch,
  // so a coerced comparison would report every never-expiring code expired.
  if (invite.expires_at !== null && new Date(invite.expires_at) < new Date()) {
    return { state: "expired", kind, invite };
  }

  // A legacy invite is spent by `used_at` and can never be un-spent. Course
  // codes have no such flag and no use limit: they stand until revoked or
  // expired.
  if (kind === "legacy_invite" && invite.used_at !== null) {
    return { state: "consumed", kind, invite };
  }

  return { state: "ok", kind, invite };
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

/**
 * Write the admission record onto the caller's membership row.
 *
 * Attribution, not accounting: it names which code admitted this member and
 * nothing counts or caps over it. Provenance the row already carries is
 * never overwritten (`IS NULL`) — a convenor admitted by their own site's
 * invite keeps that older, truer answer — so a zero-row result here is
 * unremarkable and needs no interpretation.
 */
async function recordAdmission(
  db: DbInstance,
  args: { projectId: number; userId: number; invite: InviteRow },
): Promise<void> {
  const { projectId, userId, invite } = args;
  await db
    .update(project_members)
    .set({ joined_via_invite_id: invite.id })
    .where(
      and(
        eq(project_members.project_id, projectId),
        eq(project_members.user_id, userId),
        isNull(project_members.joined_via_invite_id),
      ),
    );
}

/** States that mean the token itself was refused, as opposed to the surface. */
function isTokenFailure(state: RedeemState): boolean {
  return (
    state === "not_found" ||
    state === "expired" ||
    state === "revoked" ||
    state === "wrong_kind"
  );
}

/**
 * Attach a site to the course a class code belongs to.
 *
 * Joining is the child convenor's act, and that is enforced here rather
 * than trusted: a caller holding no convenor row on `childProjectId` is a
 * caller that skipped its gate, so this throws instead of returning a
 * state a user interface could render. In Wave 1 the function records the
 * attachment only — the parent link and the admission record; preloading
 * the course collection and copying its staff down are wired on top of it
 * later.
 *
 * A site attached to this course under a *different* code is already
 * enrolled and asks for nothing: it returns `ok` and touches neither its
 * admission record nor the course's count, which already includes it.
 * Keying idempotence on the course rather than on the admission record is
 * what lets a second code of the same course be offered by a site that
 * already belongs without being refused. The one thing such a site can
 * still be owed is the record itself, lost to a partial failure, and that
 * is written unconditionally — it is bookkeeping, and the site is counted
 * whether or not it carries one.
 *
 * The self-repair is real only where the parent link survived. A
 * redemption that lost the parent compare-and-set to a DIFFERENT course
 * leaves nothing behind to repair — the record follows the enrolment, so
 * it was never written — and every later retry of that losing code is
 * refused with `already_enrolled` before it reaches the record write, as
 * it should be: the child belongs to the other course now.
 */
export async function redeemForSite(
  db: DbInstance,
  args: { token: string; childProjectId: number; userId: number },
): Promise<RedeemForSiteResult> {
  const { token, childProjectId, userId } = args;

  const childRows = await db
    .select({ id: projects.id, kind: projects.kind, parent: projects.parent_project_id })
    .from(projects)
    .where(eq(projects.id, childProjectId))
    .limit(1);
  const child = childRows[0];

  const callerRows = await db
    .select({
      role: project_members.role,
      joined_via_invite_id: project_members.joined_via_invite_id,
    })
    .from(project_members)
    .where(
      and(
        eq(project_members.project_id, childProjectId),
        eq(project_members.user_id, userId),
      ),
    )
    .limit(1);
  const caller = callerRows[0];

  // Fail closed: no project or no convenor row means the caller's own gate
  // did not run, and a redemption that proceeded would set a parent with no
  // admission record behind it.
  if (!child || caller?.role !== "convenor") {
    throw new Error(
      `redeemForSite: user ${userId} does not convene project ${childProjectId}`,
    );
  }

  // Before the token is looked up, so that the difference between
  // `rate_limited` and `not_found` never tells a guesser which guesses were
  // real, and in one step with the limit decision so a burst cannot walk
  // through it. The slot is handed back below unless the token itself was
  // refused.
  const slot = await reserveAttempt(db, userId);
  if (!slot.admitted) return { state: "rate_limited" };
  let guessed = false;

  try {
    // The limiter has already spoken for this caller; passing the user again
    // would have `resolveCode` refuse the very attempt that was just admitted.
    const resolved = await resolveCode(db, token, { expectedKind: "site" });

    // Unreachable: `resolveCode` reports `rate_limited` only when it is given
    // a user to consult the limiter about, and this caller's limit was
    // already decided, once, by the reservation above.
    if (resolved.state === "rate_limited") return { state: "rate_limited" };

    if (resolved.state === "not_found") {
      guessed = true;
      return { state: "not_found" };
    }

    const { invite, kind } = resolved;
    const courseProjectId = invite.project_id;
    const alreadyAttached = child.parent === courseProjectId;

    // What the token is worth is decided before what the site is: a wrong,
    // expired or revoked code reports its own state even when the child could
    // never have attached anyway.
    if (resolved.state !== "ok") {
      guessed = isTokenFailure(resolved.state);
      return { state: resolved.state, kind };
    }

    // A course cannot join a course, which also forecloses parent cycles.
    // Distinct from `already_enrolled`, which is a different parent, and from
    // `wrong_kind`, which is a code-versus-surface mismatch. Neither this nor
    // `already_enrolled` counts against the limiter: a convenor mis-stating
    // their own site's situation is not guessing at tokens.
    if (child.kind !== "site") {
      return { state: "not_a_site", kind };
    }

    if (child.parent !== null && !alreadyAttached) {
      return { state: "already_enrolled", kind };
    }

    if (!alreadyAttached) {
      // Compare-and-set: a child is attached only while it has no parent, so
      // two concurrent redemptions for different courses cannot both win and
      // one child can never end up counted in two courses. The loser reads
      // the winner's parent below.
      const enrolled = await db
        .update(projects)
        .set({ parent_project_id: courseProjectId })
        .where(and(eq(projects.id, childProjectId), isNull(projects.parent_project_id)));

      if (enrolled.meta.changes === 0) {
        const settled = await db
          .select({ parent: projects.parent_project_id })
          .from(projects)
          .where(eq(projects.id, childProjectId))
          .limit(1);
        // Attached to this same course by a concurrent redemption is the
        // outcome asked for, so it is an idempotent success; anything else
        // means the child belongs elsewhere now.
        if (settled[0]?.parent !== courseProjectId) {
          return { state: "already_enrolled", kind };
        }
      }
    }

    // Attribution, after the enrolment it describes. An attached site whose
    // record was lost to a partial failure gets one back here, on any
    // redeemable code of the course.
    await recordAdmission(db, { projectId: childProjectId, userId, invite });

    return {
      state: "ok",
      courseProjectId,
      inviteId: invite.id,
      alreadyAttached,
    };
  } finally {
    if (!guessed) await releaseAttempt(db, userId, slot.windowStart);
  }
}

/**
 * Give a person the course access an instructor's Course tab depends on.
 * Redeeming a staff code is the grant, so the flag is set wherever a
 * redemption ends in admission, and setting it again changes nothing.
 */
async function grantCourseAccess(db: DbInstance, userId: number): Promise<void> {
  await db.update(users).set({ course_access: true }).where(eq(users.id, userId));
}

/**
 * Join a person to a course's teaching staff with an instructor-role code.
 *
 * Idempotent in the three ways staff admission repeats: the same code
 * twice, a TA already admitted under a different code, and the course
 * convenor, who is staff by definition. None of them writes a second row
 * or moves an existing `joined_via_invite_id`.
 *
 * A `collaborator` row on a course project is a different case. Course
 * membership is staff only, so such a row is already an anomaly rather
 * than a standing the code must respect: it is upgraded to `instructor`
 * and the admission is recorded. The fan-out rule that never upgrades a
 * collaborator row governs *child* sites, where collaborator standing is
 * the group's own membership; on the course project there is no such
 * membership to erase.
 *
 * With no membership row at all the role and the record are one write, so
 * the uniqueness of the row is settled by the statement rather than by a
 * prior read. A zero-row result there has exactly one cause — the row is
 * no longer a collaborator, because a concurrent redemption admitted this
 * person first — and that is an idempotent `ok`, not a refusal.
 */
export async function redeemAsStaff(
  db: DbInstance,
  args: { token: string; userId: number },
): Promise<RedeemAsStaffResult> {
  const { token, userId } = args;

  const slot = await reserveAttempt(db, userId);
  if (!slot.admitted) return { state: "rate_limited" };
  let guessed = false;

  try {
    const resolved = await resolveCode(db, token, { expectedKind: "staff" });

    // Unreachable, for the reason `redeemForSite` gives.
    if (resolved.state === "rate_limited") return { state: "rate_limited" };

    if (resolved.state === "not_found") {
      guessed = true;
      return { state: "not_found" };
    }

    const { invite, kind } = resolved;
    const courseProjectId = invite.project_id;

    const heldRows = await db
      .select({
        role: project_members.role,
        joined_via_invite_id: project_members.joined_via_invite_id,
      })
      .from(project_members)
      .where(
        and(
          eq(project_members.project_id, courseProjectId),
          eq(project_members.user_id, userId),
        ),
      )
      .limit(1);
    const held = heldRows[0];

    // Standing that already amounts to staff. A collaborator row is not that,
    // so it does not short-circuit the write below.
    const alreadyStaff = held?.role === "convenor" || held?.role === "instructor";

    if (resolved.state !== "ok") {
      guessed = isTokenFailure(resolved.state);
      return { state: resolved.state, kind };
    }

    // Defence in depth: an instructor-role code on something that is not a
    // course would make staff of a plain site. `createCode`'s gate refuses to
    // mint one, so no such row can exist today.
    const projectRows = await db
      .select({ kind: projects.kind })
      .from(projects)
      .where(eq(projects.id, courseProjectId))
      .limit(1);
    if (projectRows[0]?.kind !== "course") {
      guessed = true;
      return { state: "wrong_kind", kind };
    }

    // Standing that is already staff is the whole answer: no row is written
    // and no record is moved. The convenor is staff by definition, and a TA
    // admitted under another code keeps the code that admitted them.
    if (alreadyStaff) {
      await grantCourseAccess(db, userId);
      return {
        state: "ok",
        courseProjectId,
        inviteId: invite.id,
        alreadyStaff: true,
      };
    }

    // One statement, because with no membership row the role and the record
    // ARE the same write. `ON CONFLICT` absorbs a concurrent duplicate, and
    // its own WHERE keeps it off a row that has meanwhile become staff;
    // provenance already on a collaborator row is coalesced, never moved.
    const now = new Date().toISOString();
    const admitted = await db.run(sql`
      INSERT INTO ${project_members}
        (project_id, user_id, role, invited_at, joined_at, joined_via_invite_id)
      VALUES (${courseProjectId}, ${userId}, 'instructor', ${now}, ${now}, ${invite.id})
      ON CONFLICT (project_id, user_id) DO UPDATE SET
        role = 'instructor',
        joined_via_invite_id =
          COALESCE(${project_members.joined_via_invite_id}, excluded.joined_via_invite_id)
      WHERE ${project_members.role} = 'collaborator'
    `);

    // Zero rows can only mean the conflict path declined, and it declines on
    // one condition: the row is no longer a collaborator. So a concurrent
    // redemption made this user staff first — the outcome asked for, reported
    // as the idempotent success it is rather than as a refusal.
    await grantCourseAccess(db, userId);
    return {
      state: "ok",
      courseProjectId,
      inviteId: invite.id,
      alreadyStaff: admitted.meta.changes === 0,
    };
  } finally {
    if (!guessed) await releaseAttempt(db, userId, slot.windowStart);
  }
}
