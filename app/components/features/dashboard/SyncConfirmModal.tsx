/**
 * This file renders the Sync confirmation modal — the multi-step
 * modal for pulling changes made directly in the GitHub repo back
 * into the compositor. It is mounted once for the whole app, in the
 * `_app` layout (`SyncReviewProvider`), and opened through
 * `useSyncReview().openReview` by the out-of-sync popover, the publish
 * page's stale-head blocker and the upgrade page.
 *
 * Provides a state-machine flow:
 *   1. Computing — opening the dialog submits compute-full-sync-diff
 *   2. DiffReady — every change as an item with its own choice, and Apply
 *   3. Applying — applyFetcher submits apply-full-sync intent
 *   4. Success — brief confirmation; the host revalidates the route data
 *      (`onApplied`) and the dialog closes, so the page keeps what it shows
 *   5. Failed — error display with retry option
 *
 * The DiffReady step lists, first, what the check found wrong in the
 * repository's sheets and step files (`diff.warnings`), then every change as
 * an item (`sync-items.ts`): a change GitHub alone made defaults to GitHub's
 * version, a change made on both sides has no choice made, and a two-way diff
 * (no base) has no defaults at all. Apply waits until every item has a
 * choice, and "When you apply" says what the payload will do. Object order
 * and the Telar version are notices: every accept applies them. Story or page
 * files the check could not read for a request cause are a notice with Try
 * again, and Apply takes everything else without recording those files; for
 * a structural cause they are items.
 *
 * The sync intents live on the /dashboard action (the app's shared
 * global endpoint), so every fetcher submit here targets it
 * explicitly — a bare POST would hit the rendering route's own
 * action, which does not handle them.
 *
 * @version v1.5.5-beta
 */

import { useEffect, useRef, useState } from "react";
import { useSiteFetcher } from "~/lib/page-site";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import { SheetWarnings } from "~/components/ui/SheetWarnings";
import { SheetChoicesStep, choicesQuestionOf, type SheetChoicesQuestion } from "./SheetChoicesStep";
import type { FullSyncDiff } from "~/lib/sync.server";
import {
  emptySelections,
  applyNoteKeys,
  listedPageChanges,
  listedPageFiles,
  changedWhileReviewedOf,
  requestUnread,
  successKey,
} from "./sync-changes";
import type { ThreeWaySelections } from "./sync-changes";
import { applySummaryOf, changesForApply, NO_NOTICES, syncItemsOf, syncNoticesOf, undecidedItems } from "./sync-items";

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
import { SyncItemCards, SyncNoticesBlock, WhenYouApply } from "./SyncItemCards";
import {
  ChangedWhileReviewedNotice, NOTHING_CHANGED_WHILE_REVIEWED, PageReviewNotices,
  type ChangedWhileReviewed,
} from "./SyncPageContentBlock";

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
  | "computing"
  | "diffReady"
  | "applying"
  | "success"
  | "failed";

interface SyncConfirmModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once an apply has landed, to read the route data again. */
  onApplied?: () => void;
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
// The diffReady step's notices and actions
// ---------------------------------------------------------------------------

/** The diffReady heading's key. `filesUnread`: the story or the page files could not be read. */
function diffReadyHeading(anythingToApply: boolean, filesUnread: boolean): string {
  if (anythingToApply) return "sync_modal.review.title";
  return filesUnread ? "sync_modal.title" : "sync_modal.no_changes";
}

const NOTICE_CLASS = "font-body text-sm text-charcoal bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4";

/** That the check could not read the story or page files just now, with Try again. */
function RequestUnreadNotice({ messageKey, onTryAgain }: { messageKey: string; onTryAgain: () => void }) {
  const { t } = useTranslation("dashboard");
  return (
    <div data-testid="request-unread" className={NOTICE_CLASS}>
      <p>{t(messageKey)}</p>
      <button type="button" onClick={onTryAgain} className="font-body text-sm text-terracotta underline hover:text-terracotta/80 mt-1">
        {t("sync_modal.review.try_again")}
      </button>
    </div>
  );
}

