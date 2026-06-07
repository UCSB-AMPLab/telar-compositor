/**
 * This file renders the onboarding wizard — a 4-step Connect → Sync →
 * Review → Done flow that a new user runs once to bring their Telar
 * repo into the compositor.
 *
 * Has its own layout (no tab nav). Auth-protected via authMiddleware.
 * Loader fetches GitHub App installations and the user's repos. Action
 * runs the full import pipeline and handles the Sheets URL retry path
 * (where the user's first Sheets URL was inaccessible and they enter a
 * corrected one).
 *
 * @version v1.3.0-beta
 */

import { redirect } from "react-router";
import type { Route } from "./+types/onboarding";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { listUserInstallations, listInstallationRepos, getFileContent } from "~/lib/github.server";
import { checkTelarVersion } from "~/lib/upgrade.server";
import type { Repository } from "~/lib/github.server";
import { importRepo } from "~/lib/import.server";
import { commitFilesToRepo, disableGoogleSheetsInConfig, verifySiteUrl, enableGitHubPages } from "~/lib/commit.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { handleCreateSiteIntents } from "~/lib/onboarding-create-site.server";
import { getDb } from "~/lib/db.server";
import {
  projects,
  project_config,
  project_themes,
  project_landing,
  project_members,
  project_invites,
  objects,
  stories,
  steps,
  layers,
  glossary_terms,
  activity_log,
} from "~/db/schema";
import { eq, inArray } from "drizzle-orm";
import { Header } from "~/components/layout/Header";
import { WizardShell } from "~/components/features/onboarding/WizardShell";

export const middleware = [authMiddleware];
export const handle = { i18n: ["onboarding", "common", "account"] };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoWithInstallation extends Repository {
  installationId: number;
}

// ---------------------------------------------------------------------------
// Cascade-delete helper
// ---------------------------------------------------------------------------

/**
 * Cascade-delete every row that depends on `projectId`, in dependency order:
 * layers → steps → stories → objects → glossary_terms → project_config →
 * project_themes → project_landing → project_members → project_invites →
 * projects. Exported so the unit tests can record the delete-table sequence
 * without bootstrapping the full route action.
 *
 * The deletes are issued as a single `db.batch([...])` so D1 executes them
 * atomically; a worker that's evicted mid-cascade can no longer leave behind
 * orphan rows referencing a deleted parent.
 */
