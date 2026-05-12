/**
 * This file is the locale switcher API route — accepts a POST with
 * `locale` form data, sets the locale cookie, and writes
 * `ui_locale` to D1 for authenticated users so the language choice
 * persists across browsers.
 *
 * Redirects back to the referring page when the Referer is
 * same-origin and uses an http(s) scheme. Cross-origin, malformed,
 * non-http(s), or missing Referer values fall back to `/signin` to
 * prevent open-redirect abuse.
 *
 * When the request is authenticated (`userContext` is populated by
 * the layout's `authMiddleware`), the action also writes
 * `ui_locale` to the user's D1 row before setting the cookie. D1
 * failures are caught and logged; the cookie + redirect still
 * happen so the UI never split-brains on cookie vs D1.
 *
 * @version v1.2.0-beta
 */

import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/api.locale";
import { localeCookie } from "~/i18n/i18next.server";
import { getDb } from "~/lib/db.server";
import { users } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const locale = formData.get("locale");

  if (locale !== "en" && locale !== "es") {
    throw redirect("/signin");
  }

  // When authenticated, persist ui_locale to D1 first so that on the
  // next sign-in the callback hydration restores it across browsers.
  // This is best-effort — if D1
  // throws, we still set the cookie + redirect so the UI never split-brains
  // on cookie vs D1.
  //
  // We can't rely on authMiddleware here: /api/locale also serves anonymous
  // users (sign-in page locale toggle), and authMiddleware redirects to
  // /signin when there's no session. Resolve the user inline instead — if
  // there's no session cookie, just skip the D1 write.
  const env = context.cloudflare.env as Env;
  try {
    const sessionStorage = createSessionStorage(env.SESSION_SECRET);
    const session = await sessionStorage.getSession(
      request.headers.get("Cookie"),
    );
    const userId = session.get("userId") as number | undefined;
    if (userId) {
      const db = getDb(env.DB);
      await db
        .update(users)
        .set({ ui_locale: locale })
        .where(eq(users.id, Number(userId)));
    }
  } catch (err) {
    console.error("[api.locale] D1 write failed:", err);
    // fall through — cookie + redirect below still executes
  }

  // Validate Referer origin and scheme to prevent open redirect.
  // Cross-origin, malformed, non-http(s), or missing Referer falls back to /signin.
  const referer = request.headers.get("Referer");
  let target = "/signin";
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const reqOrigin = new URL(request.url).origin;
      if (
        (refUrl.protocol === "http:" || refUrl.protocol === "https:") &&
        refUrl.origin === reqOrigin
      ) {
        target = refUrl.pathname + refUrl.search;
      }
    } catch {
      // malformed Referer — fall through to /signin
    }
  }

  return redirect(target, {
    headers: {
      "Set-Cookie": await localeCookie.serialize(locale),
    },
  });
}
