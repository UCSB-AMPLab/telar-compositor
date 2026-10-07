/**
 * This file renders the onboarding wizard — a 4-step Connect → Sync →
 * Review → Done flow that a new user runs once to bring their Telar
 * repo into the compositor.
 *
 * Has its own layout (no tab nav). Auth-protected via authMiddleware.
 * Loader fetches GitHub App installations and the user's repos. Action
 * runs the full import pipeline and handles the Sheets URL retry path
 * (where the user's first Sheets URL was inaccessible and they enter a
 * corrected one), and the path that moves a repository whose default branch
 * is not `main` onto `main` before importing it. Each of those three first
 * checks that the installation named in the form reaches the repository.
 *
 * The wizard also creates course projects and joins sites to courses. Both
 * ride the import intent because `importRepo` is the only code that inserts
 * a project row: the kind travels with the import, and a class code entered
 * alongside it is redeemed once the import returns, since the row a join
 * attaches only exists from that moment. A refused or broken join leaves the
 * site standing — the code can be entered again from settings — so it is
 * reported as an outcome on the import result rather than thrown.
 *
 * Only one of those two is gated. Creating a course is running one, so it
 * takes the course password (ruling 20); redeeming a class code is joining
 * one, and a student who has never seen the app cannot be asked for a
 * password on top of their code. The loader reports whether this session has
 * answered it so the form knows what to offer, and the action refuses a
 * course outright when it has not — the loader flag is what the browser is
 * shown, never what the decision rests on.
 *
 * @version v1.5.2-beta
 */

import { redirect } from "react-router";
import { answerReadsWhenUnreachable } from "~/lib/unreachable-write";
import type { Route } from "./+types/onboarding";
import { authMiddleware, userContext } from "~/middleware/auth.server";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { listUserInstallations, listInstallationRepos, getFileContent } from "~/lib/github.server";
import { siteNeedsUpgrade } from "~/lib/upgrade-gate.server";
import type { Repository } from "~/lib/github.server";
import {
  CollidingColumnsRefusal,
  TabsChangedError,
  collidingColumnsImportResult,
  importRepo,
  parseProjectKind,
  refusedImportResult,
} from "~/lib/import.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { importOnMain } from "~/lib/default-branch.server";
import { unreadableFailure } from "~/lib/sync-failure.server";
import type { CourseJoinOutcome, ImportResult, ProjectKind } from "~/lib/import.server";
import { redeemForSite } from "~/lib/join-codes.server";
import { mayUseCourses, requireCourseAccess } from "~/lib/course-gate.server";
import { applyRedemptionSideEffects, detachCourseChildren, evictMembers } from "~/lib/course-membership.server";
import { commitFilesToRepo, disableGoogleSheetsInConfig, SheetsNotDisableableError, verifySiteUrl, enableGitHubPages } from "~/lib/commit.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { handleCreateSiteIntents, importScopeRefusal } from "~/lib/onboarding-create-site.server";
import { configLineRegex } from "~/lib/config-yaml-block.server";
import { getDb } from "~/lib/db.server";
import { repairSiteConfig, type ConfigRepair } from "~/lib/config-repair.server";
import { unlinkProjectCascade } from "~/lib/project-unlink.server";
import {
  projects,
  project_config,
  project_members,
  objects,
  stories,
  steps,
  layers,
} from "~/db/schema";
import { and, eq } from "drizzle-orm";
import { getUserRole } from "~/lib/membership.server";
import { objectsReadFollowingHead } from "~/lib/github-status.server";
import { onboardingRecordJson, pageFilesColumn } from "~/lib/page-files-record.server";
import { Header } from "~/components/layout/Header";
import { WizardShell } from "~/components/features/onboarding/WizardShell";

