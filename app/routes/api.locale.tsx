/**
 * Locale switcher API route.
 *
 * Accepts POST with locale form data, sets the locale cookie,
 * and redirects back to the referring page.
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

  const referer = request.headers.get("Referer") || "/signin";

  return redirect(referer, {
    headers: {
      "Set-Cookie": await localeCookie.serialize(locale),
    },
  });
}
