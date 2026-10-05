/**
 * Keeps an open story editor at its story's address when the story's ID
 * changes, for whoever changed it and for everyone else with it open. The
 * editor's loader looks the story up in D1 by the ID in the address, so the
 * page first asks the Durable Object to write the document to D1 (the flush
 * the stories page uses before opening a new story), then replaces the
 * address, keeping the open step and layer. An ID the document already holds
 * when the page subscribes is followed the same way. A failed flush leaves the
 * page where it is; the next snapshot writes the new ID, and the loader sends
 * the old address to it on the next load.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type * as Y from "yjs";

import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { useSiteFetcher } from "~/lib/page-site";

/** The flush this hook sends; the editor route reads nothing again after it. */
export const FOLLOW_FLUSH_INTENT = "flush-yjs-snapshot";

export function useFollowStoryId(storyYMap: Y.Map<unknown> | null, storyId: string): void {
  const flush = useSiteFetcher<{ ok: boolean; intent: string }>();
  const submitFlush = flush.submit;
  const navigate = useNavigate();
  const { search } = useLocation();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!storyYMap) return;
    const follow = () => {
      const current = storyYMap.get("story_id");
      if (typeof current !== "string" || current === "" || current === storyId) return;
      setTarget(current);
      submitFlush({ intent: FOLLOW_FLUSH_INTENT }, { method: "post", action: "/stories" });
    };
    storyYMap.observe(follow);
    follow();
    return () => storyYMap.unobserve(follow);
  }, [storyYMap, storyId, submitFlush]);

  useEffect(() => {
    if (target === null || flush.state !== "idle" || flush.data === undefined) return;
    setTarget(null);
    // Refused because the site changed, the layout's notice says why; any
    // other failure leaves D1 without the new ID.
    if (isSiteChanged(flush.data) || flush.data.ok !== true) return;
    navigate(`/stories/${encodeURIComponent(target)}${search}`, { replace: true });
  }, [target, flush.state, flush.data, navigate, search]);
}
