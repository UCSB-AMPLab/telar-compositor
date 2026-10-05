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
 * Action handles five intents (a `clientAction` answers a `poll-build` or a
 * `run-validation` that fails in transit as unreachable, and passes every
 * other intent through):
 *   - `run-validation` — runs pre-publish checks and returns
 *     `ValidationResult`
 *   - `publish` — refuses first on a site behind the latest release or a
 *     latest release that cannot be read (see `~/lib/upgrade-gate.server`),
 *     then assembles the full file set, commits, updates D1, returns the new
 *     SHA
 *   - `poll-build` — polls GitHub Actions and returns the build
 *     status/conclusion, named with the sha it answers for (driven headless by
 *     this page's poll loop)
 *   - `dismiss-intro` — no-op (dismissal handled client-side via
 *     localStorage)
 *   - `repair-build-workflow` — commits the framework's `build.yml` over a
 *     workflow that cannot protect the site's private stories; the rebuild that
 *     commit starts is followed by a `poll-build` poll of the repair's own,
 *     shown in the checks section's repair line and nowhere else
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
 * @version v1.5.0-beta
 */

import { eq } from "drizzle-orm";
import { glossarySheetOrder } from "~/lib/glossary-order.server";
import { useEffect, useRef, useState } from "react";
import { redirect, useOutletContext, useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ExternalLink, Pencil, XCircle } from "lucide-react";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { postToCollaborationDO } from "~/lib/internal-marker.server";
import { storyColumnDetail, tableColumnDetail } from "~/lib/story-columns";
import { deletedStoryLayerFiles, renamedStorySheets, sheetsOfStoriesWritten } from "~/lib/story-left-files.server";
import { keptChangedWarnings, owedStoryDeletions, parseOwedStoryFiles } from "~/lib/story-files-to-delete.server";
import { publishedStorySheetWrites } from "~/lib/story-source-path.server";
import { useIsPublisher } from "~/hooks/use-role";
import type { Route } from "./+types/_app.publish";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, objects, steps, layers, project_config, project_landing, project_pages, glossary_terms } from "~/db/schema";
import { decrypt } from "~/lib/crypto.server";
import { checkRepoAvailability, getFileAtRef, getRepoHead, GitHubPermissionError } from "~/lib/github.server";
import type { FileAtRef } from "~/lib/github.server";
import { requirePublishingRole } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest, resolvePageProject, siteChangedAnswer } from "~/lib/active-project.server";
import { useSiteFetcher } from "~/lib/page-site";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { recordActivity } from "~/lib/activity.server";
import { signInternalMarker } from "../../workers/auth";
import type { LeaseOutcome } from "../../workers/freeze-lease";
import { controlFreezeLease, newFreezeOperationId } from "~/lib/freeze-lease.server";
import { useOperationLock } from "~/hooks/use-operation-lock";
import { OperationLockNotice } from "~/components/features/collaboration/OperationLockNotice";
import {
  commitFilesToRepo,
  listWorkflowRunsBySha,
  getJobSteps,
  isRepoPrivate,
  mapStepsToBuildPhases,
  StaleHeadError,
} from "~/lib/commit.server";
import { fetchFrameworkFilesAtVersion, healMissingFrameworkFiles } from "~/lib/upgrade.server";
import { getInstallationInfo, getInstallationToken, resolveProjectToken } from "~/lib/github-app.server";
import { capturePagesOnLoad } from "~/lib/page-capture.server";
import { snapshotSettledOnLoad, storeWrittenPageFrontmatter } from "~/lib/page-written-frontmatter.server";
import { bumpProjectHeadFrom, headAdvancedFrom, objectsReadAdvancedFrom } from "~/lib/github-status.server";
import { heldPagesRecord, pageFilesRecordAdvancedFrom, recordedPageDeletions } from "~/lib/page-files-record.server";
import { parsePageFilesRecord, serialisePageFilesRecord } from "~/lib/page-files-record";
import { commitOnOwnToken } from "~/lib/publish-commit-token.server";
import { repairBuildWorkflow } from "~/lib/build-workflow.server";
import { readRepoWriteGate, type RepoWriteGate } from "~/lib/upgrade-gate.server";
import { normalizeVersionTag } from "~/lib/version";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { resolvePublishSteps } from "~/components/features/site-status/build-phase-collapse";
import { PublishingStepper } from "~/components/features/site-status/PublishingStepper";
import {
  computeChangeSummary,
  computeStoryDeletions,
  olderStoryCopies,
  deletedStoryDataCopies,
  computePageDeletions,
  carriedPageDeletions,
  clearCarriedPageSources,
  runPrePublishValidation,
  stepLayersForValidation,
  buildPublishFileSet,
  buildConfigChangeFields,
  buildPageContentHashes,
  buildEntityHashes,
  readPublishPages,
  readPublishLanding,
  findEntityMaxUpdatedAt,
  ENTITY_HASHES_VERSION,
  UnwritableConfigBlockError,
  UnreadablePageError,
  UnreadablePublishFileError,
  UnreadableProjectCsvError,
  UnwritablePageFrontmatterError,
  StoryColumnsBlockedError,
  withCarriedFrontmatter,
  pageFrontmatterReplacedWarnings,
  replacedSettingsKey,
  withReplacedSettings,
} from "~/lib/publish.server";
import type {
  PublishSnapshot,
  ChangeSummary,
  ReplacedSettings,
  ValidationItem,
  ValidationResult,
  RemovableColumns,
  StepForValidation,
  StepLayerForValidation,
} from "~/lib/publish.server";
import { settingsChangeI18nKey, SETTINGS_CHANGE_FALLBACK_KEY } from "~/lib/settings-change-i18n";
import { Button } from "~/components/ui/Button";
import { DocsLink } from "~/components/ui/DocsLink";
import { ChangeSummary as ChangeSummaryComponent } from "~/components/features/publish/ChangeSummary";
import { ValidationChecks, ValidationWarnings } from "~/components/features/publish/ValidationChecks";
import type {
  WorkflowRepair,
  WorkflowRepairBuild,
  WorkflowRepairStatus,
} from "~/components/features/publish/ValidationChecks";
import { CommitMessageEditor } from "~/components/features/publish/CommitMessageEditor";
import { recordPublishFailure } from "~/lib/publish-failure-capture";
import { deriveWorkflowRepairBuild, type RepairPollSnapshot } from "~/lib/workflow-repair-build";
import { ObjectsCommitUnready, ObjectsSheetChanged, prepareObjectsCommit } from "~/lib/pending-object-ops.server";
import { KeptColumnsRefusal, captureKeptColumns } from "~/lib/kept-columns-capture.server";
import { renamedColumnWarningsAt } from "~/lib/renamed-columns.server";
import { sheetWarningChecksAt } from "~/lib/sheet-warning-checks.server";
import { configSheets } from "~/lib/unreadable-characters.server";
import { CORRECTS_HEADINGS, headingFilesOf, headingsHeadline } from "~/lib/sheet-warnings";
import { spanishSheetCounterparts } from "~/lib/site-sheets.server";
import { wait } from "~/lib/wait";
import { answerReadsWhenUnreachable, isUnreachableAnswer } from "~/lib/unreachable-write";

