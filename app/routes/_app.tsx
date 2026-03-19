/**
 * Authenticated application layout.
 *
 * Applies auth middleware — all child routes are protected.
 * Renders: Header + TabNav + UpgradeBanner (when outdated) + SyncBanner (when HEAD diverged) + content area + Footer.
 *
 * On every authenticated page load, the loader:
 *   1. Checks whether the active project's stored head_sha matches the repo's
 *      current HEAD. If not, sets headDiverged: true so the SyncBanner can warn.
 *   2. Checks the site's telar_version against the latest release. If outdated,
 *      sets needsUpgrade: true and redirects gated routes (/publish, /objects)
 *      to /upgrade.
 *
 * Both checks fail open — if the GitHub API call fails, the user is not blocked.
 */

import { redirect, Outlet, Link, useLocation } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/_app";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, project_config } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getRepoHead } from "~/lib/github.server";
import { checkTelarVersion } from "~/lib/upgrade.server";
import { Header } from "~/components/layout/Header";
import { TabNav } from "~/components/layout/TabNav";
import { Footer } from "~/components/layout/Footer";
import { SyncBanner } from "~/components/layout/SyncBanner";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle } from "lucide-react";

export const middleware = [authMiddleware];
export const handle = { i18n: ["common", "upgrade"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) {
    // Should not happen — authMiddleware redirects if no user
    throw new Response("Unauthorized", { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  let headDiverged = false;
  let activeProjectId: number | null = null;
  let needsUpgrade = false;
  let latestTelarTag: string | null = null;
  let isBelowMinimum = false;

  try {
    const db = getDb(env.DB);

    // Get the active project from session (same pattern as _app.objects.tsx)
    const sessionStorage = createSessionStorage(env.SESSION_SECRET);
    const session = await sessionStorage.getSession(request.headers.get("Cookie"));
    const sessionActiveId = session.get("activeProjectId") as number | undefined;

    if (sessionActiveId) {
      activeProjectId = Number(sessionActiveId);

      // Fetch the project's head_sha and repo name
      const projectRows = await db
        .select({
          id: projects.id,
          head_sha: projects.head_sha,
          github_repo_full_name: projects.github_repo_full_name,
        })
        .from(projects)
        .where(eq(projects.id, activeProjectId));

      const project = projectRows[0];

      if (project && project.head_sha && project.github_repo_full_name) {
        // Decrypt the user's access token
        const token = await decrypt(
          user.encrypted_access_token,
          env.ENCRYPTION_KEY,
        );

        const [owner, repo] = project.github_repo_full_name.split("/");

        // Fetch current repo HEAD and compare
        const repoHead = await getRepoHead(token, owner, repo);
        headDiverged = repoHead !== project.head_sha;

        // Version check — gated routes redirect to /upgrade if outdated
        try {
          const configRows = await db
            .select({ telar_version: project_config.telar_version })
            .from(project_config)
            .where(eq(project_config.project_id, activeProjectId));
          const siteVersion = configRows[0]?.telar_version ?? null;

          if (siteVersion) {
            const versionCheck = await checkTelarVersion(token, siteVersion);
            needsUpgrade = versionCheck.needsUpgrade;
            latestTelarTag = versionCheck.latestTag;
            isBelowMinimum = versionCheck.isBelowMinimum;
          }
        } catch {
          // Fail open — don't block the user
          needsUpgrade = false;
        }

        // Redirect gated routes to /upgrade
        const url = new URL(request.url);
        const GATED_PATHS = ["/publish", "/objects", "/onboarding"];
        if (needsUpgrade && GATED_PATHS.some((p) => url.pathname.startsWith(p))) {
          throw redirect(`/upgrade?from=${encodeURIComponent(url.pathname)}`);
        }
      }
    }
  } catch (err) {
    // Re-throw redirects (they are Responses, not Errors)
    if (err instanceof Response) throw err;
    // Fail open — don't block the user on GitHub API errors
    headDiverged = false;
  }

  return {
    user: {
      github_id: user.github_id,
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
    headDiverged,
    activeProjectId,
    needsUpgrade,
    latestTelarTag,
    isBelowMinimum,
  };
}

function UpgradeBanner() {
  const { t } = useTranslation("upgrade");
  const location = useLocation();
  const isOnUpgradePage = location.pathname === "/upgrade";

  if (isOnUpgradePage) return null;

  return (
    <div className="bg-terracotta/10 border-b border-terracotta/20 px-6 py-3 flex items-center gap-3">
      <ArrowUpCircle className="w-4 h-4 text-terracotta shrink-0" aria-hidden="true" />
      <p className="font-body text-sm text-terracotta flex-1">
        {t("subtitle")}
      </p>
      <Link
        to="/upgrade"
        className="font-heading font-semibold text-sm text-terracotta underline underline-offset-2 hover:opacity-80 shrink-0"
      >
        {t("goToUpgrade")}
      </Link>
    </div>
  );
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, headDiverged, needsUpgrade } = loaderData;

  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Header user={user} />
      <TabNav />
      {needsUpgrade && <UpgradeBanner />}
      {headDiverged && <SyncBanner />}
      <main className="flex-1 p-6">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
