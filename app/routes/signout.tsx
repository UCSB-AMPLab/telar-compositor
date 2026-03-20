/**
 * Sign-out route. Destroys the session cookie and redirects to /signin.
 */

import { redirect } from "react-router";
import { createSessionStorage } from "~/lib/session.server";
import type { Route } from "./+types/signout";

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env;
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));

  return redirect("/signin", {
    headers: {
      "Set-Cookie": await sessionStorage.destroySession(session),
    },
  });
}
