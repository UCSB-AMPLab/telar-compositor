/**
 * Collaboration gate password check.
 *
 * Accepts POST with a `password` form field, compares it against the
 * COLLAB_GATE secret on the server, and returns { ok: true | false }.
 * Keeps the password value out of the client bundle so the gate can
 * actually limit access to the collaboration UI during beta.
 */

import type { Route } from "./+types/api.collab-gate";

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env;
  const expected = env.COLLAB_GATE;

  // Gate disabled — accept any unlock attempt so the UI doesn't block users.
  if (!expected) return { ok: true };

  const formData = await request.formData();
  const submitted = formData.get("password");
  const ok = typeof submitted === "string" && submitted === expected;
  return { ok };
}
