/**
 * Which list the stories page reads: the shared document's, or the loader's.
 *
 * The document's arrays are empty until it syncs, because nothing has arrived,
 * so before that the loader's list (read from D1) is shown. The live list takes
 * over at the first sync, or as soon as it holds rows.
 *
 * @version v1.5.0-beta
 */

import type { ProviderSyncState } from "~/hooks/use-provider-synced";

export function storiesSource(input: {
  /** The document, its operations and its mirrored array are all present. */
  liveReady: boolean;
  syncState: ProviderSyncState;
  liveCount: number;
}): "live" | "loader" {
  const { liveReady, syncState, liveCount } = input;
  return liveReady && (syncState === "synced" || liveCount > 0) ? "live" : "loader";
}
