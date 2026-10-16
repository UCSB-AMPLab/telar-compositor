/**
 * SyncReviewProvider — the review of the changes made on GitHub, mounted once
 * for the whole app in the `_app` layout. It renders the review dialog
 * (SyncConfirmModal) and hands every component under it `useSyncReview()`:
 *
 * - `openReview()` opens the dialog wherever the author is, so the pill's
 *   popover, the publish page's stale-head blocker and the upgrade page open
 *   the same review without leaving the page;
 * - `canReview` says whether this person can apply a review. The dialog's
 *   intents are the /dashboard action's `compute-full-sync-diff` and
 *   `apply-full-sync`, which `requireOwner` gates to the site's convenor, so
 *   the dialog is mounted for the convenor alone and `openReview` does
 *   nothing for anyone else;
 * - `coordinatorName` is who chooses for everyone else: the convenor's stored
 *   GitHub display name, else their GitHub login, else null.
 *
 * An apply that lands reads the route data again (`useRevalidator`) instead
 * of reloading the page, so a page holding unsaved state (the story editor)
 * keeps what it shows. The dialog's check submits through a fetcher keyed
 * `SYNC_DIFF_FETCHER_KEY`; the provider reads the same fetcher to raise the
 * version-change toast, so it must be mounted inside the ToastProvider.
 *
 * Outside a provider (a component rendered alone), `useSyncReview()` answers
 * a review nobody can open.
 *
 * @version v1.5.5-beta
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { SyncConfirmModal, SYNC_DIFF_FETCHER_KEY } from "~/components/features/dashboard/SyncConfirmModal";
import { useVersionChangeToast } from "~/hooks/use-version-change-toast";

export interface SyncReview {
  /** Opens the review dialog; does nothing for someone who cannot apply it. */
  openReview: () => void;
  /** Whether this person can apply a review: the site's convenor. */
  canReview: boolean;
  /** The name of the person who coordinates the site, or null when none is stored. */
  coordinatorName: string | null;
}

const NO_REVIEW: SyncReview = { openReview: () => {}, canReview: false, coordinatorName: null };

export const SyncReviewContext = createContext<SyncReview>(NO_REVIEW);

/** The review the nearest provider offers. */
export function useSyncReview(): SyncReview {
  return useContext(SyncReviewContext);
}

/**
 * The key and values of a "who chooses" line: `named` with the coordinator's
 * name, or `unnamed` when no name is stored, so a name is never made up.
 */
export function coordinatorLine(
  named: string,
  unnamed: string,
  coordinatorName: string | null,
): [string, { name?: string }] {
  return coordinatorName ? [named, { name: coordinatorName }] : [unnamed, {}];
}

/**
 * The key and values of a message the convenor and everyone else read
 * differently: `keys.convenor` for the person who can apply the review, and
 * for everyone else the coordinator's `named` or `unnamed` line.
 */
export function reviewerLine(
  keys: { convenor: string; named: string; unnamed: string },
  canReview: boolean,
  coordinatorName: string | null,
): [string, { name?: string }] {
  return canReview ? [keys.convenor, {}] : coordinatorLine(keys.named, keys.unnamed, coordinatorName);
}

export function SyncReviewProvider({
  canReview,
  coordinatorName,
  children,
}: {
  canReview: boolean;
  coordinatorName: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const revalidator = useRevalidator();
  const diffFetcher = useFetcher({ key: SYNC_DIFF_FETCHER_KEY });
  useVersionChangeToast(diffFetcher.data as Parameters<typeof useVersionChangeToast>[0]);

  const openReview = useCallback(() => {
    if (canReview) setOpen(true);
  }, [canReview]);
  const close = useCallback(() => setOpen(false), []);
  const revalidate = revalidator.revalidate;
  const applied = useCallback(() => {
    void revalidate();
  }, [revalidate]);

  const value = useMemo(() => ({ openReview, canReview, coordinatorName }), [openReview, canReview, coordinatorName]);

  return (
    <SyncReviewContext.Provider value={value}>
      {children}
      {canReview && <SyncConfirmModal open={open} onClose={close} onApplied={applied} />}
    </SyncReviewContext.Provider>
  );
}
