/**
 * This file renders the Sync confirmation modal — the multi-step
 * modal for pulling changes made directly in the GitHub repo back
 * into the compositor. It mounts on the Objects page (the daily
 * home) and opens via the `?sync=1` deep-link that the out-of-sync
 * popover and the publish page's stale-head blocker both point at.
 *
 * Provides a state-machine flow:
 *   1. Confirm — prompt user to check what changed in the repo
 *   2. Computing — diffFetcher submits compute-full-sync-diff intent
 *   3. (Optional) Conflict — warns about unpublished local changes
 *   4. DiffReady — diff display with apply button
 *   5. Applying — applyFetcher submits apply-full-sync intent
 *   6. Success — brief confirmation, then page refresh
 *   7. Failed — error display with retry option
 *
 * The Conflict and DiffReady steps list, first, what the check found wrong in
 * the repository's sheets and step files (`diff.warnings`). The DiffReady step
 * lists the stories whose content changed and the pages whose file changed
 * on GitHub, each with its own choice.
 *
 * Two comparison modes, driven by `diff.classification`:
 *   - three-way (base = repo files at head_sha available): editor-only
 *     changes are suppressed, genuine repo↔editor conflicts are surfaced
 *     inline with a per-field / per-row choice (default keep mine), and the
 *     coarse conflict-warning step is skipped. Apply builds a precise
 *     FullSyncChanges from the selections.
 *   - two-way (base unavailable): all-or-nothing, with a conflict-warning step
 *     keyed off the live count when known, else the loader's estimate.
 *
 * The sync intents live on the /dashboard action (the app's shared
 * global endpoint), so every fetcher submit here targets it
 * explicitly — a bare POST would hit the rendering route's own
 * action, which does not handle them.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useSiteFetcher } from "~/lib/page-site";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import { SheetWarnings } from "~/components/ui/SheetWarnings";
import { SheetChoicesStep, choicesQuestionOf, type SheetChoicesQuestion } from "./SheetChoicesStep";
import type { FullSyncDiff } from "~/lib/sync.server";
import {
  buildAllOrNothingChanges,
  buildThreeWayChanges,
  contentChoiceOf,
  contentInconclusive,
  emptySelections,
  hasConflictItems,
  hasDiffChanges,
  applyNoteKeys,
  contentView,
  keepMineFields,
  listedContentChanges,
  listedPageChanges,
  listedPageFiles,
  ownValue,
  changedWhileReviewedOf,
  successKey,
} from "./sync-changes";
import type { ConflictChoice, ThreeWaySelections } from "./sync-changes";

// The builders and selection types live in sync-changes.ts; exported from here
// as well, where the dialog's other modules and tests have always found them.
export {
  buildAllOrNothingChanges,
  buildThreeWayChanges,
  contentChoiceOf,
  contentInconclusive,
  emptySelections,
  listedContentChanges,
} from "./sync-changes";
export type { ConflictChoice, ThreeWaySelections } from "./sync-changes";
import type { CollidingColumns } from "~/lib/sync-failure.server";
import { configFieldLabel } from "~/lib/activity-display";
import { SyncConflictsBlock } from "./SyncConflictsBlock";
import { SyncStoryContentBlock } from "./SyncStoryContentBlock";
import {
  ChangedWhileReviewedNotice, NOTHING_CHANGED_WHILE_REVIEWED, PageReviewNotices,
  type ChangedWhileReviewed,
} from "./SyncPageContentBlock";
import { SyncPagesBlocks } from "./SyncPageFilesBlock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Shared useFetcher key so the page hosting the modal can observe the
 * same compute-full-sync-diff response and surface the version-change
 * toast without duplicating the submission.
 */
export const SYNC_DIFF_FETCHER_KEY = "dashboard-sync-diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncStep =
  | "confirm"
  | "computing"
  | "conflict"
  | "diffReady"
  | "applying"
  | "accepting"
  | "success"
  | "acceptedSuccess"
  | "failed";

interface SyncConfirmModalProps {
  open: boolean;
  /** The header's count: live when `countKnown`, otherwise the loader's estimate. */
  unpublishedCount: number;
  countKnown?: boolean;
  onClose: () => void;
}

