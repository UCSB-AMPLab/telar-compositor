import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  // API routes
  route("/api/locale", "routes/api.locale.tsx"),

  // Unauthenticated routes
  layout("routes/_auth.tsx", [
    route("/signin", "routes/_auth.signin.tsx"),
    route("/auth/callback", "routes/_auth.callback.tsx"),
  ]),

  // Sign out
  route("/signout", "routes/signout.tsx"),

  // Onboarding wizard — authenticated but no tab nav
  route("/onboarding", "routes/onboarding.tsx"),

  // Authenticated routes (auth middleware applied in _app.tsx)
  layout("routes/_app.tsx", [
    index("routes/home.tsx"),
    route("/dashboard", "routes/_app.dashboard.tsx"),
    route("/objects", "routes/_app.objects.tsx"),
    route("/objects/:objectId", "routes/_app.objects.$objectId.tsx"),
    route("/stories", "routes/_app.stories.tsx"),
    route("/stories/:storyId", "routes/_app.stories.$storyId.tsx"),
    route("/glossary", "routes/_app.glossary.tsx"),
    route("/config", "routes/_app.config.tsx"),
    route("/publish", "routes/_app.publish.tsx"),
    route("/upgrade", "routes/_app.upgrade.tsx"),
  ]),
] satisfies RouteConfig;
