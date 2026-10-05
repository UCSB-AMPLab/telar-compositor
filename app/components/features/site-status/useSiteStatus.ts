/**
 * useSiteStatus — the client hook that derives the single active Site Status
 * state by precedence and the transient ~1.5s "Saving" overlay. It reads only
 * cheap, already-available signals — no I/O:
 *   - _app loader fields via useRouteLoaderData("routes/_app")
 *   - isPublishing via useCollaborationContext() (global Yjs awareness)
 *   - in-flight save fetchers via useFetchers() matched against ALL_SAVE_INTENTS
 *
 * Precedence: persistence-halted > repo-unavailable > publishing > out-of-sync >
 * repo-invitation > unpublished > upgrade > in-sync. The halted state is the one input that is not
 * cheap and not already available: it comes from usePersistenceHalt, which asks
 * the object only after a continuous disconnection, never on navigation.
 * Saving is an OVERLAY on the active base state, never a competitor in the
 * precedence ordering. The pure deriveState() is exported so precedence is
 * testable without mounting React.
 *
 * The out-of-band GitHub-status poll (one per page, SiteStatusProvider) merges its live
 * result OVER the loader's cached gh_* values so the pill stays current
 * between navigations (the loader only reads the cache, instant).
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useFetchers, useRouteLoaderData } from "react-router";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useSharedGithubStatus } from "~/components/features/site-status/SiteStatusProvider";
import {
  usePersistenceHalt,
  type PersistenceHaltResult,
} from "~/hooks/use-persistence-halt";
import type { OwnRepoAccess } from "~/lib/repo-access";
import { ALL_SAVE_INTENTS } from "~/components/features/site-status/save-intents";

/** Milliseconds the Saving overlay lingers after the last save fetcher settles. */
const SAVING_LINGER_MS = 1500;

export type SiteStatusState =
  | "persistence-halted"
  | "repo-unavailable"
  | "publishing"
  | "out-of-sync"
  | "repo-invitation"
  | "unpublished"
  | "upgrade"
  | "in-sync";

export interface DeriveStateInput {
  /**
   * A halt this client knows about and nothing has cleared. It dominates every
   * other signal: while saving has stopped, what the repository or the publish
   * queue is doing is not what the editor needs to be told.
   */
  halted?: boolean;
  repoUnavailable?: boolean;
  isPublishing?: boolean;
  /**
   * The GitHub Actions build is still running after a successful commit.
   * Distinct from isPublishing (which flips false on commit return and keeps
   * the freeze/disable semantics); isBuilding keeps the pill in "publishing"
   * through the build so it doesn't drop to "In sync" mid-build.
   */
  isBuilding?: boolean;
  headDiverged?: boolean;
  /** The member's own repository invitation is open or has lapsed. */
  invitationOpen?: boolean;
  unpublishedCount?: number;
  needsUpgrade?: boolean;
}

/**
 * Pure precedence: persistence-halted (dominant) > repo-unavailable >
 * publishing > out-of-sync > repo-invitation > unpublished > upgrade > in-sync. Saving is handled
 * separately as an overlay. The "publishing" branch covers both the commit phase
 * (isPublishing) and the subsequent build phase (isBuilding).
 */
export function deriveState(input: DeriveStateInput): SiteStatusState {
  if (input.halted) return "persistence-halted";
  if (input.repoUnavailable) return "repo-unavailable";
  if (input.isPublishing || input.isBuilding) return "publishing";
  if (input.headDiverged) return "out-of-sync";
  if (input.invitationOpen) return "repo-invitation";
  if ((input.unpublishedCount ?? 0) > 0) return "unpublished";
  if (input.needsUpgrade) return "upgrade";
  return "in-sync";
}

interface AppLoaderData {
  activeProjectId?: number | null;
  repoUnavailable?: boolean;
  headDiverged?: boolean;
  needsUpgrade?: boolean;
  unpublishedCount?: number;
  latestTelarTag?: string | null;
  repoFullName?: string | null;
  userRole?: "convenor" | "collaborator" | "instructor" | null;
}