/** What a sync action returns when it fails (see `syncFailure`). */
interface SyncFailureData {
  error: string;
  message?: string;
  collidingColumns?: CollidingColumns;
  /** The sheet a `sheet_unreadable` failure could not read. */
  sheet?: string;
  /** The path of the file a `file_unreadable` failure could not read. */
  file?: string;
}

type DiffFetcherData =
  | { ok: true; intent: "compute-full-sync-diff"; diff: FullSyncDiff }
  | ({ ok: false; intent: "compute-full-sync-diff" } & SyncFailureData)
  | null
  | undefined;

type ApplyFetcherData =
  | {
      ok: true;
      intent: "apply-full-sync";
      newHeadSha: string | null;
      storyFilesInconclusive?: boolean;
      pageFilesInconclusive?: boolean;
    }
  | ({ ok: false; intent: "apply-full-sync"; storyIds?: string[]; pageIds?: number[]; objectIds?: string[] } & SyncFailureData)
  | { ok: true; intent: "accept-divergence" }
  | { ok: false; intent: "accept-divergence"; error: string; message?: string }
  | null
  | undefined;


// ---------------------------------------------------------------------------
// Helper: the failed step's message
// ---------------------------------------------------------------------------

/**
 * The failed step's message. A sheet the sync refused for its colliding
 * columns names the sheet and the columns; a sheet, file or ignored-stories
 * list it could not read is named, with nothing synced; object rows and
 * glossary terms D1 refused, and entries it could not store, have their own messages. Any
 * other code shows the general sync failure message, never the server's text;
 * an answer with no code, as an unreachable one, shows the unknown-error one.
 */
export function syncFailureMessage(
  data: SyncFailureData,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (data.error === "colliding_columns" && data.collidingColumns) {
    return t("sync_modal.error_colliding_columns", {
      sheet: data.collidingColumns.sheet,
      columns: data.collidingColumns.headers.map((h) => `"${h}"`).join(", "),
    });
  }
  if (data.error === "sheet_unreadable" && data.sheet) {
    return t("sync_modal.error_sheet_unreadable", { sheet: data.sheet });
  }
  if (data.error === "file_unreadable" && data.file) {
    return t("sync_modal.error_file_unreadable", { file: data.file });
  }
  if (data.error === "objects_not_added") return t("objects:sync_not_added");
  if (data.error === "entries_refused") return t("sync_modal.error_entries_refused");
  if (data.error === "inserts_not_added") return t("sync_modal.error_terms_not_added");
  if (data.error === "ignore_list_unreadable") return t("sync_modal.error_ignore_list_unreadable");
  if (data.error === undefined) return t("unknown_error");
  return t("objects:sync_error_toast");
}

// ---------------------------------------------------------------------------
// Collapsible category section (pre-accepted, repo-only items)
// ---------------------------------------------------------------------------

interface CategorySectionProps {
  label: string;
  items: string[];
}

/** A reorder of objects as the one item it is in the objects section: no choice, applied with the sync. */
function reorderItemsOf(diff: FullSyncDiff, label: string): string[] {
  return diff.objects.reordered != null ? [label] : [];
}

