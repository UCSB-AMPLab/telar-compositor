/**
 * SiteStatusProvider — runs the GitHub-status poll once for the page and hands
 * the result to every useSiteStatus() consumer, so the header chip and the
 * sync dialog read one answer instead of each polling on its own clock.
 *
 * It also holds the forced check behind the pill's Try again. That check reads
 * the same endpoint with `force=1`, past the refresh window. Its answer stands
 * in for the poll's until a poll read that started after it arrived answers,
 * so the pill changes when the check ends rather than at the next poll. A poll
 * read already in flight when the answer arrived may carry the status from
 * before the check, and does not replace it. The answer belongs to the site
 * it was asked for.
 *
 * Mounted once in the app layout. A consumer rendered outside it (a component
 * mounted alone) falls back to a poll of its own.
 *
 * @version v1.5.5-beta
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useGithubStatusPoll, useStampedGithubStatusPoll } from "~/hooks/use-github-status-poll";
import { readBackgroundOnce, readsStartedSoFar } from "~/hooks/use-background-read";
import { usePageSite } from "~/lib/page-site";
import type { DerivedGithubStatus } from "~/lib/github-status.server";

type Live = DerivedGithubStatus | undefined;

interface Shared {
  live: Live;
  recheck: () => Promise<void>;
  rechecking: boolean;
}

const LiveStatusContext = createContext<Shared | null>(null);

const FORCED_URL = "/api/site-status?payload=gh-status&force=1";

export function SiteStatusProvider({ children }: { children: ReactNode }) {
  const polled = useStampedGithubStatusPoll();
  const scope = usePageSite().live;
  // `readsBefore`: the background reads started when the answer arrived. A
  // poll answer from one of those reads does not replace it.
  const [forced, setForced] = useState<{ scope: number | null; data: DerivedGithubStatus; readsBefore: number } | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      const read = await readBackgroundOnce(FORCED_URL);
      // A failed read leaves the pill as it is; the poll's own beat answers next.
      if (read.ok) setForced({ scope, data: read.data as DerivedGithubStatus, readsBefore: readsStartedSoFar() });
    } finally {
      setRechecking(false);
    }
  }, [scope]);

  const superseded = forced !== null && polled.startedAt !== null && polled.startedAt > forced.readsBefore;
  const standing = forced !== null && forced.scope === scope && !superseded;
  useEffect(() => {
    if (forced !== null && !standing) setForced(null);
  }, [forced, standing]);

  const live = standing && forced ? forced.data : polled.data;
  return <LiveStatusContext.Provider value={{ live, recheck, rechecking }}>{children}</LiveStatusContext.Provider>;
}

/** The page's shared poll result; polls on its own only when no provider is mounted. */
export function useSharedGithubStatus(): Live {
  const shared = useContext(LiveStatusContext);
  const own = useGithubStatusPoll(shared === null);
  return shared === null ? own : shared.live;
}

const NO_RECHECK = { recheck: async () => {}, rechecking: false };

/** The forced check, which only a mounted provider can make. */
export function useGithubRecheck(): { recheck: () => Promise<void>; rechecking: boolean } {
  const shared = useContext(LiveStatusContext);
  return shared === null ? NO_RECHECK : { recheck: shared.recheck, rechecking: shared.rechecking };
}
