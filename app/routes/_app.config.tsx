/**
 * This file is the Config route — the site-configuration editor with
 * explicit Save (in contrast to the autosave model used elsewhere in
 * the compositor, because config changes are higher-stakes and the
 * user expects a deliberate gesture before pushing).
 *
 * Fields update the Yjs config map on change (preventing the
 * Durable Object snapshot from overwriting them). The Save button
 * writes directly to D1 for immediate persistence. Dirty state is
 * tracked — navigating away with unsaved changes shows a
 * confirmation modal.
 *
 * The page also carries the course surface (design §5): the second of the two
 * places a class code can be entered, and the only place a site leaves a
 * course. It sits outside the configuration form and outside its dirty-state
 * tracking, because a join is not a field the Save button writes — it is a
 * cross-project act settled the moment it is submitted. Both halves are the
 * child convenor's alone: a collaborator must not attach the group's site to a
 * course or pull it out of one.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { and, eq } from "drizzle-orm";
import { Form, Link, useBlocker, useNavigation, useOutletContext } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle, Check, CheckCircle, Loader2, RefreshCw } from "lucide-react";
import * as Y from "yjs";
import type { Route } from "./+types/_app.config";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { project_config, project_members, project_themes, projects } from "~/db/schema";
import { resolveActiveProjectFromRequest, resolvePageProject, siteChangedAnswer } from "~/lib/active-project.server";
import { reconcileSheetsFlagFromRepo } from "~/lib/sheets-reconcile.server";
import { decrypt } from "~/lib/crypto.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { getRepoTree, getFileOnDefaultBranch } from "~/lib/github.server";
import { parseYaml } from "~/lib/yaml.server";
import { canWriteConfigField } from "~/lib/config-fields";
import { redeemForSite } from "~/lib/join-codes.server";
import {
  applyRedemptionSideEffects,
  courseDisplayName,
  detachChildFromCourse,
} from "~/lib/course-membership.server";
import type { CourseJoinOutcome } from "~/lib/import.server";
import {
  courseSettingsMessage,
  type CourseSettingsOutcome,
} from "~/components/features/onboarding/CourseJoinNotice";
import { ConfigSection } from "~/components/features/config/ConfigSection";
import { ConvenorOnlyNote } from "~/components/features/config/ConvenorOnlyNote";
import { FieldWithHelp } from "~/components/features/config/FieldWithHelp";
import { ToggleField } from "~/components/features/config/ToggleField";
import { ThemeSwatches } from "~/components/features/config/ThemeSwatches";
// NavigationEditor removed — navigation is managed from the Pages tab
import { Button } from "~/components/ui/Button";
import { DocsLink } from "~/components/ui/DocsLink";
import { InlineHtmlEditor } from "~/components/ui/InlineHtmlEditor";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { detectThemeAlert } from "~/lib/theme-recognition";
import { getYText } from "~/lib/yjs-helpers";
import { SiteField, useSiteFetcher } from "~/lib/page-site";
import { answerReadsWhenUnreachable } from "~/lib/unreachable-write";
import { SiteChangedDialog, isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";

// `onboarding` and `team` carry the redemption outcomes. They are named here
// because this surface reports the same states the creation-time join does,
// and reporting them from the same strings is what keeps a student who joined
// at creation and one who joined from settings reading the same sentence.
export const handle = {
  i18n: ["common", "config", "onboarding", "team"],
  hideAutosaveIndicator: true,
};

// ---------------------------------------------------------------------------
// The course surface
// ---------------------------------------------------------------------------

/**
 * Redeem a class code against the site this page is configuring.
 *
 * `redeemForSite` owns the token and the attachment and
 * `applyRedemptionSideEffects` owns everything that follows from it; this only
 * names the course and turns a throw into an outcome. Both are re-runnable, so
 * a code that failed at creation reaches the same end state when it is entered
 * here — which is what the wizard's failure message promises.
 *
 * The convenor requirement is verified twice, and the second time is the one
 * that counts: `redeemForSite` re-reads the caller's row at the write, so a
 * standing lost between this route's read and that statement refuses the
 * redemption rather than completing it. Its refusal is a throw — a programmer
 * error for a caller that skipped its gate — and is reported here as `error`
 * rather than allowed to lose the page.
 */
async function joinCourseFromSettings(
  db: ReturnType<typeof getDb>,
  env: Env,
  args: { token: string; childProjectId: number; userId: number },
): Promise<CourseSettingsOutcome> {
  try {
    const outcome = await redeemForSite(db, args);
    if (outcome.state !== "ok") return outcome;

    const effects = await applyRedemptionSideEffects(db, env, {
      courseProjectId: outcome.courseProjectId,
      childProjectId: args.childProjectId,
    });

    // The site left, or another course took it, while the sequence ran. The
    // collection is that other course's to give, so nothing here succeeded.
    if (!effects.enrolled) return { state: "not_enrolled" };

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
    // A throw can mean the attachment never happened or that it did and the
    // collection transfer did not. Both take the same repair — entering the
    // code again re-runs the sequence, and every step is a no-op where it
    // already ran.
    console.error("joinCourseFromSettings failed:", err);
    return { state: "error", intent: "join" };
  }
}