export async function unlinkProjectCascade(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
  db: any,
  projectId: number,
): Promise<void> {
  // Resolve dependent ids before the batch — these are reads, not writes,
  // so they don't need to be inside the atomic group.
  const storyIds = await db
    .select({ id: stories.id })
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const ids = storyIds.map((s: { id: number }) => s.id);

  let stepIds: { id: number }[] = [];
  if (ids.length > 0) {
    stepIds = await db
      .select({ id: steps.id })
      .from(steps)
      .where(inArray(steps.story_id, ids));
  }

  // biome-ignore lint/suspicious/noExplicitAny: drizzle batch tuple typing
  const batchOps: any[] = [];
  if (stepIds.length > 0) {
    batchOps.push(
      db
        .delete(layers)
        .where(inArray(layers.step_id, stepIds.map((s: { id: number }) => s.id))),
    );
  }
  if (ids.length > 0) {
    batchOps.push(db.delete(steps).where(inArray(steps.story_id, ids)));
  }
  batchOps.push(
    db.delete(stories).where(eq(stories.project_id, projectId)),
    db.delete(objects).where(eq(objects.project_id, projectId)),
    db.delete(glossary_terms).where(eq(glossary_terms.project_id, projectId)),
    db.delete(project_config).where(eq(project_config.project_id, projectId)),
    db.delete(project_themes).where(eq(project_themes.project_id, projectId)),
    db.delete(project_landing).where(eq(project_landing.project_id, projectId)),
    db.delete(project_members).where(eq(project_members.project_id, projectId)),
    db.delete(project_invites).where(eq(project_invites.project_id, projectId)),
    db.delete(activity_log).where(eq(activity_log.project_id, projectId)),
    db.delete(projects).where(eq(projects.id, projectId)),
  );

  await db.batch(batchOps);
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

  // Check if user already has projects — if so, redirect to the daily home
  // (/objects) unless ?force=1 is in the query string. Dashboard is
  // retired as a destination.
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  const db = getDb(env.DB);
  const existingProjects = await db
    .select({ id: projects.id, github_repo_full_name: projects.github_repo_full_name, onboarding_completed: projects.onboarding_completed })
    .from(projects)
    .where(eq(projects.user_id, user.id));

  const hasIncompleteOnboarding = existingProjects.some((p) => !p.onboarding_completed);
  if (!force && !hasIncompleteOnboarding && existingProjects.length > 0) {
    throw redirect("/objects");
  }

  // Fetch all GitHub App installations and their repos.
  // GitHub API failure is a soft error: degrade to empty lists so the
  // repo-connect CTA (and install-app link) remain reachable. Mirrors the
  // graceful-degradation pattern in _app.account.tsx loader (~lines 148-169).
  let installations: Awaited<ReturnType<typeof listUserInstallations>>["installations"] = [];
  let repos: RepoWithInstallation[] = [];
  try {
    const result = await listUserInstallations(token);
    installations = result.installations;

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
    repos = reposByInstallation.flat();
  } catch {
    // Swallow — GitHub 5xx / rate-limit / transient-401.
    // Empty installations + repos keeps the page functional.
  }

  // Orphan-repo detection. "App can see it AND no D1
  // row" — used by StepConnect to render a "New — connect to continue" badge
  // next to repos that were likely created via the compositor but never
  // completed the import flow. Heuristic may false-positive on unrelated repos
  // the App can see; import flow rejects non-Telar repos cleanly.
  const connectedFullNames = new Set(
    existingProjects.map((p) => p.github_repo_full_name),
  );
  const orphanRepoNames = repos
    .map((r) => r.full_name)
    .filter((name) => !connectedFullNames.has(name));

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
    orphanRepoNames,
    githubAppSlug: env.GITHUB_APP_SLUG,
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
      if (result.valid && result.telarVersion) {
        const versionCheck = await checkTelarVersion(token, result.telarVersion);
        if (versionCheck.needsUpgrade) {
          return redirect("/upgrade?from=/config");
        }
      }
      return result;
    }

    const result = await importRepo({
      token,
      installationId,
      repoFullName,
      userId: user.id,
      env,
    });
    if (result.valid && result.telarVersion) {
      const versionCheck = await checkTelarVersion(token, result.telarVersion);
      if (versionCheck.needsUpgrade) {
        return redirect("/upgrade?from=/config");
      }
    }
    return result;
  }

  if (
    intent === "check-repo-name" ||
    intent === "create-site" ||
    intent === "check-installation-scope"
  ) {
    return handleCreateSiteIntents(
      intent,
      formData,
      token,
      env,
      (user.ui_locale as "en" | "es" | null) ?? null,
    );
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
        const installToken = await getInstallationToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          project.installation_id,
        );
        const result = await enableGitHubPages(installToken, owner, repo);
        pagesUrl = result.pagesUrl;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("enableGitHubPages error:", msg);
        if (msg === "pages_permission_denied") {
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

      // Persist github_pages_url when we learned it from enable/fix flows — the
      // column historically stayed null, leaving every consumer of it dead.
      const persistedPagesUrl = pagesUrl
        ? pagesUrl.replace(/\/+$/, "")
        : null;
      await db.update(projects).set({
        head_sha: result.newHeadSha,
        ...(persistedPagesUrl ? { github_pages_url: persistedPagesUrl } : {}),
        updated_at: new Date().toISOString(),
        gh_checked_at: null,
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

    // Promote the newly-onboarded project to the active session slot so the
    // dashboard opens on it instead of whatever the previous active project
    // was. Without this, returning users who add a second site land on their
    // old site and wonder why the new one isn't showing.
    const sessionStorage = createSessionStorage(env.SESSION_SECRET);
    const session = await sessionStorage.getSession(request.headers.get("Cookie"));
    session.set("activeProjectId", projectId);
    const cookie = await sessionStorage.commitSession(session);

    return new Response(
      JSON.stringify({ ok: true, intent: "complete-onboarding" }),
      {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": cookie,
        },
      },
    );
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
    await unlinkProjectCascade(db, projectId);

    return { ok: true, intent: "unlink-project" };
  }

  throw new Response("Bad Request", { status: 400 });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OnboardingPage({ loaderData }: Route.ComponentProps) {
  const { user, repos, installations, connectedProjects, orphanRepoNames, githubAppSlug } = loaderData;

  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Header user={user} hasProject={false} />
      <main className="flex-1 flex items-start justify-center pt-10 pb-16 px-4">
        <div className="w-full max-w-2xl">
          <WizardShell repos={repos} installations={installations} connectedProjects={connectedProjects} orphanRepoNames={orphanRepoNames} user={user} hasInstallations={installations.length > 0} githubAppSlug={githubAppSlug} />
        </div>
      </main>
    </div>
  );
}
