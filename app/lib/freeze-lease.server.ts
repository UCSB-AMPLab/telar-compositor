/**
 * The actions' side of the operation lease: start, renew and end one on the
 * project's Durable Object (`workers/freeze-lease.ts`).
 *
 * Called by the publish and upgrade actions after their own role checks, which
 * is what makes a lease something only a running operation can hold. A begin
 * the object refuses means another publish or upgrade is running, and the
 * caller stops there. Every other outcome lets the operation through: a lock
 * the object could not be asked about is not a reason to refuse, because the
 * expected-head check on every commit is what stops a real collision, and a
 * lease that could not be renewed or ended expires on its own. Nothing here
 * throws.
 *
 * @version v1.5.3-beta
 */

import { postToCollaborationDO } from "~/lib/internal-marker.server";
import { leaseControlText, parseRefusalText, type LeaseControl, type LeaseHolder } from "../../workers/freeze-lease";

/** A new operation id. Never broadcast; it travels only through the holder's page. */
export function newFreezeOperationId(): string {
  return crypto.randomUUID();
}

/**
 * What a lease control came to: applied, refused by the object (for a begin,
 * another operation is running), or not answered at all.
 */
export type LeaseResult = "applied" | "refused" | "unavailable";

/**
 * Send `control` for `userId` on `projectId`. A refusal and an unreachable
 * object are logged; neither throws.
 */
export async function controlFreezeLease(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  userId: number,
  control: LeaseControl,
): Promise<LeaseResult> {
  return (await controlFreezeLeaseNamingHolder(env, projectId, userId, control)).result;
}

/**
 * Send `control` as `controlFreezeLease` does, and answer with it the lease a
 * refusal met, when the object named one.
 */
export async function controlFreezeLeaseNamingHolder(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  userId: number,
  control: LeaseControl,
): Promise<{ result: LeaseResult; holder: LeaseHolder | null }> {
  const text = leaseControlText(control);
  try {
    const query = new URLSearchParams({ control: text, userId: String(userId) });
    const res = await postToCollaborationDO(env, projectId, "freeze", `/freeze?${query}`, userId, text);
    // Read whole, so the response releases the object whatever it said.
    const body = await res.text().catch(() => "");
    if (res.ok) return { result: "applied", holder: null };
    console.warn(`[freeze] project ${projectId}: ${text} answered ${res.status} ${body}`);
    if (res.status !== 409) return { result: "unavailable", holder: null };
    return { result: "refused", holder: parseRefusalText(body) };
  } catch (err) {
    console.warn(`[freeze] project ${projectId}: ${text} could not be sent`, err);
    return { result: "unavailable", holder: null };
  }
}
