/**
 * useGithubStatusPoll — polls the out-of-band GitHub-status refresh endpoint
 * (/api/site-status?payload=gh-status) so the Site Status pill stays current
 * without a navigation. The _app loader only READS the cached gh_* columns;
 * this poll triggers the refresh (server-side, claim-deduped) and returns the
 * fresh derived status. Polls on mount, every 45s, and on window focus.
 *
 * @version v1.3.0-beta
 */
import { useEffect } from "react";
import { useFetcher } from "react-router";
import type { DerivedGithubStatus } from "~/lib/github-status.server";

const POLL_INTERVAL_MS = 45_000;

export function useGithubStatusPoll(): DerivedGithubStatus | undefined {
  const fetcher = useFetcher<DerivedGithubStatus>();
  // `load` is stable across renders per RR v7; the effect wires mount + interval + focus.
  const load = fetcher.load;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const poll = () => load("/api/site-status?payload=gh-status");
    poll(); // on mount
    const id = window.setInterval(poll, POLL_INTERVAL_MS);
    window.addEventListener("focus", poll);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", poll);
    };
  }, [load]);
  return fetcher.data;
}
