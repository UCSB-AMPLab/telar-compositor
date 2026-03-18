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
import { listUserInstallations, listInstallationRepos, getFileContent } from "~/lib/github.server";
import type { Repository } from "~/lib/github.server";
import { importRepo } from "~/lib/import.server";
import { commitFilesToRepo, disableGoogleSheetsInConfig, verifySiteUrl, enableGitHubPages } from "~/lib/commit.server";
import { getDb } from "~/lib/db.server";
import {
  projects,
  project_config,
  project_themes,
  project_landing,
  objects,
  stories,
  steps,
  layers,
  glossary_terms,
} from "~/db/schema";
import { eq, inArray } from "drizzle-orm";
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

  const db = getDb(env.DB);
  const existingProjects = await db
    .select({ id: projects.id, github_repo_full_name: projects.github_repo_full_name, onboarding_completed: projects.onboarding_completed })
    .from(projects)
    .where(eq(projects.user_id, user.id));

  const hasIncompleteOnboarding = existingProjects.some((p) => !p.onboarding_completed);
  if (!force && !hasIncompleteOnboarding && existingProjects.length > 0) {
    throw redirect("/dashboard");
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
      github_plan: user.github_plan,
    },
    repos,
    installations,
    connectedProjects: existingProjects,
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

  if (intent === "check-site-config") {
    const projectId = Number(formData.get("project_id"));
    const db = getDb(env.DB);

    const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return { ok: true, intent: "check-site-config", sheetsEnabled: false, urlMismatch: null };

    const [owner, repo] = project.github_repo_full_name.split("/");

    const configContent = await getFileContent(token, owner, repo, "_config.yml");
    if (!configContent) return { ok: true, intent: "check-site-config", sheetsEnabled: false, pagesNotEnabled: false, urlMismatch: null };

    const { isGoogleSheetsEnabled } = await import("~/lib/commit.server");
    const sheetsEnabled = isGoogleSheetsEnabled(configContent);
    const urlCheck = await verifySiteUrl(token, owner, repo, configContent);

    return {
      ok: true,
      intent: "check-site-config",
      sheetsEnabled,
      pagesNotEnabled: !urlCheck.pagesEnabled,
      urlMismatch: urlCheck.pagesEnabled && !urlCheck.match ? { pagesUrl: urlCheck.pagesUrl, configUrl: urlCheck.configUrl } : null,
    };
  }

  if (intent === "fix-site-config") {
    const projectId = Number(formData.get("project_id"));
    const fixSheets = formData.get("fixSheets") === "true";
    const fixUrl = formData.get("fixUrl") === "true";
    const enablePages = formData.get("enablePages") === "true";
    let pagesUrl = formData.get("pagesUrl") as string | null;

    const db = getDb(env.DB);

    const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new Response("Project not found", { status: 404 });

    const [owner, repo] = project.github_repo_full_name.split("/");

    // Enable GitHub Pages first if needed (so we have the URL for config fix)
    if (enablePages) {
      try {
        const result = await enableGitHubPages(token, owner, repo);
        pagesUrl = result.pagesUrl;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("403") || msg.includes("not accessible")) {
          return { ok: false, intent: "fix-site-config", error: "pages_permission_denied", installationId: project.installation_id };
        }
        return { ok: false, intent: "fix-site-config", error: "pages_failed", message: msg };
      }
    }

    let configContent = await getFileContent(token, owner, repo, "_config.yml");
    if (!configContent) return { ok: false, intent: "fix-site-config", error: "config_not_found" };

    const commitParts: string[] = [];

    if (fixSheets) {
      configContent = disableGoogleSheetsInConfig(configContent);
      commitParts.push("disable Google Sheets");
    }

    // Fix URL if we have a Pages URL to match against (from enablePages or from check)
    if ((fixUrl || enablePages) && pagesUrl) {
      const parsed = new URL(pagesUrl);
      const newUrl = `${parsed.protocol}//${parsed.host}`;
      const newBaseurl = parsed.pathname.replace(/\/+$/, "");
      configContent = configContent.replace(
        /^(url:\s*)"?[^"\n]*"?\s*$/m,
        `$1"${newUrl}"`
      );
      configContent = configContent.replace(
        /^(baseurl:\s*)"?[^"\n]*"?\s*$/m,
        `$1"${newBaseurl}"`
      );
      commitParts.push(enablePages ? "enable GitHub Pages and set site URL" : "fix site URL");

      await db.update(project_config).set({
        url: newUrl,
        baseurl: newBaseurl,
        updated_at: new Date().toISOString(),
      }).where(eq(project_config.project_id, projectId));
    }

    if (commitParts.length > 0) {
      const result = await commitFilesToRepo(
        token, owner, repo, "main",
        [{ path: "_config.yml", content: configContent }],
        `chore: ${commitParts.join(", ")} — now managed by Telar Compositor`
      );

      await db.update(projects).set({
        head_sha: result.newHeadSha,
        updated_at: new Date().toISOString(),
      }).where(eq(projects.id, projectId));
    }

    if (fixSheets) {
      await db.update(project_config).set({
        google_sheets_enabled: false,
        updated_at: new Date().toISOString(),
      }).where(eq(project_config.project_id, projectId));
    }

    return { ok: true, intent: "fix-site-config" };
  }

  if (intent === "complete-onboarding") {
    const projectId = Number(formData.get("project_id"));
    const db = getDb(env.DB);
    await db
      .update(projects)
      .set({ onboarding_completed: true, updated_at: new Date().toISOString() })
      .where(eq(projects.id, projectId));
    return { ok: true, intent: "complete-onboarding" };
  }

  if (intent === "unlink-project") {
    const projectId = Number(formData.get("project_id"));
    const db = getDb(env.DB);

    // Verify this project belongs to the user
    const project = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();

    if (!project) {
      return { ok: false, intent: "unlink-project", error: "not_found" };
    }

    // Cascade delete: layers → steps → stories, then other project tables, then project
    const storyIds = await db
      .select({ id: stories.id })
      .from(stories)
      .where(eq(stories.project_id, projectId));

    if (storyIds.length > 0) {
      const ids = storyIds.map((s) => s.id);
      const stepIds = await db
        .select({ id: steps.id })
        .from(steps)
        .where(inArray(steps.story_id, ids));

      if (stepIds.length > 0) {
        await db.delete(layers).where(inArray(layers.step_id, stepIds.map((s) => s.id)));
      }
      await db.delete(steps).where(inArray(steps.story_id, ids));
    }

    await db.delete(stories).where(eq(stories.project_id, projectId));
    await db.delete(objects).where(eq(objects.project_id, projectId));
    await db.delete(glossary_terms).where(eq(glossary_terms.project_id, projectId));
    await db.delete(project_config).where(eq(project_config.project_id, projectId));
    await db.delete(project_themes).where(eq(project_themes.project_id, projectId));
    await db.delete(project_landing).where(eq(project_landing.project_id, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));

    return { ok: true, intent: "unlink-project" };
  }

  throw new Response("Bad Request", { status: 400 });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OnboardingPage({ loaderData }: Route.ComponentProps) {
  const { user, repos, connectedProjects } = loaderData;

  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Header user={user} />
      <main className="flex-1 flex items-start justify-center pt-10 pb-16 px-4">
        <div className="w-full max-w-2xl">
          <WizardShell repos={repos} connectedProjects={connectedProjects} user={user} />
        </div>
      </main>
    </div>
  );
}
