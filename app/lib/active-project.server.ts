/**
 * Request-scoped resolution of the caller's active project.
 *
 * Bundles the session-cookie read and the membership-aware project lookup
 * that route loaders and actions otherwise repeat inline: open the session
 * from the request's Cookie header, pull `activeProjectId`, and hand it to
 * `resolveActiveProject` (which verifies membership and falls back to the
 * user's first project when the session id is missing or invalid).
 *
 * Returns the same `{ project, userRole } | null` shape as
 * `resolveActiveProject` — `null` when the user has no project memberships.
 *
 * This helper lives in its own module (not in membership.server.ts) so that
 * tests mocking `~/lib/membership.server` and `~/lib/session.server` at the
 * module boundary continue to intercept the primitives it delegates to.
 *
 * @version v1.5.0-beta
 */

import { data } from "react-router";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { SITE_CHANGED } from "~/lib/page-site";
import { readHandoffSite, readTabSite } from "~/lib/tab-site";

/** The site a request resolves to before membership is checked. */
export interface SiteHint<T> {
  siteId: number | T;
  /** The hand-off cookie's site, when it was used. */
  handoffSite: number | undefined;
}

/**
 * The site the tab that made the request is working on (`~/lib/tab-site`),
 * else the session's. A document request's hand-off cookie counts, and a
 * redirect answered under it is retried without it (`handoffRedirectMiddleware`),
 * so it is a hint every loader reads alike and never the cause of a redirect.
 */
export function siteHint<T>(request: Request, sessionSite: T): SiteHint<T> {
  const named = readTabSite(request);
  return {
    siteId: named ?? sessionSite,
    handoffSite: readHandoffSite(request),
  };
}

/** Whether the site a render resolved is the one the hand-off named. */
export function isHandoffSite(handoffSite: number | undefined, activeProjectId: number | null): boolean {
  return activeProjectId !== null && handoffSite === activeProjectId;
}

/**
 * The site the tab that made the request is working on, else the session's,
 * with the membership check and first-project fallback of
 * `resolveActiveProject`.
 */
export async function resolveActiveProjectFromRequest(
  request: Request,
  env: Env,
  userId: number,
) {
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;
  const db = getDb(env.DB);
  const hint = siteHint(request, sessionActiveId);
  return resolveActiveProject(db, userId, hint.siteId);
}

type ActiveProject = NonNullable<Awaited<ReturnType<typeof resolveActiveProject>>>;

export type PageProjectResolution =
  | ({ kind: "ok" } & ActiveProject)
  | { kind: "no_project" }
  | { kind: "site_changed"; currentSiteName: string };

/** A resolution that admitted the write: the page's site is the session's. */
export type PageProject = Extract<PageProjectResolution, { kind: "ok" }>;

/**
 * The session's active project for an action, refused unless the page that
 * submitted the form showed that same site.
 *
 * The session carries one active site for the whole browser, so a tab that
 * still shows site A posts into whatever site another tab switched to. A page
 * posts `siteId`, the site it was showing (`~/lib/page-site`). A different id,
 * or none, means the write could land on a site the author is not looking at:
 * nothing is written, and the caller answers `siteChangedAnswer`.
 */
export async function resolvePageProject(
  request: Request,
  env: Env,
  userId: number,
  formData: FormData,
): Promise<PageProjectResolution> {
  const resolved = await resolveActiveProjectFromRequest(request, env, userId);
  if (!resolved) return { kind: "no_project" };
  if (formData.get("siteId") !== String(resolved.project.id)) {
    return { kind: "site_changed", currentSiteName: resolved.project.github_repo_full_name };
  }
  return { kind: "ok", ...resolved };
}

/**
 * An action's answer to a write refused by `resolvePageProject`. The 409 keeps
 * React Router from revalidating, which would reload the refusing tab for the
 * other site before the author has read why.
 */
export function siteChangedAnswer<I extends string | null>(intent: I, currentSiteName: string) {
  return data(
    { ok: false as const, intent, error: SITE_CHANGED, currentSiteName },
    { status: 409 },
  );
}

/**
 * The active project the session names EXPLICITLY, or null.
 *
 * The resolver above falls back to the user's first membership when the session
 * carries no id or an unusable one, which is right for a page that has to render
 * something and wrong for an endpoint that binds a confirmation to a project: a
 * fallback would let a request that named project A be answered for project B
 * because the session happened to carry nothing. So this one answers null in
 * exactly the cases the fallback covers, and the caller refuses.
 *
 * It resolves an id and nothing else. Membership is the caller's to verify, and
 * has to be: a session with no active project and a session naming a project the
 * user does not belong to are different answers to the client.
 */
export async function resolveActiveProjectStrict(
  request: Request,
  env: Env,
): Promise<number | null> {
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = readTabSite(request) ?? session.get("activeProjectId");
  const projectId = Number(sessionActiveId);
  if (sessionActiveId === undefined || sessionActiveId === null || sessionActiveId === "") {
    return null;
  }
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return null;
  return projectId;
}