export const middleware = [authMiddleware];
// `team` carries the code-refusal strings, which the wizard shares with the
// other two redemption surfaces rather than restating.
export const handle = { i18n: ["onboarding", "common", "account", "team", "course"] };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoWithInstallation extends Repository {
  installationId: number;
  // Set on the synthetic repo handed off by the create flow. `createdThisRun`
  // marks the import as origin="created"; `bornClean` (born-clean fully
  // succeeded this run) gates skipping the post-import config check. Absent for
  // the import flow.
  createdThisRun?: boolean;
  bornClean?: boolean;
  // The create form's two project-level answers, carried here rather than
  // through the `create-site` intent: neither concerns provisioning the repo,
  // and both are spent by the import that inserts the project row. Absent on
  // the connect-an-existing-repo path, where the kind is a site by default.
  kind?: ProjectKind;
  courseCode?: string;
}


// ---------------------------------------------------------------------------
// Form-supplied project id — standing check
// ---------------------------------------------------------------------------

/**
 * True when `userId` convenes the project named by a form-supplied
 * `projectId`.
 *
 * Every wizard intent that carries a `project_id` acts on a project the caller
 * has themselves just brought in: `importRepo` writes the importing user's
 * `project_members` row with role `convenor` in the same step that inserts the
 * project row, no other path creates a project, and nothing transfers the
 * role. So the convenor is the only standing a caller legitimately mid-flow
 * ever has on the project the wizard is acting on, and a collaborator, an
 * instructor and a non-member are all outside the flow.
 *
 * The id arrives from the form, so a missing, non-numeric or non-positive
 * value is refused before any query — the same `Number.isFinite` shape
 * `unlink-project` and `_app.account.tsx` apply. Callers turn `false` into the
 * payload their intent already returns for a project that does not exist, so
 * no refusal reports whether an id is real.
 */
async function callerConvenes(
  db: ReturnType<typeof getDb>,
  projectId: number,
  userId: number,
): Promise<boolean> {
  if (!Number.isFinite(projectId) || projectId <= 0) return false;
  return (await getUserRole(db, projectId, userId)) === "convenor";
}

// ---------------------------------------------------------------------------
// Creation-time course join
// ---------------------------------------------------------------------------

/**
 * The course's own name, for the message that confirms the join. Falls back
 * to the repo it lives in, which is the only other name a course is sure to
 * have: `project_config.title` is written at import from the repo's
 * `_config.yml` and an empty title there is legal.
 */
async function courseDisplayName(
  db: ReturnType<typeof getDb>,
  courseProjectId: number,
): Promise<string> {
  const config = await db
    .select({ title: project_config.title })
    .from(project_config)
    .where(eq(project_config.project_id, courseProjectId))
    .limit(1);
  const title = (config[0]?.title ?? "").trim();
  if (title) return title;

  const project = await db
    .select({ repo: projects.github_repo_full_name })
    .from(projects)
    .where(eq(projects.id, courseProjectId))
    .limit(1);
  return project[0]?.repo ?? "";
}

/**
 * Redeem a class code against the site the wizard has just created.
 *
 * `redeemForSite` owns the writes and the refusals; this only names the
 * course on success and turns a throw into an outcome. The throw is
 * `redeemForSite`'s programmer-error signal for a caller with no convenor
 * row on the child — unreachable here, because the import inserted that row
 * moments ago — but the site exists either way, and losing a created site to
 * a stack trace is a worse answer than telling the user the code did not
 * take.
 */