/**
 * Take this site out of its course.
 *
 * `detachChildFromCourse` is the whole sequence; this establishes who may ask
 * for it and which course it is.
 *
 * The standing and the enrolment are read in one statement immediately before
 * the call, not carried down from the loader's resolution at the top of the
 * action: the two are separated by awaits, and a leave that acted on a stale
 * pair would clear one course's markers on a site another course now holds.
 * The parent half of that race is closed properly — `detachChildFromCourse`
 * re-reads the parent and refuses a child claimed by anyone else — so this
 * read narrows the role half to a single statement, which is as close as the
 * sequence's own signature allows.
 */
async function leaveCourseFromSettings(
  db: ReturnType<typeof getDb>,
  env: Env,
  args: { childProjectId: number; userId: number },
): Promise<CourseSettingsOutcome> {
  const rows = await db
    .select({ parent: projects.parent_project_id, role: project_members.role })
    .from(projects)
    .innerJoin(
      project_members,
      and(
        eq(project_members.project_id, projects.id),
        eq(project_members.user_id, args.userId),
      ),
    )
    .where(eq(projects.id, args.childProjectId))
    .limit(1);
  const current = rows[0];

  if (!current || current.role !== "convenor") return { state: "forbidden" };
  // Already out. Reporting the departure is truthful and idempotent — the
  // section renders the same either way.
  if (current.parent === null) return { state: "left" };

  try {
    await detachChildFromCourse(db, env, {
      courseProjectId: current.parent,
      childProjectId: args.childProjectId,
    });
    return { state: "left" };
  } catch (err) {
    // The marker clear failed, which leaves the site enrolled and the whole
    // sequence safe to run again.
    console.error("leaveCourseFromSettings failed:", err);
    return { state: "error", intent: "leave" };
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    return {
      hasProject: false as const,
      config: null,
      themes: [],
      userRole: null,
      course: null,
    };
  }
  const { project, userRole } = resolved;
  const [configRows, themes] = await Promise.all([
    db
      .select()
      .from(project_config)
      .where(eq(project_config.project_id, project.id))
      .limit(1),
    db
      .select({
        theme_id: project_themes.theme_id,
        name: project_themes.name,
        swatch_color: project_themes.swatch_color,
      })
      .from(project_themes)
      .where(eq(project_themes.project_id, project.id)),
  ]);

  let config = configRows[0] ?? null;

  // The D1 flag is a cached copy of the repo's google_sheets.enabled and can
  // strand at true (a warm collab Y.Doc clobbers the disable-path's direct D1
  // write on its next snapshot; once the repo reads false, no push re-fires
  // the repair). Reconcile against the repo before rendering the warning —
  // costs nothing in the common already-disabled case, and fails open to the
  // D1 value whenever the repo is unreadable.
  if (config?.google_sheets_enabled) {
    try {
      // resolveProjectToken hands the installation token only to a
      // publishing role: a private repo a collaborator is not a GitHub
      // collaborator on would otherwise never reconcile for them, leaving
      // the stale flag (and its warning) stuck. This loader carries no role
      // gate of its own, so an instructor or non-member reads no more than
      // their own GitHub account already can.
      const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = project.github_repo_full_name.split("/");
      const token = await resolveProjectToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        project.installation_id,
        userToken,
        userRole,
      );
      const enabled = await reconcileSheetsFlagFromRepo(db, env as never, {
        token,
        owner,
        repo,
        projectId: project.id,
        d1Enabled: true,
      });
      if (!enabled) config = { ...config, google_sheets_enabled: false };
    } catch {
      // decrypt/token/reconcile failure — render the D1 value unchanged
    }
  }

  // Absent on a course project: a course cannot join a course (§5), and a form
  // whose only outcome is `not_a_site` is a trap rather than an offer. The
  // course's id is deliberately not shipped — the leave action reads the
  // parent link itself, so there is no id for a client to substitute.
  const course =
    project.kind === "site"
      ? {
          courseName:
            project.parent_project_id === null
              ? null
              : await courseDisplayName(db, project.parent_project_id),
        }
      : null;

  return { hasProject: true as const, config, themes, userRole, course };
}

/**
 * The rows the repository's `_data/themes/*.yml` files give the project, or
 * null when the listing is truncated or any theme file could not be read. A file that is gone by the time
 * it is read, or holds no YAML mapping, is not a theme and is left out.
 */
