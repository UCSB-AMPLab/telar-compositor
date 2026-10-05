/**
 * The reload hand-off cookie never causes a redirect.
 *
 * A tab hands its site to the document request that follows it in a cookie
 * (`~/lib/tab-site`). That site can send the page somewhere the session's site
 * would not (the role guard, the upgrade gate), and the redirect's target is
 * another path, which the path-scoped cookie does not reach: the redirect can
 * bounce back, or end on a page for a site the author never asked for.
 *
 * Whatever the reason, where a document request carried the hand-off and the
 * answer is a redirect, the answer is replaced by a redirect to the same
 * address that clears the cookie. The retry carries no hand-off and resolves as
 * it would without one; a genuine reload then returns to its own site through
 * the layout's gate. A hand-off request that renders is left alone.
 *
 * @version v1.5.0-beta
 */

import type { MiddlewareFunction } from "react-router";
import { readHandoffSite, TAB_SITE_COOKIE } from "~/lib/tab-site";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The redirect that retries `request` without its hand-off, or null to leave `response` alone. */
export function retryWithoutHandoff(request: Request, response: Response): Response | null {
  if (request.method !== "GET" || !REDIRECT_STATUSES.has(response.status)) return null;
  if (readHandoffSite(request) === undefined) return null;
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const headers = new Headers({
    Location: url.pathname + url.search,
    "Set-Cookie": `${TAB_SITE_COOKIE}=; Max-Age=0; Path=${url.pathname}; SameSite=Lax${secure}`,
  });
  // A session cookie the replaced response set (a sign-out) must survive.
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export const handoffRedirectMiddleware: MiddlewareFunction = async ({ request }, next) => {
  let response: Response;
  try {
    response = (await next()) as Response;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    response = thrown;
  }
  return retryWithoutHandoff(request, response) ?? response;
};