export interface SiteStatusResult {
  state: SiteStatusState;
  /** Transient overlay: true while saving + ~1.5s after the last fetcher settles. */
  saving: boolean;
  /** Unpublished change count (0 when none / not yet supplied by the loader). */
  count: number;
  /**
   * Whether `count` is the live content-diff count. The loader's count is a
   * stand-in that over-counts, so it must not be displayed as a number.
   */
  countKnown: boolean;
  latestTag: string | null;
  userRole: "convenor" | "collaborator" | "instructor" | null;
  needsUpgrade: boolean;
  /** The member's own repository state from the poll; null until it answers. */
  ownRepoAccess: OwnRepoAccess | null;
  /**
   * The halt this client knows about and the restore action for it. The trigger
   * is called HERE and nowhere else, so the pill and the popover share one
   * clock, one read policy and one outcome rather than running two of each.
   */
  persistence: PersistenceHaltResult;
}

/** The project id `usePersistenceHalt` reads for, from the loader's cache. */
function activeProjectIdOf(app: AppLoaderData | null): number | null {
  return app?.activeProjectId ?? null;
}

export function useSiteStatus(): SiteStatusResult {
  const app = (useRouteLoaderData("routes/_app") as AppLoaderData | null) ?? null;
  const { isPublishing, isBuilding } = useCollaborationContext();
  const fetchers = useFetchers();
  // The page's single GitHub-status poll (SiteStatusProvider): its live result
  // merges OVER loader cached values (GitHub status AND the real content-diff
  // count — see the merge below).
  const live = useSharedGithubStatus();
  const persistence = usePersistenceHalt(activeProjectIdOf(app));

  const isSaving = fetchers.some(
    (f) =>
      f.state === "submitting" &&
      f.formData &&
      (ALL_SAVE_INTENTS as readonly string[]).includes(
        f.formData.get("intent") as string,
      ),
  );

  // Saving overlay: lifted from SaveIndicator's fetcher-watch + linger timer,
  // retimed 2000ms -> 1500ms.
  const [showSaving, setShowSaving] = useState(false);
  const wasSavingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isSaving) {
      wasSavingRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      setShowSaving(true);
    } else if (wasSavingRef.current) {
      wasSavingRef.current = false;
      setShowSaving(true);
      timerRef.current = setTimeout(() => setShowSaving(false), SAVING_LINGER_MS);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isSaving]);

  // The poll also returns the real content-diff count, merged OVER the loader's
  // cheap updated_at proxy (which over-counts rows touched by DO snapshots
  // without content change). ?? is intentional: 0 is a valid live value that
  // MUST override a stale loader proxy; undefined means the poll couldn't
  // compute it and we fall back to the loader.
  const ownRepoAccess = live?.ownRepoAccess ?? null;
  const state = deriveState({
    halted: persistence.halted,
    repoUnavailable: live?.repoUnavailable ?? app?.repoUnavailable ?? false,
    isPublishing,
    isBuilding,
    headDiverged: live?.headDiverged ?? app?.headDiverged ?? false,
    invitationOpen: ownRepoAccess?.stage === "pending" || ownRepoAccess?.stage === "lapsed",
    unpublishedCount: live?.unpublishedCount ?? app?.unpublishedCount ?? 0,
    needsUpgrade: live?.needsUpgrade ?? app?.needsUpgrade ?? false,
  });

  return {
    state,
    saving: isSaving || showSaving,
    count: live?.unpublishedCount ?? app?.unpublishedCount ?? 0,
    countKnown: live?.unpublishedCount !== undefined,
    latestTag: live?.latestTelarTag ?? app?.latestTelarTag ?? null,
    userRole: app?.userRole ?? null,
    needsUpgrade: live?.needsUpgrade ?? app?.needsUpgrade ?? false,
    ownRepoAccess,
    persistence,
  };
}
