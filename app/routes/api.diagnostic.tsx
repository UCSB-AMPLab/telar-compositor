/**
 * This file is the convenor's read of what a project's collaboration object
 * knows about its own persistence, and the two staging-only controls the
 * staging exercises drive it with.
 *
 * A resource route (no default export) nested under the `_app` layout, so it
 * inherits `authMiddleware` and the authenticated user on context, exactly as
 * `api.persistence` does. It resolves its project the same strict way — the
 * session must carry an explicit active project, the caller must hold a
 * membership in it, and `?projectId=` or the form's `projectId` must equal it —
 * and then gates on `requireOwner`, because what the object answers here is
 * operational detail about one project's storage.
 *
 * The object's status and body pass through untouched. This route decides who
 * may ask; it decides nothing about the answer, and it never retries. The
 * controls are refused by the object itself outside staging, so this route
 * carries no environment rule of its own and cannot drift from the object's.
 *
 * No user-facing string and no i18n key: nothing here reaches a screen.
 *
 * @version v1.5.0-beta
 */

import type { Route } from "./+types/api.diagnostic";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { getUserRole, requireOwner } from "~/lib/membership.server";
import { resolveActiveProjectStrict } from "~/lib/active-project.server";
import {
  getFromCollaborationDO,
  postToCollaborationDO,
} from "~/lib/internal-marker.server";

/** The intents the control half accepts, as a closed set. */
const DIAGNOSTIC_INTENTS = new Set(["record", "hold"]);

/** The asserted id, or null when the request named nothing usable. */
function assertedDiagnosticProject(raw: string | null): number | null {
  if (raw === null || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Resolve and bind the project this request is about, in the order
 * `api.persistence` fixes: no explicit session project is a 404 even when the
 * first membership would have equalled the assertion; a session project the
 * caller holds no membership in is a 403; and only then is the assertion
 * compared, so a mismatch never reaches the object.
 */
async function bindDiagnosticProject(
  request: Request,
  env: Env,
  userId: number,
  asserted: number | null,
): Promise<number> {
  const projectId = await resolveActiveProjectStrict(request, env);
  if (projectId === null) throw new Response("no_active_project", { status: 404 });

  const role = await getUserRole(getDb(env.DB), projectId, userId);
  if (role === null) throw new Response("Forbidden", { status: 403 });

  if (asserted !== projectId) throw new Response("project_mismatch", { status: 409 });
  return projectId;
}

/** The two options the object owns a policy for, and the only ones forwarded. */
const DIAGNOSTIC_OPTIONS = ["validate", "count"] as const;

/**
 * The options the read passes through: each of the two as supplied, and nothing
 * else composed.
 *
 * The value is forwarded verbatim because the policy on it is the object's — a
 * count outside the domain is its `400`, and either option outside staging is
 * its `403`. A route that filtered the value would answer a malformed request
 * with an ordinary read and hide the refusal the operator asked for; a route
 * that composed an option nobody sent would ask a question of its own.
 */
function diagnosticOptionQuery(url: URL): string {
  const options = new URLSearchParams();
  for (const name of DIAGNOSTIC_OPTIONS) {
    const value = url.searchParams.get(name);
    if (value !== null) options.set(name, value);
  }
  return options.toString();
}

/** The object's answer, passed through with the code and body it gave. */
function passThrough(status: number, body: string, contentType: string | null): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (contentType !== null) headers["Content-Type"] = contentType;
  return new Response(body, { status, headers });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // authMiddleware (applied by the _app layout) guarantees a user here.
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const url = new URL(request.url);
  const projectId = await bindDiagnosticProject(
    request,
    env,
    user.id,
    assertedDiagnosticProject(url.searchParams.get("projectId")),
  );

  // `requireOwner` throws its own 403 `Response`; letting it escape is what
  // keeps a refusal from being reported to the convenor as a transport error.
  await requireOwner(getDb(env.DB), projectId, user.id);

  const query = diagnosticOptionQuery(url);
  const answer = await getFromCollaborationDO(
    env,
    projectId,
    "diagnostic",
    `/diagnostic?${query}`,
  );
  return passThrough(
    answer.status,
    await answer.text(),
    answer.headers.get("Content-Type"),
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const value = String(form.get("value") ?? "");
  if (!DIAGNOSTIC_INTENTS.has(intent) || (value !== "0" && value !== "1")) {
    throw new Response("unknown_intent", { status: 400 });
  }

  const projectId = await bindDiagnosticProject(
    request,
    env,
    user.id,
    assertedDiagnosticProject(String(form.get("projectId") ?? "")),
  );
  await requireOwner(getDb(env.DB), projectId, user.id);

  // The control string is bound into the signature and re-derived by the object
  // from its own query, so a marker minted to stop recording cannot be replayed
  // to release a hold.
  const control = `${intent}=${value}`;
  const answer = await postToCollaborationDO(
    env,
    projectId,
    "diagnostic-control",
    `/diagnostic?${control}`,
    control,
  );
  return passThrough(
    answer.status,
    await answer.text(),
    answer.headers.get("Content-Type"),
  );
}
