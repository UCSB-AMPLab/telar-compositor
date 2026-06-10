/**
 * This file is the Publish route — one scrollable page with three stacked
 * sections (What's changing / What we checked / Publish) that the user runs to
 * push their D1-stored compositor content out to GitHub as a Telar-format
 * commit. (This single-page flow replaced the prior 3-step wizard.)
 *
 * Loader fetches the active project, computes a change summary
 * against the stored publish snapshot, and returns project + user
 * info for rendering.
 *
 * Action handles four intents:
 *   - `run-validation` — runs pre-publish checks and returns
 *     `ValidationResult`
 *   - `publish` — assembles the full file set, commits, updates D1,
 *     returns the new SHA
 *   - `poll-build` — polls GitHub Actions and returns the build
 *     status/conclusion (driven headless by this page's poll loop)
 *   - `dismiss-intro` — no-op (dismissal handled client-side via
 *     localStorage)
 *
 * Renders three sections with `ChangeSummary` (chips), `ValidationChecks`
 * (chilca-pale passed-checks list + blockers), and an inline terracotta
 * Publish section (mono commit card + click-to-reveal `CommitMessageEditor`).
 *
 * Post-commit: the in-route BuildTracker is GONE. Build
 * chrome (the 5-row phase log) is owned by the Site Status pill via the
 * awareness broadcast. This page only shows an honest "Publishing…
 * — track progress in the status pill" inline state while a headless
 * `poll-build` loop watches the build to completion, then swaps to a single
 * success card ("Published. <url>" + primary Open + secondary View commit) on
 * `buildConclusion === "success"`, or a failure/retry card otherwise. The swap
 * is NEVER keyed off `isPublishing` (which flips false on commit return, before
 * the build runs — the landmine).
 *
 * @version v1.3.0-beta
 */

import { eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useOutletContext, useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ExternalLink, Pencil, XCircle } from "lucide-react";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useIsConvenor } from "~/hooks/use-role";
import type { Route } from "./+types/_app.publish";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, objects, steps, project_config, project_landing, project_pages, glossary_terms } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getRepoHead } from "~/lib/github.server";
import { requireOwner, resolveActiveProject } from "~/lib/membership.server";
import { recordActivity } from "~/lib/activity.server";
import { signInternalMarker } from "../../workers/auth";
import {
  commitFilesToRepo,
  listWorkflowRunsBySha,
  getJobSteps,
  mapStepsToBuildPhases,
  StaleHeadError,
} from "~/lib/commit.server";
import { healMissingFrameworkFiles } from "~/lib/upgrade.server";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { resolvePublishSteps } from "~/components/features/site-status/build-phase-collapse";
import { PublishingStepper } from "~/components/features/site-status/PublishingStepper";
import {
  computeChangeSummary,
  computeStoryDeletions,
  runPrePublishValidation,
  buildPublishFileSet,
  buildConfigChangeFields,
  buildPageContentHashes,
  buildEntityHashes,
  findEntityMaxUpdatedAt,
  ENTITY_HASHES_VERSION,
} from "~/lib/publish.server";
import type { PublishSnapshot, ChangeSummary, ValidationResult } from "~/lib/publish.server";
import { settingsChangeI18nKey, SETTINGS_CHANGE_FALLBACK_KEY } from "~/lib/settings-change-i18n";
import { Button } from "~/components/ui/Button";
import { DocsLink } from "~/components/ui/DocsLink";
import { ChangeSummary as ChangeSummaryComponent } from "~/components/features/publish/ChangeSummary";
import { ValidationChecks } from "~/components/features/publish/ValidationChecks";
import { CommitMessageEditor } from "~/components/features/publish/CommitMessageEditor";

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
  const modifiedStories = summary.stories.modified.length;
  const deletedStories = summary.stories.deleted.length;
  const newObjects = summary.objects.new.length;
  const modifiedObjects = summary.objects.modified.length;
  const deletedObjects = summary.objects.deleted.length;
  const newPages = summary.pages.new.length;
  const modifiedPages = summary.pages.modified.length;
  const deletedPages = summary.pages.deleted.length;
  const newTerms = summary.glossary.new.length;
  const modifiedTerms = summary.glossary.modified.length;
  const deletedTerms = summary.glossary.deleted.length;

  // In back-compat bootstrap mode the `modified` arrays are noise + signal
  // mixed (every existing entity flagged because the snapshot lacked
  // entity_hashes). We can't separate the user's actual edits from the
  // back-compat flood, so we omit modify_X parts entirely rather than
  // mislead — better to lose per-edit visibility for one publish than to
  // tell the user they modified 47 objects when they only touched one.
  // add_X / remove_X parts ARE reliable in back-compat (legacy story_ids /
  // object_ids / page_slugs let us detect adds and deletes accurately).
  const includeModified = !summary.backCompatBootstrap;

  if (newStories > 0) parts.push(t("auto_commit.add_stories", { count: newStories }));
  if (includeModified && modifiedStories > 0) parts.push(t("auto_commit.modify_stories", { count: modifiedStories }));
  if (deletedStories > 0) parts.push(t("auto_commit.remove_stories", { count: deletedStories }));
  if (newObjects > 0) parts.push(t("auto_commit.add_objects", { count: newObjects }));
  if (includeModified && modifiedObjects > 0) parts.push(t("auto_commit.modify_objects", { count: modifiedObjects }));
  if (deletedObjects > 0) parts.push(t("auto_commit.remove_objects", { count: deletedObjects }));
  if (newPages > 0) parts.push(t("auto_commit.add_pages", { count: newPages }));
  if (includeModified && modifiedPages > 0) parts.push(t("auto_commit.modify_pages", { count: modifiedPages }));
  if (deletedPages > 0) parts.push(t("auto_commit.remove_pages", { count: deletedPages }));
  if (newTerms > 0) parts.push(t("auto_commit.add_terms", { count: newTerms }));
  if (includeModified && modifiedTerms > 0) parts.push(t("auto_commit.modify_terms", { count: modifiedTerms }));
  if (deletedTerms > 0) parts.push(t("auto_commit.remove_terms", { count: deletedTerms }));

  // Settings — first-publish bypass first (single "all" entry preserves the
  // legacy first-publish headline), then per-field naming for incremental
  // changes. The lang entry is special-cased with a target-
  // language form and pushed FIRST within the settings group so it survives
  // the 3-part headline cap when other fields also changed.
  const settingsChanges = summary.settings.changed;
  if (settingsChanges.some((e) => e.key === "all")) {
    parts.push(t("auto_commit.update_settings"));
  } else if (settingsChanges.length > 0) {
    const settingsParts: string[] = [];
    // Value-dependent keys go first so the headline reads with the most
    // significant change up front (language change reads naturally as the
    // primary action). Same ordering used by both surfaces consuming
    // computeChangeSummary so commit subject and Review modal stay aligned.
    // settingsChangeI18nKey is the single source of truth for the i18n key of
    // each entry (lang / collection_mode / nested block on-off / flat field);
    // the popover resolves identical labels via the same helper. The generic
    // fallback guards any future managed field that lacks a dedicated string,
    // so an unmapped key degrades to "update a setting" rather than leaking.
    const resolveSetting = (entry: { key: string; label: string; value?: string }) =>
      t(`auto_commit.${settingsChangeI18nKey(entry)}`, {
        defaultValue: t(`auto_commit.${SETTINGS_CHANGE_FALLBACK_KEY}`),
      });
    const langEntry = settingsChanges.find((e) => e.key === "lang");
    if (langEntry) {
      settingsParts.push(resolveSetting(langEntry));
    }
    for (const entry of settingsChanges) {
      if (entry.key === "lang") continue;
      settingsParts.push(resolveSetting(entry));
    }
    parts.push(...settingsParts);
  }

  if (summary.landing.changed) parts.push(t("auto_commit.update_homepage"));
  if (summary.navigation.changed) parts.push(t("auto_commit.update_nav"));

  const headline = parts.length > 0
    ? parts.slice(0, 3).join(", ").replace(/^./, (c) => c.toUpperCase())
    : t("auto_commit.default_headline");

  return headline;
}