async function readThemeRows(
  token: string,
  owner: string,
  repo: string,
  projectId: number,
): Promise<Array<typeof project_themes.$inferInsert> | null> {
  const { tree, truncated } = await getRepoTree(token, owner, repo);
  // A truncated listing omits entries, so a theme left out of it would be
  // deleted by the replacement.
  if (truncated) return null;
  const themeFiles = tree.filter(
    (entry) => entry.type === "blob" && entry.path.startsWith("_data/themes/") && entry.path.endsWith(".yml"),
  );
  const rows: Array<typeof project_themes.$inferInsert> = [];
  for (const entry of themeFiles) {
    const read = await getFileOnDefaultBranch(token, owner, repo, entry.path);
    if (read.status === "error") return null;
    if (read.status === "absent" || !read.content) continue;
    const parsed = parseYaml(read.content) as Record<string, unknown> | null;
    if (!parsed) continue;
    const filename = entry.path.split("/").pop()!.replace(/\.yml$/, "");
    const colors = parsed.colors as Record<string, Record<string, string>> | undefined;
    rows.push({
      project_id: projectId,
      theme_id: filename,
      name: (parsed.name as string) || filename,
      description: (parsed.description as string) || undefined,
      creator: (parsed.creator as string) || undefined,
      creator_url: (parsed.creator_url as string) || undefined,
      swatch_color: colors?.text?.heading || undefined,
    });
  }
  return rows;
}

/**
 * A theme refresh that fails in transit is answered unreachable, so the page
 * stays open and says the refresh could not be made. It reads the repository
 * and then rewrites the project's themes, so an unreachable answer claims
 * neither: the button runs it again. Every other intent reaches the server
 * action unchanged.
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  return (await answerReadsWhenUnreachable(request, serverAction, ["refresh-themes"])) as Awaited<
    ReturnType<typeof action>
  >;
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;

  // Every intent acts on the session's site, and only when the page that
  // posted it showed that site.
  const resolved = await resolvePageProject(request, env, user.id, formData);
  if (resolved.kind === "site_changed") {
    return siteChangedAnswer(intent, resolved.currentSiteName);
  }
  if (resolved.kind === "no_project") {
    return { saved: false, error: "No project found" };
  }
  const { project, userRole } = resolved;

  // refresh-themes is not a config field and takes no part in the per-field
  // split below: it wipes project_themes for the project and replaces it with
  // whatever the repo currently holds. That is the site-wide destructive class
  // the objects route already admits the convenor alone to.
  // `resolvePageProject` establishes membership only, so the role
  // it reports is what the gate reads, and an instructor carries a
  // collaborator's editorial rights and no more.
  if (intent === "refresh-themes" && userRole !== "convenor") {
    return { ok: false, intent: "refresh-themes", error: "forbidden" };
  }

  // Joining and leaving are the child convenor's acts (§5). The gate is here
  // as well as inside the two sequences because a refusal the user reads is
  // better than a thrown page, and because the leave sequence gates the
  // course rather than the caller.
  if (intent === "join-course" || intent === "leave-course") {
    if (userRole !== "convenor") {
      return { intent, outcome: { state: "forbidden" } as CourseSettingsOutcome };
    }

    if (intent === "leave-course") {
      return {
        intent,
        outcome: await leaveCourseFromSettings(db, env, {
          childProjectId: project.id,
          userId: user.id,
        }),
      };
    }

    // Judged as a string before it is used as one: anything else is a
    // hand-built submission, and a redemption is not the place to find out
    // what `String(value)` makes of a file or a null.
    const submittedCode = formData.get("course_code");
    const token = typeof submittedCode === "string" ? submittedCode.trim() : "";
    // The field is required in the page, so an empty code reaches here only
    // from a submission the page did not make. Nothing is attempted and
    // nothing is reported — an empty box is not a wrong code, and counting it
    // against the redemption limiter would let a form make a user wait.
    if (!token) return { intent, outcome: null };

    return {
      intent,
      outcome: await joinCourseFromSettings(db, env, {
        token,
        childProjectId: project.id,
        userId: user.id,
      }),
    };
  }

  if (intent === "refresh-themes") {
    try {
      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = project.github_repo_full_name.split("/");
      // Every theme is read before anything is written, and one that cannot be
      // read refuses the refresh: dropping it would show the picker fewer
      // themes than the site has.
      const themeRows = await readThemeRows(token, owner, repo, project.id);
      if (themeRows === null) return { ok: false, intent: "refresh-themes", error: "fetch_failed" };
      // One batch, so a failure leaves the old set.
      await db.batch([
        db.delete(project_themes).where(eq(project_themes.project_id, project.id)),
        ...themeRows.map((row) => db.insert(project_themes).values(row)),
      ]);
      return { ok: true, intent: "refresh-themes", count: themeRows.length };
    } catch {
      return { ok: false, intent: "refresh-themes", error: "fetch_failed" };
    }
  }

  const submitted: Partial<typeof project_config.$inferInsert> = {
    title: formData.get("title") as string,
    description: formData.get("description") as string,
    author: formData.get("author") as string,
    email: formData.get("email") as string,
    lang: formData.get("lang") as string,
    theme: formData.get("theme") as string,
    logo: formData.get("logo") as string,
    include_demo_content: formData.get("include_demo_content") === "true",
    url: formData.get("url") as string,
    baseurl: formData.get("baseurl") as string,
    show_on_homepage: formData.get("show_on_homepage") === "true",
    show_story_steps: formData.get("show_story_steps") === "true",
    show_object_credits: formData.get("show_object_credits") === "true",
    browse_and_search: formData.get("browse_and_search") === "true",
    show_link_on_homepage: formData.get("show_link_on_homepage") === "true",
    show_sample_on_homepage: formData.get("show_sample_on_homepage") === "true",
    collection_mode: formData.get("collection_mode") === "true",
    skip_stories: formData.get("skip_stories") === "true",
    featured_count: parseInt(formData.get("featured_count") as string) || 4,
    story_key: formData.get("story_key") as string,
  };

  // One form carries both halves of the configuration, so a member's save is
  // SPLIT rather than refused: the fields the split leaves with them persist,
  // and the convenor-only six are dropped and named back. Refusing the whole
  // submission would leave a collaborator unable to change a single field they
  // are entitled to, since every one of them travels with the six.
  //
  // Dropping is also the only correct reading of the payload. The page renders
  // the six inside a disabled fieldset, and a disabled control submits
  // nothing — so a collaborator's `url` arrives as null, and writing the
  // submitted value would blank the site's address rather than preserve it.
  const writable: Partial<typeof project_config.$inferInsert> = {};
  const refusedFields: string[] = [];
  for (const key of Object.keys(submitted) as (keyof typeof submitted)[]) {
    if (canWriteConfigField(key, userRole)) {
      (writable as Record<string, unknown>)[key] = submitted[key];
    } else {
      refusedFields.push(key);
    }
  }

  // A role the split does not recognise writes nothing at all.
  if (Object.keys(writable).length === 0) {
    return { saved: false, error: "forbidden" };
  }

  await db
    .update(project_config)
    .set({ ...writable, updated_at: new Date().toISOString() })
    .where(eq(project_config.project_id, project.id));

  return { saved: true, refusedFields };
}

/**
 * The number a `featured_count` entry becomes in the shared document.
 *
 * An entry that is not a count at all takes the field's default, which is
 * also what 0 takes: the collection has no meaning at zero featured objects.
 */
