/**
 * Shared helpers for the internal-marker auth used when the Worker action and
 * loader layers make RPC calls to a Collaboration Durable Object: the headers
 * on their own, and the whole signed GET for the routes that only read.
 *
 * Extracted from _app.account.tsx and _app.dashboard.tsx to prevent the
 * security-relevant signing logic from drifting between the two consumers.
 *
 * @version v1.5.0-beta
 */

import { signInternalMarker } from "../../workers/auth";

/**
 * One marker-signed GET to a project's Collaboration Durable Object.
 *
 * Signing, resolving the stub and building the request are a single act: every
 * read-only caller does all three, and a caller that signed for one op and
 * asked for another is refused at the far end with a 401 that reads like an
 * outage. Keeping them together is what makes the op in the signature and the
 * op in the path impossible to state twice.
 *
 * `userId` is bound into the marker and MUST equal the value the route
 * re-derives from its own query string, so it belongs to the path it travels
 * with rather than to the caller's own identity.
 */
export async function getFromCollaborationDO(
  env: Env,
  projectId: number,
  op: string,
  path: string,
  userId?: number | string,
): Promise<Response> {
  return callCollaborationDO(env, projectId, op, path, "GET", userId);
}

/**
 * One marker-signed POST to a project's Collaboration Durable Object, for a
 * route whose whole request is its path and its signature.
 *
 * It shares `getFromCollaborationDO`'s single reach so that signing, resolving
 * the stub and building the request stay one act for a write as they are for a
 * read, and so the worker keeps one call site into the object rather than one
 * per verb. A body is deliberately not offered: every control this carries is
 * bound into the signature through `binding` and, where the route reads one,
 * `detail`, and a body would be a second statement of the same thing that the
 * far end could not verify.
 */
export async function postToCollaborationDO(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  op: string,
  path: string,
  binding?: number | string,
  detail?: string,
): Promise<Response> {
  return callCollaborationDO(env, projectId, op, path, "POST", binding, detail);
}

async function callCollaborationDO(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  op: string,
  path: string,
  method: "GET" | "POST",
  userId?: number | string,
  detail?: string,
): Promise<Response> {
  const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, op, userId, detail);
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
  return stub.fetch(new Request(`https://internal${path}`, { method, headers }));
}

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
  detail?: string,
): Promise<Record<string, string>> {
  const { sigHex, timestamp } =
    detail === undefined
      ? await signInternalMarker(projectId, secret, op, userId)
      : await signInternalMarker(projectId, secret, op, userId, detail);
  return {
    "X-Internal-Auth": sigHex,
    "X-Internal-Timestamp": String(timestamp),
    "X-Internal-Project": String(projectId),
  };
}
