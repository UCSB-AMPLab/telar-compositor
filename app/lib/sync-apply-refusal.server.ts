/**
 * What the dashboard's full-sync apply answers when the collaboration object
 * did not take all of an accept: story or page content, or object fields,
 * edited in the Compositor since the check, or entries it cannot store, for
 * which it took none of it; or content it could not save, or new object rows
 * D1 refused, beside which the other accepted changes stand. head_sha has not
 * moved.
 *
 * @version v1.5.0-beta
 */

import {
  InsertsNotAdded, ObjectsChangedSinceReview, ObjectsNotAdded, PageContentNotApplied, StoryContentNotApplied, SyncEntriesRefused,
} from "~/lib/sync.server";

/**
 * Accepted story content the collaboration object did not apply, as the
 * sync dialog reads it. The other accepted changes stand and head_sha has
 * not moved: a story edited here since the check needs the check again, one
 * that failed to save needs the accept again.
 */
function storyContentRefusal(err: StoryContentNotApplied) {
  const changed = err.changedSinceReview.length > 0;
  return {
    ok: false as const,
    intent: "apply-full-sync" as const,
    error: changed ? "story_changed_since_review" : "story_content_failed",
    storyIds: changed ? err.changedSinceReview : err.failed,
  };
}

/** Accepted page content the collaboration object did not apply, as `storyContentRefusal` answers for stories. */
function pageContentRefusal(err: PageContentNotApplied) {
  const changed = err.changedSinceReview.length > 0;
  return {
    ok: false as const,
    intent: "apply-full-sync" as const,
    error: changed ? "page_changed_since_review" : "page_content_failed",
    pageIds: changed ? err.changedSinceReview : err.failed,
  };
}

/**
 * The sync dialog's answer for accepted story or page content, object
 * fields, new object rows or entries not applied, or null for any other
 * failure.
 */
export function contentRefusal(err: unknown) {
  if (err instanceof StoryContentNotApplied) return storyContentRefusal(err);
  if (err instanceof PageContentNotApplied) return pageContentRefusal(err);
  if (err instanceof ObjectsNotAdded) {
    return { ok: false as const, intent: "apply-full-sync" as const, error: "objects_not_added", objectIds: err.objectIds };
  }
  if (err instanceof InsertsNotAdded) {
    return { ok: false as const, intent: "apply-full-sync" as const, error: "inserts_not_added", failed: err.failed };
  }
  if (err instanceof SyncEntriesRefused) {
    return { ok: false as const, intent: "apply-full-sync" as const, error: "entries_refused", message: err.message };
  }
  if (err instanceof ObjectsChangedSinceReview) {
    return {
      ok: false as const, intent: "apply-full-sync" as const, error: "object_changed_since_review", objectIds: err.objectIds,
    };
  }
  return null;
}
