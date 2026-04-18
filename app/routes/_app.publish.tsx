/**
 * Publish — 3-step publish wizard (Review, Checks, Publish).
 *
 * Loader: fetches the active project, computes a change summary against the
 *         stored publish snapshot, and returns project + user info.
 *
 * Action: handles four intents —
 *   run-validation: runs pre-publish checks and returns ValidationResult
 *   publish: assembles the full file set, commits, updates D1, returns SHA
 *   poll-build: polls GitHub Actions and returns phase statuses
 *   dismiss-intro: no-op (dismissal handled client-side via localStorage)
 *
 * Component: wizard with PublishProgressBar, ChangeSummary, GitEducationPanel,
 *            ValidationChecks, CommitMessageEditor, BuildTracker.
 */

import { eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import type { Route } from "./+types/_app.publish";
import { RestrictionBanner } from "~/components/layout/RestrictionBanner";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, objects, steps, project_config, project_landing } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getRepoHead } from "~/lib/github.server";
import { requireOwner, resolveActiveProject } from "~/lib/membership.server";
import {
  commitFilesToRepo,
  listWorkflowRunsBySha,
  getJobSteps,
  mapStepsToBuildPhases,
  StaleHeadError,
} from "~/lib/commit.server";
import {
  computeChangeSummary,
  runPrePublishValidation,
  buildPublishFileSet,
} from "~/lib/publish.server";
import type { PublishSnapshot, ChangeSummary, ValidationResult } from "~/lib/publish.server";
import { Button } from "~/components/ui/Button";
import { PublishProgressBar } from "~/components/features/publish/PublishProgressBar";
import type { PublishStep } from "~/components/features/publish/PublishProgressBar";
import { ChangeSummary as ChangeSummaryComponent } from "~/components/features/publish/ChangeSummary";
import { GitEducationPanel } from "~/components/features/publish/GitEducationPanel";
import { ValidationChecks } from "~/components/features/publish/ValidationChecks";
import { CommitMessageEditor } from "~/components/features/publish/CommitMessageEditor";
import { BuildTracker } from "~/components/features/publish/BuildTracker";

