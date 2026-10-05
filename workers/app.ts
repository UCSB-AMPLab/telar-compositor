/**
 * This file is the Cloudflare Worker entry point — the top of the
 * compositor's request pipeline. Wires the React Router request
 * handler to the worker `fetch`, exposes the collaboration Durable
 * Object class, and gates the `/ws/:projectId/reset` route by
 * session + project membership before forwarding to the DO.
 *
 * @version v1.5.0-beta
 */

import { createRequestHandler, RouterContextProvider } from "react-router";
import "../app/lib/html-unescape.server";
import {
  parseSessionCookie,
  getUserIdFromToken,
  signInternalMarker,
  parseCanonicalProjectId,
} from "./auth";

export { ProjectCollaborationDO } from "./collaboration";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
  interface RouterContextProvider {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

/**
 * Admin: POST /ws/:projectId/reset — reset Yjs state for a project. Requires
 * an authenticated convenor session before forwarding to the DO, and signs
 * an internal marker so the DO can reject requests that don't come through
 * this gate. The id is validated through the same canonical parse the
 * upgrade route below uses (see parseCanonicalProjectId in ./auth), so the
 * two routes can never bind the collaboration DO from the same URL segment
 * two different ways.
 *
 * Returns null for any request that isn't this route, so the caller falls
 * through to whatever else might handle it.
 */
async function handleWsReset(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const segments = url.pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "ws" || segments[3] !== "reset") return null;

  const projectId = parseCanonicalProjectId(segments[2]);
  if (projectId === null) return new Response("Bad request", { status: 400 });

  const token = parseSessionCookie(request.headers.get("Cookie"));
  if (!token) return new Response("Unauthorized", { status: 401 });

  const userId = await getUserIdFromToken(token, env.SESSION_SECRET);
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const memberRow = await env.DB
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .first<{ role: string }>();
  if (!memberRow) return new Response("Not a project member", { status: 403 });
  if (memberRow.role !== "convenor") return new Response("Forbidden", { status: 403 });

  // Sign an internal marker so the DO can reject direct reaches.
  // Sign the request with HMAC-SHA256(SESSION_SECRET, "ws-reset:<projectId>:<timestamp>").
  // Replay within the 30s window is accepted — DO routing is internal.
  const { sigHex, timestamp } = await signInternalMarker(projectId, env.SESSION_SECRET, "reset");

  const id = env.COLLABORATION.idFromName(String(projectId));
  const stub = env.COLLABORATION.get(id);
  return stub.fetch(
    new Request("https://internal/reset", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(projectId),
      },
    }),
  );
}

/**
 * Route a WebSocket upgrade under /ws/:projectId to the Collaboration
 * Durable Object. Must run BEFORE React Router — it cannot handle 101
 * Upgrade responses. Exactly /ws/:projectId is accepted: a trailing segment,
 * or anything but the canonical decimal form of the id, is refused here,
 * before any Durable Object is addressed — idFromName hashes this string
 * verbatim, so a lenient parse could name a different object than the same
 * id names elsewhere (see parseCanonicalProjectId in ./auth).
 *
 * Returns null for any request that isn't a /ws/ upgrade, so the caller
 * falls through to whatever else might handle it.
 */
async function handleWsUpgrade(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.headers.get("Upgrade") !== "websocket" || !url.pathname.startsWith("/ws/")) {
    return null;
  }
  const segments = url.pathname.split("/");
  const projectId = segments.length === 3 ? parseCanonicalProjectId(segments[2]) : null;
  if (projectId === null) return new Response("Invalid project ID", { status: 400 });

  const id = env.COLLABORATION.idFromName(String(projectId));
  const stub = env.COLLABORATION.get(id);
  return stub.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const resetResponse = await handleWsReset(request, env, url);
    if (resetResponse) return resetResponse;

    const upgradeResponse = await handleWsUpgrade(request, env, url);
    if (upgradeResponse) return upgradeResponse;

    // All other requests: React Router SSR handler
    const context = new RouterContextProvider();
    (context as any).cloudflare = { env, ctx };
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