async function joinCourseAtCreation(
  db: ReturnType<typeof getDb>,
  env: Env,
  args: { token: string; childProjectId: number; userId: number },
): Promise<CourseJoinOutcome> {
  try {
    const outcome = await redeemForSite(db, args);
    if (outcome.state !== "ok") return outcome;

    // Only once the import has finished writing D1: the side effects ingest
    // into the child's document, and a cold Durable Object builds that
    // document from whatever D1 holds at that instant.
    const effects = await applyRedemptionSideEffects(db, env, {
      courseProjectId: outcome.courseProjectId,
      childProjectId: args.childProjectId,
    });

    // The site left, or another course took it, while the sequence ran. The
    // collection is that other course's to give, and the site never joined —
    // reporting `ok` here would tell the student a departed site is theirs.
    if (!effects.enrolled) {
      return {
        state: "not_enrolled",
        courseProjectId: outcome.courseProjectId,
        courseName: await courseDisplayName(db, outcome.courseProjectId),
      };
    }

    return {
      state: "ok",
      courseProjectId: outcome.courseProjectId,
      courseName: await courseDisplayName(db, outcome.courseProjectId),
      alreadyAttached: outcome.alreadyAttached,
      preloaded: effects.preload.inserted,
      skippedConflict: effects.preload.skippedConflict.length,
      skippedRepoBound: effects.preload.skippedRepoBound.length,
    };
  } catch (err) {
    // A throw here can mean the attachment never happened or that it did and
    // the collection transfer did not. Both are reported the same way and both
    // take the same repair — re-entering the code re-runs the sequence, and
    // every step of it is a no-op where it already ran.
    console.error("joinCourseAtCreation failed:", err);
    return { state: "failed" };
  }
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

  // Someone whose sites are all set up is sent to Start, the dashboard,
  // unless ?force=1 asks for the wizard to add another site.
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  const db = getDb(env.DB);
  const existingProjects = await db
    .select({ id: projects.id, github_repo_full_name: projects.github_repo_full_name, onboarding_completed: projects.onboarding_completed })
    .from(projects)
    .where(eq(projects.user_id, user.id));

  const hasIncompleteOnboarding = existingProjects.some((p) => !p.onboarding_completed);
  if (!force && !hasIncompleteOnboarding && existingProjects.length > 0) {
    throw redirect("/start");
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
    },
    repos,
    installations,
    connectedProjects: existingProjects,
    orphanRepoNames,
    githubAppSlug: env.GITHUB_APP_SLUG,
    courseGateOpen: mayUseCourses(user),
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Which refusal an author is shown when GitHub declines to switch Pages on.
 *
 * A private repository outranks whatever status GitHub refused with: Pages does
 * not serve one on a free plan, and the REST reference documents only 201, 409
 * and 422 for that endpoint, so the 403 the permission branch reads is itself a
 * guess. On a private repository that guess sends the author to the App's
 * installation settings for a problem that has nothing to do with permissions.
 *
 * The visibility question is asked here and nowhere else on this route, because
 * this is the only path on which the answer changes what anyone is told. A null
 * answer means the probe could not resolve it and no cause is claimed.
 */
async function pagesFailureRefusal(
  message: string,
  token: string,
  owner: string,
  repo: string,
  installationId: number,
) {
  const { isRepoPrivate } = await import("~/lib/commit.server");
  if ((await isRepoPrivate(token, owner, repo)) === true) {
    return { ok: false as const, intent: "fix-site-config", error: "pages_private_repo", message };
  }
  if (message === "pages_permission_denied") {
    return { ok: false as const, intent: "fix-site-config", error: "pages_permission_denied", installationId };
  }
  return { ok: false as const, intent: "fix-site-config", error: "pages_failed", message };
}

/**
 * Runs the first import, turning a refused sheet, or a file it could not read,
 * into a result the sync step shows. A sheet with two columns for one field
 * that both hold values stops the import here, before the Compositor manages
 * the site, and the sync step offers the column picker; the choices posted
 * with the next import are settled before it runs (`settleImportChoices`).
 * Where the picker cannot see the group, the refusal names the columns to
 * remove in the sheet itself. A file GitHub did not
 * answer for is named by what it is, as a sync names one, so the author can
 * try again. Any other failure propagates.
 */
async function importOrRefusal(params: Parameters<typeof importRepo>[0], formData: FormData): Promise<ImportResult> {
  const site = { token: params.token, repoFullName: params.repoFullName, userId: params.userId, secret: params.env.SESSION_SECRET };
  // Loaded when used: the repair it runs reads import.server.ts's tables as it loads.
  const { importChoicesResult, settleImportChoices } = await import("~/lib/sheet-choices.server");
  const settled = await settleImportChoices(formData, site);
  if (!settled.proceed) return settled.result;
  try {
    return await importRepo({ ...params, readTab: settled.readTab, checkTabs: settled.checkTabs });
  } catch (err) {
    if (err instanceof CollidingColumnsRefusal) return (await importChoicesResult(err, site)) ?? collidingColumnsImportResult(err);
    // A tab changed after the author chose: asked again, or, with nothing left to choose, imported as it now is.
    if (err instanceof TabsChangedError) return (await importChoicesResult(err, site)) ?? importOrRefusal(params, new FormData());
    if (err instanceof SheetUnreadableError) return unreadableFileImportResult(err.path);
    throw err;
  }
}

/** The import's answer for a file it could not read, carrying the file's name. */
function unreadableFileImportResult(path: string): ImportResult {
  const failure = unreadableFailure(path);
  if (failure.error === "sheet_unreadable") {
    return refusedImportResult({ validationError: failure.error, unreadableSheet: failure.sheet });
  }
  if (failure.error === "file_unreadable") {
    return refusedImportResult({ validationError: failure.error, unreadableFile: failure.file });
  }
  return refusedImportResult({ validationError: failure.error });
}

/**
 * A `check-site-config` that fails in transit (a Pages request that rejects, a
 * bare 5xx) is answered unreachable, so the wizard says the check could not be
 * made and asks again. Every other intent reaches the server action unchanged.
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  return answerReadsWhenUnreachable(request, serverAction, ["check-site-config"]);
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const env = context.cloudflare.env as Env;
  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // `fix_default_branch` is the import after moving the repository's default
  // branch to `main`, which the author asks for from the refusal the import
  // gave; what to change is decided from GitHub, never from the form.
  if (intent === "import" || intent === "import_with_url" || intent === "fix_default_branch") {
    const installationId = Number(formData.get("installation_id"));
    const repoFullName = formData.get("repo_full_name") as string;
    // Both come from the create-site form and are absent on the plain
    // connect-a-repo path. The kind is narrowed rather than trusted; the code
    // is trimmed because a code copied off a slide or an LMS arrives with
    // whitespace around it far more often than not.
    const kind = parseProjectKind(formData.get("kind"));
    // Refused before the import runs, so a forged submission cannot leave a
    // course row behind. The class code below is read either way: joining a
    // course is never gated.
    if (kind === "course") requireCourseAccess(user);
    const courseCode = ((formData.get("course_code") as string) ?? "").trim();
    // The retry path re-reads config from GitHub, so the corrected URL is
    // passed as an override rather than patched into D1 first.
    const sheetsUrl =
      intent === "import_with_url" ? (formData.get("sheets_url") as string) : null;
    const origin = formData.get("origin") === "created" ? "created" : "imported";

    // The installation and repository both come from the form, so whether the
    // one reaches the other is asked here before anything reads or changes the
    // repository; the client's pre-check is no guarantee.
    const scopeRefusal = await importScopeRefusal(env, intent, installationId, repoFullName);
    if (scopeRefusal) return scopeRefusal;

    const runImport = () =>
      importOrRefusal({
        token,
        installationId,
        repoFullName,
        userId: user.id,
        env,
        kind,
        ...(sheetsUrl !== null
          ? { overrideGoogleSheetsUrl: sheetsUrl || undefined }
          : { origin }),
      }, formData);
    const [owner, repo] = repoFullName.split("/");
    const result =
      intent === "fix_default_branch" ? await importOnMain(token, owner, repo, runImport) : await runImport();

    // After the import, never before: the project row a join attaches only
    // exists from the moment the import writes it. An import that produced no
    // row has nothing to attach, and the code stays unspent.
    let courseJoin: CourseJoinOutcome | undefined;
    if (courseCode && result.valid && result.projectId) {
      courseJoin = await joinCourseAtCreation(getDb(env.DB), env, {
        token: courseCode,
        childProjectId: result.projectId,
        userId: user.id,
      });
    }

    // No upgrade redirect here, whatever the site's version. This runs before
    // `complete-onboarding` makes the new site the active project, so an
    // upgrade opened now would resolve the previous one, and leaving the
    // wizard here would discard the course-join outcome on its way to the
    // screen. The version is read at completion instead (below).
    return courseJoin ? { ...result, courseJoin } : result;
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

    // title / lang / theme / url / baseurl are the published site's identity
    // and address, so this write takes the convenor standing every
    // project_id-bearing intent takes.
    if (!(await callerConvenes(db, projectId, user.id))) {
      return { saved: false, error: "not_found" };
    }

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

    // The refusal is the payload an unknown project already produces, so a
    // caller with no standing learns neither the repo's name nor whether the
    // id is real.
    if (!(await callerConvenes(db, projectId, user.id))) {
      return { ok: true, intent: "check-site-config", sheetsEnabled: false, urlMismatch: null };
    }

    const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return { ok: true, intent: "check-site-config", sheetsEnabled: false, urlMismatch: null };

    const [owner, repo] = project.github_repo_full_name.split("/");

    const configContent = await getFileContent(token, owner, repo, "_config.yml");
    if (!configContent) return { ok: true, intent: "check-site-config", sheetsEnabled: false, pagesNotEnabled: false, urlMismatch: null };

    const { isGoogleSheetsEnabled } = await import("~/lib/commit.server");
    const sheetsEnabled = isGoogleSheetsEnabled(configContent);
    // Retry on a transient settling 404 only for born-clean created sites,
    // whose just-enabled Pages deployment may not have registered yet and
    // would otherwise be misread as "Pages not enabled." For imported sites
    // a disabled Pages is a real state, not a settling race, so read once and
    // report immediately instead of paying ~3s of pointless retries.
    const urlCheck = await verifySiteUrl(token, owner, repo, configContent, {
      attempts: project.origin === "created" ? 3 : 1,
      intervalMs: 1500,
    });

    // A Pages read that failed says nothing about whether Pages is on.
    if (urlCheck.readFailed) return { ok: false as const, reason: "unreachable" as const, intent: "check-site-config" as const };

    return {
      ok: true,
      intent: "check-site-config",
      sheetsEnabled,
      // A refused read (401 or 403) says nothing about whether Pages is on,
      // and enabling it would be refused the same way, so the Pages step is
      // not offered.
      pagesNotEnabled: !urlCheck.pagesEnabled && !urlCheck.readRefused,
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

    // This intent commits to the repo and rewrites url / baseurl in D1, so it
    // takes the convenor standing. The refusal is indistinguishable from the
    // one an id with no project behind it gets.
    if (!(await callerConvenes(db, projectId, user.id))) {
      return { ok: false, intent: "fix-site-config", error: "not_found" };
    }

    const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new Response("Project not found", { status: 404 });

    const [owner, repo] = project.github_repo_full_name.split("/");

    // The config is read, and Sheets is dry-run off, before Pages is touched:
    // a refusal then leaves Pages as it was.
    let configContent = await getFileContent(token, owner, repo, "_config.yml");
    if (!configContent) return { ok: false, intent: "fix-site-config", error: "config_not_found" };
    let sheetsOff = configContent;
    if (fixSheets) {
      try {
        sheetsOff = disableGoogleSheetsInConfig(configContent);
      } catch (err) {
        // Nothing is changed: carrying on would report Sheets as off.
        if (err instanceof SheetsNotDisableableError) return { ok: false, intent: "fix-site-config", error: "sheets_not_disableable" };
        throw err;
      }
    }

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
        return await pagesFailureRefusal(msg, token, owner, repo, project.installation_id);
      }
    }

    const commitParts: string[] = [];
    // What the commit fixes, repaired in the document once the commit lands.
    const repair: ConfigRepair = {};

    if (fixSheets) {
      configContent = sheetsOff;
      commitParts.push("disable Google Sheets");
      repair.google_sheets_enabled = false;
    }

    // Fix URL if we have a Pages URL to match against (from enablePages or from check)
    if ((fixUrl || enablePages) && pagesUrl) {
      const parsed = new URL(pagesUrl);
      const newUrl = `${parsed.protocol}//${parsed.host}`;
      const newBaseurl = parsed.pathname.replace(/\/+$/, "");
      // Rewrite url/baseurl through the shared line matcher so any inline
      // `# comment` on those lines survives the fix (re-emitted via $2).
      configContent = configContent.replace(
        configLineRegex("url"),
        `$1"${newUrl}"$2`
      );
      configContent = configContent.replace(
        configLineRegex("baseurl"),
        `$1"${newBaseurl}"$2`
      );
      commitParts.push(enablePages ? "enable GitHub Pages and set site URL" : "fix site URL");
      repair.url = newUrl;
      repair.baseurl = newBaseurl;
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
      // The record of the page files, derived from the folder at the new head
      // and D1 (R4); left as it is when the folder cannot be read.
      const pageFilesJson = await onboardingRecordJson(env.DB, projectId, {
        access: { token, owner, repo },
        commit: result.newHeadSha,
        previousJson: project.page_files_json,
        snapshotJson: project.publish_snapshot,
      });
      // objects_read_sha follows only where it was the head this commit
      // replaces, as every head writer has it.
      await db.update(projects).set({
        head_sha: result.newHeadSha,
        objects_read_sha: objectsReadFollowingHead(result.newHeadSha),
        ...pageFilesColumn(pageFilesJson),
        ...(persistedPagesUrl ? { github_pages_url: persistedPagesUrl } : {}),
        updated_at: new Date().toISOString(),
        gh_checked_at: null,
      }).where(eq(projects.id, projectId));
    }

    // After the commit, and through the collaboration document: the snapshot
    // writes these columns, so a D1 write alone would be overwritten by a warm
    // document, and nothing is rebuilt, so no editor's changes are lost.
    // Best-effort, and it writes D1 itself when the document does not confirm.
    if (Object.keys(repair).length > 0) await repairSiteConfig(db, env as never, projectId, repair);

    return { ok: true, intent: "fix-site-config" };
  }

  if (intent === "complete-onboarding") {
    const projectId = Number(formData.get("project_id"));
    const db = getDb(env.DB);

    // Marking a project onboarded also promotes it into the caller's session
    // as the active project, so the standing is the convenor's alone.
    if (!(await callerConvenes(db, projectId, user.id))) {
      return { ok: false, intent: "complete-onboarding", error: "not_found" };
    }

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

    // A site behind the latest release goes straight to its upgrade, in the
    // same response that makes it the active project — so /upgrade resolves
    // the site just set up, and nothing on the wizard's last screen can be
    // followed first on the old session. Read from the recorded config, not
    // the import's response, so a wizard resumed after a reload is covered.
    if (await siteNeedsUpgrade(db, env, { projectId, userToken: token })) {
      return redirect("/upgrade?from=/start", { headers: { "Set-Cookie": cookie } });
    }

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

    // Unlink cascade-deletes the project and every dependent row, so it takes
    // the same convenor predicate as the other destructive project actions
    // (`delete-project` in _app.account.tsx, via requireOwner). Reported as
    // "not_found" rather than the account route's "invalid_project_id" so
    // every refusal on this intent — garbage id, foreign project, absent
    // project — is one indistinguishable payload.
    if (!(await callerConvenes(db, projectId, user.id))) {
      return { ok: false, intent: "unlink-project", error: "not_found" };
    }

    // A course made in the wizard leaves any site already enrolled in it
    // first, as every project delete does.
    try {
      await detachCourseChildren(db, env, projectId);
    } catch (err) {
      console.error(`[unlink-project] project ${projectId}: its sites could not be detached`, err);
      return { ok: false, intent: "unlink-project", error: "unlink_failed" };
    }

    // Cascade delete: layers → steps → stories, then other project tables, then project
    await evictMembers(env, await unlinkProjectCascade(db, projectId));

    return { ok: true, intent: "unlink-project" };
  }

  throw new Response("Bad Request", { status: 400 });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OnboardingPage({ loaderData }: Route.ComponentProps) {
  const { user, repos, installations, connectedProjects, orphanRepoNames, githubAppSlug, courseGateOpen } = loaderData;

  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Header user={user} hasProject={false} />
      <main className="flex-1 flex items-start justify-center pt-10 pb-16 px-4">
        <div className="w-full max-w-2xl">
          <WizardShell repos={repos} installations={installations} connectedProjects={connectedProjects} orphanRepoNames={orphanRepoNames} user={user} hasInstallations={installations.length > 0} githubAppSlug={githubAppSlug} courseGateOpen={courseGateOpen} />
        </div>
      </main>
    </div>
  );
}
