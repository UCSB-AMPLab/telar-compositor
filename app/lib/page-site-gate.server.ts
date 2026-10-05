/**
 * The page-site check at the top of a route action.
 *
 * Its own module so that tests mocking `~/lib/active-project.server` at the
 * module boundary also replace the resolver this check calls.
 *
 * @version v1.5.0-beta
 */

import {
  resolvePageProject,
  siteChangedAnswer,
  type PageProject,
} from "~/lib/active-project.server";

/**
 * The page-site check at the top of an action: the refusal to return, or the
 * session's site (null when the user has no project) for the intents to use.
 * An intent in `exempt` acts on a row's own site or on none, and skips it.
 */
export async function gatePageSite(
  request: Request,
  env: Env,
  userId: number,
  formData: FormData,
  intent: string,
  exempt: readonly string[],
): Promise<
  | { refused: ReturnType<typeof siteChangedAnswer>; page: null }
  | { refused: null; page: PageProject | null }
> {
  if (exempt.includes(intent)) return { refused: null, page: null };
  const r = await resolvePageProject(request, env, userId, formData);
  if (r.kind === "site_changed") {
    return { refused: siteChangedAnswer(intent, r.currentSiteName), page: null };
  }
  return { refused: null, page: r.kind === "ok" ? r : null };
}