function CategorySection({ label, items }: CategorySectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-cream-dark hover:bg-cream-dark/80 transition-colors"
      >
        <span className="font-heading font-semibold text-sm text-charcoal">{label}</span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-charcoal/50" />
        ) : (
          <ChevronDown className="w-4 h-4 text-charcoal/50" />
        )}
      </button>
      {open && (
        <ul className="px-4 py-2 space-y-1 bg-white">
          {items.map((item) => (
            <li key={item} className="font-body text-sm text-charcoal/80">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The diffReady step's notices and actions
// ---------------------------------------------------------------------------

/** The diffReady heading's key. `filesUnread`: the story or the page files could not be read. */
function diffReadyHeading(anythingToApply: boolean, filesUnread: boolean): string {
  if (anythingToApply) return "sync_modal.changes_found";
  return filesUnread ? "sync_modal.title" : "sync_modal.no_changes";
}

const NOTICE_CLASS = "font-body text-sm text-charcoal bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4";

/**
 * Why the list changed, after Keep my version was refused because GitHub
 * moved past the commit the list was read at, or after an accept refused
 * stories or pages edited while they were reviewed; and that the check could
 * not read the story files or the page files.
 */
function ReviewNotices({
  changedWhileReviewed,
  pagesChangedWhileReviewed,
  storyFilesUnread,
  pageFilesUnread,
  githubMovedWhileReviewed,
}: {
  changedWhileReviewed: ChangedWhileReviewed;
  pagesChangedWhileReviewed: string[];
  storyFilesUnread: boolean;
  pageFilesUnread: boolean;
  githubMovedWhileReviewed: boolean;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <>
      {githubMovedWhileReviewed && <p className={NOTICE_CLASS}>{t("sync_modal.accept_divergence_stale")}</p>}
      <ChangedWhileReviewedNotice changed={changedWhileReviewed} />
      {storyFilesUnread && <p className={NOTICE_CLASS}>{t("sync_modal.content_inconclusive")}</p>}
      <PageReviewNotices pagesChangedWhileReviewed={pagesChangedWhileReviewed} pageFilesUnread={pageFilesUnread} />
    </>
  );
}

/** What applying, or keeping the Compositor's version, will do. */
function ApplyNotes({
  anythingToApply,
  storyFilesUnread,
  pageFilesUnread,
}: {
  anythingToApply: boolean;
  storyFilesUnread: boolean;
  pageFilesUnread: boolean;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <>
      {applyNoteKeys(anythingToApply, storyFilesUnread, pageFilesUnread).map((key) => (
        <p key={key} className="font-body text-sm text-gray-600 mb-2">{t(key)}</p>
      ))}
    </>
  );
}


interface DiffReadyActionsProps {
  anythingToApply: boolean;
  /** The story or the page files could not be read. */
  filesUnread: boolean;
  onClose: () => void;
  onCheckAgain: () => void;
  onKeepMine: () => void;
  onApply: () => void;
}

/**
 * The diffReady step's buttons. With the story or page files unread the
 * author can check again or keep the Compositor's version, and Apply, when
 * there is anything else to apply, says it applies the other changes.
 */
function DiffReadyActions({ anythingToApply, filesUnread, onClose, onCheckAgain, onKeepMine, onApply }: DiffReadyActionsProps) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="flex flex-wrap gap-3 justify-end mt-4">
      <button
        type="button"
        onClick={onClose}
        className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
      >
        {anythingToApply || filesUnread ? t("cancel") : t("sync_modal.close")}
      </button>
      {filesUnread && (
        <button
          type="button"
          onClick={onCheckAgain}
          className="font-heading font-semibold text-sm uppercase tracking-wider border border-charcoal text-charcoal rounded-full px-5 py-2 hover:bg-charcoal hover:text-cream transition-colors"
        >
          {t("sync_modal.check_again")}
        </button>
      )}
      {(anythingToApply || filesUnread) && (
        <button
          type="button"
          onClick={onKeepMine}
          className="font-heading font-semibold text-sm uppercase tracking-wider border border-charcoal text-charcoal rounded-full px-5 py-2 hover:bg-charcoal hover:text-cream transition-colors"
        >
          {t("sync_modal.use_compositor_version")}
        </button>
      )}
      {anythingToApply && (
        <button
          type="button"
          onClick={onApply}
          className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
        >
          {filesUnread ? t("sync_modal.apply_other_changes") : t("sync_modal.apply_sync")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncConfirmModal({ open, unpublishedCount, countKnown = true, onClose }: SyncConfirmModalProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  // Stable fetcher key so the hosting page can subscribe to the same
  // sync-diff response via useFetcher({ key }) and surface the
  // version-change toast (see _app.objects.tsx / useVersionChangeToast).
  const diffFetcher = useSiteFetcher({ key: SYNC_DIFF_FETCHER_KEY });
  const applyFetcher = useSiteFetcher();

  const [step, setStep] = useState<SyncStep>("confirm");
  const [diff, setDiff] = useState<FullSyncDiff | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  // A sheet the check refused for columns read as one field, offered for a choice instead of a message.
  const [question, setQuestion] = useState<SheetChoicesQuestion | null>(null);
  const [selections, setSelections] = useState<ThreeWaySelections>(emptySelections);
  // The stories an accept refused as edited while they were reviewed, named
  // on the list the dialog checked again for them.
  const [changedWhileReviewed, setChangedWhileReviewed] = useState<ChangedWhileReviewed>(NOTHING_CHANGED_WHILE_REVIEWED);
  // The pages an accept refused as edited while they were reviewed, likewise.
  const [pagesChangedWhileReviewed, setPagesChangedWhileReviewed] = useState<string[]>([]);
  // The accept applied the other changes but, the story files unread, left
  // the site out of sync.
  const [appliedStillDivergent, setAppliedStillDivergent] = useState(false);
  // The same, with the page files unread.
  const [appliedPagesStillDivergent, setAppliedPagesStillDivergent] = useState(false);
  // Keep my version was refused because GitHub moved past the commit the
  // dialog showed; the dialog checked again, and says so above the result.
  const [githubMovedWhileReviewed, setGithubMovedWhileReviewed] = useState(false);

  const diffData = diffFetcher.data as DiffFetcherData;
  const applyData = applyFetcher.data as ApplyFetcherData;

  // The diff fetcher keeps its previous data in flight for a new submission,
  // so a fresh compute-full-sync-diff response cannot be told apart from the
  // stale one by presence or shape alone. Recording the object that was
  // current when the submission went out lets the effect below recognise
  // and ignore that same stale object when it re-runs before the real
  // response lands.
  const submittedDiffDataRef = useRef<DiffFetcherData>(undefined);

  // Reset step when modal opens or closes
  useEffect(() => {
    if (!open) {
      setStep("confirm");
      setDiff(null);
      setErrorMessage("");
      setSelections(emptySelections());
      setChangedWhileReviewed(NOTHING_CHANGED_WHILE_REVIEWED);
      setPagesChangedWhileReviewed([]);
      setAppliedStillDivergent(false);
      setAppliedPagesStillDivergent(false);
      setGithubMovedWhileReviewed(false);
    }
  }, [open]);

  // Handle diff fetcher result. Only act while a compute is in flight: route
  // revalidation after an apply re-runs this effect (unpublishedCount changes)
  // with the same stale diffData, which would otherwise yank a post-apply step
  // back to diffReady/conflict. Guarding on step === "computing" pins it.
  //
  // step === "computing" also becomes true again on Retry -> Check changes,
  // while diffData still holds the previous submission's response (react-router
  // keeps a fetcher's old data until the new one resolves). Without the ref
  // check below, that stale response would be read as the answer to the new
  // submission and the modal would flash back to failed before the real
  // response arrives. Ignoring the object recorded at submission time makes
  // the effect act only on the response to its own submission, regardless of
  // when the fetcher's state flips to submitting.
  useEffect(() => {
    if (step !== "computing") return;
    if (!diffData) return;
    if (diffData === submittedDiffDataRef.current) return;
    // The layout's notice speaks for a check refused because the site
    // changed; this dialog has nothing to show for it.
    if (isSiteChanged(diffData)) {
      onClose();
      return;
    }
    if (!diffData.ok || diffData.intent !== "compute-full-sync-diff") {
      setQuestion(choicesQuestionOf(diffData));
      setErrorMessage(diffData.ok ? "" : syncFailureMessage(diffData, t));
      setStep("failed");
      return;
    }
    const hasChanges = hasDiffChanges(diffData.diff);
    // Three-way surfaces conflicts inline, so the coarse warning is skipped. Two-way
    // warns whenever the live count is unknown (the estimate misses local deletions)
    // and otherwise only when the live count is above 0.
    setDiff(diffData.diff);
    setSelections(emptySelections());
    if (hasChanges && diffData.diff.classification === "two-way" && (!countKnown || unpublishedCount > 0)) {
      setStep("conflict");
    } else {
      setStep("diffReady");
    }
  }, [diffData, unpublishedCount, countKnown, step]);
  useEffect(() => {
    // A warning chosen from the estimate is withdrawn if the live count lands as 0.
    if (step === "conflict" && countKnown && unpublishedCount === 0) setStep("diffReady");
  }, [step, countKnown, unpublishedCount]);

  // Handle apply / accept-divergence fetcher result
  useEffect(() => {
    if (!applyData) return;
    if (isSiteChanged(applyData)) {
      onClose();
      return;
    }
    if (!applyData.ok) {
      if (
        (applyData.intent === "accept-divergence" && applyData.error === "accept_divergence_stale") ||
        (applyData.intent === "apply-full-sync" && applyData.error === "sync_base_stale")
      ) {
        // GitHub, or the recorded head, moved past the diff the author was
        // shown, so their choice was not saved: check again, and say why the
        // list changed.
        setGithubMovedWhileReviewed(true);
        handleCheckChanges();
        return;
      }
      if (handledPageRefusal(applyData)) return;
      const names = storyNames(applyData.intent === "apply-full-sync" ? applyData.storyIds : undefined);
      if (applyData.error === "story_changed_since_review" || applyData.error === "object_changed_since_review") {
        // The live story, or an object's field, is no longer the one
        // reviewed: check again, and say why the list changed.
        setChangedWhileReviewed(changedWhileReviewedOf(applyData, names, diff));
        handleCheckChanges();
        return;
      }
      setErrorMessage(
        applyData.error === "story_content_failed"
          ? t("sync_modal.error_story_failed", { stories: names.join(", ") })
          : syncFailureMessage(applyData, t),
      );
      setStep("failed");
      return;
    }
    if (applyData.intent === "accept-divergence") {
      setStep("acceptedSuccess");
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
    if (applyData.intent === "apply-full-sync") {
      setAppliedStillDivergent(applyData.storyFilesInconclusive === true);
      setAppliedPagesStillDivergent(applyData.pageFilesInconclusive === true);
      setStep("success");
      setTimeout(() => window.location.reload(), 1500);
    }
  }, [applyData]);

  /** The stories' names as the dialog showed them, by id. */
  function storyNames(ids: readonly string[] | undefined): string[] {
    return (ids ?? []).map((id) => {
      const shown =
        diff?.stories.content?.conclusive === true
          ? diff.stories.content.changes.find((c) => c.story_id === id)?.title
          : undefined;
      return `“${shown || diff?.stories.changedStories.find((s) => s.story_id === id)?.title || id}”`;
    });
  }

  /**
   * An accept refused for its pages, answered: checked again, naming the
   * pages edited while they were reviewed, or failed, naming those not saved.
   * False for any other refusal.
   */
  function handledPageRefusal(data: Extract<NonNullable<ApplyFetcherData>, { ok: false }>): boolean {
    const pages = pageNames(data.intent === "apply-full-sync" ? data.pageIds : undefined);
    if (data.error === "page_changed_since_review") {
      setPagesChangedWhileReviewed(pages);
      handleCheckChanges();
      return true;
    }
    if (data.error !== "page_content_failed") return false;
    setErrorMessage(t("sync_modal.error_page_failed", { pages: pages.join(", ") }));
    setStep("failed");
    return true;
  }

  /** The pages' names as the dialog showed them, by id. */
  function pageNames(ids: readonly number[] | undefined): string[] {
    const shown = diff ? [...listedPageChanges(diff), ...listedPageFiles(diff)] : [];
    return (ids ?? []).map((id) => `“${shown.find((c) => c.pageId === id)?.title || id}”`);
  }

  function handleCheckChanges() {
    submittedDiffDataRef.current = diffFetcher.data as DiffFetcherData;
    setStep("computing");
    diffFetcher.submit(
      { intent: "compute-full-sync-diff" },
      { method: "post", action: "/dashboard" }
    );
  }

  function handleApply() {
    if (!diff) return;
    const changes =
      diff.classification === "three-way"
        ? buildThreeWayChanges(diff, selections)
        : buildAllOrNothingChanges(diff, selections);
    setChangedWhileReviewed(NOTHING_CHANGED_WHILE_REVIEWED);
    setPagesChangedWhileReviewed([]);
    setGithubMovedWhileReviewed(false);
    setStep("applying");
    applyFetcher.submit(
      { intent: "apply-full-sync", changes: JSON.stringify(changes) },
      { method: "post", action: "/dashboard" }
    );
  }

  function handleAcceptDivergence() {
    setGithubMovedWhileReviewed(false);
    setStep("accepting");
    // The identity of the diff the author reviewed, never the page's state.
    applyFetcher.submit(
      diff ? keepMineFields(diff) : { intent: "accept-divergence" },
      { method: "post", action: "/dashboard" }
    );
  }

  function handlePublishFirst() {
    onClose();
    navigate("/publish");
  }

  // ---------------------------------------------------------------------------
  // Selection setters
  // ---------------------------------------------------------------------------

  function setObjectFieldChoice(objectId: string, field: string, choice: ConflictChoice) {
    setSelections((prev) => ({
      ...prev,
      objectFieldChoices: {
        ...prev.objectFieldChoices,
        [objectId]: { ...(ownValue(prev.objectFieldChoices, objectId) ?? {}), [field]: choice },
      },
    }));
  }
  function setObjectRestore(objectId: string, restore: boolean) {
    setSelections((prev) => ({
      ...prev,
      objectRestore: { ...prev.objectRestore, [objectId]: restore },
    }));
  }
  function setObjectDelete(objectId: string, del: boolean) {
    setSelections((prev) => ({
      ...prev,
      objectDelete: { ...prev.objectDelete, [objectId]: del },
    }));
  }
  function setStoryRestore(storyId: string, restore: boolean) {
    setSelections((prev) => ({
      ...prev,
      storyRestore: { ...prev.storyRestore, [storyId]: restore },
    }));
  }
  function setRowChoice(kind: "story" | "config" | "glossary", id: string, choice: ConflictChoice) {
    setSelections((prev) => {
      const key =
        kind === "story" ? "storyChoices" : kind === "config" ? "configChoices" : "glossaryChangedChoices";
      return { ...prev, [key]: { ...prev[key], [id]: choice } };
    });
  }
  function setStoryContentChoice(storyId: string, choice: ConflictChoice) {
    setSelections((prev) => ({
      ...prev,
      storyContentChoices: { ...prev.storyContentChoices, [storyId]: choice },
    }));
  }
  function setGlossaryRestore(termId: string, restore: boolean) {
    setSelections((prev) => ({
      ...prev,
      glossaryRestore: { ...prev.glossaryRestore, [termId]: restore },
    }));
  }

  // ---------------------------------------------------------------------------
  // Build category sections for the diffReady step (repo-only, pre-accepted)
  // ---------------------------------------------------------------------------

  function buildCategorySections(threeWay: boolean) {
    if (!diff) return [];
    const sections: { label: string; items: string[] }[] = [];

    const itemNew = (name: string) => t("sync_modal.item_new", { name });
    const itemChanged = (name: string) => t("sync_modal.item_changed", { name });
    const itemRemoved = (name: string) => t("sync_modal.item_removed", { name });
    const sectionLabel = (category: string, count: number, anyChanged: boolean) =>
      `${category} (${anyChanged
        ? t("sync_modal.section_count_changed", { count })
        : t("sync_modal.section_count", { count })})`;

    // In three-way mode, conflicts (deleted-here objects, conflict-field
    // objects) move to the dedicated conflicts block, so the category lists
    // show only the pre-accepted repo-only items.
    const newObjects = threeWay
      ? diff.objects.newObjects.filter((o) => !o.deletedInCompositor)
      : diff.objects.newObjects;
    const changedObjects = threeWay
      ? diff.objects.changedObjects.filter((o) => o.conflictFields.length === 0)
      : diff.objects.changedObjects;
    // Deleted-in-repo/edited-here objects render in the conflicts block.
    const missingObjects = threeWay
      ? diff.objects.missingObjects.filter((o) => !o.editedInCompositor)
      : diff.objects.missingObjects;

    const reorderItems = reorderItemsOf(diff, t("objects:sync_order_changed"));
    const objectItems: string[] = [
      ...newObjects.map((o) => itemNew(o.object_id)),
      ...changedObjects.map((o) => itemChanged(o.object_id)),
      ...reorderItems,
      ...missingObjects.map((o) => itemRemoved(o.object_id)),
    ];
    if (objectItems.length > 0) {
      sections.push({
        label: sectionLabel(
          t("sync_modal.objects_category"),
          objectItems.length,
          changedObjects.length > 0,
        ),
        items: objectItems,
      });
    }

    const storyName = (s: { title?: string | null; story_id: string }) =>
      s.title || t("common:untitled");
    // A story whose content changed too is on its content card, whose one
    // choice covers its row.
    const onContentCard = new Set(listedContentChanges(diff).map((c) => c.story_id));
    const changedStories = (threeWay
      ? diff.stories.changedStories.filter((s) => !s.conflict)
      : diff.stories.changedStories
    ).filter((s) => !onContentCard.has(s.story_id));
    // Deleted-here (repo edited, editor deleted) stories render in the conflicts
    // block, not the pre-accepted category list.
    const newStories = threeWay
      ? diff.stories.newStories.filter((s) => !s.deletedInCompositor)
      : diff.stories.newStories;
    const storyItems: string[] = [
      ...newStories.map((s) => itemNew(storyName(s))),
      ...changedStories.map((s) => itemChanged(storyName(s))),
      ...diff.stories.missingStories.map((s) => itemRemoved(storyName(s))),
    ];
    if (storyItems.length > 0) {
      sections.push({
        label: sectionLabel(
          t("sync_modal.stories_category"),
          newStories.length + changedStories.length + diff.stories.missingStories.length,
          false,
        ),
        items: storyItems,
      });
    }

    const changedConfig = threeWay
      ? diff.config.changedFields.filter((c) => !c.conflict)
      : diff.config.changedFields;
    if (changedConfig.length > 0) {
      sections.push({
        label: sectionLabel(t("sync_modal.config_category"), changedConfig.length, true),
        items: changedConfig.map((c) => configFieldLabel(c.key, t) || t("sync_modal.config_setting")),
      });
    }

    // Glossary category. Three-way filters out conflict (changed) and
    // deleted-here (added) terms — they render in the conflicts block.
    const glossaryName = (tm: { title?: string | null; term_id: string }) => tm.title || tm.term_id;
    const addedTerms = threeWay
      ? diff.glossary.added.filter((tm) => !tm.deletedInCompositor)
      : diff.glossary.added;
    const changedTerms = threeWay
      ? diff.glossary.changed.filter((tm) => !tm.conflict)
      : diff.glossary.changed;
    const glossaryItems: string[] = [
      ...addedTerms.map((tm) => itemNew(glossaryName(tm))),
      ...changedTerms.map((tm) => itemChanged(glossaryName(tm))),
      ...diff.glossary.removed.map((tm) => itemRemoved(glossaryName(tm))),
    ];
    if (glossaryItems.length > 0) {
      sections.push({
        label: sectionLabel(
          t("sync_modal.glossary_category"),
          addedTerms.length + changedTerms.length + diff.glossary.removed.length,
          changedTerms.length > 0,
        ),
        items: glossaryItems,
      });
    }

    return sections;
  }

  const threeWay = diff?.classification === "three-way";
  const categorySections = buildCategorySections(Boolean(threeWay));
  const conflictsPresent = Boolean(diff && threeWay && hasConflictItems(diff));
  const suppressedCount = threeWay ? diff?.suppressedEditorOnly ?? 0 : 0;
  const { contentChanges, storyFilesUnread, pageChanges, pageFiles, pageFilesUnread } = contentView(diff);
  const filesUnread = storyFilesUnread || pageFilesUnread;
  const anythingToApply = conflictsPresent || [categorySections, contentChanges, pageChanges, pageFiles].some((list) => list.length > 0);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg p-0">
      {/* ------------------------------------------------------------------ */}
      {/* Confirm step                                                         */}
      {/* ------------------------------------------------------------------ */}
      {step === "confirm" && (
        <div className="p-6">
          <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
            {t("sync_modal.title")}
          </h3>
          <p className="font-body text-sm text-gray-600 mb-6">
            {t("sync_modal.confirm_body")}
          </p>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleCheckChanges}
              className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.check_changes")}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Computing step                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === "computing" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-terracotta animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.computing")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Conflict step (two-way fallback only)                                */}
      {/* ------------------------------------------------------------------ */}
      {step === "conflict" && (
        <div className="p-6">
          {/* A re-check after Keep my version was refused can land here. */}
          {githubMovedWhileReviewed && <p className={NOTICE_CLASS}>{t("sync_modal.accept_divergence_stale")}</p>}
          <SheetWarnings warnings={diff?.warnings ?? []} defaultOpen className="mb-4" />
          <div className="flex items-start gap-3 mb-5">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-heading font-semibold text-base text-charcoal mb-1">
                {t("sync_modal.title")}
              </h3>
              <p className="font-body text-sm text-gray-600">
                {countKnown ? t("sync_modal.conflict_warning", { count: unpublishedCount }) : t("sync_modal.conflict_warning_unknown")}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setStep("diffReady")}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.sync_anyway")}
            </button>
            <button
              type="button"
              onClick={handlePublishFirst}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-terracotta text-terracotta rounded-full px-5 py-2 hover:bg-terracotta/5 transition-colors"
            >
              {t("sync_modal.publish_first")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* DiffReady step                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === "diffReady" && (
        <div className="p-6">
          <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
            {t(diffReadyHeading(anythingToApply, filesUnread))}
          </h3>

          <div className="max-h-[55dvh] overflow-y-auto -mx-2 px-2">
            <ReviewNotices
              changedWhileReviewed={changedWhileReviewed}
              pagesChangedWhileReviewed={pagesChangedWhileReviewed}
              storyFilesUnread={storyFilesUnread}
              pageFilesUnread={pageFilesUnread}
              githubMovedWhileReviewed={githubMovedWhileReviewed}
            />

            <SheetWarnings warnings={diff?.warnings ?? []} defaultOpen className="mb-4" />

            {diff && (
              <SyncStoryContentBlock
                changes={contentChanges}
                rows={diff.stories.changedStories}
                choiceOf={(change) => contentChoiceOf(change, selections)}
                onChoice={setStoryContentChoice}
              />
            )}

            <SyncPagesBlocks diff={diff} selections={selections} setSelections={setSelections} />

            {/* Conflicts block (three-way, first) */}
            {conflictsPresent && diff && (
              <SyncConflictsBlock
                diff={diff}
                selections={selections}
                onObjectFieldChoice={setObjectFieldChoice}
                onObjectRestore={setObjectRestore}
                onObjectDelete={setObjectDelete}
                onRowChoice={setRowChoice}
                onStoryRestore={setStoryRestore}
                onGlossaryRestore={setGlossaryRestore}
                contentStoryIds={new Set(contentChanges.map((c) => c.story_id))}
              />
            )}

            {/* Category sections (repo-only, pre-accepted) */}
            {categorySections.length > 0 && (
              <div className="space-y-2 mb-4">
                {categorySections.map((section) => (
                  <CategorySection key={section.label} label={section.label} items={section.items} />
                ))}
              </div>
            )}

            {/* Suppressed editor-only note (three-way) */}
            {suppressedCount > 0 && (
              <p className="font-body text-xs text-gray-500 mb-2">
                {t("sync_modal.editor_only_note", { count: suppressedCount })}
              </p>
            )}

            <ApplyNotes anythingToApply={anythingToApply} storyFilesUnread={storyFilesUnread} pageFilesUnread={pageFilesUnread} />
          </div>

          <DiffReadyActions
            anythingToApply={anythingToApply}
            filesUnread={filesUnread}
            onClose={onClose}
            onCheckAgain={handleCheckChanges}
            onKeepMine={handleAcceptDivergence}
            onApply={handleApply}
          />
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Applying step                                                        */}
      {/* ------------------------------------------------------------------ */}
      {step === "applying" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-terracotta animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.applying")}</p>
        </div>
      )}

      {/* Accepting (accept-divergence in flight) */}
      {step === "accepting" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-charcoal animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.accepting")}</p>
        </div>
      )}

      {/* Accept-divergence succeeded */}
      {step === "acceptedSuccess" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="font-body text-sm text-gray-700">{t("sync_modal.accepted_success")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Success step                                                         */}
      {/* ------------------------------------------------------------------ */}
      {step === "success" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="font-body text-sm text-gray-700 text-center">
            {t(successKey(appliedStillDivergent, appliedPagesStillDivergent))}
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Failed step                                                          */}
      {/* ------------------------------------------------------------------ */}
      {step === "failed" && question && (
        <SheetChoicesStep className="p-6" question={question} onChosen={handleCheckChanges} onCancel={onClose} />
      )}
      {step === "failed" && !question && (
        <div className="p-6">
          <div className="flex flex-col items-center gap-3 py-6 mb-4">
            <AlertCircle className="w-10 h-10 text-red-500" />
            <p className="font-body text-sm text-gray-700 text-center">{errorMessage}</p>
          </div>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.retry")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
