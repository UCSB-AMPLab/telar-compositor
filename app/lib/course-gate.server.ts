/**
 * This file decides who may create and run courses.
 *
 * It was a password. One shared word in an environment variable, answered once
 * per session and remembered as a boolean on the signed session cookie — the
 * cheapest thing that could gate a feature while the question of who should
 * have it was deliberately left open.
 *
 * Leaving it open had two costs, and both showed up in use. The word sat in
 * plaintext in a tracked config file, so the gate was only as closed as the
 * repository. And access being a property of the SESSION meant the only way to
 * reach the door was to be shown it: every signed-in person met an invitation
 * to unlock courses, opened a dialog, and read that courses were in testing for
 * a small group they were not in. A gate that has to advertise itself to the
 * people it excludes is answering the wrong question.
 *
 * So access is a property of the PERSON now, carried on `users.course_access`,
 * granted from the backend while the group is small. Nothing is shown to
 * anyone who does not have it, because nothing needs to be: there is no door
 * to find. The flag survives sessions, which is what a password answered per
 * session never did.
 *
 * There is deliberately no interface for granting it. The column is the whole
 * mechanism, set by hand, and it is what an admin surface would read if one is
 * ever built.
 *
 * Closed is the default state and that is load-bearing: the column defaults to
 * 0, so every existing user and every new sign-up arrives without access, and
 * a deploy that forgets to grant anything opens nothing.
 *
 * @version v1.5.0-beta
 */

import type { users } from "~/db/schema";

/**
 * Whether this person may create and run courses.
 *
 * Takes the user row rather than the request: the answer is about them, not
 * about how they arrived, and every caller already holds it. `null` is a
 * caller with no user at all, which is closed for the same reason an unset
 * column is.
 */
export function mayUseCourses(
  user: Pick<typeof users.$inferSelect, "course_access"> | null | undefined,
): boolean {
  return user?.course_access === true;
}

/**
 * Throw 403 unless this person may use courses.
 *
 * The refusal carries no detail, as its predecessor did not: a caller reaching
 * a course action without access has either forged the request or kept a stale
 * form open, and neither wants an explanation of what is missing.
 */
export function requireCourseAccess(
  user: Pick<typeof users.$inferSelect, "course_access"> | null | undefined,
): void {
  if (!mayUseCourses(user)) {
    throw new Response("Forbidden", { status: 403 });
  }
}