export const handle = { i18n: ["common", "publish", "team"] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashObject(obj: unknown): string {
  return JSON.stringify(obj);
}

/**
 * Key-order-independent copy of a value, so two reads of the same D1 state
 * fingerprint identically however the rows came back.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalise(source[key]);
    return out;
  }
  return value;
}

/**
 * A digest of the state a change summary was computed from.
 *
 * The auto-generated commit message is an inventory of that summary, and it
 * outlives the page: it becomes GitHub's permanent record of what the commit
 * contained, and nothing later can correct it. The loader builds the summary
 * behind its own forced snapshot; the action forces another and publishes
 * whatever D1 holds after that, so a collaborator's edits can land in the
 * commit while the message goes on describing the state before them.
 *
 * Stamping the state lets the action ask one question — is this still the
 * state the message describes? — without keeping a second copy of the loader's
 * summary assembly, which is the drift this codebase keeps paying for.
 *
 * Covers everything `computeChangeSummary` reads: `entityHashes` carries
 * stories, objects, pages, glossary, navigation, landing and the managed
 * settings fields; `allStoryIds` adds the drafts the hashes exclude by design;
 * the prior publish snapshot is the other operand of the diff.
 */
async function fingerprintSummaryState(input: {
  entityHashes: unknown;
  allStoryIds: readonly string[];
  priorSnapshot: PublishSnapshot | null;
}): Promise<string> {
  const canonical = JSON.stringify(
    canonicalise({
      entityHashes: input.entityHashes,
      storyIds: [...input.allStoryIds].sort(),
      priorSnapshot: input.priorSnapshot,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The sentence a refused publish shows, by the code the action returned.
 *
 * A Map, because the lookup key is a string from a response body: asking a
 * plain object whether it has a key reaches `Object.prototype`, where
 * `constructor` is a hit.
 *
 * A code absent from here shows the generic build failure, which says nothing
 * about what happened — so a refusal the author is meant to understand needs a
 * line here and a string in both catalogues, not only a code in the action.
 */
const PUBLISH_ERROR_KEYS = new Map<string, string>([
  ["stale_head", "build.stale_head_error"],
  ["snapshot_failed", "build.snapshot_failed"],
  ["snapshot_unreachable", "build.snapshot_unreachable"],
  ["snapshot_incomplete", "build.snapshot_incomplete"],
  ["validation_blocked", "build.validation_blocked"],
  ["config_unreadable", "build.config_unreadable"],
  ["page_unreadable", "build.page_unreadable"],
  ["operation_in_progress", "build.operation_in_progress"],
  ["publish_failed", "build.publish_failed_description"],
  ["github_permission", "build.github_permission"],
  ["release_unknown", "release_unknown"],
  ["objects_unreadable", "build.objects_unreadable"],
  ["objects_unregistered", "build.objects_unregistered"],
  ["landing_unreadable", "build.landing_unreadable"],
  ["glossary_unreadable", "build.glossary_unreadable"],
  ["project_unreadable", "build.project_unreadable"],
  ["changed_during_publish", "build.changed_during_publish"],
  ["stories_unreadable", "build.stories_unreadable"],
]);

/**
 * Where a publish on a site behind the latest release goes instead, as the
 * `_app` loader sends the page: to the upgrade, or, for a collaborator whose
 * upgrade only the convenor can complete, back to Objects. Null for any
 * other gate.
 */
function publishGateRedirect(gate: RepoWriteGate): string | null {
  if (gate === "upgrade_required") return `/upgrade?from=${encodeURIComponent("/publish")}`;
  if (gate === "upgrade_awaits_convenor") return "/objects";
  return null;
}

/**
 * The publish form field naming, as a JSON list of `replacedSettings`, the
 * page and stored block of each `page_frontmatter_replaced` warning the page
 * showed the author.
 */
const ACKNOWLEDGED_REPLACED_PAGES = "acknowledgedReplacedPages";

/** The refusal of a publish that would replace settings the author was not warned of. */
const REPLACED_PAGES_UNACKNOWLEDGED = "page_frontmatter_unacknowledged";

/**
 * The settings a publish request says the author was warned of, by
 * `replacedSettingsKey`; none for a missing or malformed field or entry.
 */
function acknowledgedReplacedPages(formData: FormData): Set<string> {
  const raw = formData.get(ACKNOWLEDGED_REPLACED_PAGES);
  if (typeof raw !== "string") return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(isReplacedSettings).map(replacedSettingsKey));
  } catch {
    return new Set();
  }
}

function isReplacedSettings(entry: unknown): entry is ReplacedSettings {
  if (typeof entry !== "object" || entry === null) return false;
  const { pageId, fingerprint } = entry as Record<string, unknown>;
  return typeof pageId === "number" && typeof fingerprint === "string";
}

/** Gap before each retry of the post-commit D1 write, in order. */
const LANDED_PUBLISH_RETRY_DELAYS_MS = [100, 300];
const LANDED_PUBLISH_MAX_TRIES = LANDED_PUBLISH_RETRY_DELAYS_MS.length + 1;

/**
 * Writes the `db.update(projects)` that records a landed publish —
 * `published_sha`, `head_sha`'s compare-and-set, `last_published_at` and
 * `publish_snapshot` — in one batch with the record of each story's file
 * (`publishedStorySheetWrites`), retrying on a short pause when D1 refuses it.
 * A story record that missed while the rest landed would leave a story
 * claiming a file the publish gave another, which the next publish lays out
 * from.
 *
 * The commit has already landed by the time this runs, so a throw here must
 * never reach the action's catch: the batch is idempotent, and a repeat after
 * a transient failure is safe. If every try fails, the miss is logged once,
 * named by project and commit, and swallowed: the head, the snapshot and the
 * story records then stay at the previous publish until a sync check or the
 * next publish records them.
 */
async function recordLandedPublish(
  db: ReturnType<typeof getDb>,
  projectId: number,
  write: Record<string, unknown>,
  newHeadSha: string,
  storiesWritten: ReadonlyArray<{ id: number; story_id: string }>,
): Promise<void> {
  for (let attempt = 0; attempt < LANDED_PUBLISH_MAX_TRIES; attempt++) {
    try {
      const landed = db.update(projects).set(write).where(eq(projects.id, projectId));
      const records = publishedStorySheetWrites(db, projectId, storiesWritten);
      if (records.length === 0) await landed;
      else await db.batch([landed, ...records]);
      return;
    } catch (err) {
      if (attempt === LANDED_PUBLISH_MAX_TRIES - 1) {
        console.error("[publish] record of a landed commit failed", { projectId, commit: newHeadSha, err });
        return;
      }
      await wait(LANDED_PUBLISH_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** The headline is everything before the first blank line; the body is what follows it. */
function splitCommitMessage(fullMessage: string): { commitMessage: string; commitBody: string | undefined } {
  const blankLineIdx = fullMessage.indexOf("\n\n");
  if (blankLineIdx === -1) return { commitMessage: fullMessage, commitBody: undefined };
  return { commitMessage: fullMessage.slice(0, blankLineIdx), commitBody: fullMessage.slice(blankLineIdx + 2) };
}

/** One entry per page and block named by a settings-replaced warning. */
function replacedSettingsOf(warnings: readonly ValidationItem[]): ReplacedSettings[] {
  const warned = new Map<string, ReplacedSettings>();
  for (const warning of warnings) {
    const settings = warning.code === "page_frontmatter_replaced" ? warning.replacedSettings : undefined;
    if (settings) warned.set(`${settings.pageId}:${settings.fingerprint}`, { pageId: settings.pageId, fingerprint: settings.fingerprint });
  }
  return [...warned.values()];
}

/**
 * The answer a publish gives for what it threw before or during its commit.
 *
 * A managed block the writer cannot edit, in a file that changed between the
 * check and the write, reports as a blocked validation rather than a failed
 * commit because that is what it is, and because reloading runs the check
 * that names the block; a page whose front matter cannot take its title,
 * and a story whose columns as the file set read them are refused, report the
 * same way, for the same reason. A page file that could not be read to carry its front
 * matter forward stops the publish before anything is written, so the author
 * can retry.
 */
/**
 * The refusal for a file the publish could not read: index.md, glossary.csv,
 * project.csv or a story CSV, or the story CSVs could not be listed, and the
 * file written without it would drop what it carries. project.csv read to find
 * the stories deleted since it was written is the same refusal, named for what
 * the author sees.
 */
function unreadableFileError(err: unknown): string | null {
  if (err instanceof UnreadableProjectCsvError) return "project_unreadable";
  if (err instanceof UnreadablePublishFileError) return `${err.file}_unreadable`;
  return null;
}

function publishFailure(err: unknown, projectId: number) {
  if (err instanceof StaleHeadError) {
    return { ok: false, intent: "publish", error: "stale_head", projectId };
  }
  if (
    err instanceof UnwritableConfigBlockError ||
    err instanceof UnwritablePageFrontmatterError ||
    err instanceof StoryColumnsBlockedError
  ) {
    return { ok: false, intent: "publish", error: "validation_blocked", projectId };
  }
  if (err instanceof UnreadablePageError) {
    return { ok: false, intent: "publish", error: "page_unreadable", projectId };
  }
  const unreadable = unreadableFileError(err);
  if (unreadable) return { ok: false, intent: "publish", error: unreadable, projectId };
  // objects.csv could not be read, or an objects operation still owed could
  // not be finished: either way the file written from D1 would drop objects.
  if (err instanceof ObjectsCommitUnready) {
    return { ok: false, intent: "publish", error: `objects_${err.reason}`, projectId };
  }
  // A row D1 holds under a stripped id GitHub writes padded, before the
  // project's ids were repaired: the sync repairs it, so the author is sent
  // there as for a head that moved.
  if (err instanceof ObjectsSheetChanged) {
    return { ok: false, intent: "publish", error: "stale_head", projectId };
  }
  // The kept columns a story CSV holds and D1 never recorded could not be
  // read, or were not taken into the document, and the file written from D1
  // would drop them; or the story changed after they were read.
  if (err instanceof KeptColumnsRefusal) {
    return { ok: false, intent: "publish", error: err.code, projectId };
  }
  // GitHub refused the credential the commit ran on. A retry changes nothing,
  // and it is not a fault in the site.
  if (err instanceof GitHubPermissionError) {
    return { ok: false, intent: "publish", error: "github_permission", projectId };
  }
  return { ok: false, intent: "publish", error: "publish_failed", projectId };
}

/**
 * After a failed publish: stores the repository's current name if GitHub says
 * it was renamed, so the author's next publish runs against the right one
 * instead of waiting for the status poll to heal it. Never throws; the
 * failure being answered is the one that matters.
 */
async function healRenamedRepo(
  db: ReturnType<typeof getDb>,
  token: string,
  project: { id: number; github_repo_full_name: string | null },
): Promise<void> {
  const [owner, repo] = (project.github_repo_full_name ?? "").split("/");
  if (!owner || !repo) return;
  try {
    const { canonicalFullName } = await checkRepoAvailability(token, owner, repo);
    if (canonicalFullName && canonicalFullName !== project.github_repo_full_name) {
      await db.update(projects).set({ github_repo_full_name: canonicalFullName }).where(eq(projects.id, project.id));
    }
  } catch (healErr) {
    console.warn("[publish] could not check the repository's name after a failure", healErr);
  }
}

function publishErrorMessage(
  t: (key: string) => string,
  error: string | undefined,
): string {
  return t(PUBLISH_ERROR_KEYS.get(error ?? "") ?? "build.failed_description");
}

/** The headline for a publish with no listed change: the heading correction when headings are to be corrected, else the neutral one. */
function emptyHeadline(headingFiles: readonly string[], t: (key: string) => string): string {
  return t(headingFiles.length > 0 ? "auto_commit.correct_headings" : "auto_commit.default_headline");
}

/** The config text without its byte-order mark, or null when the file was not read. */
function configTextWithoutBom(file: FileAtRef): string | null {
  return file.status === "ok" ? file.content.replace(/^\uFEFF/, "") : null;
}

/** Whether the page has nothing to publish: up to date, and no headings for a publish to correct. */
function nothingToPublish(isUpToDate: boolean, headingFiles: readonly string[]): boolean {
  return isUpToDate && headingFiles.length === 0;
}

/** Marks the submission as claiming a heading correction when its headline is the one that says so. */
function claimHeadingsCorrected(fields: Record<string, string>, headline: string, t: (key: string) => string): void {
  if (headline === t("auto_commit.correct_headings")) fields[CORRECTS_HEADINGS] = "1";
}

function autoGenerateCommitMessage(
  summary: ChangeSummary,
  t: (key: string, opts?: Record<string, unknown>) => string,
  headingFiles: readonly string[] = [],
): string {
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

  parts.push(...structureParts(summary, t));

  if (parts.length === 0) return emptyHeadline(headingFiles, t);
  const headline = parts.slice(0, 3).join(", ").replace(/^./, (c) => c.toUpperCase());

  return headline;
}

/** The commit message's parts for the homepage, the navigation menu and the order of objects. */
function structureParts(summary: ChangeSummary, t: (key: string) => string): string[] {
  const flags: Array<[boolean, string]> = [
    [summary.landing.changed, "auto_commit.update_homepage"],
    [summary.navigation.changed, "auto_commit.update_nav"],
    [summary.objectOrder.changed, "auto_commit.reorder_objects"],
  ];
  return flags.filter(([changed]) => changed).map(([, key]) => t(key));
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

/**
 * Carries out the reset a page front-matter blocker offers, when the form
 * names a page: the collaboration object keeps only the page's title and
 * snapshots before it answers, so the checks that follow read a D1 that has
 * it. Nothing is reset for a form without a slug.
 *
 * A reset that fails is logged and the checks run anyway: they read what D1
 * holds, so the blocker stays on the page for the author to try again. The
 * outcome then names the page, so the page can say the click did not work
 * rather than show the same blocker as though nothing had been asked.
 */
async function resetRequestedPageFrontmatter(
  formData: FormData,
  env: Env,
  projectId: number,
): Promise<{ resetFailed?: { page: string } }> {
  const slug = formData.get("resetPageFrontmatter");
  if (typeof slug !== "string" || !slug) return {};
  const failed = { resetFailed: { page: slug } };
  try {
    const response = await postToCollaborationDO(
      env,
      projectId,
      "reset-page-frontmatter",
      `/reset-page-frontmatter?${new URLSearchParams({ slug })}`,
      undefined,
      slug,
    );
    const body = await response.text();
    if (response.ok) return {};
    console.warn(`reset-page-frontmatter: ${response.status} ${body}`);
    return failed;
  } catch (err) {
    console.warn("reset-page-frontmatter: the collaboration object could not be reached", err);
    return failed;
  }
}

/**
 * Asks the project's Durable Object to write its document to D1, and reports
 * whether it did. False covers both a snapshot that failed and an object that
 * could not be reached: either way D1 may still be behind the document.
 */
async function forceDocSnapshot(env: Env, projectId: number): Promise<boolean> {
  try {
    const doId = env.COLLABORATION.idFromName(String(projectId));
    const doStub = env.COLLABORATION.get(doId);
    const { sigHex, timestamp } = await signInternalMarker(
      projectId,
      env.SESSION_SECRET,
      "snapshot",
    );
    const snapshotReq = new Request(`https://internal/snapshot`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(projectId),
      },
    });
    const snapshotRes = await doStub.fetch(snapshotReq);
    return snapshotRes.ok;
  } catch {
    return false;
  }
}

/**
 * Carries out the removal a column blocker offers, when the form names one:
 * the collaboration object removes the column from every step of the story
 * (or, for `removeTable` objects or glossary, from every row of that table)
 * and answers once D1 agrees, so the checks that follow read a D1 that has it.
 * Nothing is removed for a form without its fields.
 *
 * A removal that fails is logged and the checks run anyway: they read what D1
 * holds, so the blocker stays on the page for the author to try again. The
 * outcome then names the column, so the page can say the click did not work
 * rather than show the same blocker as though nothing had been asked.
 */
async function removeRequestedStoryColumn(
  formData: FormData,
  env: Env,
  projectId: number,
): Promise<{ removalFailed?: { column: string } }> {
  const storyId = formData.get("removeStoryId");
  const column = formData.get("removeColumn");
  const table = formData.get("removeTable");
  const wholeTable = table === "objects" || table === "glossary" ? table : null;
  if (typeof column !== "string" || !column) return {};
  if (!wholeTable && (typeof storyId !== "string" || !storyId)) return {};
  const failed = { removalFailed: { column } };
  const op = wholeTable ? "remove-table-column" : "remove-story-column";
  const query = wholeTable
    ? new URLSearchParams({ table: wholeTable, column })
    : new URLSearchParams({ story: String(storyId), column });
  try {
    const response = await postToCollaborationDO(
      env,
      projectId,
      op,
      `/${op}?${query}`,
      undefined,
      wholeTable ? tableColumnDetail(wholeTable, column) : storyColumnDetail(String(storyId), column),
    );
    const body = await response.text();
    if (response.ok) return {};
    console.warn(`${op}: ${response.status} ${body}`);
    return failed;
  } catch (err) {
    console.warn(`${op}: the collaboration object could not be reached`, err);
    return failed;
  }
}

/** The column a removal carried by the page's last check could not remove, if any. */
function removalFailureOf(data: PublishActionData | undefined): { column: string } | null {
  if (!data || !data.ok || data.intent !== "run-validation") return null;
  return data.removalFailed ?? null;
}

/** The page a reset carried by the page's last check could not clear, if any. */
function resetFailureOf(data: PublishActionData | undefined): { page: string } | null {
  if (!data || !data.ok || data.intent !== "run-validation") return null;
  return data.resetFailed ?? null;
}

/**
 * The page hashes, and the last publish's snapshot they are compared with,
 * as they stand once every page never captured has been captured.
 *
 * Whether a page is a translation decides where its menu entry is written, so
 * the hashes must read the front matter the publish will write from, as the
 * Pages loader stores it (`capturePagesOnLoad`). The capture also brings the
 * snapshot's entry for each page it stored up to that page's new hash, so the
 * snapshot is read again with the hashes; comparing new hashes with the
 * snapshot as it stood before the capture lists an unchanged page as
 * modified. Nothing is read again when no page was stored, which is every
 * load once all pages are captured. A page whose file cannot be read stays
 * uncaptured and the load goes on; a failure to read again keeps the hashes
 * and the snapshot from before the capture, which agree with each other.
 */
async function hashesAfterCapture(
  env: Env,
  db: ReturnType<typeof getDb>,
  user: { encrypted_access_token: string },
  project: Parameters<typeof capturePagesOnLoad>[2] & { publish_snapshot: string | null },
  userRole: Parameters<typeof capturePagesOnLoad>[3],
  pages: Parameters<typeof capturePagesOnLoad>[4],
  hashes: Awaited<ReturnType<typeof buildEntityHashes>>,
): Promise<{ entityHashes: Awaited<ReturnType<typeof buildEntityHashes>>; publishSnapshot: string | null }> {
  const before = { entityHashes: hashes, publishSnapshot: project.publish_snapshot };
  if (!pages.some((p) => p.frontmatter === null)) return before;
  const captured = await capturePagesOnLoad(env, user, project, userRole, pages);
  if (!captured.some((p, i) => p.frontmatter !== pages[i].frontmatter)) return before;
  try {
    const [entityHashes, row] = await Promise.all([
      buildEntityHashes(db, project.id),
      db.select({ publish_snapshot: projects.publish_snapshot }).from(projects).where(eq(projects.id, project.id)).limit(1),
    ]);
    return { entityHashes, publishSnapshot: row[0]?.publish_snapshot ?? null };
  } catch (err) {
    console.error("publish review: re-reading after the front matter capture failed:", err);
    return before;
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    // No active project — onboarding, not /dashboard (which loops via /objects).
    return redirect("/onboarding");
  }
  const { project: activeProject, userRole } = resolved;

  // Force a DO snapshot before reading D1 — otherwise the change summary is
  // computed against stale rows (e.g. orphan pages from earlier broken
  // deploys) that the publish action's own snapshot will then DELETE before
  // commit, producing a "+ 4 pages" summary against a commit that only
  // creates 2 files. The cost is one doc load and one full snapshot per
  // /publish navigation, paid whether or not a DO instance was already alive:
  // an instance that woke unbound binds from the signed marker and flushes
  // rather than answering 200 without work, because "the document is not
  // dirty" is a claim about memory and says nothing about D1. Identical to
  // the action's snapshot call below, just earlier in the request lifecycle,
  // so a publish pays it twice.
  //
  // The outcome is carried to the page. Everything below is a claim about the
  // site's CURRENT state, and only a snapshot that ran makes it one: a DO that
  // failed or could not answer still holds edits D1 has never seen, so the
  // diff would describe a superseded state — and its up-to-date verdict
  // would both mislead the author and disable the publish button. The
  // page says it could not read the state instead. It does not refuse the
  // publish: the action makes this same call and fails closed there, so a
  // failure that has cleared by then must not cost the author a publish.
  // An unreachable DO falls through to D1 reads with whatever state exists,
  // flagged as the partial read it is.
  const snapshotOk = await forceDocSnapshot(env, activeProject.id);

  // Fetch display metadata + entity hashes in parallel. buildEntityHashes
  // reads stories/objects/pages/glossary/config/landing internally (plus
  // steps/layers for story hashing) — D1 handles concurrent reads fine,
  // and parallelising shaves the per-page latency we add to the loader.
  // Pages are fetched here for the empty-slug filter and for the capture of
  // any page never captured (`hashesAfterCapture`); the config row
  // is fetched here because computeChangeSummary's per-field settings diff
  // needs the raw row, not just its hash.
  const [storyRows, objectRows, pageRows, glossaryRows, configRow, hashesBeforeCapture] = await Promise.all([
    db.select({ story_id: stories.story_id, title: stories.title, draft: stories.draft })
      .from(stories)
      .where(eq(stories.project_id, activeProject.id)),
    db.select({ object_id: objects.object_id, title: objects.title })
      .from(objects)
      .where(eq(objects.project_id, activeProject.id)),
    db.select({
      id: project_pages.id,
      slug: project_pages.slug,
      title: project_pages.title,
      frontmatter: project_pages.frontmatter,
      frontmatter_source: project_pages.frontmatter_source,
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
  const afterCapture = await hashesAfterCapture(
    env, db, user, activeProject, userRole, pageRows, hashesBeforeCapture,
  );
  const { entityHashes } = afterCapture;
  // A page whose written block was stored after its publish, while the
  // snapshot's move past it did not land, is moved here, so it does not read
  // as changed (`snapshotSettledOnLoad`).
  const publishSnapshot = await snapshotSettledOnLoad(
    env.DB, activeProject.id, afterCapture.publishSnapshot, entityHashes.pages,
  );

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
  if (publishSnapshot) {
    try {
      snapshot = JSON.parse(publishSnapshot) as PublishSnapshot;
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

  // Stamp the state this summary was built from. The page's generated commit
  // message is an inventory of the summary and travels to the action, which
  // publishes what its own snapshot leaves in D1; the stamp is how that action
  // tells whether the message still describes the commit. Null when the
  // snapshot did not run: the page already falls back to the neutral headline
  // there, and a fingerprint of a read that failed would claim more than this
  // loader knows.
  const summaryStamp = snapshotOk
    ? await fingerprintSummaryState({
        entityHashes,
        allStoryIds: currentState.allStoryIds,
        priorSnapshot: effectiveSnapshot,
      })
    : null;

  return {
    project: {
      id: activeProject.id,
      head_sha: activeProject.head_sha,
      published_sha: activeProject.published_sha,
      last_published_at: activeProject.last_published_at,
      publish_snapshot: publishSnapshot,
      github_repo_full_name: activeProject.github_repo_full_name,
      github_pages_url: activeProject.github_pages_url,
      installation_id: activeProject.installation_id,
    },
    changeSummary,
    snapshotOk,
    summaryFingerprint: summaryStamp,
    user: {
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
  };
}

// ---------------------------------------------------------------------------
// repair-build-workflow
// ---------------------------------------------------------------------------

/**
 * The `repair-build-workflow` intent's whole body: it wires the repair's real
 * dependencies and maps its result onto the page's action data. Only `intent`
 * comes from the client — repository, installation, head and App credentials
 * are all derived here, so a hand-made POST can neither aim the commit
 * elsewhere nor choose what it carries.
 */
async function runBuildWorkflowRepair(input: {
  db: ReturnType<typeof getDb>;
  env: Env;
  projectToken: string;
  frameworkToken: string;
  owner: string;
  repo: string;
  project: { id: number; github_repo_full_name: string; head_sha: string | null; installation_id: number };
  /** The acting user's own role — never assumed. Only a convenor can act on
   *  the App installation's settings page a workflows refusal might name. */
  userRole: "convenor" | "collaborator" | "instructor";
}): Promise<PublishActionData> {
  const { db, env, projectToken, frameworkToken, owner, repo, project, userRole } = input;
  const result = await repairBuildWorkflow(
    {
      getRepoHead,
      getFileAtRef,
      hasPrivateNonDraftStory: async () => {
        const rows = await db
          .select({ private: stories.private, draft: stories.draft })
          .from(stories)
          .where(eq(stories.project_id, project.id));
        return rows.some((s) => s.private && !s.draft);
      },
      fetchFrameworkFilesAtVersion,
      getInstallationToken,
      getInstallationInfo,
      commitFilesToRepo,
      bumpProjectHeadFrom: (fromSha, toSha) => bumpProjectHeadFrom(db, project.id, fromSha, toSha),
    },
    {
      projectToken,
      frameworkToken,
      owner,
      repo,
      repoFullName: project.github_repo_full_name,
      projectHeadSha: project.head_sha ?? null,
      installationId: project.installation_id,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      role: userRole,
    },
  );

  const intent = "repair-build-workflow" as const;
  switch (result.kind) {
    case "repaired":
      return {
        ok: true,
        intent,
        outcome: "repaired",
        newHeadSha: result.newHeadSha,
        recorded: result.recorded,
      };
    case "already_current":
      return { ok: true, intent, outcome: "already_current" };
    case "not_needed":
      return { ok: true, intent, outcome: "not_needed" };
    case "stale_head":
      return { ok: false, intent, error: "stale_head" };
    case "insufficient_permissions":
      return { ok: false, intent, error: "insufficient_permissions", reauthUrl: result.reauthUrl };
    case "insufficient_permissions_convenor_required":
      // Same underlying refusal as insufficient_permissions, but the acting
      // user cannot act on the App's installation settings page — only its
      // convenor can — so there is no reauthUrl to offer here. Mirrors the
      // upgrade route's insufficient_permissions_convenor_required.
      return { ok: false, intent, error: "insufficient_permissions_convenor_required" };
    default:
      return { ok: false, intent, error: "workflow_repair_failed" };
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * What an author is shown when the build comes back anything but successful.
 *
 * `repoPrivate` names the cause only on a definite `true`. Null is the answer
 * both when the build failed for some other reason and when the visibility
 * probe could not resolve, and those two read the same on purpose: neither one
 * licenses the card to say why.
 */
function BuildFailureCard({
  repoPrivate,
  repoFullName,
  buildUrl,
  onRetry,
}: {
  repoPrivate: boolean | null;
  repoFullName: string | null;
  buildUrl: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation("publish");
  const causeIsVisibility = repoPrivate === true;
  return (
    <div className="rounded-lg bg-terracotta-pale border border-terracotta px-6 py-8 text-center">
      <XCircle className="w-12 h-12 text-terracotta mx-auto mb-3" />
      <h2 className="font-heading font-bold text-xl text-charcoal-deep mb-2">
        {t("failure_card.heading")}
      </h2>
      <p className="font-body text-sm text-charcoal/70 mb-6">
        {t(causeIsVisibility ? "failure_card.private_repo" : "failure_card.description")}
      </p>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        {causeIsVisibility && repoFullName && (
          <a
            href={`https://github.com/${repoFullName}/settings`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-body text-sm text-anil-ink hover:underline"
          >
            {t("failure_card.private_repo_cta")}
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
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
        <Button type="button" variant="primary" onClick={onRetry}>
          {t("failure_card.try_again")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Whether the repository was private at the moment a build failed, or null.
 *
 * GitHub Pages does not serve a private repository on a free plan, so the
 * deploy step is where a repository made private after onboarding stops
 * publishing, and the Actions log is the only place that currently says so.
 *
 * Asked only once a run has actually concluded in failure. On every other poll
 * the answer is null without a request: the loop runs every five seconds for
 * every publish in the product, and a cause claimed against a build that
 * succeeded would be a claim about nothing.
 */
async function privateRepoIfBuildFailed(
  run: { status: string; conclusion: string | null },
  token: string,
  owner: string,
  repo: string,
): Promise<boolean | null> {
  if (run.status !== "completed" || run.conclusion === "success") return null;
  return await isRepoPrivate(token, owner, repo);
}

/**
 * The action, answered in the browser. A `poll-build` or a `run-validation`
 * that fails in transit (the request never completes, a bare 5xx, an
 * undecodable answer) is answered as unreachable, with its intent and status
 * 503 (`answerReadsWhenUnreachable`), so the page stays open: the publishing
 * popover keeps its last poll, and the checks say they could not be run and
 * offer to run again. A `run-validation` that carries a reset or a removal may
 * have made it before the answer was lost, so an unreachable answer claims
 * neither, and the next run shows what the site holds. Every other intent
 * reaches the server action unchanged: those write, and what their failure
 * means to the author is not a read's answer.
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  return answerReadsWhenUnreachable(request, serverAction, ["poll-build", "run-validation"]);
}

/** Every layer of the project's steps, in one query. */
async function selectProjectStepLayers(
  db: ReturnType<typeof getDb>,
  projectId: number,
): Promise<StepLayerForValidation[]> {
  return db
    .select({ step_id: layers.step_id, title: layers.title, content: layers.content })
    .from(layers)
    .innerJoin(steps, eq(layers.step_id, steps.id))
    .innerJoin(stories, eq(steps.story_id, stories.id))
    .where(eq(stories.project_id, projectId));
}

/**
 * The project's step layers, read on the first call only: every later call
 * answers from that same read, so the checks sharing it make one query
 * between them, and none when no check asks.
 */
function projectStepLayersLoader(
  db: ReturnType<typeof getDb>,
  projectId: number,
): () => Promise<StepLayerForValidation[]> {
  let read: Promise<StepLayerForValidation[]> | undefined;
  return () => {
    read ??= selectProjectStepLayers(db, projectId);
    return read;
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Every intent acts on the session's site, and only when the page that
  // posted it showed that site.
  const resolved = await resolvePageProject(request, env, user.id, formData);
  if (resolved.kind === "site_changed") {
    return siteChangedAnswer(intent, resolved.currentSiteName);
  }
  if (resolved.kind === "no_project") {
    return { ok: false, intent, error: "no_project" };
  }
  const { project: activeProject, userRole } = resolved;

  // Guard: a publishing role — the roles the group's write-through actions
  // are open to. Every admitted role is named in the set, never inferred.
  await requirePublishingRole(db, activeProject.id, user.id);

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
        // The reset a page front-matter blocker offers, when this check
        // carries one. It completes, snapshot included, before D1 is read.
        const reset = await resetRequestedPageFrontmatter(formData, env, activeProject.id);

        // The removal a story column blocker offers, when this check carries
        // one. It completes, snapshot included, before D1 is read below.
        const removal = await removeRequestedStoryColumn(formData, env, activeProject.id);

        // Repo reads run under the installation token: a collaborator's own
        // token has no read access to a private repository they are not a
        // GitHub collaborator on (OAuth scopes grant nothing beyond what the
        // authorizing user already has on GitHub).
        const projectToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          token,
          userRole,
        );

        // Fetch current repo HEAD for stale check
        const currentRepoHead = await getRepoHead(projectToken, owner, repo);

        // Fetch objects for validation. extra_columns feeds object_reserved_column
        // (a reserved name in the custom-column passthrough).
        const objectRows = await db.select({
          object_id: objects.object_id,
          title: objects.title,
          extra_columns: objects.extra_columns,
        })
          .from(objects)
          .where(eq(objects.project_id, activeProject.id));

        // Fetch stories for this project. `private` and `draft` feed the two
        // private-story warnings (private_story_no_key and
        // private_story_workflow_stale): a private, non-draft story fails the
        // published build on Telar >=1.6 when either prerequisite is missing;
        // drafts never reach the published index, so they are exempt.
        const storyRows = await db.select({ id: stories.id, story_id: stories.story_id, title: stories.title, private: stories.private, draft: stories.draft })
          .from(stories)
          .where(eq(stories.project_id, activeProject.id));

        // Collect all steps for this project (one query per story to avoid IN
        // clause complexity). Each row carries its story's id and title,
        // which the answer-limit blocker needs to say which story a step
        // belongs to; the loop already knows the story, so no join is needed.
        // Kind decides, with a step's layers, whether the story CSV writes
        // it, which the story column blockers and the renamed-column check
        // need to know which columns it carries.
        let allSteps: StepForValidation[] = [];
        for (const story of storyRows) {
          const stepsForStory = await db.select({
            id: steps.id,
            step_number: steps.step_number,
            kind: steps.kind,
            object_id: steps.object_id,
            x: steps.x,
            y: steps.y,
            zoom: steps.zoom,
            question: steps.question,
            answer: steps.answer,
            extra_columns: steps.extra_columns,
          }).from(steps).where(eq(steps.story_id, story.id));
          allSteps = allSteps.concat(
            stepsForStory.map((s) => ({
              ...s,
              story_id: story.story_id,
              story_title: story.title,
            })),
          );
        }

        // Fetch pages for empty-title validation (page_no_title warning) and
        // for the front matter each would publish with. A page never
        // captured has its file's block carried forward at the head the
        // stale check compared against, as the publish would; a read that
        // fails leaves the page unjudged.
        const pageRows = await withCarriedFrontmatter(
          await db.select({
            id: project_pages.id,
            slug: project_pages.slug,
            title: project_pages.title,
            frontmatter: project_pages.frontmatter,
            frontmatter_source: project_pages.frontmatter_source,
          })
            .from(project_pages)
            .where(eq(project_pages.project_id, activeProject.id)),
          { token: projectToken, owner, repo, ref: currentRepoHead },
          false,
        );

        // Fetch glossary terms for validation. extra_columns feeds
        // glossary_reserved_column, the glossary counterpart of the object
        // blocker above.
        const glossaryRows = await db.select({
          term_id: glossary_terms.term_id,
          title: glossary_terms.title,
          extra_columns: glossary_terms.extra_columns,
        })
          .from(glossary_terms)
          .where(eq(glossary_terms.project_id, activeProject.id))
          .orderBy(glossarySheetOrder());

        // The project's config row: the site-wide story key to check against
        // private stories, and the managed fields and blocks a publish would
        // heal into _config.yml, which the config checks need whole.
        const configRow = await db.select()
          .from(project_config)
          .where(eq(project_config.project_id, activeProject.id))
          .limit(1);

        // The framework's second prerequisite for a private story: a build.yml
        // that runs the encryption step. Read only when such a story exists, so
        // a site without one pays no GitHub call, and pinned to the commit the
        // stale-head check compared against, so the warning describes the tree
        // this publish will land on rather than the default branch's tip.
        // getFileAtRef never throws; "error" is indeterminate and stays silent.
        let buildWorkflow: FileAtRef | undefined;
        if (storyRows.some((s) => s.private && !s.draft)) {
          buildWorkflow = await getFileAtRef(
            projectToken,
            owner,
            repo,
            ".github/workflows/build.yml",
            currentRepoHead,
          );
          if (buildWorkflow.status === "error") {
            console.warn("run-validation: could not read .github/workflows/build.yml");
          }
        }

        // The repository's _config.yml, pinned to the commit the stale-head
        // check compared against, for the managed blocks the publish writer
        // could not edit. Read here because validation is where an author is
        // told: discovering it at the write leaves the file silently alone.
        // "error" and "absent" both read as no file, and nothing is reported —
        // a check that cannot see the file has nothing to say about it.
        const configAtHead = await getFileAtRef(
          projectToken,
          owner,
          repo,
          "_config.yml",
          currentRepoHead,
        );
        if (configAtHead.status === "error") {
          console.warn("run-validation: could not read _config.yml");
        }

        // Read once for the story column blockers and the renamed-column
        // warning below, and only if one of them needs it.
        const loadLayers = projectStepLayersLoader(db, activeProject.id);

        const validation = runPrePublishValidation({
          headSha: activeProject.head_sha ?? "",
          currentRepoHead,
          stories: storyRows.map((s) => ({ story_id: s.story_id, title: s.title, private: s.private, draft: s.draft })),
          steps: allSteps,
          objects: objectRows,
          pages: pageRows,
          glossary: glossaryRows,
          storyKey: configRow[0]?.story_key ?? null,
          configYml: configAtHead.status === "ok" ? configAtHead.content : null,
          config: configRow[0],
          buildWorkflow,
          stepLayers: await stepLayersForValidation(allSteps, loadLayers),
        });
        // A repeated column the publish will write under `name_N`, read from
        // the sheets at the same commit. Taken after the checks above, so no
        // sheet is read while their stale-head blocker stands.
        validation.warnings.push(
          ...(await renamedColumnWarningsAt(
            validation,
            {
              objects: objectRows,
              glossary: glossaryRows,
              stories: storyRows,
              steps: allSteps,
              loadLayers,
            },
            (path) => getFileAtRef(projectToken, owner, repo, path, currentRepoHead, { strict: true }),
          )),
        );

        // What the sheets on GitHub are warned about, one read per sheet at
        // the same commit. Advisory: the sync state is not touched.
        validation.warnings.push(
          ...(await sheetWarningChecksAt(
            validation,
            storyRows.map((s) => s.story_id),
            (path) => getFileAtRef(projectToken, owner, repo, path, currentRepoHead, { strict: true }),
            configSheets(configTextWithoutBom(configAtHead)),
          )),
        );

        // A recorded story file changed on GitHub since it was read is left
        // by the publish, and named here.
        validation.warnings.push(
          ...keptChangedWarnings((await owedStoryDeletions(
            parseOwedStoryFiles(activeProject.story_files_to_delete_json),
            storyRows.map((s) => s.story_id),
            (path) => getFileAtRef(projectToken, owner, repo, path, currentRepoHead, { strict: true }),
          ).catch(() => ({ changed: [] as string[] }))).changed),
        );

        // Each settings-replaced warning names the page and block it is
        // about, which the publish that acknowledges it sends back.
        validation.warnings = await withReplacedSettings(validation.warnings, pageRows);

        return { ok: true, intent: "run-validation", validation, ...removal, ...reset };
      } catch (err) {
        console.error("[publish] run-validation failed", err);
        return { ok: false, intent: "run-validation", error: "validation_failed" };
      }
    }

    case "publish": {
      let commitMessage = (formData.get("commitMessage") as string | null)?.trim() || "Publish site";
      let commitBody = (formData.get("commitBody") as string | null)?.trim() || undefined;
      // Present only when the message is the one this page generated from the
      // loader's summary. A message the author typed carries none: it is not
      // an inventory of a read, so it cannot describe a state that moved, and
      // replacing their words would be its own kind of wrong.
      const submittedFingerprint =
        (formData.get("summaryFingerprint") as string | null)?.trim() || null;
      // Rendered by the page because it is localised; the action has no locale.
      const fallbackHeadline =
        (formData.get("fallbackHeadline") as string | null)?.trim() || null;
      const claimsHeadings = formData.get(CORRECTS_HEADINGS) === "1";
      const acknowledgedReplaced = acknowledgedReplacedPages(formData);

      // Before the lease, and outside the block below that turns a throw into
      // a failure: a site behind the latest release is sent where loading the
      // page would send it (a fetcher follows an action redirect), and a
      // release that cannot be read refuses with nothing taken or written.
      const releaseGate = await readRepoWriteGate(db, env, {
        project: activeProject,
        userRole,
        userToken: token,
      });
      const gateRedirect = publishGateRedirect(releaseGate);
      if (gateRedirect) throw redirect(gateRedirect);
      if (releaseGate === "release_unknown") {
        return { ok: false, intent: "publish", error: "release_unknown", projectId: activeProject.id };
      }

      // From here until the request ends, however it ends, no other publish or
      // upgrade may begin and collaborators' editors wait: the finally below
      // is the one place the lease is let go, and every return in the block
      // passes through it. A begin the object refuses means another is
      // running already, and this one stops before it reads anything.
      const freezeOperation = newFreezeOperationId();
      let freezeOutcome: LeaseOutcome = "failed";
      let healToken: string | null = null;
      const lease = await controlFreezeLease(env, activeProject.id, user.id, {
        op: "begin",
        kind: "publish",
        operationId: freezeOperation,
      });
      if (lease === "refused") return { ok: false, intent: "publish", error: "operation_in_progress", projectId: activeProject.id };

      try {
        // The App installation token, for every read and the eventual commit
        // against the project's own repository: a collaborator's own token
        // has no write access to it, and on a private repo may have no read
        // access either (OAuth scopes grant nothing beyond what the
        // authorizing user already has on GitHub). Resolved before anything
        // reads the repository.
        const installToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          token,
          userRole,
        );
        healToken = installToken;

        // The revision this whole publish is: resolved once, here, and carried
        // by every read that follows and by the commit itself. A branch name
        // resolves again on each read, so a hand commit landing mid-publish
        // would leave the file set built from one revision and committed over
        // another — the author's edit undone by a publish that reported
        // success. With one SHA, that commit fails the publish instead, and
        // the page already says the head moved.
        //
        // Captured before the forced snapshot, and before the objects
        // operations still owed are finished below, so the sheet that
        // completion reads is the sheet this publish rewrites and commits
        // over. The run-validation intent has a head read of its own; it is a
        // separate request and its value cannot be reused here.
        const publishSha = await getRepoHead(installToken, owner, repo, "main");

        // The publish commits D1's content over publishSha, so it may do so
        // only when publishSha is the recorded head: recording a commit is
        // what acknowledges the GitHub edits up to it, and an edit that
        // landed since the page's own check would be overwritten unread.
        // Refused before the objects are finished, the snapshot forced, or
        // anything written; the finally below lets the lease go. A project
        // with no head recorded is refused too, as the page's check already
        // refuses it.
        if (publishSha !== activeProject.head_sha) {
          return { ok: false, intent: "publish", error: "stale_head", projectId: activeProject.id };
        }

        // Before the forced snapshot, and so before anything reads D1: an
        // upload or objects commit whose objects reached the repository and
        // not D1 would be written out of objects.csv by the file set below.
        // objects.csv is read strictly at the publish head, the operations
        // still owed are finished with it under the lease this publish holds,
        // and the file it read is the one rewritten. The snapshot comes after,
        // so it is the last write D1 takes before the reads. A read that fails
        // or a completion that fails throws `ObjectsCommitUnready`, answered as
        // `objects_unreadable` or `objects_unregistered` below.
        const objectsSheet = await prepareObjectsCommit(env, db, activeProject.id, {
          token: installToken, owner, repo, head: publishSha,
        });

        // Force a DO snapshot before the publish pipeline runs, so the pipeline
        // reads the author's latest collaborative content rather than whatever
        // D1 last received.
        //
        // Three outcomes, and only the first publishes:
        //   200        — the DO answered, having bound the project from the
        //                signed marker, loaded the document and flushed it.
        //                An instance that woke with no project bound binds
        //                from the marker rather than skipping the flush: a
        //                null id is a fact about the instance, not about D1,
        //                and skipping on it answered 200 over a blob that had
        //                already superseded the rows publish then committed.
        //                D1 is authoritative only because the flush ran.
        //   non-200    — the DO answered and its snapshot did not leave D1
        //                current: it failed outright, was blocked, or ran and
        //                lost an entity's INSERT (`snapshot_incomplete`).
        //   fetch throws — the DO could not answer at all.
        //
        // The last is NOT "no instance is alive": a stub fetch instantiates the
        // object on demand, so an absent instance is created and answers 200.
        // A rejection means the instance could not respond, which is exactly
        // the state in which D1 may be missing the author's work — so it
        // refuses too, with its own code.
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
            // The DO's forced snapshot failed (e.g. a D1-batch failure). Fail
            // closed — publishing now would ship stale D1. The DO's /snapshot
            // handler catches INSIDE its blockConcurrencyWhile callback, which
            // is what makes this 500 reachable: a callback that throws resets
            // the DO, and the reset arrives here as a rejection instead.
            //
            // `snapshot_incomplete` is the one refusal that is not about the
            // snapshot breaking: it ran, and lost a specific entity's INSERT
            // (a snapshot cannot abort mid-flush, so the rest was still
            // written). Publishing would ship a site missing that object or
            // page, so it refuses too — with its own code, because the author's
            // remedy is different and telling them their edits were not saved
            // would be false.
            // Read defensively: a body that will not decode must not fall into
            // the catch below and be reported as an unreachable session.
            const code = await snapshotRes.text().catch(() => "");
            return {
              ok: false,
              intent: "publish",
              error: code === "snapshot_incomplete" ? "snapshot_incomplete" : "snapshot_failed",
              projectId: activeProject.id,
            };
          }
        } catch (err) {
          // The DO could not answer. D1 may be missing edits held in the
          // instance, and nothing here can tell whether it was. Refuse, with a
          // code distinct from a failed snapshot so the author is told the
          // editing session was unreachable rather than that the save broke.
          console.error("Publish: forced snapshot unreachable —", err);
          return { ok: false, intent: "publish", error: "snapshot_unreachable", projectId: activeProject.id };
        }

        // The kept columns a story's CSV holds and D1 never recorded, read
        // before the file set below rewrites the CSV from D1 and would drop
        // them (see `~/lib/kept-columns-capture.server`). After the
        // forced snapshot, so the rows aligned against are the author's
        // latest, and before every read below, so the captured columns are in
        // the rows the checks judge and the files are built from. The capture
        // goes through the collaboration object, which answers once it is in
        // D1. A story that changed since this read refuses the publish, and
        // so does any capture the object did not take, or a CSV that could
        // not be read: each throws `KeptColumnsRefusal`, answered in the catch below.
        await captureKeptColumns(db, env, activeProject.id, { token: installToken, owner, repo }, publishSha);

        // Re-run the blocker check against the rows the snapshot above just
        // wrote. Everything the page showed — the diff, the checks, the commit
        // message — came from the LOADER's snapshot, which may have failed or
        // may simply be minutes stale, and the page's own refusal runs in the
        // browser, where a direct POST skips it. This is the only pass that
        // measures what is actually about to be committed.
        //
        // Scope is deliberately narrower than the page's pass, in both
        // directions that matter:
        //
        //   - Only blockers refuse. Warnings are advisory by definition and
        //     the author has already seen them.
        //   - Page, story, object, glossary and step rows are fetched for the
        //     blockers derived from content — `page_no_title`,
        //     `story_no_title`, `object_reserved_column`,
        //     `glossary_reserved_column`, the story column blockers and the
        //     answer checks — and the
        //     repository's _config.yml with the project's config row for the
        //     two the file itself raises, `config_block_unwritable` and
        //     `config_unparseable`. `stale_head` is the
        //     other blocker and is deliberately excluded: it compares a live
        //     GitHub read against the project row, so HEAD moving between the
        //     author reading the page and pressing publish would cost them a
        //     publish for a reason they were never shown. Passing one sha as
        //     both operands is what holds it out of scope here.
        //
        // A new content blocker added to `runPrePublishValidation` needs its
        // input fetched here too, or it will ship unchecked; the blocker set is
        // pinned by a test so the coupling cannot drift silently.

        const [
          pageRowsForValidation,
          storyRowsForValidation,
          objectRowsForValidation,
          glossaryRowsForValidation,
          stepRowsForValidation,
          configRowForValidation,
        ] = await Promise.all([
          db
            .select({ slug: project_pages.slug, title: project_pages.title, frontmatter: project_pages.frontmatter })
            .from(project_pages)
            .where(eq(project_pages.project_id, activeProject.id)),
          db
            .select({ story_id: stories.story_id, title: stories.title, draft: stories.draft })
            .from(stories)
            .where(eq(stories.project_id, activeProject.id)),
          db
            .select({ object_id: objects.object_id, title: objects.title, extra_columns: objects.extra_columns })
            .from(objects)
            .where(eq(objects.project_id, activeProject.id)),
          db
            .select({ term_id: glossary_terms.term_id, title: glossary_terms.title, extra_columns: glossary_terms.extra_columns })
            .from(glossary_terms)
            .where(eq(glossary_terms.project_id, activeProject.id))
            .orderBy(glossarySheetOrder()),
          // Joined rather than looped per story, because this pass has no
          // story ids to loop over and runs its fetches in parallel. Kind
          // decides, with a step's layers, whether the story CSV writes it,
          // which the story column blockers need.
          db
            .select({
              id: steps.id,
              step_number: steps.step_number,
              kind: steps.kind,
              object_id: steps.object_id,
              x: steps.x,
              y: steps.y,
              zoom: steps.zoom,
              question: steps.question,
              answer: steps.answer,
              extra_columns: steps.extra_columns,
              story_id: stories.story_id,
              story_title: stories.title,
            })
            .from(steps)
            .innerJoin(stories, eq(steps.story_id, stories.id))
            .where(eq(stories.project_id, activeProject.id)),
          // Whole, not a column list: the config checks judge the _config.yml
          // this publish would write, and the write is built from every managed
          // field and block of this row.
          db
            .select()
            .from(project_config)
            .where(eq(project_config.project_id, activeProject.id))
            .limit(1),
        ]);

        // The _config.yml this publish is about to rewrite, read from the
        // branch it commits to, so a managed block the writer cannot edit
        // stops the publish here — where a direct submission of this action
        // reaches too, and the page's own pass does not.
        // Strict, because this read feeds a rewrite. Without it "absent" means
        // a 404 OR any 200 whose body carries no usable content — which GitHub
        // sends for a file past its inline size — and reading that as "this
        // repository has no _config.yml" is the silent skip by its own route.
        const configForValidation = await getFileAtRef(
          installToken,
          owner,
          repo,
          "_config.yml",
          publishSha,
          { strict: true },
        );

        // "Absent" and "error" are different answers and only one of them is a
        // publish. Absent is a repository with no _config.yml, which is a
        // legitimate site: nothing to check, nothing to write. An error is a
        // read that could not find out — a network failure, a 5xx, a rate
        // limit — and reading it as no file is how a site's settings go missing
        // under a success card: the checks judge nothing, the assembly writes
        // no config, and the publish reports success. Refuse instead, and say
        // which read failed.
        if (configForValidation.status === "error") {
          return { ok: false, intent: "publish", error: "config_unreadable", projectId: activeProject.id };
        }
        // The strict read keeps a leading byte-order mark, and the heal matches
        // a managed key from the line's first character: a key on the first
        // line would go unrecognised and be written a second time.
        const configYmlAtPublish =
          configForValidation.status === "ok" ? configForValidation.content.replace(/^\uFEFF/, "") : null;

        const postSnapshotValidation = runPrePublishValidation({
          headSha: "",
          currentRepoHead: "",
          stories: storyRowsForValidation,
          steps: stepRowsForValidation,
          objects: objectRowsForValidation,
          pages: pageRowsForValidation,
          glossary: glossaryRowsForValidation,
          storyKey: null,
          configYml: configYmlAtPublish,
          config: configRowForValidation[0],
          stepLayers: await stepLayersForValidation(
            stepRowsForValidation,
            projectStepLayersLoader(db, activeProject.id),
          ),
        });
        // The codes are not returned to the page. Its own checks section is
        // driven by the loader's pass, and reloading re-runs both against the
        // rows this snapshot just wrote, which is where the author sees exactly
        // what to fix.
        if (postSnapshotValidation.blockers.length > 0) {
          return { ok: false, intent: "publish", error: "validation_blocked", projectId: activeProject.id };
        }

        // Same guard as the loader — a corrupt persisted snapshot would
        // otherwise throw out of the publish action mid-flight.
        let priorSnapshot: PublishSnapshot | null = null;
        if (activeProject.publish_snapshot) {
          try {
            priorSnapshot = JSON.parse(activeProject.publish_snapshot) as PublishSnapshot;
          } catch {
            priorSnapshot = null;
          }
        }

        // One read of the state the snapshot above just wrote, used twice: to
        // decide whether the submitted commit message still describes what is
        // about to be committed, and as the publish snapshot recorded at the
        // end. Reading it here rather than after the commit also errs in the
        // safe direction — an edit landing between this read and the file-set
        // assembly ships in the commit and stays flagged as unpublished, where
        // a later read would have recorded it as published without ever
        // committing it.
        //
        // The pages, the settings row and the landing row are captured once
        // here and handed to both the hashes and the file set, so the files
        // committed, the page files deleted and the snapshot recorded below all
        // describe the same pages and settings. The settings row is
        // the one the validation judged.
        const [capturedPages, capturedLandingRows, objectIdRows] = await Promise.all([
          readPublishPages(db, activeProject.id),
          readPublishLanding(db, activeProject.id),
          db.select({ object_id: objects.object_id }).from(objects).where(eq(objects.project_id, activeProject.id)),
        ]);
        const captured = {
          pages: capturedPages,
          config: configRowForValidation[0] ?? null,
          landing: capturedLandingRows[0] ?? null,
        };

        // A page whose stored settings the writer cannot read is written with
        // its title alone, and its other settings are gone from the site. The
        // author is warned of it by the page's checks, which a page that could
        // not read the state never runs and a direct request never sees. So
        // the pages this publish writes that way, carried forward as the file
        // set carries them, must each be named by the request as warned of,
        // by page and stored block, so a page given the slug since or a block
        // changed since is not taken as warned of; otherwise nothing is
        // written and the warnings go back to be shown.
        const carriedPages = await withCarriedFrontmatter(captured.pages, { token: installToken, owner, repo, ref: publishSha });
        const replacedUnwarned = (
          await withReplacedSettings(pageFrontmatterReplacedWarnings(carriedPages), carriedPages)
        ).filter((warning) => !warning.replacedSettings || !acknowledgedReplaced.has(replacedSettingsKey(warning.replacedSettings)));
        if (replacedUnwarned.length > 0) {
          return {
            ok: false,
            intent: "publish",
            error: REPLACED_PAGES_UNACKNOWLEDGED,
            warnings: replacedUnwarned,
            projectId: activeProject.id,
          };
        }
        const [entityHashes, allStoryRows] = await Promise.all([
          buildEntityHashes(db, activeProject.id, captured),
          db
            .select({ id: stories.id, story_id: stories.story_id, draft: stories.draft, source_path: stories.source_path })
            .from(stories)
            .where(eq(stories.project_id, activeProject.id)),
        ]);

        // The message is permanent in GitHub's history and no later publish can
        // correct it, so a message that no longer matches the state falls back
        // to the neutral headline rather than shipping a false inventory. The
        // publish itself is never refused over this: the content is fine, only
        // the description of it is out of date.
        if (submittedFingerprint) {
          const currentFingerprint = await fingerprintSummaryState({
            entityHashes,
            allStoryIds: allStoryRows.map((s) => s.story_id),
            priorSnapshot,
          });
          if (currentFingerprint !== submittedFingerprint) {
            commitMessage = fallbackHeadline || "Publish site";
            commitBody = undefined;
          }
        }

        // Read the user-content file set and the site's pinned framework version
        // concurrently — the version read (for the heal below) is independent of
        // the file-set assembly, so don't serialise an extra D1 round-trip onto
        // the publish hot path. The version read is self-contained and fail-safe:
        // if it errors, siteVersion is null and the heal simply skips.
        const glossaryReadFrom: { path?: string } = {};
        const headingsCorrected: string[] = [];
        const [files, siteVersion] = await Promise.all([
          buildPublishFileSet({
            token: installToken,
            owner,
            repo,
            ref: publishSha,
            projectId: activeProject.id,
            env,
            // The file the check above judged, handed down rather than read
            // again: a second read is a second revision, and the publish would
            // then edit a file nothing checked.
            configYml: configYmlAtPublish,
            // The row it judged, for the same reason. The check's answer is the
            // row and the file together, so a second read of the row is a
            // second answer: a settings save landing between the two turns a
            // check that passed into a config write silently dropped.
            config: captured.config,
            pages: captured.pages,
            landing: captured.landing,
            // The objects.csv completion read, for the same reason.
            objectsSheet,
            glossaryReadFrom,
            headingsCorrected,
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
        commitMessage = headingsHeadline(claimsHeadings, headingsCorrected, fallbackHeadline, commitMessage);

        // Best-effort framework-file heal: restore any framework
        // file entirely missing from the user repo (e.g. package-lock.json,
        // which the v1.5.0 `npm ci` build requires). Reaches sites the
        // version-gated upgrade flow can't — it self-redirects when the site is
        // already on the latest framework version. Fail-open: never blocks the
        // publish; a miss retries next publish. The project's own tree and
        // build.yml read run on installToken (a collaborator's own token may
        // have no read access to a private repo); the framework's public repo
        // (UCSB-AMPLab/telar) fetch stays on the user token, since an
        // installation token cannot reach a repo outside its own installation.
        const healedPaths: string[] = [];
        try {
          const tag = siteVersion ? normalizeVersionTag(siteVersion) : "";
          const healed = await healMissingFrameworkFiles(
            installToken,
            owner,
            repo,
            tag,
            token,
            env.TELAR_RELEASE_TAG,
            publishSha,
          );
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

        // Hard-deleted/renamed pages: a prior page slug no longer present gets
        // its {slug}.md deleted, mirroring the story logic. From the captured
        // rows the files were written from, with the SAME trim/non-empty filter
        // the snapshot's page_slugs is built with below, so a still-live page is
        // never targeted.
        const committablePageSlugs = captured.pages
          .map((p) => (p.slug ?? "").trim())
          .filter((slug) => slug.length > 0);

        // Combine story + page hard-deletes, but never delete a path we are also
        // writing this publish (a recycled slug being rewritten — additions and
        // deletions ship in one commit payload, so an overlap must resolve to a
        // write, not a delete).
        //
        // Hard-deleted stories (present in the prior publish's file set, no
        // longer in D1) get their {story_id}.csv deleted. Drafts are NOT
        // hard-deletes — they remain in D1 with draft=true and their file is
        // still written by the file-set assembly above. Empty when there is no
        // prior snapshot (first publish) or no story was removed. Story ids and
        // the prior snapshot are the single read taken before the file set, so
        // the deletion decision, the commit-message check and the snapshot
        // recorded below all describe one state.
        const additionPaths = new Set(files.map((f) => f.path));
        // A renamed story's old CSV is also named by its own record, which
        // holds before any publish snapshot does.
        // A story deleted before any publish is named by the Compositor's own
        // record of the CSV it read, which holds while no snapshot does.
        const owedStoryFiles = await owedStoryDeletions(
          parseOwedStoryFiles(activeProject.story_files_to_delete_json),
          allStoryRows.map((r) => r.story_id),
          (path) => getFileAtRef(installToken, owner, repo, path, publishSha, { strict: true }),
        );
        const storyDeletions = [...new Set([
          ...computeStoryDeletions(allStoryRows.map((r) => r.story_id), priorSnapshot),
          ...renamedStorySheets(allStoryRows),
          ...owedStoryFiles.paths,
        ])];
        const deletions = [
          ...storyDeletions,
          // The layer files those CSVs name at the head, so a story whose ID
          // changed, or one deleted, leaves no file under its old ID. The CSVs
          // written now are read at the head too: a layer file the earlier one
          // names and the new one does not is left by a retitled or removed layer.
          ...(await deletedStoryLayerFiles({ token: installToken, owner, repo, ref: publishSha }, [...storyDeletions, ...sheetsOfStoriesWritten(allStoryRows, files)], files)),
          ...computePageDeletions(committablePageSlugs, priorSnapshot),
          // The record's files no captured page holds: the file of a page
          // renamed or deleted here before any publish recorded its slug, and
          // a file GitHub added that the author chose not to take.
          ...recordedPageDeletions(parsePageFilesRecord(activeProject.page_files_json), captured.pages),
          // A page carried from another page's file, written under its own
          // slug, leaves that file behind unless it is deleted here.
          ...carriedPageDeletions(captured.pages),
          // The Spanish sheet beside each English one written, except a
          // glosario.csv the glossary was not read from: the build converts it
          // as a story. The commit drops the Spanish files not there.
          ...spanishSheetCounterparts(files, glossaryReadFrom.path),
        ].filter((path, i, all) => !additionPaths.has(path) && all.indexOf(path) === i);

        // The publish snapshot, built now — before the commit — from the
        // same reads the file set and the deletions above were built from,
        // taken before the file set. Nothing here throws after the commit
        // lands: a throw from JSON.parse below or from hashObject answers
        // publish_failed with nothing committed, exactly as it did before
        // this ran here, and the commit that follows has nothing left to
        // throw before it lands.
        //
        // entity_hashes is the new single source of truth for change
        // detection; legacy fields (story_ids, object_ids, page_slugs,
        // page_hashes, config_hash, config_managed, landing_hash,
        // navigation_hash) are dual-written during the transition so a
        // roll-back doesn't lose change-tracking data, and so old snapshots'
        // computeChangeSummary readers keep working until the next publish
        // overwrites the snapshot.
        const config = captured.config;
        const landing = captured.landing;
        const nonDraftStories = allStoryRows.filter((s) => !s.draft);

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
          all_story_ids: allStoryRows.map((s) => s.story_id),
          object_ids: objectIdRows.map((o) => o.object_id),
          page_slugs: committablePageSlugs,
          page_hashes: buildPageContentHashes(captured.pages),
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
        // Serialised here too: nothing that can throw may run between the
        // commit landing and the record of it.
        const newSnapshotJson = JSON.stringify(newSnapshot);

        // Publish commits on the member's own token when their stored access
        // is "access", and under the installation token resolved above
        // otherwise: nobody is refused. Reads above stay on the installation
        // token.

        // createCommitOnBranch takes no author, so the commit's identity is
        // the App's — the publisher's name has nowhere to land but the body.
        // GitHub logins only, never github_name: GitHub restricts a username
        // to alphanumeric characters and dashes, cannot start or end with a
        // dash, and cannot contain two consecutive dashes (docs.github.com,
        // "Username considerations for external authentication") — a
        // character set that cannot spell "[skip ci]" or contain a newline.
        // A display name is free text and gets neither guarantee: it could
        // read "Alice [skip ci]" (suppressing the push-triggered build,
        // which GitHub honours in commit messages) or carry a newline that
        // injects extra paragraphs. The login is used exactly as GitHub
        // returned it — its character set already makes it safe, so there
        // is nothing to strip or rewrite.
        const publisherLine = `Published by @${user.github_login}`;
        const healedNote =
          healedPaths.length > 0
            ? `Restored framework files: ${healedPaths.join(", ")}`
            : null;
        const publishMessageBody = [commitBody, healedNote, publisherLine]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");

        // An unreadable _data copy of a story stops the build and is removed,
        // for every story this publish writes and every story project.csv at
        // publishSha lists and D1 no longer has; a root copy only where the
        // story was read from it. Read before the commit: a project.csv that
        // cannot be read refuses the publish with nothing committed.
        const olderCopies = [
          ...olderStoryCopies(files, allStoryRows),
          ...(await deletedStoryDataCopies(
            { token: installToken, owner, repo, ref: publishSha },
            allStoryRows.map((r) => r.story_id),
          )),
        ];

        // Publish always triggers a full build — tiles are deployed via GitHub
        // Pages (artifact upload), so partial workflows can't deploy content.
        const result = await commitOnOwnToken(
          db,
          { projectId: activeProject.id, userId: user.id, userToken: token, installToken },
          (commitToken) =>
            commitFilesToRepo(
              commitToken,
              owner,
              repo,
              "main",
              files,
              commitMessage,
              publishMessageBody,
              deletions.length > 0 ? deletions : undefined,
              undefined,
              // The head this publish was built against. A commit landing since
              // then makes this one fail rather than replace it.
              publishSha,
              olderCopies,
            ),
        );

        const newHeadSha = result.newHeadSha;
        const landedPageFilesJson = serialisePageFilesRecord(heldPagesRecord(newHeadSha, captured.pages));
        // The commit landed: whatever the bookkeeping below meets, the site
        // changed, and collaborators are not told that it failed.
        freezeOutcome = "succeeded";
        const now = new Date().toISOString();

        // head_sha advances compare-and-set from the head this publish was
        // built on: a head another writer recorded during the publish is
        // kept. What this publish committed is recorded either way.
        //
        // Each story written is recorded in the same batch, at the file it
        // was written to, which the next publish lays it out from.
        //
        // Tried up to three times on D1 refusing this one idempotent
        // batch: recordLandedPublish logs and swallows rather than
        // throwing, because the commit above already landed and nothing
        // after it may turn a published site into a reported failure.
        await recordLandedPublish(db, activeProject.id, {
          published_sha: newHeadSha,
          head_sha: headAdvancedFrom(publishSha, newHeadSha),
          objects_read_sha: objectsReadAdvancedFrom(publishSha, newHeadSha),
          // Every captured page held by a file, written or not, at the new
          // head, with the head: a blank-title page keeps its file.
          page_files_json: pageFilesRecordAdvancedFrom(publishSha, landedPageFilesJson),
          // The files it owed are deleted or named, and a snapshot now exists.
          story_files_to_delete_json: null,
          last_published_at: now,
          publish_snapshot: newSnapshotJson,
          updated_at: now,
          gh_checked_at: null,
        }, newHeadSha, allStoryRows);

        // A page whose stored block the publish could not read was written
        // with its title alone; the block written is stored now that the
        // commit has landed, with the lease still held. Logs and returns on
        // failure, as the record above does.
        await storeWrittenPageFrontmatter(env, activeProject.id, captured.pages);

        // A page carried from a file this commit deleted no longer names it,
        // so no later publish deletes a file created there since. Logs and
        // returns on failure, as the record above does.
        await clearCarriedPageSources(db, activeProject.id, captured.pages, deletions);

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

        return { ok: true, intent: "publish", newHeadSha, commitUrl, leftFiles: keptChangedWarnings(owedStoryFiles.changed) };
      } catch (err) {
        console.error("[publish] commit failed", err);
        const failure = publishFailure(err, activeProject.id);
        if (healToken && (failure.error === "publish_failed" || failure.error === "github_permission")) {
          await healRenamedRepo(db, healToken, activeProject);
        }
        return failure;
      } finally {
        await controlFreezeLease(env, activeProject.id, user.id, {
          op: "end",
          operationId: freezeOperation,
          outcome: freezeOutcome,
        });
      }
    }

    case "poll-build": {
      const sha = formData.get("sha") as string | null;
      const runIdParam = formData.get("runId") as string | null;

      if (!sha) {
        return { ok: false, intent: "poll-build", error: "missing_sha" };
      }

      // Every answer names the commit it answers for. A caller running more
      // than one build at a time — the repair's poll beside the publish's —
      // has no other way to tell a late response from the current one: the
      // fetcher holds whichever landed last, and the shas are what separate
      // the builds.
      try {
        // Same reasoning as run-validation: a collaborator's own token may
        // have no read access to a private repository.
        const projectToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          token,
          userRole,
        );
        const runs = await listWorkflowRunsBySha(projectToken, owner, repo, sha);

        if (runs.length === 0) {
          return {
            ok: true,
            intent: "poll-build",
            sha,
            buildStatus: "pending",
            buildConclusion: null,
            buildUrl: null,
            runId: null,
            phases: null,
            repoPrivate: null,
          };
        }

        const run = runs[0];

        const repoPrivate = await privateRepoIfBuildFailed(run, projectToken, owner, repo);

        if (runIdParam) {
          const jobSteps = await getJobSteps(projectToken, owner, repo, Number(runIdParam));
          const phases = mapStepsToBuildPhases(jobSteps);
          return {
            ok: true,
            intent: "poll-build",
            sha,
            buildStatus: run.status,
            buildConclusion: run.conclusion,
            buildUrl: run.html_url,
            runId: run.id,
            phases,
            repoPrivate,
          };
        }

        return {
          ok: true,
          intent: "poll-build",
          sha,
          buildStatus: run.status,
          buildConclusion: run.conclusion,
          buildUrl: run.html_url,
          runId: run.id,
          phases: null,
          repoPrivate,
        };
      } catch (err) {
        console.error("[publish] poll-build failed", err);
        return { ok: false, intent: "poll-build", sha, error: "poll_failed" };
      }
    }

    case "dismiss-intro": {
      // Dismissal is handled client-side via localStorage — no D1 write needed.
      return { ok: true, intent: "dismiss-intro" };
    }

    case "repair-build-workflow": {
      // The repair's project-repo reads (deps.getRepoHead, deps.getFileAtRef)
      // run under the installation token; its commit mints and uses its own
      // installation token internally regardless. Same reasoning as
      // run-validation: a collaborator's own token may have no read access to
      // a private repo. The framework repository is a separate, public repo
      // the project's installation is not granted — its read stays on the
      // user's own token (see resolveWorkflowFile's fetchFrameworkFilesAtVersion
      // call in build-workflow.server.ts).
      let repairToken: string;
      try {
        repairToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          token,
          userRole,
        );
      } catch {
        return { ok: false, intent: "repair-build-workflow", error: "workflow_repair_failed" };
      }
      return await runBuildWorkflowRepair({
        db,
        env,
        projectToken: repairToken,
        frameworkToken: token,
        owner,
        repo,
        project: activeProject,
        userRole,
      });
    }

    default:
      return { ok: false, intent, error: "unknown_intent" };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PublishActionData =
  | {
      ok: true;
      intent: "run-validation";
      validation: ValidationResult;
      /** The column this check was asked to remove and could not. */
      removalFailed?: { column: string };
      /** The page this check was asked to reset and could not. */
      resetFailed?: { page: string };
    }
  | { ok: false; intent: "run-validation"; error: string }
  | { ok: false; intent: "run-validation"; reason: "unreachable"; error?: undefined }
  | { ok: true; intent: "publish"; newHeadSha: string; commitUrl: string; leftFiles: ValidationItem[] }
  | { ok: false; intent: "publish"; error: string }
  | { ok: false; intent: "publish"; error: typeof REPLACED_PAGES_UNACKNOWLEDGED; warnings: ValidationItem[]; projectId: number }
  | { ok: true; intent: "poll-build"; sha: string; buildStatus: string; buildConclusion: string | null; buildUrl: string | null; runId: number | null; phases: unknown; repoPrivate: boolean | null }
  | { ok: false; intent: "poll-build"; error: string; sha?: string }
  | { ok: false; intent: "poll-build"; reason: "unreachable"; error?: undefined; sha?: undefined }
  | { ok: true; intent: "dismiss-intro" }
  | { ok: true; intent: "repair-build-workflow"; outcome: "repaired" | "already_current" | "not_needed"; newHeadSha?: string; recorded?: boolean }
  | { ok: false; intent: "repair-build-workflow"; error: string; reauthUrl?: string | null }
  | { ok: false; intent: string; error: string }
  | null
  | undefined;

/**
 * What the repair fetcher can carry. It is submitted with one intent only, so
 * its data is the repair's two members rather than the whole page union.
 */
type RepairActionData =
  | Extract<PublishActionData, { intent: "repair-build-workflow" }>
  | null
  | undefined;

/**
 * A `poll-build` answer, either way it went. The repair's poll reads its
 * failures as well as its successes, so both members are in hand before the
 * session checks apply.
 */
type PollBuildData = Extract<PublishActionData, { intent: "poll-build" }>;

/** Whether a fetcher's data is one of those answers. */
function isPollBuildData(data: PublishActionData): data is PollBuildData {
  return !!data && data.intent === "poll-build";
}

/** Whether the repair's poll of the current session came back unreachable. */
function repairPollUnanswered(data: unknown, pollSession: number | null, session: number): boolean {
  return isUnreachableAnswer(data) && pollSession === session;
}

/**
 * The checks section's repair prop: where the repair stands, the settings page
 * a refusal named, where its rebuild has got to, and the submit that starts
 * one. Starting a repair opens a new poll session before the submit, so a
 * response owed to the previous one arrives outside it.
 */
function buildWorkflowRepairProp(
  fetcher: { state: "idle" | "loading" | "submitting"; submit: (target: Record<string, string>, options: { method: "post" }) => void },
  data: RepairActionData,
  build: WorkflowRepairBuild | null,
  beginSession: () => void,
  buildUnchecked: boolean,
): WorkflowRepair {
  return {
    status: deriveWorkflowRepairStatus(fetcher.state, data),
    buildUnchecked,
    reauthUrl: data && !data.ok ? data.reauthUrl ?? null : null,
    build,
    onRepair: () => {
      beginSession();
      fetcher.submit({ intent: "repair-build-workflow" }, { method: "post" });
    },
  };
}

/**
 * Where the build-workflow repair stands. An in-flight fetcher is `running`
 * whatever it last returned; a settled repair is read off its result, and every
 * outcome the action calls `ok` counts as done for the page — what the
 * repository looks like afterwards is the re-run's answer, not this one's.
 */
function deriveWorkflowRepairStatus(
  fetcherState: "idle" | "loading" | "submitting",
  data: RepairActionData,
): WorkflowRepairStatus {
  if (fetcherState !== "idle") return "running";
  if (!data || data.intent !== "repair-build-workflow") return "idle";
  // The layout's notice speaks for a repair refused because the site changed.
  if (isSiteChanged(data)) return "idle";
  if (data.ok) return "done";
  if (data.error === "insufficient_permissions") return "permission";
  if (data.error === "insufficient_permissions_convenor_required") {
    return "permission_convenor_required";
  }
  if (data.error === "stale_head") return "stale";
  return "failed";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * What the page says when nothing has changed since the last publish: that
 * the site is up to date, or, where the checks found headings the site
 * misreads in files a publish rewrites, that publishing corrects them.
 */
function UpToDateNotice({ headingFiles }: { headingFiles: readonly string[] }) {
  const { t } = useTranslation("publish");
  const files = headingFiles.map((f) => `"${f}"`).join(", ");
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center bg-cream rounded-lg border border-cream-dark">
      <p className="font-heading font-semibold text-charcoal mb-1">
        {files ? t("review.header_spelling_title") : t("review.up_to_date")}
      </p>
      <p className="font-body text-sm text-charcoal/60">
        {files ? t("review.header_spelling_description", { files }) : t("review.up_to_date_description")}
      </p>
    </div>
  );
}

export default function PublishPage({ loaderData }: Route.ComponentProps) {
  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};
  const appData = useRouteLoaderData("routes/_app") as
    | { repoUnavailable?: boolean; repoFullName?: string | null; releaseUnknown?: boolean }
    | null;
  const repoUnavailable = appData?.repoUnavailable ?? false;
  // The latest release could not be read; the action refuses a publish on
  // the same reading, so the button waits rather than offering it.
  const releaseUnknown = appData?.releaseUnknown ?? false;
  const repoFullName = appData?.repoFullName ?? null;
  const { t } = useTranslation("publish");
  const { project, changeSummary, snapshotOk, summaryFingerprint } = loaderData;

  // Role read via the typed loader hook (replaces the ad-hoc useRouteLoaderData
  // cast). An instructor or a caller with no project membership is redirected
  // away from /publish by the routes/_app loader guard (→ /objects?denied=publish),
  // so this is a belt-and-braces don't-render: such a caller never reaches this
  // component, but if they did we render nothing rather than a restriction
  // notice. Render-gating is a UX layer only — the server side enforces the
  // same convenor-or-collaborator gate independently.
  const isPublisher = useIsPublisher();
  if (!isPublisher) return null;

  const { provider } = useCollaborationContext();
  // Another member's publish or upgrade; the server refuses to begin this one
  // while it runs, so the button waits on it and says whose it is.
  const operationLock = useOperationLock();

  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  // A run of the checks that did not answer. It leaves the checks unanswered
  // rather than clean: an empty result would offer Publish over warnings the
  // author has not seen, and the action re-checks blockers only.
  const [validationFailed, setValidationFailed] = useState(false);
  // The settings-replaced warnings a refused publish returned, for pages the
  // checks on screen did not warn of. Shown above Publish, and acknowledged
  // with the next publish.
  const [refusedReplacements, setRefusedReplacements] = useState<ValidationItem[]>([]);
  const [publishResult, setPublishResult] = useState<{ newHeadSha: string; commitUrl: string; leftFiles: ValidationItem[] } | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Commit-message editing: the mono card shows the auto-generated message
  // by default; the textarea (CommitMessageEditor) is revealed only on click.
  // `editedMessage` overrides the auto-generated message once the user touches
  // it.
  const [isEditingMessage, setIsEditingMessage] = useState(false);
  const [editedMessage, setEditedMessage] = useState<string | null>(null);

  // Clear the publish awareness fields on TRUE unmount. Without this, a user who
  // navigates away from /publish mid-build leaves this client's awareness
  // pinned at `building: true`, and the global pill reads it off awareness and
  // would stay in "Publishing…" until the socket reconnects. Empty deps so the
  // cleanup runs only on unmount; the latest provider is read from a ref.
  const providerRef = useRef(provider);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);
  useEffect(() => {
    return () => {
      const p = providerRef.current;
      if (!p) return;
      p.awareness.setLocalStateField("building", false);
      p.awareness.setLocalStateField("publishSha", null);
      p.awareness.setLocalStateField("publishCommitUrl", null);
    };
  }, []);

  const validationFetcher = useSiteFetcher();
  const publishFetcher = useSiteFetcher();
  // Headless build-complete poll. This
  // page is where the success card lives, so it owns the poll loop that watches
  // the GitHub Actions build to completion — the Site Status pill drives the
  // build chrome, but the pill's `isPublishing` flips false on commit return
  // (before the build runs), so the page cannot read completion off awareness.
  const pollFetcher = useSiteFetcher();
  // The build-workflow repair offered under the stale-workflow warning. Its own
  // fetcher so a repair in flight never reads as a publish or a validation run.
  const repairFetcher = useSiteFetcher();
  // The repair's build is followed by a poll of its own — its own fetcher, its
  // own sha, its own session — so that neither poll can end, overwrite or
  // cancel the other's request, and so the repair reaches none of the publish
  // state the pill and the success card read.
  const repairPollFetcher = useSiteFetcher();

  const validationData = validationFetcher.data as PublishActionData;

  // The reset a page front-matter blocker offers travels with a re-run of the
  // checks: the action has the collaboration object reset and snapshot, then
  // reads D1, so the result it returns already reflects the reset.
  const handleResetPageFrontmatter = (slug: string) =>
    validationFetcher.submit(
      { intent: "run-validation", resetPageFrontmatter: slug },
      { method: "post" },
    );
  const publishData = publishFetcher.data as PublishActionData;

  // The removal a story column blocker offers travels with a re-run of the
  // checks: the action has the collaboration object remove and snapshot, then
  // reads D1, so the result it returns already reflects the removal.
  const handleRemoveColumn = (removable: RemovableColumns, column: string) =>
    validationFetcher.submit(
      removable.table === "steps"
        ? { intent: "run-validation", removeStoryId: removable.storyId ?? "", removeColumn: column }
        : { intent: "run-validation", removeTable: removable.table, removeColumn: column },
      { method: "post" },
    );
  const pollData = pollFetcher.data as PublishActionData;
  const repairData = repairFetcher.data as RepairActionData;
  const repairPollData = repairPollFetcher.data as PublishActionData;

  // Build-completion state, driven only by the headless poll (never by
  // isPublishing — the landmine). `buildStatus === "completed"` stops the loop;
  // `buildConclusion` then decides success vs failure card.
  const [buildStatus, setBuildStatus] = useState<string>("pending");
  const [buildConclusion, setBuildConclusion] = useState<string | null>(null);
  // Whether the repository was private when the build failed. Only `true`
  // licenses the failure card to name it as the cause; null means the probe
  // could not answer and the card stays generic.
  const [repoPrivate, setRepoPrivate] = useState<boolean | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  // The 6 real BUILD_PHASES from the headless poll, kept so the inline tracker
  // (PublishingStepper) shows live per-step progress. Null until the first poll
  // lands; resolvePublishSteps synthesises a dispatching state.
  const [buildPhases, setBuildPhases] = useState<BuildPhaseStatus[] | null>(null);
  const isBuildComplete = buildStatus === "completed";

  // Broadcast the build's progress to all connected clients via Yjs awareness,
  // for the Site Status pill; the freeze itself is the server's lease. The
  // SHA/commitUrl are lifted off-route here so the global
  // Site Status pill's PublishingPopover can drive the existing poll-build
  // loop from any route — they survive navigation away from /publish.
  // Declared after isBuildComplete because the "building" field depends on it.
  useEffect(() => {
    if (!provider) return;
    // "building" stays true from commit-success (publishResult set) until the
    // build completes — keeping the Site Status pill in "publishing" through the
    // build, while the freeze lifts when the commit returns.
    provider.awareness.setLocalStateField("building", !!publishResult && !isBuildComplete);
    provider.awareness.setLocalStateField("publishSha", publishResult?.newHeadSha ?? null);
    provider.awareness.setLocalStateField("publishCommitUrl", publishResult?.commitUrl ?? null);
  }, [publishResult, isBuildComplete, provider]);

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
  const headingFiles = headingFilesOf(validationResult);

  // Everything below that reads `changeSummary` is a claim about the site's
  // current state, and the loader's forced snapshot is what makes it one. When
  // that snapshot did not run, D1 is behind the document and the summary
  // describes a superseded state.
  const stateUnreadable = snapshotOk === false;

  // The commit message is the one derived value that outlives the page: it is
  // submitted with the publish and becomes GitHub's permanent record of what
  // the commit contained. An inventory built from a state we could not read
  // would write a false one, and no later publish can correct it — so the
  // message falls back to its neutral headline, which claims nothing.
  const autoGeneratedHeadline = stateUnreadable
    ? t("auto_commit.default_headline")
    : autoGenerateCommitMessage(changeSummary, t, headingFiles);
  const autoGeneratedBody = stateUnreadable
    ? ""
    : autoGenerateCommitBody(changeSummary, t);
  const autoGeneratedMessage = autoGeneratedBody
    ? `${autoGeneratedHeadline}\n\n${autoGeneratedBody}`
    : autoGeneratedHeadline;

  // Handle validation response
  useEffect(() => {
    if (!validationData) return;
    if (validationData.ok && validationData.intent === "run-validation") {
      setValidationFailed(false);
      setValidationResult(validationData.validation);
      // The checks' own answer now says which pages' settings are replaced.
      setRefusedReplacements([]);
    } else if (!validationData.ok && validationData.intent === "run-validation") {
      setValidationResult(null);
      setValidationFailed(true);
    }
  }, [validationData]);


  // Handle publish response
  useEffect(() => {
    if (!publishData) return;
    if (publishData.ok && publishData.intent === "publish") {
      setIsPublishing(false);
      setPublishResult({ newHeadSha: publishData.newHeadSha, commitUrl: publishData.commitUrl, leftFiles: publishData.leftFiles });
    } else if (!publishData.ok && publishData.intent === "publish") {
      setIsPublishing(false);
      // Refused because the site changed: nothing was committed, and the
      // layout's notice says why.
      if (isSiteChanged(publishData)) return;
      // Refused because it would replace settings the author was not warned
      // of: nothing was committed, and the warnings are the explanation.
      if ("warnings" in publishData) {
        setRefusedReplacements(publishData.warnings);
        return;
      }
      setPublishError(publishErrorMessage(t, publishData.error));
      // The action names the project it acted on, which is the session's and can
      // differ from the one this page shows when another tab switched it.
      if ("projectId" in publishData && typeof publishData.projectId === "number") {
        recordPublishFailure(publishData.error ?? "unknown", publishData.projectId);
      }
    }
  }, [publishData, t]);

  // Each repair is its own poll session, scoped two ways. The sha is what a
  // response answers for, so a response naming another commit is not this
  // session's however it arrives; the counter behind it covers a failure that
  // names no commit, and the repair fetcher's own held-over `repaired` result.
  const repairSessionRef = useRef(0);
  const repairPollSessionRef = useRef<number | null>(null);
  const repairPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The sha the session polls for, written only where its poll starts and
  // cleared where the session ends, so it names the commit in flight and not
  // whichever repair settled last.
  const repairPollShaRef = useRef<string | null>(null);
  // The fetcher's live state, read from inside the scheduled submit, which
  // closes over the render that scheduled it.
  const repairPollStateRef = useRef(repairPollFetcher.state);
  // Publish attempts, counted where they are submitted. A count is what tells
  // a publish that started after the repair from one already in flight when it
  // began — the result object alone cannot, since it arrives after either.
  const publishAttemptRef = useRef(0);
  const publishAttemptAtRepairRef = useRef(0);
  // Latched once, because the publish it stands for is a build that ran: a
  // later retry clearing `publishResult` does not unrun it. Only the next
  // repair session, with its own build to account for, resets it.
  const [publishFollowedRepair, setPublishFollowedRepair] = useState(false);
  const [repairPollSnapshot, setRepairPollSnapshot] = useState<
    { session: number; poll: RepairPollSnapshot } | null
  >(null);

  const repairPollCurrent =
    repairPollSnapshot && repairPollSnapshot.session === repairSessionRef.current
      ? repairPollSnapshot.poll
      : null;
  const repairBuild = deriveWorkflowRepairBuild(repairPollCurrent, publishFollowedRepair);

  /** End the running poll session, then open the next one. */
  function beginRepairSession() {
    if (repairPollTimerRef.current) clearTimeout(repairPollTimerRef.current);
    repairPollTimerRef.current = null;
    repairPollSessionRef.current = null;
    repairPollShaRef.current = null;
    repairSessionRef.current += 1;
    publishAttemptAtRepairRef.current = publishAttemptRef.current;
    setPublishFollowedRepair(false);
    setRepairPollSnapshot(null);
  }

  // A publish counts as following the repair only when it was submitted after
  // the session opened AND reached a commit: a publish that failed produced no
  // build, so it explains no cancellation.
  useEffect(() => {
    if (!publishResult) return;
    if (publishAttemptRef.current <= publishAttemptAtRepairRef.current) return;
    setPublishFollowedRepair(true);
  }, [publishResult]);

  function submitRepairPoll(sha: string) {
    repairPollFetcher.submit({ intent: "poll-build", sha }, { method: "post" });
  }

  const workflowRepair = buildWorkflowRepairProp(
    repairFetcher,
    repairData,
    repairBuild,
    beginRepairSession,
    // The poll is asked again on its own; until one is answered, the line
    // above it is the last answer, not the build's present state.
    repairPollUnanswered(repairPollData, repairPollSessionRef.current, repairSessionRef.current),
  );

  // A settled repair speaks for the repository as it stands, which the checks on
  // screen do not, so they are re-run once per distinct successful result —
  // including for `already_current` and `not_needed`, whose whole point is that
  // the tree has moved under the warning. Identity-compared against the last
  // result processed, so a re-render with the same result object does not
  // trigger a second run, but each new successful repair does.
  const lastRerunForRef = useRef<typeof repairData>(null);
  useEffect(() => {
    if (repairData?.ok !== true) return;
    if (lastRerunForRef.current === repairData) return;
    lastRerunForRef.current = repairData;
    validationFetcher.submit({ intent: "run-validation" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairData]);

  // Only `repaired` starts a poll: the other two outcomes commit nothing, so
  // there is no build to follow. Latched on the result object, which is what
  // tells the session's own `repaired` from the one the fetcher still holds
  // from the session before it.
  const repairPollStartedForRef = useRef<RepairActionData>(null);
  useEffect(() => {
    if (repairData?.ok !== true) return;
    if (repairData.outcome !== "repaired" || !repairData.newHeadSha) return;
    if (repairPollStartedForRef.current === repairData) return;
    repairPollStartedForRef.current = repairData;
    repairPollSessionRef.current = repairSessionRef.current;
    repairPollShaRef.current = repairData.newHeadSha;
    submitRepairPoll(repairData.newHeadSha);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairData]);

  useEffect(() => {
    repairPollStateRef.current = repairPollFetcher.state;
  }, [repairPollFetcher.state]);

  // One submit per response, five seconds after it, and only while the fetcher
  // is idle — a fixed interval would cancel its own request as soon as a poll
  // outlasted the tick. A response that answers for another commit, or for a
  // session already ended, is dropped whole: it neither renders nor schedules,
  // which is what keeps a new repair's result and the previous repair's late
  // response apart when they land in the same render.
  useEffect(() => {
    if (isSiteChanged(repairPollData)) return;
    if (!isPollBuildData(repairPollData)) return;
    const session = repairPollSessionRef.current;
    if (session === null || session !== repairSessionRef.current) return;
    const sha = repairPollShaRef.current;
    if (!sha) return;
    if (repairPollData.sha != null && repairPollData.sha !== sha) return;
    if (repairPollTimerRef.current) clearTimeout(repairPollTimerRef.current);
    repairPollTimerRef.current = null;
    // A failed poll says nothing about the build, so the line stands where the
    // last answer left it and the poll asks again. Only `completed` ends it.
    if (repairPollData.ok) {
      setRepairPollSnapshot({
        session,
        poll: {
          buildStatus: repairPollData.buildStatus,
          buildConclusion: repairPollData.buildConclusion,
          buildUrl: repairPollData.buildUrl,
        },
      });
      if (repairPollData.buildStatus === "completed") return;
    }
    repairPollTimerRef.current = setTimeout(() => {
      repairPollTimerRef.current = null;
      if (repairPollStateRef.current !== "idle") return;
      if (repairPollSessionRef.current !== repairSessionRef.current) return;
      submitRepairPoll(sha);
    }, 5000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairPollData]);

  // Leaving the page ends the repair's poll; the build goes on at GitHub, and
  // the line is page-local, so nothing is restored on return.
  useEffect(() => {
    return () => {
      if (repairPollTimerRef.current) clearTimeout(repairPollTimerRef.current);
    };
  }, []);

  // Process headless poll-build results. Mirrors BuildTracker's poll-result
  // handling minus the per-phase UI state (the pill owns the phase log). Once
  // buildStatus is "completed" we latch the conclusion and the loop stops.
  useEffect(() => {
    // A poll refused because the site changed is not asked again: the
    // layout's notice has said why, and this tab's build is not the
    // session's.
    if (isSiteChanged(pollData)) {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      return;
    }
    if (!pollData?.ok || pollData.intent !== "poll-build") return;
    if (pollData.buildUrl) setBuildUrl(pollData.buildUrl);
    if (pollData.runId != null) setRunId(pollData.runId);
    if (pollData.phases) setBuildPhases(pollData.phases as BuildPhaseStatus[]);
    setBuildStatus(pollData.buildStatus);
    if (pollData.buildStatus === "completed") {
      setBuildConclusion(pollData.buildConclusion);
      setRepoPrivate(pollData.repoPrivate);
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
    // Checks run against D1, so without a successful snapshot they measure the
    // same superseded rows the diff is withheld for. A clean verdict from that
    // read is the page vouching for content it never saw — and the checks also
    // gate the publish button, so a stale blocker would refuse a publish over
    // an edit that may already be fixed. The action re-checks after its own
    // snapshot; that is the pass the published content is measured against.
    if (stateUnreadable) return;
    hasRunValidationRef.current = true;
    validationFetcher.submit({ intent: "run-validation" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePublish(fullMessage: string) {
    publishAttemptRef.current += 1;
    setIsPublishing(true);
    setPublishError(null);
    // Split on first blank line: everything before is the headline, after is the body
    const { commitMessage, commitBody } = splitCommitMessage(fullMessage);
    // The action publishes what its own snapshot leaves in D1, which can hold
    // edits this summary never saw. Send the state stamp the message was built
    // from so it can tell, and the neutral headline to use instead — that
    // headline is localised, and the action has no locale.
    //
    // Only for the message this page generated. What the author typed is their
    // account of their own publish, not an inventory of a read, and it travels
    // unstamped so the action leaves it alone. An untouched editor submits the
    // generated message verbatim, so it is still stamped.
    const fields: Record<string, string> = { intent: "publish", commitMessage };
    if (commitBody) fields.commitBody = commitBody;
    // The page and block of each settings-replaced warning on screen, which
    // the action refuses to replace unnamed.
    const warned = replacedSettingsOf([...(validationResult?.warnings ?? []), ...refusedReplacements]);
    if (warned.length > 0) fields[ACKNOWLEDGED_REPLACED_PAGES] = JSON.stringify(warned);
    const isGenerated = fullMessage === autoGeneratedMessage;
    if (isGenerated && typeof summaryFingerprint === "string" && summaryFingerprint.length > 0) {
      fields.summaryFingerprint = summaryFingerprint;
      fields.fallbackHeadline = t("auto_commit.default_headline");
      claimHeadingsCorrected(fields, autoGeneratedHeadline, t);
    }
    publishFetcher.submit(fields, { method: "post" });
  }

  function closeMessageEditor(message: string) {
    setEditedMessage(message.trim() || null);
    setIsEditingMessage(false);
  }

  function runValidation() {
    setValidationFailed(false);
    validationFetcher.submit({ intent: "run-validation" }, { method: "post" });
  }

  function handleRetry() {
    setPublishResult(null);
    setPublishError(null);
    setIsPublishing(false);
    setValidationResult(null);
    setRefusedReplacements([]);
    setIsEditingMessage(false);
    setEditedMessage(null);
    // Reset the headless build-poll state so a re-publish starts a fresh poll.
    setBuildStatus("pending");
    setBuildConclusion(null);
    setBuildUrl(null);
    setRunId(null);
    setBuildPhases(null);
    // The checks were cleared above and Publish waits on their answer; the
    // mount run does not fire again, so the retry runs them itself.
    if (!stateUnreadable) runValidation();
  }

  // A diff computed without a successful snapshot describes rows the document
  // has already moved past, so the summary is withheld rather than shown with
  // a caveat. The up-to-date verdict in particular is load-bearing twice over:
  // it is a claim to the author AND it disables the publish button, which
  // would lock them out over a read that failed.
  const isUpToDate = !stateUnreadable && changeSummary.isUpToDate;
  // Headings the site misreads in files every publish rewrites: a publish is
  // what corrects them, so it stays possible with nothing else changed
  // (`headingFiles`, above).
  // Publish waits for the checks to answer, including a re-run while an older
  // answer is still on screen: the action re-checks blockers only, so a
  // warning the author has not seen yet would otherwise go out unread. A page
  // that cannot read the state never runs the checks and does not wait.
  const checksUnanswered = !stateUnreadable && (validationResult === null || validationFetcher.state !== "idle");
  const publishDisabled =
    isPublishing ||
    hasBlockers ||
    checksUnanswered ||
    nothingToPublish(isUpToDate, headingFiles) ||
    operationLock !== null ||
    releaseUnknown;

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
          {/* Named whatever the build does: the record they came from is cleared. */}
          <ValidationWarnings warnings={publishResult.leftFiles} className="mb-4" />
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
            <BuildFailureCard
              repoPrivate={repoPrivate}
              repoFullName={repoFullName}
              buildUrl={buildUrl}
              onRetry={handleRetry}
            />
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
            {stateUnreadable ? (
              <div className="flex flex-col items-center justify-center py-10 text-center bg-cream rounded-lg border border-cream-dark">
                <p className="font-heading font-semibold text-charcoal mb-1">
                  {t("review.state_unavailable")}
                </p>
                <p className="font-body text-sm text-charcoal/60">
                  {t("review.state_unavailable_description")}
                </p>
              </div>
            ) : isUpToDate ? (
              <UpToDateNotice headingFiles={headingFiles} />
            ) : (
              <ChangeSummaryComponent summary={changeSummary} />
            )}
          </section>

          {/* === WHAT WE CHECKED === */}
          <section>
            <h2 className="font-heading font-semibold text-lg text-charcoal mb-3">
              {t("sections.what_we_checked")}
            </h2>
            {stateUnreadable ? (
              // `ValidationChecks` renders a spinner for a null result, which
              // would sit there for good on a page that never runs the checks.
              <p className="font-body text-sm text-charcoal/60 py-4">
                {t("checks.state_unavailable")}
              </p>
            ) : validationFailed ? (
              <div className="py-4 space-y-3">
                <p role="alert" className="font-body text-sm text-terracotta-deep">
                  {t("checks.failed")}
                </p>
                <Button type="button" variant="secondary" onClick={runValidation}>
                  {t("checks.run_again")}
                </Button>
              </div>
            ) : (
              <ValidationChecks
                validation={validationResult}
                workflowRepair={workflowRepair}
                onResetPageFrontmatter={handleResetPageFrontmatter}
                onRemoveColumn={handleRemoveColumn}
                removalFailed={removalFailureOf(validationData)}
                resetFailed={resetFailureOf(validationData)}
              />
            )}
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

            {refusedReplacements.length > 0 && (
              <div className="bg-cream rounded-lg p-3 mb-4">
                <ValidationWarnings warnings={refusedReplacements} className="" />
              </div>
            )}

            {isEditingMessage ? (
              <div className="rounded-lg bg-cream px-4 py-3">
                <CommitMessageEditor
                  defaultMessage={editedMessage ?? autoGeneratedMessage}
                  onPublish={handlePublish}
                  onDone={closeMessageEditor}
                  loading={isPublishing}
                  disabled={publishDisabled}
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

            {hasBlockers && (
              <p className="font-body text-sm text-cream/90 mt-3">
                {t("publish_section.blocked_note")}
              </p>
            )}
            {releaseUnknown && !isPublishing && !publishError && (
              <p className="font-body text-sm text-cream/90 mt-3">{t("release_unknown")}</p>
            )}
            {operationLock && !isPublishing && (
              <OperationLockNotice lock={operationLock} waiting="publish" className="text-cream/90 mt-3" />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
