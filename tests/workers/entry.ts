/**
 * Worker entry for the `workers` Vitest project.
 *
 * `wrangler.jsonc` names `workers/app.ts` as `main`, and that file imports
 * `virtual:react-router/server-build` — a module the app's Vite build creates
 * and nothing else can resolve, so it cannot be the entry inside workerd. This
 * file stands in: it re-exports the real Durable Object class, so the class
 * `wrangler.jsonc`'s `v1` migration declares is the class under test, and it
 * carries the one route the tests need — the `/ws/:projectId` upgrade forward
 * that `workers/app.ts` performs.
 *
 * Nothing else is routed. The reset gate, the session cookie parsing and the
 * React Router handler belong to the production entry and are exercised by the
 * unit suite; adding them here would make this file a second implementation to
 * keep in step.
 *
 * The `/ws/` branch mirrors `workers/app.ts` down to the id validation: it
 * has to reject the same non-canonical forms (a leading zero, trailing
 * junk, an extra path segment) the production route does, or a test run
 * through this entry would pass on a request the real route would refuse.
 *
 * Known limit of this mirror: it has no `/ws/:projectId/reset` route, and
 * every non-matching request (including any POST to `/ws/:projectId/reset`)
 * falls through to the flat 404 below instead of production's SSR handler
 * and its reset auth gate. Concretely, a POST to `/ws/2/reset` carrying an
 * `Upgrade: websocket` header answers 400 here (path length 4, rejected by
 * the length check above) but reaches `handleWsReset` in production, which
 * matches on method and path shape alone — it does not look at the Upgrade
 * header — and enters the reset auth flow instead. A test written against
 * this entry for that combination would therefore not be testing what
 * production does; there is no such test here for that reason.
 *
 * @version v1.5.0-beta
 */

import { parseCanonicalProjectId } from "../../workers/auth";

export { ProjectCollaborationDO } from "../../workers/collaboration";

export default {
  // Both parameters are stated rather than inferred from the `satisfies` below,
  // so a test can call this handler with a `Request` it constructed itself.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/ws/") && request.headers.get("Upgrade") === "websocket") {
      const pathSegments = url.pathname.split("/");
      if (pathSegments.length !== 3) {
        return new Response("Invalid project ID", { status: 400 });
      }
      const projectId = parseCanonicalProjectId(pathSegments[2]);
      if (projectId === null) {
        return new Response("Invalid project ID", { status: 400 });
      }
      const id = env.COLLABORATION.idFromName(String(projectId));
      const stub = env.COLLABORATION.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
