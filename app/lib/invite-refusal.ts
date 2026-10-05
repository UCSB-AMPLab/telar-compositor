/**
 * This file names the refusal states of the invite-acceptance page and the
 * string each one renders. It is kept out of the route so the route module
 * exports only route members.
 *
 * @version v1.5.0-beta
 */

/**
 * The refusal states and the string each one renders. `not_found` and
 * `expired` deliberately share a message — the page must not confirm that
 * an expired token was ever real.
 */
export const INVITE_REFUSAL_KEYS = {
  not_found: "accept_expired",
  expired: "accept_expired",
  used: "accept_used",
  revoked: "accept_revoked",
  wrong_kind: "accept_wrong_kind",
} as const;
