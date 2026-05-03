/**
 * Locale switcher API route.
 *
 * Accepts POST with locale form data, sets the locale cookie,
 * and redirects back to the referring page when the Referer is
 * same-origin and uses an http(s) scheme. Cross-origin, malformed,
 * non-http(s), or missing Referer values fall back to /signin to
 * prevent open-redirect abuse.
 */

import { redirect } from "react-router";
import type { Route } from "./+types/api.locale";
import { localeCookie } from "~/i18n/i18next.server";

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const locale = formData.get("locale");

  if (locale !== "en" && locale !== "es") {
    throw redirect("/signin");
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