function featuredCountYValue(raw: string): number {
  return parseInt(raw) || 4;
}

/** The numeric config fields the shared document holds. */
const NUMBER_CONFIG_FIELDS = ["featured_count"] as const;

function updateYText(yConfig: Y.Map<unknown>, key: string, value: string) {
  const existing = yConfig.get(key);
  if (existing instanceof Y.Text) {
    if (existing.toString() !== value) {
      existing.delete(0, existing.length);
      existing.insert(0, value);
    }
  } else {
    yConfig.set(key, new Y.Text(value));
  }
}

/**
 * Mirror the saved form into the shared document.
 *
 * `canWrite` is the same per-field decision the action applied, and is not
 * optional: a field the caller may not write is also a field the disabled
 * fieldset did not submit, so an ungated pass would set the site's url to null
 * in the Y.Doc and the Durable Object would snapshot that straight into D1.
 */
function syncFormToYjs(
  form: HTMLFormElement,
  yConfig: Y.Map<unknown>,
  canWrite: (name: string) => boolean,
) {
  const fd = new FormData(form);
  const textFields = ["title", "description", "author", "email"];
  for (const key of textFields) {
    if (!canWrite(key)) continue;
    updateYText(yConfig, key, fd.get(key) as string);
  }
  const scalarStrings = ["lang", "baseurl", "url", "theme", "logo", "story_key"];
  for (const key of scalarStrings) {
    if (!canWrite(key)) continue;
    yConfig.set(key, fd.get(key) as string);
  }
  const booleans = [
    "include_demo_content", "show_on_homepage", "show_story_steps",
    "show_object_credits", "browse_and_search", "show_link_on_homepage",
    "show_sample_on_homepage", "collection_mode", "skip_stories",
  ];
  for (const key of booleans) {
    if (!canWrite(key)) continue;
    yConfig.set(key, fd.get(key) === "true");
  }
  for (const key of NUMBER_CONFIG_FIELDS) {
    if (!canWrite(key)) continue;
    yConfig.set(key, featuredCountYValue((fd.get(key) as string | null) ?? ""));
  }
}

/** Whether a theme refresh has settled on a failure, which the page says and the button retries. */
function themeRefreshCouldNotBeMade(data: unknown, refreshing: boolean): boolean {
  const answer = data as { ok?: boolean; intent?: string; error?: string } | undefined;
  return !refreshing && answer?.ok === false && answer.intent === "refresh-themes" && answer.error !== "forbidden";
}

function ThemeRefreshNote({ failed }: { failed: boolean }) {
  const { t } = useTranslation("config");
  if (!failed) return null;
  return (
    <p role="status" className="mt-1 text-xs font-body text-terracotta-deep">
      {t("sections.site_settings.refresh_themes_failed")}
    </p>
  );
}

