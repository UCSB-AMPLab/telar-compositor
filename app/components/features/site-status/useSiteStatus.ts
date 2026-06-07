/**
 * useSiteStatus — the client hook that derives the single active Site Status
 * state by precedence and the transient ~1.5s "Saving" overlay. It reads only
 * cheap, already-available signals — no I/O:
 *   - _app loader fields via useRouteLoaderData("routes/_app")
 *   - isPublishing via useCollaborationContext() (global Yjs awareness)
 *   - in-flight save fetchers via useFetchers() matched against ALL_SAVE_INTENTS
 *
 * Precedence: repo-unavailable > publishing > out-of-sync > unpublished > upgrade > in-sync.
 * Saving is an OVERLAY on the active base state, never a competitor in the
 * precedence ordering. The pure deriveState() is exported so precedence is
 * testable without mounting React.
 *
 * The out-of-band GitHub-status poll (useGithubStatusPoll) merges its live
 * result OVER the loader's cached gh_* values so the pill stays current
 * between navigations (the loader only reads the cache, instant).
 *
 * @version v1.3.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useFetchers, useRouteLoaderData } from "react-router";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useGithubStatusPoll } from "~/hooks/use-github-status-poll";
import { ALL_SAVE_INTENTS } from "~/components/features/site-status/save-intents";

/** Milliseconds the Saving overlay lingers after the last save fetcher settles. */
const SAVING_LINGER_MS = 1500;

export type SiteStatusState =
  | "repo-unavailable"
  | "publishing"
  | "out-of-sync"
  | "unpublished"
  | "upgrade"
  | "in-sync";

export interface DeriveStateInput {
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
  unpublishedCount?: number;
  needsUpgrade?: boolean;
}

/**
 * Pure precedence: repo-unavailable (dominant) > publishing > out-of-sync >
 * unpublished > upgrade > in-sync. Saving is handled separately as an overlay.
 * The "publishing" branch covers both the commit phase (isPublishing) and the
 * subsequent build phase (isBuilding).
 */
export function deriveState(input: DeriveStateInput): SiteStatusState {
  if (input.repoUnavailable) return "repo-unavailable";
  if (input.isPublishing || input.isBuilding) return "publishing";
  if (input.headDiverged) return "out-of-sync";
  if ((input.unpublishedCount ?? 0) > 0) return "unpublished";
  if (input.needsUpgrade) return "upgrade";
  return "in-sync";
}

interface AppLoaderData {
  repoUnavailable?: boolean;
  headDiverged?: boolean;
  needsUpgrade?: boolean;
  unpublishedCount?: number;
  latestTelarTag?: string | null;
  repoFullName?: string | null;
  userRole?: "convenor" | "collaborator" | null;
}

export interface SiteStatusResult {
  state: SiteStatusState;
  /** Transient overlay: true while saving + ~1.5s after the last fetcher settles. */
  saving: boolean;
  /** Unpublished change count (0 when none / not yet supplied by the loader). */
  count: number;
  latestTag: string | null;
  userRole: "convenor" | "collaborator" | null;
  needsUpgrade: boolean;
}

export function useSiteStatus(): SiteStatusResult {
  const app = (useRouteLoaderData("routes/_app") as AppLoaderData | null) ?? null;
  const { isPublishing, isBuilding } = useCollaborationContext();
  const fetchers = useFetchers();
  // Out-of-band GitHub-status poll: merges live result OVER loader cached values
  // (GitHub status AND the real content-diff count — see the merge below).
  const live = useGithubStatusPoll();

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
  const state = deriveState({
    repoUnavailable: live?.repoUnavailable ?? app?.repoUnavailable ?? false,
    isPublishing,
    isBuilding,
    headDiverged: live?.headDiverged ?? app?.headDiverged ?? false,
    unpublishedCount: live?.unpublishedCount ?? app?.unpublishedCount ?? 0,
    needsUpgrade: live?.needsUpgrade ?? app?.needsUpgrade ?? false,
  });

  return {
    state,
    saving: isSaving || showSaving,
    count: live?.unpublishedCount ?? app?.unpublishedCount ?? 0,
    latestTag: live?.latestTelarTag ?? app?.latestTelarTag ?? null,
    userRole: app?.userRole ?? null,
    needsUpgrade: live?.needsUpgrade ?? app?.needsUpgrade ?? false,
  };
}