/**
 * Why the list changed, after an apply was refused because GitHub, or the
 * recorded head, moved past the commit the list was read at, or after an accept refused
 * stories or pages edited while they were reviewed; and that the check could
 * not read the story files or the page files just now.
 */
function ReviewNotices({
  changedWhileReviewed,
  pagesChangedWhileReviewed,
  storyFilesUnread,
  pageFilesUnread,
  githubMovedWhileReviewed,
  onTryAgain,
}: {
  changedWhileReviewed: ChangedWhileReviewed;
  pagesChangedWhileReviewed: string[];
  storyFilesUnread: boolean;
  pageFilesUnread: boolean;
  githubMovedWhileReviewed: boolean;
  onTryAgain: () => void;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <>
      {githubMovedWhileReviewed && <p className={NOTICE_CLASS}>{t("sync_modal.accept_divergence_stale")}</p>}
      <ChangedWhileReviewedNotice changed={changedWhileReviewed} />
      {storyFilesUnread && <RequestUnreadNotice messageKey="sync_modal.review.request_stories" onTryAgain={onTryAgain} />}
      <PageReviewNotices pagesChangedWhileReviewed={pagesChangedWhileReviewed} />
      {pageFilesUnread && <RequestUnreadNotice messageKey="sync_modal.review.request_pages" onTryAgain={onTryAgain} />}
    </>
  );
}

/** What applying will do. */
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
  /** An item has no choice yet. */
  applyWaits: boolean;
  /** The story or the page files could not be read just now (a request cause). */
  filesUnread: boolean;
  onClose: () => void;
  onApply: () => void;
}

/**
 * The diffReady step's buttons. With the story or page files unread just now
 * the notice offers Try again, and Apply, when there is anything else to
 * apply, says it applies the other changes. Apply waits until every item has
 * a choice.
 */
