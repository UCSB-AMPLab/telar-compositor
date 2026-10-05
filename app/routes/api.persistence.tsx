/**
 * This file is the resource route behind the site-status pill's halted state:
 * a loader that reports whether a project's saving has stopped, and an action
 * that lets its convenor restore it from the last save.
 *
 * It is a resource route (no default export) nested under the `_app` layout, so
 * it inherits `authMiddleware` and the authenticated user on context. It is NOT
 * reached from the `_app` loader: a durable-object round trip on every
 * navigation would wake every evicted object for a state that is almost always
 * "not halted", so the client fetches this route on its own schedule.
 *
 * Both halves resolve the target project the same way, and the way is strict.
 * `?projectId=` (loader) and the `projectId` field (action) are ASSERTIONS: the
 * session must carry an explicit, valid active-project id, the caller must hold
 * a membership in it, and it must equal what the request asserted. What that
 * binding protects is a confirmation shown in one tab being applied to the
 * project another tab has since selected. It does not prove what the user is
 * looking at, and it is not the authorisation boundary — `requireOwner` is.
 *
 * The action keeps three things apart that a caller would otherwise conflate:
 * what the reset did, what the state read afterwards says, and whether the
 * transport is certain of either. A landed reset whose readback threw is a
 * landed reset with an unreadable state; a reset whose fetch threw stays
 * uncertain whatever the readback shows, because the generation advances before
 * the rebuild and a moved generation proves neither a landed replacement nor a
 * healthy project. `landed` comes from a 200 and nothing else.
 *
 * @version v1.5.0-beta
 */

import type { Route } from "./+types/api.persistence";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { getUserRole, requireOwner } from "~/lib/membership.server";
import { resolveActiveProjectStrict } from "~/lib/active-project.server";
import { readPersistenceState } from "~/lib/collab-reset.server";
import type { PersistenceStateAnswer } from "~/lib/collab-reset.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { parseCanonicalGeneration } from "../../workers/doc-log";

export type { PersistenceStateAnswer };

/** What one reset attempt did, kept apart from what the state read afterwards. */
export type ResetOutcome =
  | { kind: "landed" }
  | { kind: "stale"; generation: number | null }
  | { kind: "retry" }
  | { kind: "failed"; status: number; body: string }
  | { kind: "uncertain" };

export interface ResetReport {
  projectId: number;
  reset: ResetOutcome;
  state: PersistenceStateAnswer | { unreadable: true };
}

/** The refusals both halves share, as the responses they throw. */
const NO_ACTIVE_PROJECT = () => new Response("no_active_project", { status: 404 });
const PROJECT_MISMATCH = () => new Response("project_mismatch", { status: 409 });

/** The asserted id, or null when the request named nothing usable. */
function assertedProjectId(raw: string | null): number | null {
  if (raw === null || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** The generation a `reset_stale` body names, or null when it names none. */
function staleGeneration(body: string): number | null {
  return parseCanonicalGeneration(body.split(":")[1] ?? null);
}

/** Map the object's answer to one reset outcome, logging only what is unnamed. */
function outcomeFor(projectId: number, status: number, body: string): ResetOutcome {
  if (status === 200) return { kind: "landed" };
  if (status === 409 && body.startsWith("reset_stale")) {
    return { kind: "stale", generation: staleGeneration(body) };
  }
  if (status === 503 && body === "reset_failed") return { kind: "retry" };
  console.warn(`[persistence-reset] project ${projectId}: ${status} ${body}`);
  return { kind: "failed", status, body };
}

/**
 * Resolve and bind the project this request is about.
 *
 * Order is the contract: no explicit session project is a 404 even when the
 * first membership would have equalled the assertion; a session project the
 * caller holds no membership in is a 403; and only then is the assertion
 * compared, so a mismatch never reaches the object.
 */
async function bindProject(
  request: Request,
  env: Env,
  userId: number,
  asserted: number | null,
): Promise<number> {
  const projectId = await resolveActiveProjectStrict(request, env);
  if (projectId === null) throw NO_ACTIVE_PROJECT();

  const role = await getUserRole(getDb(env.DB), projectId, userId);
  if (role === null) throw new Response("Forbidden", { status: 403 });

  if (asserted !== projectId) throw PROJECT_MISMATCH();
  return projectId;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // authMiddleware (applied by the _app layout) guarantees a user here.
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const url = new URL(request.url);
  const projectId = await bindProject(
    request,
    env,
    user.id,
    assertedProjectId(url.searchParams.get("projectId")),
  );

  // The answer is a moment's state of one object, and a cached copy of it would
  // offer a convenor a generation the object has already spent.
  return Response.json(await readPersistenceState(env as never, projectId), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const form = await request.formData();
  if (form.get("intent") !== "reset") {
    throw new Response("unknown_intent", { status: 400 });
  }

  const projectId = await bindProject(
    request,
    env,
    user.id,
    assertedProjectId(String(form.get("projectId") ?? "")),
  );

  // Refused before the authorisation check costs nothing and reaches nothing:
  // the object call is what an unguarded generation would have to be sent to,
  // and there is no unguarded fallback to fall back to.
  const expectedGeneration = parseCanonicalGeneration(
    String(form.get("expectedGeneration") ?? ""),
  );
  if (expectedGeneration === null) {
    throw new Response("bad_generation", { status: 400 });
  }

  // `requireOwner` throws its own 403 `Response`; letting it escape is what
  // keeps a refusal from being reported to the convenor as a transport error.
  await requireOwner(getDb(env.DB), projectId, user.id);

  const reset = await sendReset(env, projectId, expectedGeneration);

  // The read follows in every case, including an uncertain one: the convenor
  // needs to see where the project stands, and the two are reported separately.
  let state: PersistenceStateAnswer | { unreadable: true };
  try {
    state = await readPersistenceState(env as never, projectId);
  } catch {
    state = { unreadable: true };
  }

  return Response.json({ projectId, reset, state } satisfies ResetReport);
}

/** One signed, generation-bound POST. It never retries and never falls back. */
async function sendReset(
  env: Env,
  projectId: number,
  expectedGeneration: number,
): Promise<ResetOutcome> {
  try {
    const headers = await makeInternalMarkerHeaders(
      projectId,
      env.SESSION_SECRET,
      "reset",
      `${expectedGeneration}`,
    );
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    const response = await stub.fetch(
      new Request(`https://internal/reset?expectedGeneration=${expectedGeneration}`, {
        method: "POST",
        headers,
      }),
    );
    return outcomeFor(projectId, response.status, await response.text());
  } catch {
    // A throw does not prove the reset did not land.
    return { kind: "uncertain" };
  }
}
