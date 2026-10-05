/**
 * SiteStatusProvider — runs the GitHub-status poll once for the page and hands
 * the result to every useSiteStatus() consumer, so the header chip and the
 * sync dialog read one answer instead of each polling on its own clock.
 *
 * Mounted once in the app layout. A consumer rendered outside it (a component
 * mounted alone) falls back to a poll of its own.
 *
 * @version v1.5.0-beta
 */

import { createContext, useContext, type ReactNode } from "react";
import { useGithubStatusPoll } from "~/hooks/use-github-status-poll";
import type { DerivedGithubStatus } from "~/lib/github-status.server";

type Live = DerivedGithubStatus | undefined;

const LiveStatusContext = createContext<{ live: Live } | null>(null);

export function SiteStatusProvider({ children }: { children: ReactNode }) {
  const live = useGithubStatusPoll();
  return <LiveStatusContext.Provider value={{ live }}>{children}</LiveStatusContext.Provider>;
}

/** The page's shared poll result; polls on its own only when no provider is mounted. */
export function useSharedGithubStatus(): Live {
  const shared = useContext(LiveStatusContext);
  const own = useGithubStatusPoll(shared === null);
  return shared === null ? own : shared.live;
}
