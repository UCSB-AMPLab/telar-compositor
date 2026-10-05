/**
 * Holding the operation lease across a piece of work, for an action that
 * takes the lock (`workers/freeze-lease.ts`).
 *
 * Kept apart from `freeze-lease.server.ts` so that it reaches the object only
 * through that module's exports.
 *
 * @version v1.5.0-beta
 */

import { controlFreezeLease, newFreezeOperationId } from "~/lib/freeze-lease.server";
import type { LeaseKind, LeaseOutcome } from "../../workers/freeze-lease";

/**
 * Run `work` holding a lease of `kind`, and end the lease however `work`
 * ends: succeeded once `work` has called `landed`, failed otherwise,
 * including when it throws. A begin the object refuses runs nothing and
 * answers `{ refused: true }`; an object that could not be asked lets `work`
 * run, as every lease here does.
 */
export async function holdOperationLease<T>(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  userId: number,
  kind: LeaseKind,
  work: (landed: () => void) => Promise<T>,
): Promise<{ refused: true } | { refused: false; value: T }> {
  const operationId = newFreezeOperationId();
  const begun = await controlFreezeLease(env, projectId, userId, { op: "begin", kind, operationId });
  if (begun === "refused") return { refused: true };
  let outcome: LeaseOutcome = "failed";
  try {
    const value = await work(() => {
      outcome = "succeeded";
    });
    return { refused: false, value };
  } finally {
    await controlFreezeLease(env, projectId, userId, { op: "end", operationId, outcome });
  }
}

/**
 * Run `write`, a record a check makes of what it read, holding a lease of
 * `kind`, and only if the lease was granted: an operation holding one may be
 * writing the values the check compared, so recording the check's read then
 * could record a commit those values do not answer to. Unlike an operation,
 * which runs when the object cannot be asked, a check fails closed: a begin
 * refused or unanswered runs nothing and answers false, leaving the record
 * for the next check, which loses nothing. The lease is released as soon as
 * `write` answers.
 */
export async function recordIfLeaseFree(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  userId: number,
  kind: LeaseKind,
  write: () => Promise<boolean>,
): Promise<boolean> {
  const operationId = newFreezeOperationId();
  const begun = await controlFreezeLease(env, projectId, userId, { op: "begin", kind, operationId });
  if (begun !== "applied") return false;
  let outcome: LeaseOutcome = "failed";
  try {
    const moved = await write();
    outcome = "succeeded";
    return moved;
  } finally {
    await controlFreezeLease(env, projectId, userId, { op: "end", operationId, outcome });
  }
}
