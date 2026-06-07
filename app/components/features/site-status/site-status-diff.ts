/**
 * site-status-diff — aggregates a FullSyncDiff into {added, changed, removed}
 * totals for the out-of-sync popover's diff chips.
 *
 * The FullSyncDiff produced by computeFullSyncDiff (sync.server.ts) is NOT
 * pre-aggregated into +/~/− totals — this pure helper sums it. FullSyncDiff is
 * imported type-only so no server runtime is pulled into the client bundle.
 *
 * @version v1.3.0-beta
 */

import type { FullSyncDiff } from "~/lib/sync.server";

export interface SyncDiffTotals {
  added: number;
  changed: number;
  removed: number;
}

/**
 * Sums a FullSyncDiff into the three diff-chip buckets.
 *
 *   added   = new objects   + new stories     + glossary added
 *   changed = changed objects + changed stories + config changedFields + glossary changed
 *   removed = missing objects + missing stories + glossary removed
 *
 * unregisteredFiles, config.versionChange and hasConflicts are intentionally
 * NOT counted — they are not part of the +/~/− chip contract.
 */
export function aggregateSyncDiff(diff: FullSyncDiff): SyncDiffTotals {
  const added =
    diff.objects.newObjects.length +
    diff.stories.newStories.length +
    diff.glossary.added.length;

  const changed =
    diff.objects.changedObjects.length +
    diff.stories.changedStories.length +
    diff.config.changedFields.length +
    diff.glossary.changed.length;

  const removed =
    diff.objects.missingObjects.length +
    diff.stories.missingStories.length +
    diff.glossary.removed.length;

  return { added, changed, removed };
}
