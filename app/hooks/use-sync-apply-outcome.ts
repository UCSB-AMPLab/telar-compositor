/**
 * use-sync-apply-outcome — acts once on a successful `sync-apply` response
 * from the objects page's sync fetcher.
 *
 * The apply changes the document on the server, through the collaboration
 * object, before it answers, so nothing is removed here: the page's part is to
 * close the sync dialog, say so when the apply could not add every accepted
 * new row (`notAdded`) or left GitHub's value of a field edited here since the
 * check (`changedSinceReview`), or could not record the commit it applied as
 * read because the site changed while it ran (`readNotRecorded`), and open the commit window for the objects the apply
 * left to commit.
 *
 * React Router keeps a fetcher's `data` from its last response until the next
 * one resolves, and replaces the object on every response. The same success
 * can therefore reach this effect more than once, and acting on it again would
 * close a dialog the author has just opened and reopen the commit window with
 * the old list. The data object handled is recorded, and the same object is
 * ignored afterwards.
 *
 * Handling does not depend on the sync dialog being open: the objects the
 * apply left to commit need the commit window even when the author dismissed
 * the dialog while it ran.
 *
 * A response is only acted on for the project it applies to. An author can
 * switch the active project while a `sync-apply` submission is in flight; its
 * `pendingObjects` belong to the commit flow of the project it ran against,
 * so a response whose `projectId` no longer matches is marked handled without
 * a dialog close or a commit window.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef } from "react";
import type { PendingObject } from "~/lib/sync.server";

/** The slice of the sync fetcher's data this hook reacts to. */
export interface SyncApplyOutcomeData {
  ok: boolean;
  intent: string;
  projectId?: number;
  pendingObjects?: PendingObject[];
  notAdded?: string[];
  changedSinceReview?: string[];
  readNotRecorded?: boolean;
}

export interface UseSyncApplyOutcomeOptions {
  /** The objects page's sync fetcher data, in whatever shape it currently holds. */
  data: SyncApplyOutcomeData | null | undefined;
  /** The id of the project this page currently has active. */
  projectId: number;
  /** Closes the sync dialog (if open) and clears its diff data. */
  onClose: () => void;
  /** Called with the pending objects when the apply left any uncommitted. */
  onApplied: (pendingObjects: PendingObject[]) => void;
  /** Called with the accepted new rows the apply could not add, when there are any. */
  onNotAdded: (objectIds: string[]) => void;
  /** Called with the objects whose GitHub values were left because they were edited here since the check. */
  onChangedSinceReview?: (objectIds: string[]) => void;
  /** Called when the site changed while the apply ran, so what it landed was not recorded as read. */
  onReadNotRecorded?: () => void;
}

/**
 * Reacts to a successful `sync-apply` fetcher response exactly once. Safe to
 * call with `data: undefined`, a failure, or a `compute-sync-diff` result —
 * the effect bails without side effects.
 */
export function useSyncApplyOutcome({
  data,
  projectId,
  onClose,
  onApplied,
  onNotAdded,
  onChangedSinceReview,
  onReadNotRecorded,
}: UseSyncApplyOutcomeOptions): void {
  const handledRef = useRef<SyncApplyOutcomeData | null | undefined>(undefined);

  useEffect(() => {
    if (!data?.ok || data.intent !== "sync-apply") return;
    if (data === handledRef.current) return;
    handledRef.current = data;

    // A response for a project the author has since switched away from is
    // marked handled and otherwise ignored: the dialog and the commit window
    // belong to the project that is current now.
    if (typeof data.projectId === "number" && data.projectId !== projectId) return;

    onClose();
    announceApplyOutcome(data, { onApplied, onNotAdded, onChangedSinceReview, onReadNotRecorded });
  }, [data, projectId, onClose, onApplied, onNotAdded, onChangedSinceReview, onReadNotRecorded]);
}

/** Say what a successful apply left undone, then open the commit window for what it left to commit. */
function announceApplyOutcome(
  data: SyncApplyOutcomeData,
  handlers: Pick<UseSyncApplyOutcomeOptions, "onApplied" | "onNotAdded" | "onChangedSinceReview" | "onReadNotRecorded">,
): void {
  const notAdded = data.notAdded ?? [];
  if (notAdded.length > 0) handlers.onNotAdded(notAdded);
  const changedSinceReview = data.changedSinceReview ?? [];
  if (changedSinceReview.length > 0) handlers.onChangedSinceReview?.(changedSinceReview);
  if (data.readNotRecorded === true) handlers.onReadNotRecorded?.();
  const pendingObjects = data.pendingObjects ?? [];
  if (pendingObjects.length > 0) handlers.onApplied(pendingObjects);
}