export default function ConfigPage({ loaderData, actionData }: Route.ComponentProps) {
  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};
  const { t } = useTranslation("config");

  // Every write this page ORIGINATES is decided per field, on the same table
  // the action reads: the explicit save, the Yjs field callbacks below and the
  // description editor's Y.Text binding. Per field rather than per page
  // because the split is per field — a page-level gate would either refuse a
  // member the title they are entitled to or admit them to the site's url.
  //
  // `refresh-themes` is not a config field and stays whole: it wipes
  // project_themes and rebuilds it from the repo.
  //
  // Two writes are NOT covered and must not be read as gated. The loader's
  // `reconcileSheetsFlagFromRepo` updates google_sheets_enabled and resets the
  // collaboration document for any member who merely loads this page; its
  // value is read from the repo rather than from the caller, so it is
  // disruption a member can trigger, not a value a member can choose, and the
  // behaviour is deliberately left alone. And the Durable Object's
  // `snapshotConfig` writes nearly the whole project_config row from the
  // shared document for any client holding a socket, reaching columns this
  // form does not render at all — closing that belongs with the collaboration
  // worker, not here. These route-side gates are defence in depth.
  const userRole = loaderData.userRole;
  const isConvenor = userRole === "convenor";
  const canEditField = useCallback(
    (name: string) => canWriteConfigField(name, userRole),
    [userRole],
  );
  // A role the split does not recognise holds no editing right at all; the
  // collaborator-writable half stands in for the question, since a role either
  // reaches all of it or none of it.
  const hasEditingRights = canEditField("title");
  const themeFetcher = useSiteFetcher();
  const isRefreshingThemes = themeFetcher.state !== "idle";
  const themeRefreshFailed = themeRefreshCouldNotBeMade(themeFetcher.data, isRefreshingThemes);

  // Its own fetcher, so a join neither marks the configuration form dirty nor
  // is swallowed by its Save navigation: the two submissions are unrelated
  // writes that happen to share a page.
  const courseFetcher = useSiteFetcher<typeof action>();
  const courseBusy = courseFetcher.state !== "idle";
  const courseOutcome =
    courseFetcher.data && "outcome" in courseFetcher.data
      ? courseFetcher.data.outcome
      : null;
  const courseMessage = courseOutcome ? courseSettingsMessage(courseOutcome) : null;
  const [confirmLeave, setConfirmLeave] = useState(false);
  const navigation = useNavigation();
  const { isPublishing, ydoc } = useCollaborationContext();
  const formRef = useRef<HTMLFormElement>(null);

  // The save is a `<Form>`, whose answer reaches this route alone, so the
  // layout's watcher never sees its refusal; the notice is shown from here.
  // Latched so it can be closed while the answer is still the current one.
  const [siteChangedName, setSiteChangedName] = useState<string | null>(null);
  useEffect(() => {
    if (isSiteChanged(actionData)) setSiteChangedName(actionData.currentSiteName ?? "");
  }, [actionData]);

  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSaving = navigation.state === "submitting" &&
    navigation.formData?.get("intent") !== "refresh-themes";

  // After successful save: sync to Yjs, clear dirty, show saved animation
  useEffect(() => {
    if (actionData && "saved" in actionData && actionData.saved) {
      dirtyRef.current = false;
      setDirty(false);
      setShowSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setShowSaved(false), 2000);

      const yConfig = ydoc?.getMap<unknown>("config");
      if (yConfig && formRef.current) {
        syncFormToYjs(formRef.current, yConfig, canEditField);
      }
    }
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [actionData, ydoc, canEditField]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    setShowSaved(false);
  }, []);

  // Also sync individual field changes to Yjs on blur/change.
  //
  // Each write is gated on the field it carries, not on the page: the Durable
  // Object's snapshot writes the whole project_config row back from this map,
  // so an edit that reaches the map reaches D1 without ever passing the
  // action. The read-only fieldsets below stop the honest caller; this stops
  // the one who removes them.
  const onFieldChange = useCallback(
    (name: string, value: string) => {
      if (!canEditField(name)) return;
      markDirty();
      const yConfig = ydoc?.getMap<unknown>("config");
      if (!yConfig) return;
      const textFields = ["title", "description", "author", "email"];
      if (textFields.includes(name)) {
        updateYText(yConfig, name, value);
      } else {
        yConfig.set(name, value);
      }
    },
    [ydoc, markDirty, canEditField],
  );

  const onBooleanChange = useCallback(
    (name: string, value: boolean) => {
      if (!canEditField(name)) return;
      markDirty();
      const yConfig = ydoc?.getMap<unknown>("config");
      if (!yConfig) return;
      yConfig.set(name, value);
    },
    [ydoc, markDirty, canEditField],
  );

  // The numeric fields need the same gate as the rest: an ungated numeric
  // setter is as good a route into the config map as an ungated string one.
  const onNumberChange = useCallback(
    (name: string, value: string) => {
      if (!canEditField(name)) return;
      markDirty();
      const yConfig = ydoc?.getMap<unknown>("config");
      if (!yConfig) return;
      yConfig.set(name, featuredCountYValue(value));
    },
    [ydoc, markDirty, canEditField],
  );

  // Resolve the shared Y.Text for `description` so the rich editor and the
  // Configure tab both bind to the same Yjs value.
  const configDescriptionYText = getYText(ydoc?.getMap<unknown>("config") ?? null, "description");

  // Mirror the live Y.Text value into a hidden form field so the Save action
  // still receives `description` (InlineHtmlEditor is Yjs-bound, not a native
  // form field, so without this the form would submit an empty string).
  const [descMirror, setDescMirror] = useState<string>(loaderData.config?.description ?? "");
  useEffect(() => {
    if (!configDescriptionYText) return;
    setDescMirror(configDescriptionYText.toString());
    const obs = () => setDescMirror(configDescriptionYText.toString());
    configDescriptionYText.observe(obs);
    return () => configDescriptionYText.unobserve(obs);
  }, [configDescriptionYText]);

  // Unsaved changes blocker — uses ref so onSubmit can clear it synchronously
  const blocker = useBlocker(() => dirtyRef.current);

  if (!loaderData.hasProject) {
    return (
      <div className="max-w-3xl mx-auto py-20 text-center">
        <p className="font-body text-gray-500 mb-4">
          {t("empty_no_project")}
        </p>
        <Link
          to="/onboarding"
          className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-2.5 transition-colors"
        >
          {t("connect_repo_cta")}
        </Link>
      </div>
    );
  }

  const config = loaderData.config;
  const themes = loaderData.themes;

  // Surface an amber alert above ThemeSwatches when the project's
  // configured theme is missing or doesn't match any imported theme_id. The
  // helper suppresses the alert when themes.length === 0 — ThemeSwatches's own
  // "No themes found" copy already carries the message there.
  const themeValue = config?.theme ?? "";
  const { showAlert: showThemeAlert, isEmpty: isThemeEmpty } = detectThemeAlert({
    themeValue,
    themes,
  });

  return (
    <div className="max-w-3xl mx-auto pb-8">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-3">{t("title")}</h1>

      <div className="space-y-2 mb-6 max-w-2xl">
        <p className="text-sm font-body text-charcoal/70">{t("intro")}</p>
        <p className="text-sm font-body text-charcoal/70">
          <Trans
            ns="config"
            i18nKey="account_link_note"
            components={{
              1: (
                <Link
                  to="/account"
                  className="underline underline-offset-2 text-charcoal hover:text-terracotta"
                />
              ),
            }}
          />
        </p>
        {openDoc && <DocsLink docId="configure" onOpenDoc={openDoc} />}
      </div>

      {siteChangedName !== null && (
        <SiteChangedDialog
          reason="stopped"
          otherSiteName={siteChangedName}
          onClose={() => setSiteChangedName(null)}
        />
      )}

      <Form method="post" ref={formRef} onSubmit={() => { dirtyRef.current = false; }}>
        <SiteField />
        {/* A disabled fieldset disables every descendant control natively, so
            the inputs, toggles, swatches and Save button are inert for a
            caller the action would refuse — rather than live and discarded,
            which would leave the dirty flag set and the unsaved-changes
            blocker firing on a change that was never going to land. The
            description editor is not a form control and takes its own
            `editable` prop below.
            The outer fieldset covers the case of a role the split does not
            recognise, which may write nothing at all; the three inner ones
            hold the convenor-only fields. Each is marked read-only where it
            sits, so the explanation reaches the field it belongs to. Note that
            a disabled control submits NOTHING, which is why the action drops
            those fields rather than reading them back as empty. */}
        <fieldset disabled={!hasEditingRights} className="m-0 min-w-0 border-0 p-0">
        {/* 1. Site Settings */}
        <ConfigSection title={t("sections.site_settings.title")}>
          <FieldWithHelp
            label={t("sections.site_settings.field_title")}
            name="title"
            value={config?.title ?? ""}
            help={t("sections.site_settings.field_title_help")}
            onChange={onFieldChange}
          />
          <div className="mb-4">
            <span className="font-body font-medium text-sm text-charcoal mb-1 block">
              {t("sections.site_settings.field_description")}
            </span>
            <InlineHtmlEditor
              initialValue={config?.description ?? ""}
              yText={configDescriptionYText}
              ariaLabel={t("sections.site_settings.field_description")}
              editable={canEditField("description")}
            />
            <p className="mt-1 text-xs text-gray-400">{t("sections.site_settings.field_description_help")}</p>
            {/* Hidden mirror so the form action still receives `description`
                (the editor is Yjs-bound, not a native form field). */}
            <textarea name="description" value={descMirror} readOnly hidden aria-hidden />
          </div>
          <FieldWithHelp
            label={t("sections.site_settings.field_author")}
            name="author"
            value={config?.author ?? ""}
            onChange={onFieldChange}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_email")}
            name="email"
            value={config?.email ?? ""}
            onChange={onFieldChange}
          />
          <div className="mb-4">
            <label className="font-body font-medium text-sm text-charcoal mb-2 block">
              {t("sections.site_settings.field_theme")}
            </label>
            <p className="text-xs text-gray-400 mb-2">{t("sections.site_settings.field_theme_help")}</p>
            {showThemeAlert && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 mb-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <p className="font-heading font-semibold text-sm text-charcoal">
                    {isThemeEmpty
                      ? t("sections.site_settings.theme_alert.title_empty")
                      : t("sections.site_settings.theme_alert.title_unrecognised")}
                  </p>
                  <p className="font-body text-xs text-gray-600 mt-1">
                    {isThemeEmpty
                      ? t("sections.site_settings.theme_alert.body_empty")
                      : t("sections.site_settings.theme_alert.body_unrecognised", { value: themeValue })}
                  </p>
                </div>
              </div>
            )}
            <ThemeSwatches
              name="theme"
              value={config?.theme ?? ""}
              themes={themes}
              onChange={(value) => onFieldChange("theme", value)}
            />
            <button
              type="button"
              onClick={() =>
                themeFetcher.submit(
                  { intent: "refresh-themes" },
                  { method: "post" },
                )
              }
              disabled={isRefreshingThemes || !isConvenor}
              className="inline-flex items-center gap-1.5 mt-2 text-xs font-body text-gray-400 hover:text-charcoal transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingThemes ? "animate-spin" : ""}`} />
              {t("sections.site_settings.refresh_themes")}
            </button>
            <ThemeRefreshNote failed={themeRefreshFailed} />
          </div>
          <FieldWithHelp
            label={t("sections.site_settings.field_logo")}
            name="logo"
            value={config?.logo ?? ""}
            help={t("sections.site_settings.field_logo_help")}
            onChange={onFieldChange}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_language")}
            name="lang"
            type="select"
            value={config?.lang ?? "en"}
            help={t("sections.site_settings.field_language_help")}
            options={[
              { value: "en", label: "English" },
              { value: "es", label: "Español" },
            ]}
            onChange={onFieldChange}
          />
          <fieldset disabled={!isConvenor} className="m-0 min-w-0 border-0 p-0">
            {!isConvenor && <ConvenorOnlyNote />}
            <ToggleField
              label={t("sections.site_settings.field_demo_content")}
              name="include_demo_content"
              checked={config?.include_demo_content ?? true}
              help={t("sections.site_settings.field_demo_content_help")}
              onChange={onBooleanChange}
            />
          </fieldset>
        </ConfigSection>

        {/* 2. Hosting */}
        <ConfigSection title={t("sections.hosting.title")}>
          <fieldset disabled={!isConvenor} className="m-0 min-w-0 border-0 p-0">
            {!isConvenor && <ConvenorOnlyNote />}
            <FieldWithHelp
              label={t("sections.hosting.field_url")}
              name="url"
              value={config?.url ?? ""}
              help={t("sections.hosting.field_url_help")}
              onChange={onFieldChange}
            />
            <FieldWithHelp
              label={t("sections.hosting.field_baseurl")}
              name="baseurl"
              value={config?.baseurl ?? ""}
              help={t("sections.hosting.field_baseurl_help")}
              onChange={onFieldChange}
            />
          </fieldset>
        </ConfigSection>

        {/* 3. Story Interface */}
        <ConfigSection title={t("sections.story_interface.title")}>
          <ToggleField
            label={t("sections.story_interface.field_show_on_homepage")}
            name="show_on_homepage"
            checked={config?.show_on_homepage ?? true}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.story_interface.field_show_story_steps")}
            name="show_story_steps"
            checked={config?.show_story_steps ?? true}
            help={t("sections.story_interface.field_show_story_steps_help")}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.story_interface.field_show_object_credits")}
            name="show_object_credits"
            checked={config?.show_object_credits ?? true}
            help={t("sections.story_interface.field_show_object_credits_help")}
            onChange={onBooleanChange}
          />
        </ConfigSection>

        {/* 4. Collection Interface */}
        <ConfigSection title={t("sections.collection_interface.title")}>
          <ToggleField
            label={t("sections.collection_interface.field_browse_and_search")}
            name="browse_and_search"
            checked={config?.browse_and_search ?? true}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.collection_interface.field_show_link_on_homepage")}
            name="show_link_on_homepage"
            checked={config?.show_link_on_homepage ?? true}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.collection_interface.field_show_sample_on_homepage")}
            name="show_sample_on_homepage"
            checked={config?.show_sample_on_homepage ?? false}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.collection_interface.field_collection_mode")}
            name="collection_mode"
            checked={config?.collection_mode ?? false}
            help={t("sections.collection_interface.field_collection_mode_help")}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.collection_interface.field_skip_stories")}
            name="skip_stories"
            checked={config?.skip_stories ?? false}
            help={t("sections.collection_interface.field_skip_stories_help")}
            onChange={onBooleanChange}
          />
          <FieldWithHelp
            label={t("sections.collection_interface.field_featured_count")}
            name="featured_count"
            type="number"
            value={config?.featured_count ?? 4}
            help={t("sections.collection_interface.field_featured_count_help")}
            onChange={onNumberChange}
          />
        </ConfigSection>

        {/* 5. Story Protection */}
        <ConfigSection title={t("sections.story_protection.title")}>
          <fieldset disabled={!isConvenor} className="m-0 min-w-0 border-0 p-0">
            {!isConvenor && <ConvenorOnlyNote />}
            <FieldWithHelp
              label={t("sections.story_protection.field_story_key")}
              name="story_key"
              value={config?.story_key ?? ""}
              help={t("sections.story_protection.field_story_key_help")}
              onChange={onFieldChange}
              inputAttributes={{ "data-paste-verbatim": "" }}
            />
          </fieldset>
        </ConfigSection>

        {/* 6. Navigation Menu */}
        <ConfigSection title={t("navigation_menu_title")}>
          <p className="font-body text-sm text-gray-500">
            {t("navigation_menu_description_before")}
            <a href="/pages" className="text-terracotta hover:text-terracotta/80 underline">{t("navigation_menu_pages_link")}</a>
            {t("navigation_menu_description_after")}
          </p>
        </ConfigSection>

        {/* 7. Google Sheets Integration */}
        <ConfigSection title={t("sections.google_sheets.title")}>
          {config?.google_sheets_enabled ? (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm font-body">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p>{t("sections.google_sheets.enabled_notice")}</p>
            </div>
          ) : (
            <p className="text-sm font-body text-gray-500">
              {t("sections.google_sheets.disabled_notice")}
            </p>
          )}
        </ConfigSection>

        {/* Save button with state animation */}
        <div className="flex items-center justify-end gap-3 pb-8">
          {showSaved && (
            <span className="inline-flex items-center gap-1.5 font-body text-xs text-green-600">
              <Check className="w-3.5 h-3.5" />
              {t("saved")}
            </span>
          )}
          <Button
            type="submit"
            disabled={isPublishing || isSaving}
            loading={isSaving}
          >
            {isSaving ? t("saving") : t("save")}
          </Button>
        </div>
        </fieldset>
      </Form>

      {/* 8. Course — outside the configuration form, because a join is settled
          when it is submitted rather than when the page is saved, and nesting
          a form inside another is not a form at all. Absent entirely on a
          course project, which has no course to join. */}
      {loaderData.course && (
        <ConfigSection title={t("course.section_title")}>
          {courseMessage && (
            <div
              role="status"
              className={`flex items-start gap-3 rounded-lg border p-3 mb-4 ${
                courseMessage.tone === "success"
                  ? "border-green-200 bg-green-50"
                  : "border-amber-300 bg-amber-50"
              }`}
            >
              {courseMessage.tone === "success" ? (
                <CheckCircle
                  className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0"
                  aria-hidden="true"
                />
              )}
              <div
                className={`font-body text-sm ${
                  courseMessage.tone === "success" ? "text-green-900" : "text-amber-900"
                }`}
              >
                <p>{t(courseMessage.key, courseMessage.values)}</p>
                {courseMessage.details?.map((detail) => (
                  <p key={detail.key} className="mt-1">
                    {t(detail.key, { count: detail.count })}
                  </p>
                ))}
              </div>
            </div>
          )}

          {loaderData.course.courseName === null ? (
            <courseFetcher.Form method="post">
              <SiteField />
              <input type="hidden" name="intent" value="join-course" />
              <label
                htmlFor="course_code"
                className="font-body font-medium text-sm text-charcoal mb-1 block"
              >
                {t("course.join_label")}
              </label>
              <div className="flex items-start gap-2">
                <input
                  id="course_code"
                  name="course_code"
                  type="text"
                  required
                  disabled={!isConvenor || courseBusy}
                  placeholder={t("course.join_placeholder")}
                  className="flex-1 min-w-0 rounded-lg border border-gray-200 px-3 py-2 font-body text-sm text-charcoal disabled:bg-gray-50 disabled:text-gray-400"
                />
                <Button type="submit" disabled={!isConvenor || courseBusy} loading={courseBusy}>
                  {t("course.join_button")}
                </Button>
              </div>
              <p className="mt-1 text-xs text-gray-400">{t("course.join_hint")}</p>
            </courseFetcher.Form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-body text-sm text-charcoal">
                {t("course.current", { course: loaderData.course.courseName })}
              </p>
              <Button
                variant="secondary"
                onClick={() => setConfirmLeave(true)}
                disabled={!isConvenor || courseBusy}
              >
                {t("course.leave_button")}
              </Button>
            </div>
          )}

          {!isConvenor && (
            <p className="mt-3 font-body text-xs text-gray-500">{t("course.convenor_only")}</p>
          )}
        </ConfigSection>
      )}

      {/* Leaving takes the site's objects out of the course's protection and
          the course's staff out of its team, so it is confirmed rather than
          done on one click. */}
      {confirmLeave && loaderData.course !== null && loaderData.course.courseName !== null && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" aria-hidden="true" />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6">
              <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
                {t("course.leave_title", { course: loaderData.course.courseName })}
              </h2>
              <p className="font-body text-sm text-gray-600 mb-6">{t("course.leave_body")}</p>
              <div className="flex justify-end gap-3">
                <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
                  {t("course.leave_cancel")}
                </Button>
                <Button
                  onClick={() => {
                    setConfirmLeave(false);
                    courseFetcher.submit({ intent: "leave-course" }, { method: "post" });
                  }}
                >
                  {t("course.leave_confirm")}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Unsaved changes confirmation modal */}
      {blocker.state === "blocked" && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" aria-hidden="true" />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6">
              <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
                {t("unsaved_changes.title")}
              </h2>
              <p className="font-body text-sm text-gray-600 mb-6">
                {t("unsaved_changes.message")}
              </p>
              <div className="flex justify-end gap-3">
                <Button variant="secondary" onClick={() => blocker.reset?.()}>
                  {t("unsaved_changes.stay")}
                </Button>
                <Button onClick={() => blocker.proceed?.()}>
                  {t("unsaved_changes.leave")}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