function autoGenerateCommitBody(summary: ChangeSummary, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const includeModified = !summary.backCompatBootstrap;

  // Build per-bucket entry lists. Entries within a section are ordered
  // stories → objects → pages → glossary, matching the change-summary
  // modal's section order so commit body and modal stay aligned.
  const added: string[] = [];
  for (const s of summary.stories.new) added.push(t("auto_commit.entry_story", { title: s.title ?? s.story_id }));
  for (const o of summary.objects.new) added.push(t("auto_commit.entry_object", { title: o.title ?? o.object_id }));
  for (const p of summary.pages.new) added.push(t("auto_commit.entry_page", { title: p.title ?? p.slug }));
  for (const g of summary.glossary.new) added.push(t("auto_commit.entry_term", { title: g.title ?? g.term_id }));

  const changed: string[] = [];
  if (includeModified) {
    for (const s of summary.stories.modified) changed.push(t("auto_commit.entry_story", { title: s.title ?? s.story_id }));
    for (const o of summary.objects.modified) changed.push(t("auto_commit.entry_object", { title: o.title ?? o.object_id }));
    for (const p of summary.pages.modified) changed.push(t("auto_commit.entry_page", { title: p.title ?? p.slug }));
    for (const g of summary.glossary.modified) changed.push(t("auto_commit.entry_term", { title: g.title ?? g.term_id }));
  }

  const removed: string[] = [];
  for (const s of summary.stories.deleted) removed.push(t("auto_commit.entry_story", { title: s.title ?? s.story_id }));
  for (const o of summary.objects.deleted) removed.push(t("auto_commit.entry_object", { title: o.title ?? o.object_id }));
  for (const p of summary.pages.deleted) removed.push(t("auto_commit.entry_page", { title: p.title ?? p.slug }));
  for (const g of summary.glossary.deleted) removed.push(t("auto_commit.entry_term", { title: g.title ?? g.term_id }));

  const sections: string[][] = [];
  if (added.length > 0) sections.push([t("auto_commit.section_added"), ...added]);
  if (changed.length > 0) sections.push([t("auto_commit.section_changed"), ...changed]);
  if (removed.length > 0) sections.push([t("auto_commit.section_removed"), ...removed]);

  // Join sections with a blank line between them; flat sequence within
  // each section.
  const lines: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (i > 0) lines.push("");
    lines.push(...sections[i]);
  }

  // In back-compat bootstrap mode, add a one-time note explaining why
  // the body is sparse — keeps the commit's audit trail honest about
  // why this commit looks different from neighbours, and reassures
  // future-readers that subsequent commits will have full per-edit
  // detail.
  if (summary.backCompatBootstrap) {
    if (lines.length > 0) lines.push("");
    lines.push(t("auto_commit.bootstrap_note"));
  }

  if (lines.length > 0) lines.push("");
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
    // No active project — onboarding, not /dashboard (which loops via /objects).
    return redirect("/onboarding");
  }
  const { project: activeProject } = resolved;

  // Force a DO snapshot before reading D1 — otherwise the change summary is
  // computed against stale rows (e.g. orphan pages from earlier broken
  // deploys) that the publish action's own snapshot will then DELETE before
  // commit, producing a "+ 4 pages" summary against a commit that only
  // creates 2 files. The cost is one DB write per /publish navigation when
  // a DO is alive; if no DO instance is alive (no active collaborators) the
  // call returns 200 without any work. Identical to the action's snapshot
  // call below, just earlier in the request lifecycle.
  try {
    const doId = env.COLLABORATION.idFromName(String(activeProject.id));
    const doStub = env.COLLABORATION.get(doId);
    const { sigHex, timestamp } = await signInternalMarker(
      activeProject.id,
      env.SESSION_SECRET,
      "snapshot",
    );
    const snapshotReq = new Request(`https://internal/snapshot`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(activeProject.id),
      },
    });
    await doStub.fetch(snapshotReq);
  } catch {
    // DO unreachable — fall through to D1 reads with whatever state exists.
  }

  // Fetch display metadata + entity hashes in parallel. buildEntityHashes
  // reads stories/objects/pages/glossary/config/landing internally (plus
  // steps/layers for story hashing) — D1 handles concurrent reads fine,
  // and parallelising shaves the per-page latency we add to the loader.
  // Pages are fetched here only for the empty-slug filter; the config row
  // is fetched here because computeChangeSummary's per-field settings diff
  // needs the raw row, not just its hash.
  const [storyRows, objectRows, pageRows, glossaryRows, configRow, entityHashes] = await Promise.all([
    db.select({ story_id: stories.story_id, title: stories.title, draft: stories.draft })
      .from(stories)
      .where(eq(stories.project_id, activeProject.id)),
    db.select({ object_id: objects.object_id, title: objects.title })
      .from(objects)
      .where(eq(objects.project_id, activeProject.id)),
    db.select({
      slug: project_pages.slug,
      title: project_pages.title,
    })
      .from(project_pages)
      .where(eq(project_pages.project_id, activeProject.id)),
    db.select({ term_id: glossary_terms.term_id, title: glossary_terms.title })
      .from(glossary_terms)
      .where(eq(glossary_terms.project_id, activeProject.id)),
    db.select().from(project_config).where(eq(project_config.project_id, activeProject.id)).limit(1),
    buildEntityHashes(db, activeProject.id),
  ]);

  const config = configRow[0] ?? null;

  const nonDraftStories = storyRows.filter((s) => !s.draft);
  // Filter out empty/whitespace slugs — these never land in the publish
  // commit (see pageRowsToCommitFiles in publish.server.ts) so they
  // shouldn't appear in the diff either. Keeps the change summary
  // consistent with what actually gets pushed to GitHub.
  const committablePages = pageRows
    .map((p) => ({ slug: (p.slug ?? "").trim(), title: p.title }))
    .filter((p) => p.slug.length > 0);

  const currentState = {
    entityHashes,
    config,
    stories: nonDraftStories.map((s) => ({ story_id: s.story_id, title: s.title })),
    objects: objectRows.map((o) => ({ object_id: o.object_id, title: o.title })),
    pages: committablePages,
    glossary: glossaryRows,
    // Full D1 story-id set (drafts + non-drafts) drives the
    // fileChanges section of ChangeSummary so the gate sees draft file
    // adds/removes that the publishable-view diff misses by design.
    allStoryIds: storyRows.map((s) => s.story_id),
  };

  // Guard the snapshot parse. `publish_snapshot` is stored JSON in D1;
  // a partial write or manual DB edit can leave it non-JSON. A raw SyntaxError
  // here would escape the loader and break the whole Publish page render, so
  // treat a corrupt snapshot as "no snapshot" (loud first-publish bootstrap) —
  // consistent with how publish.server.ts wraps every other JSON.parse.
  let snapshot: PublishSnapshot | null = null;
  if (activeProject.publish_snapshot) {
    try {
      snapshot = JSON.parse(activeProject.publish_snapshot) as PublishSnapshot;
    } catch {
      snapshot = null;
    }
  }

  // Silent-bootstrap detection: when the snapshot's entity_hashes is
  // missing OR has a stale version (hash format changed), AND nothing has
  // been edited since the last publish, upgrade the snapshot in place
  // without making a GitHub commit. The user sees a clean "up to date"
  // modal — no flood, no banner, no commit pollution.
  //
  // The version check guards against the same kind of silent re-flood
  // that happened mid-Phase-36-05 when we changed object/page hash
  // inputs without bumping a format marker — old snapshot hashes didn't
  // match new ones, every entity flagged as Modified, and the back-compat
  // path didn't fire because `entity_hashes` was technically present.
  //
  // Active editors (anything edited since last_published_at) take the
  // loud bootstrap path: backCompatBootstrap=true on the ChangeSummary,
  // banner shown in the modal, modify_X parts suppressed in the commit
  // message. They publish once with that mitigated UX, snapshot upgrades
  // as part of the publish action, and subsequent publishes are accurate.
  let effectiveSnapshot: PublishSnapshot | null = snapshot;
  const snapshotIsOutdated =
    snapshot !== null &&
    (snapshot.entity_hashes === undefined ||
      (snapshot.entity_hashes.version ?? 1) !== ENTITY_HASHES_VERSION);
  if (snapshotIsOutdated && activeProject.last_published_at) {
    const maxUpdatedAt = await findEntityMaxUpdatedAt(db, activeProject.id);
    const isIdle = !maxUpdatedAt || maxUpdatedAt <= activeProject.last_published_at;
    if (isIdle) {
      effectiveSnapshot = { ...snapshot!, entity_hashes: entityHashes };
      await db.update(projects).set({
        publish_snapshot: JSON.stringify(effectiveSnapshot),
      }).where(eq(projects.id, activeProject.id));
    }
  }

  const changeSummary = computeChangeSummary(currentState, effectiveSnapshot);

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

  // decrypt runs before the per-intent try/catch blocks below, so its own
  // guard is needed: a corrupted token would otherwise become an uncaught 500
  // for EVERY publish intent (including dismiss-intro, which never uses it).
  let token: string;
  try {
    token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  } catch {
    return { ok: false, intent, error: "auth_failed" };
  }
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

        // Fetch pages for empty-title validation (page_no_title warning)
        const pageRows = await db.select({ slug: project_pages.slug, title: project_pages.title })
          .from(project_pages)
          .where(eq(project_pages.project_id, activeProject.id));

        const validation = runPrePublishValidation({
          headSha: activeProject.head_sha ?? "",
          currentRepoHead,
          stories: storyRows.map((s) => ({ story_id: s.story_id, title: s.title })),
          steps: allSteps,
          objects: objectRows,
          pages: pageRows,
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
          // Sign an internal marker so the DO can reject direct reaches the
          // same way it does for /reset. Without this, the /snapshot path is
          // a defence-in-depth gap if a future code path obtains a stub from
          // outside this server-only action.
          const { sigHex, timestamp } = await signInternalMarker(
            activeProject.id,
            env.SESSION_SECRET,
            "snapshot",
          );
          const snapshotReq = new Request(`https://internal/snapshot`, {
            method: "POST",
            headers: {
              "X-Internal-Auth": sigHex,
              "X-Internal-Timestamp": String(timestamp),
              "X-Internal-Project": String(activeProject.id),
            },
          });
          const snapshotRes = await doStub.fetch(snapshotReq);
          if (!snapshotRes.ok) {
            // Fix #13(B): a non-200 here means the DO's forced snapshot THREW
            // (e.g. a D1-batch failure). Fail closed — publishing now would
            // ship stale D1. The handler converts the throw into this 500 so
            // it is distinguishable from a fetch rejection below.
            return { ok: false, intent: "publish", error: "snapshot_failed" };
          }
        } catch {
          // Fix #13(B): a THROWN fetch means the DO is genuinely unreachable /
          // no instance is alive (no active collaborators — the normal case).
          // Continue: D1 already holds the last persisted state. A snapshot
          // that threw does NOT land here — it returns a 500 handled above.
        }

        // Read the user-content file set and the site's pinned framework version
        // concurrently — the version read (for the heal below) is independent of
        // the file-set assembly, so don't serialise an extra D1 round-trip onto
        // the publish hot path. The version read is self-contained and fail-safe:
        // if it errors, siteVersion is null and the heal simply skips.
        const [files, siteVersion] = await Promise.all([
          buildPublishFileSet({
            token,
            owner,
            repo,
            branch: "main",
            projectId: activeProject.id,
            env,
          }),
          (async (): Promise<string | null> => {
            try {
              const cfgRow = await db
                .select({ telar_version: project_config.telar_version })
                .from(project_config)
                .where(eq(project_config.project_id, activeProject.id))
                .limit(1);
              return cfgRow[0]?.telar_version ?? null;
            } catch (err) {
              console.warn("Framework-file heal: telar_version read failed —", err);
              return null;
            }
          })(),
        ]);

        // Best-effort framework-file heal (issue #18): restore any framework
        // file entirely missing from the user repo (e.g. package-lock.json,
        // which the v1.5.0 `npm ci` build requires). Reaches sites the
        // version-gated upgrade flow can't — it self-redirects when the site is
        // already on the latest framework version. Fail-open: never blocks the
        // publish; a miss retries next publish.
        const healedPaths: string[] = [];
        try {
          const tag = siteVersion
            ? siteVersion.startsWith("v") ? siteVersion : `v${siteVersion}`
            : "";
          const healed = await healMissingFrameworkFiles(token, owner, repo, tag);
          // Additive only — never shadow a user-content file already in the set.
          const existing = new Set(files.map((f) => f.path));
          for (const f of healed) {
            if (!existing.has(f.path)) {
              files.push(f);
              healedPaths.push(f.path);
            }
          }
        } catch (err) {
          // Fail-open: warn, not error — a heal miss is a recoverable skip and
          // must not trip error-level alerts (matches healMissingFrameworkFiles).
          console.warn("Framework-file heal skipped:", err);
        }

        // Hard-deleted stories (present in prior publish's
        // file set, no longer in D1) get their {story_id}.csv deleted on
        // GitHub this publish. Drafts are NOT hard-deletes — they remain in
        // D1 with draft=true and their file is still written by the file-set
        // assembly above. Snapshot is the publish-snapshot loaded earlier
        // in this action (current_snapshot below); we re-derive here to keep
        // the deletion decision adjacent to the commit call. Empty list when
        // no prior snapshot (first publish) or when no stories were removed.
        const currentStoryIdsForDeletion = await db
          .select({ story_id: stories.story_id })
          .from(stories)
          .where(eq(stories.project_id, activeProject.id));
        // Same guard as the loader — a corrupt persisted snapshot
        // would otherwise throw out of the publish action mid-flight.
        let priorSnapshot: PublishSnapshot | null = null;
        if (activeProject.publish_snapshot) {
          try {
            priorSnapshot = JSON.parse(activeProject.publish_snapshot) as PublishSnapshot;
          } catch {
            priorSnapshot = null;
          }
        }
        const deletions = computeStoryDeletions(
          currentStoryIdsForDeletion.map((r) => r.story_id),
          priorSnapshot,
        );

        // Publish always triggers a full build — tiles are deployed via GitHub
        // Pages (artifact upload), so partial workflows can't deploy content.
        const result = await commitFilesToRepo(
          token,
          owner,
          repo,
          "main",
          files,
          commitMessage,
          healedPaths.length > 0
            ? `${commitBody ? `${commitBody}\n\n` : ""}Restored framework files: ${healedPaths.join(", ")}`
            : commitBody,
          deletions.length > 0 ? deletions : undefined,
        );

        const newHeadSha = result.newHeadSha;
        const now = new Date().toISOString();

        // Compute current snapshot for storage. entity_hashes is the new
        // single source of truth for change detection; legacy fields
        // (story_ids, object_ids, page_slugs, page_hashes, config_hash,
        // config_managed, landing_hash, navigation_hash) are dual-written
        // during the transition so a roll-back doesn't lose change-tracking
        // data, and so old snapshots' computeChangeSummary readers keep
        // working until the next publish overwrites the snapshot.
        const [storyRows, objectRows, pageRows, configRow, landingRow, entityHashes] = await Promise.all([
          db.select({ story_id: stories.story_id, draft: stories.draft }).from(stories).where(eq(stories.project_id, activeProject.id)),
          db.select({ object_id: objects.object_id }).from(objects).where(eq(objects.project_id, activeProject.id)),
          db.select({
            slug: project_pages.slug,
            title: project_pages.title,
            body: project_pages.body,
            order: project_pages.order,
          }).from(project_pages).where(eq(project_pages.project_id, activeProject.id)),
          db.select().from(project_config).where(eq(project_config.project_id, activeProject.id)).limit(1),
          db.select().from(project_landing).where(eq(project_landing.project_id, activeProject.id)).limit(1),
          buildEntityHashes(db, activeProject.id),
        ]);

        const config = configRow[0] ?? null;
        const landing = landingRow[0] ?? null;
        const nonDraftStories = storyRows.filter((s) => !s.draft);
        // Mirror the loader's filter — only pages with non-empty trimmed slugs
        // land in the commit, so only those should land in the snapshot.
        const committablePageSlugs = pageRows
          .map((p) => (p.slug ?? "").trim())
          .filter((slug) => slug.length > 0);

        // Per-field managed-fields map — independent of entity_hashes
        // because computeChangeSummary's per-field settings diff uses it
        // (drives lang/title/etc. labels in the commit message).
        const newConfigManaged = config ? buildConfigChangeFields(config) : {};
        let newNavigationHash = "";
        if (config?.navigation_json) {
          try {
            newNavigationHash = hashObject(JSON.parse(config.navigation_json));
          } catch {
            // Malformed — match loader behaviour and store empty.
          }
        }
        const newSnapshot: PublishSnapshot = {
          // story_ids keeps its legacy semantics — non-drafts only — to preserve
          // the diffEntities back-compat naming layer (drafts must not surface
          // in the commit-message's added/removed stories list).
          story_ids: nonDraftStories.map((s) => s.story_id),
          // Track every story whose {story_id}.csv was written
          // by buildPublishFileSet (draft + non-draft). Drives accurate
          // hard-delete detection on the next publish via computeStoryDeletions.
          all_story_ids: storyRows.map((s) => s.story_id),
          object_ids: objectRows.map((o) => o.object_id),
          page_slugs: committablePageSlugs,
          page_hashes: buildPageContentHashes(pageRows),
          config_hash: config ? hashObject(newConfigManaged) : "",
          config_managed: newConfigManaged,
          landing_hash: landing ? hashObject({
            stories_heading: landing.stories_heading,
            stories_intro: landing.stories_intro,
            objects_heading: landing.objects_heading,
            objects_intro: landing.objects_intro,
            welcome_body: landing.welcome_body,
          }) : "",
          navigation_hash: newNavigationHash,
          entity_hashes: entityHashes,
        };

        await db.update(projects).set({
          published_sha: newHeadSha,
          head_sha: newHeadSha,
          last_published_at: now,
          publish_snapshot: JSON.stringify(newSnapshot),
          updated_at: now,
          gh_checked_at: null,
        }).where(eq(projects.id, activeProject.id));

        // Activity feed: one site-level row per publish.
        // Actor is the server-resolved authenticated user.id. Fails open.
        await recordActivity(db, {
          projectId: activeProject.id,
          actorUserId: user.id,
          verb: "published",
          entityType: "site",
          entityLabel: config?.title ?? null,
        });

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
  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};
  const appData = useRouteLoaderData("routes/_app") as
    | { repoUnavailable?: boolean; repoFullName?: string | null }
    | null;
  const repoUnavailable = appData?.repoUnavailable ?? false;
  const repoFullName = appData?.repoFullName ?? null;
  const { t } = useTranslation("publish");
  const { project, changeSummary } = loaderData;

  // Role read via the typed loader hook (replaces the ad-hoc useRouteLoaderData
  // cast). Collaborators are redirected away from /publish by the routes/_app
  // loader guard (→ /objects?denied=publish), so this is a belt-and-braces
  // don't-render: a collaborator never reaches this component, but if they did
  // we render nothing rather than a restriction notice. Render-gating is a
  // UX layer only — the publish action is enforced convenor-only server-side.
  const isConvenor = useIsConvenor();
  if (!isConvenor) return null;

  const { provider } = useCollaborationContext();

  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [publishResult, setPublishResult] = useState<{ newHeadSha: string; commitUrl: string } | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Commit-message editing: the mono card shows the auto-generated message
  // by default; the textarea (CommitMessageEditor) is revealed only on click.
  // `editedMessage` overrides the auto-generated message once the user touches
  // it.
  const [isEditingMessage, setIsEditingMessage] = useState(false);
  const [editedMessage, setEditedMessage] = useState<string | null>(null);

  // Clear the publish awareness fields on TRUE unmount. Without this, a user who
  // starts a publish and navigates away from /publish before it resolves leaves
  // this client's awareness pinned at `publishing: true` — the global pill reads
  // isPublishing off awareness and it dominates precedence, so the pill would
  // stay stuck in "Publishing…" until the socket reconnects. Empty deps so
  // the cleanup runs only on unmount; the latest provider is read from a ref.
  const providerRef = useRef(provider);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);
  useEffect(() => {
    return () => {
      const p = providerRef.current;
      if (!p) return;
      p.awareness.setLocalStateField("publishing", false);
      p.awareness.setLocalStateField("building", false);
      p.awareness.setLocalStateField("publishError", false);
      p.awareness.setLocalStateField("publishSha", null);
      p.awareness.setLocalStateField("publishCommitUrl", null);
    };
  }, []);

  const validationFetcher = useFetcher();
  const publishFetcher = useFetcher();
  // Headless build-complete poll. This
  // page is where the success card lives, so it owns the poll loop that watches
  // the GitHub Actions build to completion — the Site Status pill drives the
  // build chrome, but the pill's `isPublishing` flips false on commit return
  // (before the build runs), so the page cannot read completion off awareness.
  const pollFetcher = useFetcher();

  const validationData = validationFetcher.data as PublishActionData;
  const publishData = publishFetcher.data as PublishActionData;
  const pollData = pollFetcher.data as PublishActionData;

  // Build-completion state, driven only by the headless poll (never by
  // isPublishing — the landmine). `buildStatus === "completed"` stops the loop;
  // `buildConclusion` then decides success vs failure card.
  const [buildStatus, setBuildStatus] = useState<string>("pending");
  const [buildConclusion, setBuildConclusion] = useState<string | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  // The 6 real BUILD_PHASES from the headless poll, kept so the inline tracker
  // (PublishingStepper) shows live per-step progress. Null until the first poll
  // lands; resolvePublishSteps synthesises a dispatching state.
  const [buildPhases, setBuildPhases] = useState<BuildPhaseStatus[] | null>(null);
  const isBuildComplete = buildStatus === "completed";

  // Broadcast publish state to all connected clients via Yjs awareness.
  // The SHA/commitUrl are lifted off-route here so the global
  // Site Status pill's PublishingPopover can drive the existing poll-build
  // loop from any route — they survive navigation away from /publish.
  // Declared after isBuildComplete because the "building" field depends on it.
  useEffect(() => {
    if (!provider) return;
    provider.awareness.setLocalStateField("publishing", isPublishing);
    // "building" stays true from commit-success (publishResult set) until the
    // build completes — keeping the Site Status pill in "publishing" through the
    // build (isPublishing flips false on commit return). Separate from
    // isPublishing so the page/UI freeze (Header) is NOT held for the whole build.
    provider.awareness.setLocalStateField("building", !!publishResult && !isBuildComplete);
    provider.awareness.setLocalStateField("publishError", publishError !== null);
    provider.awareness.setLocalStateField("publishSha", publishResult?.newHeadSha ?? null);
    provider.awareness.setLocalStateField("publishCommitUrl", publishResult?.commitUrl ?? null);
  }, [isPublishing, publishError, publishResult, isBuildComplete, provider]);

  // The live published-site URL for the success card's primary Open button.
  // Falls back to the default GitHub Pages pattern when github_pages_url isn't
  // persisted yet (older imports, sites that never ran configure-site).
  const pagesUrl =
    project.github_pages_url ??
    (() => {
      const [owner, repo] = project.github_repo_full_name.split("/");
      return `https://${owner.toLowerCase()}.github.io/${repo}`;
    })();

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

  // Process headless poll-build results. Mirrors BuildTracker's poll-result
  // handling minus the per-phase UI state (the pill owns the phase log). Once
  // buildStatus is "completed" we latch the conclusion and the loop stops.
  useEffect(() => {
    if (!pollData?.ok || pollData.intent !== "poll-build") return;
    if (pollData.buildUrl) setBuildUrl(pollData.buildUrl);
    if (pollData.runId != null) setRunId(pollData.runId);
    if (pollData.phases) setBuildPhases(pollData.phases as BuildPhaseStatus[]);
    setBuildStatus(pollData.buildStatus);
    if (pollData.buildStatus === "completed") {
      setBuildConclusion(pollData.buildConclusion);
    }
  }, [pollData]);

  // Headless poll loop (harvested from BuildTracker.tsx:153-194, with the
  // runId ref-threading idiom from PublishingPopover.tsx:94-122 so later polls
  // carry runId without the interval closing over a stale null). Fires only
  // after a successful commit (publishResult set), immediately then every 5s,
  // and stops when the build completes. NOT gated on isPublishing.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runIdRef = useRef<number | null>(runId);
  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);
  useEffect(() => {
    const sha = publishResult?.newHeadSha;
    if (!sha || isBuildComplete) {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      return;
    }
    function doPoll() {
      const formData: Record<string, string> = { intent: "poll-build", sha: sha as string };
      if (runIdRef.current != null) formData.runId = String(runIdRef.current);
      pollFetcher.submit(formData, { method: "post" });
    }
    doPoll();
    pollIntervalRef.current = setInterval(doPoll, 5000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishResult?.newHeadSha, isBuildComplete]);

  // Belt-and-braces: clear the poll interval on unmount.
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Run validation automatically on MOUNT (single-page render — all three
  // sections are visible at once, so the "What we checked" section needs its
  // result without a wizard step transition). Guarded by a ref so it fires
  // exactly once per page mount.
  const hasRunValidationRef = useRef(false);
  useEffect(() => {
    if (hasRunValidationRef.current) return;
    if (repoUnavailable) return;
    hasRunValidationRef.current = true;
    validationFetcher.submit({ intent: "run-validation" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setIsEditingMessage(false);
    setEditedMessage(null);
    // Reset the headless build-poll state so a re-publish starts a fresh poll.
    setBuildStatus("pending");
    setBuildConclusion(null);
    setBuildUrl(null);
    setRunId(null);
    setBuildPhases(null);
    hasRunValidationRef.current = false;
  }

  const isUpToDate = changeSummary.isUpToDate;
  const publishDisabled = isPublishing || hasBlockers || isUpToDate;

  // Post-commit swap is gated on the headless poll's build conclusion, NEVER on
  // isPublishing (honest over snappy). Until the build completes, an
  // honest "Publishing…" inline state points at the Site Status pill.
  const buildSucceeded = isBuildComplete && buildConclusion === "success";
  const buildFailed = isBuildComplete && buildConclusion !== "success";

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-3">
        {t("title")}
      </h1>

      <div className="space-y-2 mb-6 max-w-2xl">
        <p className="text-sm font-body text-charcoal/70">{t("intro")}</p>
        {openDoc && <DocsLink docId="publish" onOpenDoc={openDoc} />}
      </div>

      {/* Post-commit: the in-route BuildTracker is gone —
          the Site Status pill owns the 5-row build chrome via the awareness
          broadcast. This page shows an honest "Publishing…" inline state while
          a headless poll watches the build, then a single success/failure
          card on real completion. Never claims "Published" before the build
          conclusion is success. */}
      {repoUnavailable ? (
        <div className="py-4">
          <div className="rounded-lg bg-terracotta-pale border border-terracotta px-6 py-8 text-center">
            <AlertTriangle className="w-12 h-12 text-terracotta mx-auto mb-3" aria-hidden="true" />
            <h2 className="font-heading font-bold text-xl text-charcoal-deep mb-2">
              {t("repo_unavailable.heading")}
            </h2>
            <p className="font-body text-sm text-charcoal mb-1">
              {t("repo_unavailable.lead", { repo: repoFullName ?? "" })}
            </p>
            <p className="font-body text-sm text-charcoal/70 max-w-md mx-auto mb-6">
              {t("repo_unavailable.body")}
            </p>
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:opacity-90 text-cream rounded-full px-6 py-2.5 transition-opacity"
            >
              {t("repo_unavailable.manage_cta")}
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      ) : publishResult ? (
        <div className="py-4">
          {buildSucceeded ? (
            /* === SUCCESS CARD === */
            <div className="rounded-lg bg-chilca-pale border border-chilca px-6 py-8 text-center">
              <CheckCircle2 className="w-12 h-12 text-chilca mx-auto mb-3" />
              <h2 className="font-heading font-bold text-xl text-charcoal-deep mb-6 break-words">
                {t("success_card.heading", { url: pagesUrl })}
              </h2>
              <div className="flex flex-col items-center justify-center gap-3">
                <a
                  href={pagesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-heading font-semibold text-sm uppercase tracking-wider bg-anil hover:bg-anil-hover text-charcoal rounded-full px-6 py-2.5 transition-colors"
                >
                  {t("success_card.open")}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <a
                  href={publishResult.commitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-body text-sm text-anil-ink hover:underline"
                >
                  {t("success_card.view_commit")}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          ) : buildFailed ? (
            /* === FAILURE / RETRY CARD === */
            <div className="rounded-lg bg-terracotta-pale border border-terracotta px-6 py-8 text-center">
              <XCircle className="w-12 h-12 text-terracotta mx-auto mb-3" />
              <h2 className="font-heading font-bold text-xl text-charcoal-deep mb-2">
                {t("failure_card.heading")}
              </h2>
              <p className="font-body text-sm text-charcoal/70 mb-6">
                {t("failure_card.description")}
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                {buildUrl && (
                  <a
                    href={buildUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-body text-sm text-anil-ink hover:underline"
                  >
                    {t("failure_card.view_actions")}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <Button type="button" variant="primary" onClick={handleRetry}>
                  {t("failure_card.try_again")}
                </Button>
              </div>
            </div>
          ) : (
            /* === PUBLISHING… INLINE TRACKER (honest — live horizontal stepper) ===
               The horizontal PublishingStepper shows the 7-step build progress
               driven by the page's own headless build poll. Terminal states use
               the success/failure cards above (never claim "Published"
               before the real build conclusion). */
            (() => {
              const { steps, activeStep, totalSteps } = resolvePublishSteps(buildPhases);
              return (
                <PublishingStepper
                  steps={steps}
                  activeStep={activeStep}
                  totalSteps={totalSteps}
                  buildUrl={buildUrl}
                />
              );
            })()
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {/* === WHAT'S CHANGING === */}
          <section>
            <h2 className="font-heading font-semibold text-lg text-charcoal mb-3">
              {t("sections.whats_changing")}
            </h2>
            {isUpToDate ? (
              <div className="flex flex-col items-center justify-center py-10 text-center bg-cream rounded-lg border border-cream-dark">
                <p className="font-heading font-semibold text-charcoal mb-1">
                  {t("review.up_to_date")}
                </p>
                <p className="font-body text-sm text-charcoal/60">
                  {t("review.up_to_date_description")}
                </p>
              </div>
            ) : (
              <ChangeSummaryComponent summary={changeSummary} />
            )}
          </section>

          {/* === WHAT WE CHECKED === */}
          <section>
            <h2 className="font-heading font-semibold text-lg text-charcoal mb-3">
              {t("sections.what_we_checked")}
            </h2>
            <ValidationChecks validation={validationResult} />
          </section>

          {/* === PUBLISH === */}
          <section className="rounded-lg bg-terracotta px-6 py-5">
            <h2 className="font-heading font-semibold text-lg text-cream mb-4">
              {t("sections.publish")}
            </h2>

            {publishError && (
              <div className="bg-cream border border-terracotta-deep rounded-lg p-3 mb-4">
                <p className="font-body text-sm text-terracotta-deep">{publishError}</p>
              </div>
            )}

            {isEditingMessage ? (
              <div className="rounded-lg bg-cream px-4 py-3">
                <CommitMessageEditor
                  defaultMessage={editedMessage ?? autoGeneratedMessage}
                  onPublish={handlePublish}
                  loading={isPublishing}
                />
              </div>
            ) : (
              <>
                <label className="block font-body text-sm text-cream/90 mb-1.5">
                  {t("publish_section.commit_message_label")}
                </label>
                <pre className="rounded-lg bg-cream text-charcoal font-mono text-sm whitespace-pre-wrap break-words px-4 py-3 mb-4">
                  {editedMessage ?? autoGeneratedMessage}
                </pre>

                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setIsEditingMessage(true)}
                    disabled={isPublishing}
                    className="inline-flex items-center gap-1.5 font-heading text-sm text-cream underline-offset-2 hover:underline disabled:opacity-60"
                  >
                    <Pencil className="w-4 h-4" />
                    {t("publish_section.edit_message")}
                  </button>

                  <Button
                    type="button"
                    variant="primary"
                    loading={isPublishing}
                    disabled={publishDisabled}
                    onClick={() => handlePublish(editedMessage ?? autoGeneratedMessage)}
                  >
                    {t("publish_section.publish_now")}
                  </Button>
                </div>
              </>
            )}

            {hasBlockers && !isEditingMessage && (
              <p className="font-body text-sm text-cream/90 mt-3">
                {t("publish_section.blocked_note")}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
