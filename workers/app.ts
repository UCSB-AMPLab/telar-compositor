import { createRequestHandler, RouterContextProvider } from "react-router";
import { parseSessionCookie, getUserIdFromToken, signInternalMarker } from "./auth";

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Admin: POST /ws/:projectId/reset — reset Yjs state for a project.
    // Require an authenticated convenor session before forwarding to the DO.
    // Sign an internal marker so the DO can reject requests that don't come
    // through this gate.
    if (url.pathname.match(/^\/ws\/\d+\/reset$/) && request.method === "POST") {
      const projectIdStr = url.pathname.split("/")[2];
      const projectId = Number(projectIdStr);
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return new Response("Bad request", { status: 400 });
      }

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
      // HMAC-SHA256(SESSION_SECRET, "ws-reset:<projectId>:<timestamp>").
      // Replay within the 30s window is accepted — DO routing is internal.
      const { sigHex, timestamp } = await signInternalMarker(projectId, env.SESSION_SECRET);

      const id = env.COLLABORATION.idFromName(projectIdStr);
      const stub = env.COLLABORATION.get(id);
      return stub.fetch(
        new Request("https://internal/reset", {
          method: "POST",
          headers: {
            "X-Internal-Auth": sigHex,
            "X-Internal-Timestamp": String(timestamp),
            "X-Internal-Project": projectIdStr,
          },
        }),
      );
    }

    // Route WebSocket upgrades to the Collaboration Durable Object
    // This must run BEFORE React Router — it cannot handle 101 Upgrade responses
    if (url.pathname.startsWith("/ws/") && request.headers.get("Upgrade") === "websocket") {
      const projectId = url.pathname.split("/")[2];
      if (!projectId) {
        return new Response("Missing project ID", { status: 400 });
      }
      const id = env.COLLABORATION.idFromName(projectId);
      const stub = env.COLLABORATION.get(id);
      return stub.fetch(request);
    }

    // All other requests: React Router SSR handler
    const context = new RouterContextProvider();
    (context as any).cloudflare = { env, ctx };
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
