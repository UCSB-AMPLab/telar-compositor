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
 * @version v1.5.0-beta
 */

import { postToCollaborationDO } from "~/lib/internal-marker.server";
import { leaseControlText, type LeaseControl } from "../../workers/freeze-lease";

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
  const text = leaseControlText(control);
  try {
    const query = new URLSearchParams({ control: text, userId: String(userId) });
    const res = await postToCollaborationDO(env, projectId, "freeze", `/freeze?${query}`, userId, text);
    // Read whole, so the response releases the object whatever it said.
    const body = await res.text().catch(() => "");
    if (res.ok) return "applied";
    console.warn(`[freeze] project ${projectId}: ${text} answered ${res.status} ${body}`);
    return res.status === 409 ? "refused" : "unavailable";
  } catch (err) {
    console.warn(`[freeze] project ${projectId}: ${text} could not be sent`, err);
    return "unavailable";
  }
}
