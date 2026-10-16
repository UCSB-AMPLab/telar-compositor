/**
 * useGithubStatusPoll — polls the out-of-band GitHub-status refresh endpoint
 * (/api/site-status?payload=gh-status) so the Site Status pill stays current
 * without a navigation. The _app loader only READS the cached gh_* columns;
 * this poll triggers the refresh (server-side, claim-deduped) and returns the
 * fresh derived status. Polls on mount, every 45s, on window focus, and after
 * every submission completes.
 *
 * It is a background read (`useBackgroundRead`): a failed poll keeps the last
 * status it had for the active project, and never reaches the error card.
 * The stamped form says which read its answer came from (`StampedRead`).
 *
 * @version v1.5.5-beta
 */
import { useStampedBackgroundRead, type StampedRead } from "~/hooks/use-background-read";
import { usePageSite } from "~/lib/page-site";
import type { DerivedGithubStatus } from "~/lib/github-status.server";

const POLL_INTERVAL_MS = 45_000;

export function useGithubStatusPoll(enabled = true): DerivedGithubStatus | undefined {
  return useStampedGithubStatusPoll(enabled).data;
}

export function useStampedGithubStatusPoll(enabled = true): StampedRead<DerivedGithubStatus> {
  return useStampedBackgroundRead<DerivedGithubStatus>({
    url: "/api/site-status?payload=gh-status",
    enabled,
    intervalMs: POLL_INTERVAL_MS,
    onFocus: true,
    afterActions: true,
    scope: usePageSite().live,
  });
}
