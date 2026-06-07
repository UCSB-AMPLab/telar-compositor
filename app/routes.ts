/**
 * This file is the React Router route manifest — every URL the
 * compositor serves is registered here, grouped into API routes,
 * unauthenticated routes, and the authenticated `_app` shell.
 *
 * @version v1.3.0-beta
 */

import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // API routes
  route("/api/locale", "routes/api.locale.tsx"),
  route("/api/welcome-ack", "routes/api.welcome-ack.tsx"),
  route("/api/release-ack", "routes/api.release-ack.tsx"),

  // Unauthenticated routes
  layout("routes/_auth.tsx", [
    route("/signin", "routes/_auth.signin.tsx"),
    route("/auth/callback", "routes/_auth.callback.tsx"),
    route("/invite/:token", "routes/_auth.invite.$token.tsx"),
  ]),

  // Sign out
  route("/signout", "routes/signout.tsx"),

  // Onboarding wizard — authenticated but no tab nav
  route("/onboarding", "routes/onboarding.tsx"),

  // Authenticated routes (auth middleware applied in _app.tsx)
  layout("routes/_app.tsx", [
    index("routes/home.tsx"),
    // Resource route (loader only) for the Site Status pill's lazy popover
    // payloads. Nested under _app so it inherits authMiddleware + userContext
    // and the active-project session resolution every other _app route uses.
    route("/api/site-status", "routes/api.site-status.tsx"),
    // Dashboard is retired AS A DESTINATION — its loader now redirects
    // to /objects. The route stays registered because its `action` export is a
    // shared global endpoint (search-users, send-invite, generate-invite,
    // remove-member, autosave-config, switch-project, reorder, sync intents).
    route("/dashboard", "routes/_app.dashboard.tsx"),
    // Start tab — the Atelier front door. `/` redirects here.
    // Loader resolves the active project, computes per-step workflow-map
    // counts, and a populated/empty state flag. Front door is always
    // reachable (NOT in GATED_PATHS).
    route("/start", "routes/_app.start.tsx"),
    route("/objects", "routes/_app.objects.tsx"),
    route("/objects/:objectId", "routes/_app.objects.$objectId.tsx"),
    route("/stories", "routes/_app.stories.tsx"),
    route("/stories/:storyId", "routes/_app.stories.$storyId.tsx"),
    // /homepage stays registered to the same module but its loader bounces to
    // /pages/index. /pages/index reuses the homepage module so the
    // landing editor's `autosave-landing` action travels with it (a known
    // pitfall — /dashboard's action does NOT handle autosave-landing).
    route("/homepage", "routes/_app.homepage.tsx"),
    // Same module, second path → an explicit `id` is required because React
    // Router derives route ids from the module path and would otherwise reject
    // the duplicate "routes/_app.homepage" id.
    route("/pages/index", "routes/_app.homepage.tsx", { id: "routes/_app.pages.index" }),
    route("/pages", "routes/_app.pages.tsx"),
    route("/glossary", "routes/_app.glossary.tsx"),
    route("/account", "routes/_app.account.tsx"),
    route("/config", "routes/_app.config.tsx"),
    route("/publish", "routes/_app.publish.tsx"),
    route("/upgrade", "routes/_app.upgrade.tsx"),
  ]),
] satisfies RouteConfig;
