/**
 * useAcceptRepoInvitation — the member accepting their own repository
 * invitation. Every place that offers the button posts the team page's
 * `accept` intent, so there is one action and one fallback behind all of them.
 *
 * @version v1.5.0-beta
 */
import { useSiteFetcher } from "~/lib/page-site";
import type { TeamActionResult } from "~/lib/repo-access";

export function useAcceptRepoInvitation() {
  const fetcher = useSiteFetcher<TeamActionResult>();
  return {
    accept: () => fetcher.submit({ intent: "accept" }, { method: "post", action: "/team" }),
    busy: fetcher.state !== "idle",
    result: fetcher.data ?? null,
  };
}
