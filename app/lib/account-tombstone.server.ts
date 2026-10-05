/**
 * What is left of an account once it is deleted: a tombstone that keeps the
 * person's name on their work, as part of each project's history, and nothing
 * else a live account holds.
 *
 * The row stays so that every reference to the person — the content they made
 * and last edited, their contributor, editing-time and activity rows, the
 * invites they issued and used — stays valid. Deleting it would break each of
 * those references, and a warm Durable Object holding one of their edits would
 * then fail its next save. What survives is their GitHub name and login,
 * which are the name the history shows and are public on GitHub in any case.
 * Everything else is cleared: their GitHub account id (so signing in again
 * makes a new account), email, plan, tokens, preferences and course access.
 *
 * A tombstone can never be a member again: migration 0057 refuses any
 * membership that names it, whichever route writes it.
 *
 * @version v1.5.0-beta
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { users } from "~/db/schema";

/** The tokens and expiry a tombstone holds: nothing usable, in NOT NULL columns. */
const NO_TOKEN = "";
const EXPIRED = new Date(0).toISOString();

/**
 * The statement that turns a live account into its tombstone, for the
 * account-deletion batch. `github_id` becomes the negated row id: unique, and
 * never a GitHub account's id, so the person's next sign-in finds no row and
 * creates a fresh one.
 */
// biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
export function tombstoneAccount(db: any, userId: number, now: string) {
  return db
    .update(users)
    .set({
      github_id: sql`-${users.id}`,
      github_email: null,
      encrypted_access_token: NO_TOKEN,
      encrypted_refresh_token: NO_TOKEN,
      access_token_expires_at: EXPIRED,
      refresh_token_expires_at: EXPIRED,
      course_access: false,
      ui_locale: null,
      last_seen_release: null,
      created_at: null,
      updated_at: now,
      deleted_at: now,
    })
    .where(and(eq(users.id, userId), isNull(users.deleted_at)));
}

/** The condition every write to a live account's own row carries. */
export function liveAccount(userId: number) {
  return and(eq(users.id, userId), isNull(users.deleted_at));
}
