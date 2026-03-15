/**
 * Onboarding wizard route.
 *
 * 4-step wizard: Connect → Sync → Review → Done.
 * Own layout (no tab nav). Auth-protected via authMiddleware.
 * Loader fetches GitHub App installations and repos.
 * Action runs the import pipeline and handles Sheets URL retry.
 */

import { redirect } from "react-router";
import type { Route } from "./+types/onboarding";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { decrypt } from "~/lib/crypto.server";
import { listUserInstallations, listInstallationRepos } from "~/lib/github.server";
import type { Repository } from "~/lib/github.server";
import { importRepo } from "~/lib/import.server";
import { getDb } from "~/lib/db.server";
import { projects, project_config } from "~/db/schema";
import { eq } from "drizzle-orm";
import { Header } from "~/components/layout/Header";
import { WizardShell } from "~/components/features/onboarding/WizardShell";

export const middleware = [authMiddleware];
export const handle = { i18n: ["onboarding", "common"] };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoWithInstallation extends Repository {
  installationId: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);

  // Check if user already has projects — if so, redirect to dashboard
  // unless ?force=1 is in the query string
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  if (!force) {
    const db = getDb(env.DB);
    const existingProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.user_id, user.id))
      .limit(1);

    if (existingProjects.length > 0) {
      throw redirect("/dashboard");
    }
  }

  // Fetch all GitHub App installations and their repos
  const { installations } = await listUserInstallations(token);

  const reposByInstallation = await Promise.all(
    installations.map((installation) =>
      listInstallationRepos(token, installation.id).then(({ repositories }) =>
        repositories.map((repo): RepoWithInstallation => ({
          ...repo,
          installationId: installation.id,
        })),
      ),
    ),
  );

  const repos = reposByInstallation.flat();

  return {
    user: {
      github_id: user.github_id,
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
    repos,
    installations,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "import" || intent === "import_with_url") {
    const installationId = Number(formData.get("installation_id"));
    const repoFullName = formData.get("repo_full_name") as string;

    if (intent === "import_with_url") {
      const sheetsUrl = formData.get("sheets_url") as string;
      // Update the project_config with the corrected sheets URL before importing
      // The import pipeline reads the URL from the repo's _config.yml, so we
      // pass it as an override by patching the DB entry if a project already exists,
      // or rely on the import pipeline to use the URL directly.
      // For the retry path: importRepo re-reads config from GitHub, so we pass
      // the overrideGoogleSheetsUrl as an extra param.
      const result = await importRepo({
        token,
        installationId,
        repoFullName,
        userId: user.id,
        env,
        overrideGoogleSheetsUrl: sheetsUrl || undefined,
      });
      return result;
    }

    const result = await importRepo({
      token,
      installationId,
      repoFullName,
      userId: user.id,
      env,
    });
    return result;
  }

  if (intent === "save_config") {
    const projectId = Number(formData.get("project_id"));
    const db = getDb(env.DB);

    const configUpdates: Record<string, unknown> = {};
    const title = formData.get("title");
    const lang = formData.get("lang");
    const theme = formData.get("theme");
    const url = formData.get("url");
    const baseurl = formData.get("baseurl");

    if (title !== null) configUpdates.title = title;
    if (lang !== null) configUpdates.lang = lang;
    if (theme !== null) configUpdates.theme = theme;
    if (url !== null) configUpdates.url = url;
    if (baseurl !== null) configUpdates.baseurl = baseurl;

    await db
      .update(project_config)
      .set({ ...configUpdates, updated_at: new Date().toISOString() })
      .where(eq(project_config.project_id, projectId));

    return { saved: true };
  }

  throw new Response("Bad Request", { status: 400 });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OnboardingPage({ loaderData }: Route.ComponentProps) {
  const { user, repos } = loaderData;

  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Header user={user} />
      <main className="flex-1 flex items-start justify-center pt-10 pb-16 px-4">
        <div className="w-full max-w-2xl">
          <WizardShell repos={repos} user={user} />
        </div>
      </main>
    </div>
  );
}
