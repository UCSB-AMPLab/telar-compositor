/**
 * The start of an upgrade's operation lease (`workers/freeze-lease.ts`), and
 * what the author is told when it is refused.
 *
 * A prepare takes the lease rather than beginning it, so an upgrade the same
 * author left before its commit, by closing or reloading the page, does not
 * hold them out of trying again. A refusal that remains is either another
 * operation, or the author's own upgrade whose commit is still acting under
 * its lease; the second is told as theirs, with the minutes until it lifts,
 * because the general message would send them looking for someone else's
 * publish.
 *
 * @version v1.5.3-beta
 */

import { controlFreezeLeaseNamingHolder, newFreezeOperationId } from "~/lib/freeze-lease.server";
import type { LeaseHolder } from "../../workers/freeze-lease";

export type UpgradeLeaseStart =
  | { operationId: string }
  | { error: "operation_in_progress" }
  | { error: "own_upgrade_in_progress"; detail: { minutes: number } };

/**
 * Take the lease for an upgrade's prepare and answer its id, or the refusal
 * to show. An object that could not be asked lets the prepare through, as
 * every lease does.
 */
export async function beginUpgradeLease(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  userId: number,
): Promise<UpgradeLeaseStart> {
  const operationId = newFreezeOperationId();
  const { result, holder } = await controlFreezeLeaseNamingHolder(env, projectId, userId, {
    op: "take",
    kind: "upgrade",
    operationId,
  });
  return result === "refused" ? upgradeLeaseRefusal(holder) : { operationId };
}

/**
 * The refusal for the lease a take met. Whole minutes, rounded up and at
 * least one, so the author is never told to retry before the lease has lifted.
 */
export function upgradeLeaseRefusal(holder: LeaseHolder | null): Exclude<UpgradeLeaseStart, { operationId: string }> {
  if (holder === null || !holder.own || holder.kind !== "upgrade") return { error: "operation_in_progress" };
  return { error: "own_upgrade_in_progress", detail: { minutes: Math.max(1, Math.ceil(holder.remainingMs / 60_000)) } };
}