function DiffReadyActions({ anythingToApply, applyWaits, filesUnread, onClose, onApply }: DiffReadyActionsProps) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="flex flex-wrap gap-3 justify-end mt-4">
      <button
        type="button"
        onClick={onClose}
        className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
      >
        {anythingToApply ? t("cancel") : t("sync_modal.close")}
      </button>
      {anythingToApply && (
        <button
          type="button"
          onClick={onApply}
          disabled={applyWaits}
          className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {filesUnread ? t("sync_modal.apply_other_changes") : t("sync_modal.review.apply")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncConfirmModal({ open, onClose, onApplied }: SyncConfirmModalProps) {
  const { t } = useTranslation("dashboard");
  // Stable fetcher key so the host can subscribe to the same sync-diff
  // response via useFetcher({ key }) and surface the version-change toast
  // (see SyncReviewProvider / useVersionChangeToast).
  const diffFetcher = useSiteFetcher({ key: SYNC_DIFF_FETCHER_KEY });
  const applyFetcher = useSiteFetcher();

  const [step, setStep] = useState<SyncStep>("computing");
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
  // An apply was refused because GitHub, or the recorded head, moved past the
  // commit the dialog showed; the dialog checked again, and says so above the result.
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
  // The close that follows a landed apply, cancelled when the dialog closes first.
  const closeAfterApplyRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Opening the dialog starts the check; closing resets it.
  useEffect(() => {
    if (open) {
      handleCheckChanges();
    } else {
      if (closeAfterApplyRef.current) clearTimeout(closeAfterApplyRef.current);
      closeAfterApplyRef.current = null;
      setStep("computing");
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
  // revalidation after an apply can re-run this effect with the same stale
  // diffData, which would otherwise yank a post-apply step
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
    setDiff(diffData.diff);
    setSelections(emptySelections());
    setStep("diffReady");
  }, [diffData, step]);

  // Handle the apply fetcher's result
  useEffect(() => {
    if (!applyData) return;
    if (isSiteChanged(applyData)) {
      onClose();
      return;
    }
    if (!applyData.ok) {
      if (applyData.error === "sync_base_stale") {
        // GitHub, or the recorded head, moved past the diff the author was
        // shown, so their choice was not saved: check again, and say why the
        // list changed.
        setGithubMovedWhileReviewed(true);
        handleCheckChanges();
        return;
      }
      if (handledPageRefusal(applyData)) return;
      const names = storyNames(applyData.storyIds);
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
    if (applyData.intent === "apply-full-sync") {
      setAppliedStillDivergent(applyData.storyFilesInconclusive === true);
      setAppliedPagesStillDivergent(applyData.pageFilesInconclusive === true);
      setStep("success");
      onApplied?.();
      closeAfterApplyRef.current = setTimeout(onClose, 1500);
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
    const pages = pageNames(data.pageIds);
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
    const changes = changesForApply(diff, selections);
    if (!changes) return;
    setChangedWhileReviewed(NOTHING_CHANGED_WHILE_REVIEWED);
    setPagesChangedWhileReviewed([]);
    setGithubMovedWhileReviewed(false);
    setStep("applying");
    applyFetcher.submit(
      { intent: "apply-full-sync", changes: JSON.stringify(changes) },
      { method: "post", action: "/dashboard" }
    );
  }

  const threeWay = diff?.classification === "three-way";
  const suppressedCount = threeWay ? diff?.suppressedEditorOnly ?? 0 : 0;
  const { stories: storyFilesUnread, pages: pageFilesUnread } = requestUnread(diff);
  const filesUnread = storyFilesUnread || pageFilesUnread;
  const items = diff ? syncItemsOf(diff) : [];
  const notices = diff ? syncNoticesOf(diff) : NO_NOTICES;
  const anythingToApply = items.length > 0 || notices.objectOrder || notices.version !== null || notices.addedPages.length > 0;
  const applyWaits = undecidedItems(items, selections).length > 0;

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg p-0">
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
      {/* DiffReady step                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === "diffReady" && (
        <div className="p-6">
          <h3 className={`font-heading font-semibold text-lg text-charcoal ${anythingToApply ? "mb-1" : "mb-4"}`}>
            {t(diffReadyHeading(anythingToApply, filesUnread))}
          </h3>
          {anythingToApply && <p className="font-body text-sm text-gray-600 mb-4">{t("sync_modal.review.intro")}</p>}

          <div className="max-h-[55dvh] overflow-y-auto -mx-2 px-2">
            <ReviewNotices
              changedWhileReviewed={changedWhileReviewed}
              pagesChangedWhileReviewed={pagesChangedWhileReviewed}
              storyFilesUnread={storyFilesUnread}
              pageFilesUnread={pageFilesUnread}
              githubMovedWhileReviewed={githubMovedWhileReviewed}
              onTryAgain={handleCheckChanges}
            />

            <SheetWarnings warnings={diff?.warnings ?? []} defaultOpen className="mb-4" />

            <SyncItemCards items={items} selections={selections} setSelections={setSelections} />

            <SyncNoticesBlock notices={notices} />

            {/* Suppressed editor-only note (three-way) */}
            {suppressedCount > 0 && (
              <p className="font-body text-xs text-gray-500 mb-2">
                {t("sync_modal.editor_only_note", { count: suppressedCount })}
              </p>
            )}

            {anythingToApply && <WhenYouApply summary={applySummaryOf(items, notices, selections)} />}

            <ApplyNotes anythingToApply={anythingToApply} storyFilesUnread={storyFilesUnread} pageFilesUnread={pageFilesUnread} />
          </div>

          <DiffReadyActions
            anythingToApply={anythingToApply}
            applyWaits={applyWaits}
            filesUnread={filesUnread}
            onClose={onClose}
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
              onClick={handleCheckChanges}
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
