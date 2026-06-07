/**
 * Shared helper for building the internal-marker auth headers used when
 * the Worker action layer makes RPC calls to a Collaboration Durable Object.
 *
 * Extracted from _app.account.tsx and _app.dashboard.tsx to prevent the
 * security-relevant signing logic from drifting between the two consumers.
 *
 * @version v1.3.0-beta
 */

import { signInternalMarker } from "../../workers/auth";

/**
 * Build the standard internal-marker headers for a DO RPC.
 *
 * Pass `projectId` and the `SESSION_SECRET` env var as `secret`, plus the `op`
 * the target DO route verifies. For per-user routes (e.g. notify-deleted with
 * `?userId=`, active-ws-count with `?exceptUserId=`) also pass `userId` — it
 * MUST equal the value placed in the request's query param so the DO's
 * independently-derived expectedUserId matches the signed value.
 *
 * Only the three transport headers are returned; `op` and `userId` are NOT
 * sent — they are bound into the signature and re-derived by the DO from its
 * own request, which is what makes a marker un-replayable across ops/users.
 */
export async function makeInternalMarkerHeaders(
  projectId: number,
  secret: string,
  op: string,
  userId?: number | string,
): Promise<Record<string, string>> {
  const { sigHex, timestamp } = await signInternalMarker(projectId, secret, op, userId);
  return {
    "X-Internal-Auth": sigHex,
    "X-Internal-Timestamp": String(timestamp),
    "X-Internal-Project": String(projectId),
  };
}