export const handle = { i18n: ["common", "publish", "team"] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashObject(obj: unknown): string {
  return JSON.stringify(obj);
}

function autoGenerateCommitMessage(summary: ChangeSummary, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const parts: string[] = [];

  const newStories = summary.stories.new.length;
  const deletedStories = summary.stories.deleted.length;
  const newObjects = summary.objects.new.length;
  const deletedObjects = summary.objects.deleted.length;

  if (newStories > 0) parts.push(t("auto_commit.add_stories", { count: newStories }));
  if (deletedStories > 0) parts.push(t("auto_commit.remove_stories", { count: deletedStories }));
  if (newObjects > 0) parts.push(t("auto_commit.add_objects", { count: newObjects }));
  if (deletedObjects > 0) parts.push(t("auto_commit.remove_objects", { count: deletedObjects }));
  if (summary.settings.changed.length > 0) parts.push(t("auto_commit.update_settings"));
  if (summary.landing.changed) parts.push(t("auto_commit.update_homepage"));

  const headline = parts.length > 0
    ? parts.slice(0, 3).join(", ").replace(/^./, (c) => c.toUpperCase())
    : t("auto_commit.default_headline");

  return headline;
}

function autoGenerateCommitBody(summary: ChangeSummary, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const lines: string[] = [];

  for (const s of summary.stories.new) {
    lines.push(t("auto_commit.new_story", { title: s.title ?? s.story_id }));
  }
  for (const s of summary.stories.deleted) {
    lines.push(t("auto_commit.deleted_story", { title: s.title ?? s.story_id }));
  }
  for (const o of summary.objects.new) {
    lines.push(t("auto_commit.new_object", { title: o.title ?? o.object_id }));
  }
  for (const o of summary.objects.deleted) {
    lines.push(t("auto_commit.deleted_object", { title: o.title ?? o.object_id }));
  }

  lines.push("");
  lines.push(t("auto_commit.footer"));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    return redirect("/dashboard");
  }
  const { project: activeProject } = resolved;

  // Fetch D1 data needed for change summary
  const [storyRows, objectRows, configRow, landingRow] = await Promise.all([
    db.select({ story_id: stories.story_id, title: stories.title, draft: stories.draft })
      .from(stories)
      .where(eq(stories.project_id, activeProject.id)),
    db.select({ object_id: objects.object_id, title: objects.title })
      .from(objects)
      .where(eq(objects.project_id, activeProject.id)),
    db.select().from(project_config).where(eq(project_config.project_id, activeProject.id)).limit(1),
    db.select().from(project_landing).where(eq(project_landing.project_id, activeProject.id)).limit(1),
  ]);

  const config = configRow[0] ?? null;
  const landing = landingRow[0] ?? null;

  const nonDraftStories = storyRows.filter((s) => !s.draft);

  const currentState = {
    storyIds: nonDraftStories.map((s) => s.story_id),
    objectIds: objectRows.map((o) => o.object_id),
    configHash: config ? hashObject({
      title: config.title,
      url: config.url,
      baseurl: config.baseurl,
      description: config.description,
      author: config.author,
      email: config.email,
      logo: config.logo,
      story_key: config.story_key,
    }) : "",
    landingHash: landing ? hashObject({
      stories_heading: landing.stories_heading,
      stories_intro: landing.stories_intro,
      objects_heading: landing.objects_heading,
      objects_intro: landing.objects_intro,
      welcome_body: landing.welcome_body,
    }) : "",
    stories: nonDraftStories.map((s) => ({ story_id: s.story_id, title: s.title })),
    objects: objectRows.map((o) => ({ object_id: o.object_id, title: o.title })),
  };

  const snapshot: PublishSnapshot | null = activeProject.publish_snapshot
    ? (JSON.parse(activeProject.publish_snapshot) as PublishSnapshot)
    : null;

  const changeSummary = computeChangeSummary(currentState, snapshot);

  return {
    project: {
      id: activeProject.id,
      head_sha: activeProject.head_sha,
      published_sha: activeProject.published_sha,
      last_published_at: activeProject.last_published_at,
      publish_snapshot: activeProject.publish_snapshot,
      github_repo_full_name: activeProject.github_repo_full_name,
      github_pages_url: activeProject.github_pages_url,
      installation_id: activeProject.installation_id,
    },
    changeSummary,
    user: {
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    return { ok: false, intent, error: "no_project" };
  }
  const { project: activeProject } = resolved;

  // Guard: only owners may publish
  await requireOwner(db, activeProject.id, user.id);

  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const [owner, repo] = activeProject.github_repo_full_name.split("/");

  switch (intent) {
    case "run-validation": {
      try {
        // Fetch current repo HEAD for stale check
        const currentRepoHead = await getRepoHead(token, owner, repo);

        // Fetch objects for validation
        const objectRows = await db.select({ object_id: objects.object_id, title: objects.title })
          .from(objects)
          .where(eq(objects.project_id, activeProject.id));

        // Fetch stories for this project
        const storyRows = await db.select({ id: stories.id, story_id: stories.story_id, title: stories.title })
          .from(stories)
          .where(eq(stories.project_id, activeProject.id));

        const storyDbIds = storyRows.map((s) => s.id);

        // Collect all steps for this project (one query per story to avoid IN clause complexity)
        let allSteps: { id: number; step_number: number; object_id: string | null; x: number | null; y: number | null; zoom: number | null; question: string | null; answer: string | null }[] = [];
        for (const storyId of storyDbIds) {
          const stepsForStory = await db.select({
            id: steps.id,
            step_number: steps.step_number,
            object_id: steps.object_id,
            x: steps.x,
            y: steps.y,
            zoom: steps.zoom,
            question: steps.question,
            answer: steps.answer,
          }).from(steps).where(eq(steps.story_id, storyId));
          allSteps = allSteps.concat(stepsForStory);
        }

        const validation = runPrePublishValidation({
          headSha: activeProject.head_sha ?? "",
          currentRepoHead,
          stories: storyRows.map((s) => ({ story_id: s.story_id, title: s.title })),
          steps: allSteps,
          objects: objectRows,
        });

        return { ok: true, intent: "run-validation", validation };
      } catch (err) {
        return {
          ok: false,
          intent: "run-validation",
          error: "validation_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "publish": {
      const commitMessage = (formData.get("commitMessage") as string | null)?.trim() || "Publish site";
      const commitBody = (formData.get("commitBody") as string | null)?.trim() || undefined;

      try {
        // Force a DO snapshot before the publish pipeline runs.
        // Ensures the publish pipeline reads the absolute latest collaborative content.
        // If no DO instance is alive (no active collaborators), this returns 200 without error.
        try {
          const doId = env.COLLABORATION.idFromName(String(activeProject.id));
          const doStub = env.COLLABORATION.get(doId);
          const snapshotReq = new Request(`https://internal/snapshot`, { method: "POST" });
          const snapshotRes = await doStub.fetch(snapshotReq);
          if (!snapshotRes.ok) {
            return { ok: false, intent: "publish", error: "snapshot_failed" };
          }
        } catch {
          // If the DO is unreachable, continue — D1 already has the last persisted state
        }

        const files = await buildPublishFileSet({
          token,
          owner,
          repo,
          branch: "main",
          projectId: activeProject.id,
          env,
        });

        // Publish always triggers a full build — tiles are deployed via GitHub
        // Pages (artifact upload), so partial workflows can't deploy content.
        const result = await commitFilesToRepo(
          token,
          owner,
          repo,
          "main",
          files,
          commitMessage,
          commitBody,
        );

        const newHeadSha = result.newHeadSha;
        const now = new Date().toISOString();

        // Compute current snapshot for storage
        const [storyRows, objectRows, configRow, landingRow] = await Promise.all([
          db.select({ story_id: stories.story_id, draft: stories.draft }).from(stories).where(eq(stories.project_id, activeProject.id)),
          db.select({ object_id: objects.object_id }).from(objects).where(eq(objects.project_id, activeProject.id)),
          db.select().from(project_config).where(eq(project_config.project_id, activeProject.id)).limit(1),
          db.select().from(project_landing).where(eq(project_landing.project_id, activeProject.id)).limit(1),
        ]);

        const config = configRow[0] ?? null;
        const landing = landingRow[0] ?? null;
        const nonDraftStories = storyRows.filter((s) => !s.draft);

        const newSnapshot: PublishSnapshot = {
          story_ids: nonDraftStories.map((s) => s.story_id),
          object_ids: objectRows.map((o) => o.object_id),
          config_hash: config ? hashObject({
            title: config.title,
            url: config.url,
            baseurl: config.baseurl,
            description: config.description,
            author: config.author,
            email: config.email,
            logo: config.logo,
            story_key: config.story_key,
          }) : "",
          landing_hash: landing ? hashObject({
            stories_heading: landing.stories_heading,
            stories_intro: landing.stories_intro,
            objects_heading: landing.objects_heading,
            objects_intro: landing.objects_intro,
            welcome_body: landing.welcome_body,
          }) : "",
        };

        await db.update(projects).set({
          published_sha: newHeadSha,
          head_sha: newHeadSha,
          last_published_at: now,
          publish_snapshot: JSON.stringify(newSnapshot),
          updated_at: now,
        }).where(eq(projects.id, activeProject.id));

        // commitUrl derived from commit SHA
        const commitUrl = `https://github.com/${owner}/${repo}/commit/${newHeadSha}`;

        return { ok: true, intent: "publish", newHeadSha, commitUrl };
      } catch (err) {
        if (err instanceof StaleHeadError) {
          return { ok: false, intent: "publish", error: "stale_head" };
        }
        return {
          ok: false,
          intent: "publish",
          error: "publish_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "poll-build": {
      const sha = formData.get("sha") as string | null;
      const runIdParam = formData.get("runId") as string | null;

      if (!sha) {
        return { ok: false, intent: "poll-build", error: "missing_sha" };
      }

      try {
        const runs = await listWorkflowRunsBySha(token, owner, repo, sha);

        if (runs.length === 0) {
          return {
            ok: true,
            intent: "poll-build",
            buildStatus: "pending",
            buildConclusion: null,
            buildUrl: null,
            runId: null,
            phases: null,
          };
        }

        const run = runs[0];

        if (runIdParam) {
          const jobSteps = await getJobSteps(token, owner, repo, Number(runIdParam));
          const phases = mapStepsToBuildPhases(jobSteps);
          return {
            ok: true,
            intent: "poll-build",
            buildStatus: run.status,
            buildConclusion: run.conclusion,
            buildUrl: run.html_url,
            runId: run.id,
            phases,
          };
        }

        return {
          ok: true,
          intent: "poll-build",
          buildStatus: run.status,
          buildConclusion: run.conclusion,
          buildUrl: run.html_url,
          runId: run.id,
          phases: null,
        };
      } catch (err) {
        return {
          ok: false,
          intent: "poll-build",
          error: "poll_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "dismiss-intro": {
      // Dismissal is handled client-side via localStorage — no D1 write needed.
      return { ok: true, intent: "dismiss-intro" };
    }

    default:
      return { ok: false, intent, error: "unknown_intent" };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PublishActionData =
  | { ok: true; intent: "run-validation"; validation: ValidationResult }
  | { ok: false; intent: "run-validation"; error: string; message?: string }
  | { ok: true; intent: "publish"; newHeadSha: string; commitUrl: string }
  | { ok: false; intent: "publish"; error: string; message?: string }
  | { ok: true; intent: "poll-build"; buildStatus: string; buildConclusion: string | null; buildUrl: string | null; runId: number | null; phases: unknown }
  | { ok: false; intent: "poll-build"; error: string }
  | { ok: true; intent: "dismiss-intro" }
  | { ok: false; intent: string; error: string }
  | null
  | undefined;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PublishPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("publish");
  const { t: tTeam } = useTranslation("team");
  const { project, changeSummary } = loaderData;

  const appData = useRouteLoaderData("routes/_app") as { userRole?: string } | null;
  const isCollaborator = appData?.userRole === "collaborator";

  if (isCollaborator) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <RestrictionBanner message={tTeam("restriction_publish")} />
      </div>
    );
  }

  const { provider } = useCollaborationContext();

  const [wizardStep, setWizardStep] = useState<PublishStep>("review");
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [publishResult, setPublishResult] = useState<{ newHeadSha: string; commitUrl: string } | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Broadcast publish state to all connected clients via Yjs awareness
  useEffect(() => {
    if (!provider) return;
    provider.awareness.setLocalStateField("publishing", isPublishing);
    provider.awareness.setLocalStateField("publishError", publishError !== null);
  }, [isPublishing, publishError, provider]);

  const validationFetcher = useFetcher();
  const publishFetcher = useFetcher();

  const validationData = validationFetcher.data as PublishActionData;
  const publishData = publishFetcher.data as PublishActionData;

  const hasBlockers = validationResult !== null && validationResult.blockers.length > 0;

  const autoGeneratedHeadline = autoGenerateCommitMessage(changeSummary, t);
  const autoGeneratedBody = autoGenerateCommitBody(changeSummary, t);
  const autoGeneratedMessage = autoGeneratedBody
    ? `${autoGeneratedHeadline}\n\n${autoGeneratedBody}`
    : autoGeneratedHeadline;

  // Handle validation response
  useEffect(() => {
    if (!validationData) return;
    if (validationData.ok && validationData.intent === "run-validation") {
      setValidationResult(validationData.validation);
    } else if (!validationData.ok && validationData.intent === "run-validation") {
      // Treat failed validation fetch as empty (no blockers, no warnings)
      setValidationResult({ blockers: [], warnings: [] });
    }
  }, [validationData]);

  // Handle publish response
  useEffect(() => {
    if (!publishData) return;
    if (publishData.ok && publishData.intent === "publish") {
      setIsPublishing(false);
      setPublishResult({ newHeadSha: publishData.newHeadSha, commitUrl: publishData.commitUrl });
    } else if (!publishData.ok && publishData.intent === "publish") {
      setIsPublishing(false);
      setPublishError(publishData.error === "stale_head"
        ? t("build.stale_head_error")
        : "publish_failed" in publishData
        ? t("build.failed_description")
        : t("build.failed_description"));
    }
  }, [publishData, t]);

  // Run validation automatically when entering "checks" step
  const hasRunValidationRef = useRef(false);
  useEffect(() => {
    if (wizardStep === "checks" && !hasRunValidationRef.current) {
      hasRunValidationRef.current = true;
      validationFetcher.submit({ intent: "run-validation" }, { method: "post" });
    }
    if (wizardStep !== "checks") {
      hasRunValidationRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardStep]);

  function handlePublish(fullMessage: string) {
    setIsPublishing(true);
    setPublishError(null);
    // Split on first blank line: everything before is the headline, after is the body
    const blankLineIdx = fullMessage.indexOf("\n\n");
    const commitMessage = blankLineIdx === -1 ? fullMessage : fullMessage.slice(0, blankLineIdx);
    const commitBody = blankLineIdx === -1 ? undefined : fullMessage.slice(blankLineIdx + 2);
    publishFetcher.submit(
      { intent: "publish", commitMessage, ...(commitBody ? { commitBody } : {}) },
      { method: "post" },
    );
  }

  function handleRetry() {
    setPublishResult(null);
    setPublishError(null);
    setIsPublishing(false);
    setValidationResult(null);
    setWizardStep("review");
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-6">
        {t("title")}
      </h1>

      {/* Progress bar — hidden once publish result is showing */}
      {!publishResult && (
        <PublishProgressBar currentStep={wizardStep} className="mb-8" />
      )}

      {/* === REVIEW STEP === */}
      {wizardStep === "review" && !publishResult && (
        <>
          <GitEducationPanel />

          <h2 className="font-heading font-semibold text-lg text-charcoal mb-3">
            {t("review.heading")}
          </h2>

          {changeSummary.isUpToDate ? (
            <div className="flex flex-col items-center justify-center py-10 text-center bg-cream rounded-lg border border-gray-200">
              <p className="font-heading font-semibold text-charcoal mb-1">
                {t("review.up_to_date")}
              </p>
              <p className="font-body text-sm text-gray-500">
                {t("review.up_to_date_description")}
              </p>
            </div>
          ) : (
            <ChangeSummaryComponent summary={changeSummary} />
          )}

          <div className="flex justify-end mt-6">
            <Button
              variant="primary"
              type="button"
              onClick={() => setWizardStep("checks")}
              disabled={changeSummary.isUpToDate}
            >
              {t("nav.next_checks")}
            </Button>
          </div>
        </>
      )}

      {/* === CHECKS STEP === */}
      {wizardStep === "checks" && !publishResult && (
        <>
          <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">
            {t("checks.heading")}
          </h2>

          <ValidationChecks
            validation={validationResult}
            className="mb-6"
          />

          <div className="flex justify-between mt-6">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setWizardStep("review")}
            >
              {t("nav.back")}
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => setWizardStep("publish")}
              disabled={hasBlockers || validationResult === null}
            >
              {t("nav.next_publish")}
            </Button>
          </div>
        </>
      )}

      {/* === PUBLISH STEP (pre-commit) === */}
      {wizardStep === "publish" && !publishResult && (
        <>
          {publishError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p className="font-body text-sm text-red-900">{publishError}</p>
            </div>
          )}

          <CommitMessageEditor
            defaultMessage={autoGeneratedMessage}
            onPublish={handlePublish}
            loading={isPublishing}
          />

          <div className="flex justify-between mt-6">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setWizardStep("checks")}
              disabled={isPublishing}
            >
              {t("nav.back")}
            </Button>
          </div>
        </>
      )}

      {/* === BUILD TRACKER (post-commit) === */}
      {publishResult && (
        <BuildTracker
          sha={publishResult.newHeadSha}
          commitUrl={publishResult.commitUrl}
          // Fall back to the default GitHub Pages URL pattern when the
          // project doesn't have github_pages_url persisted yet (older
          // imports, sites that never went through configure-site, etc.).
          // A future iteration will populate this field reliably for newly-created
          // sites; until then, the default pattern is always correct for
          // project Pages sites and gives users a working "View site"
          // button immediately after a successful build.
          pagesUrl={
            project.github_pages_url ??
            (() => {
              const [owner, repo] = project.github_repo_full_name.split("/");
              return `https://${owner.toLowerCase()}.github.io/${repo}`;
            })()
          }
          onRetry={handleRetry}
          className="py-4"
        />
      )}
    </div>
  );
}
