import { createRequestHandler, RouterContextProvider } from "react-router";

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

    // Admin: POST /ws/:projectId/reset — reset Yjs state for a project
    if (url.pathname.match(/^\/ws\/\d+\/reset$/) && request.method === "POST") {
      const projectId = url.pathname.split("/")[2];
      const id = env.COLLABORATION.idFromName(projectId);
      const stub = env.COLLABORATION.get(id);
      return stub.fetch(new Request("https://internal/reset", { method: "POST" }));
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
