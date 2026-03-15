/**
 * Authenticated application layout.
 *
 * Applies auth middleware — all child routes are protected.
 * Renders: Header + TabNav + content area + Footer.
 * User data is read from middleware context (set by authMiddleware).
 */

import { Outlet } from "react-router";
import type { Route } from "./+types/_app";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { Header } from "~/components/layout/Header";
import { TabNav } from "~/components/layout/TabNav";
import { Footer } from "~/components/layout/Footer";

export const middleware = [authMiddleware];
export const handle = { i18n: ["common"] };

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) {
    // Should not happen — authMiddleware redirects if no user
    throw new Response("Unauthorized", { status: 401 });
  }
  return {
    user: {
      github_id: user.github_id,
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;

  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Header user={user} />
      <TabNav />
      <main className="flex-1 p-6">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
