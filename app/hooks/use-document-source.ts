/**
 * use-document-source — which list a page reads, and whether it is read-only.
 *
 * The shared document's arrays are empty until it syncs, so until then the
 * loader's list stands in for it. That list is read-only: the document is the
 * source of truth and would write its own values back at its next snapshot.
 *
 * @version v1.5.0-beta
 */

import { useProviderSynced } from "~/hooks/use-provider-synced";
import { storiesSource } from "~/lib/stories-source";

/** How long an unsynced document is waited for before the loader's list stays. */
const SYNC_WAIT_MS = 8000;

export function useDocumentSource(input: {
  provider: Parameters<typeof useProviderSynced>[0];
  connectionStatus: string;
  /** The page's shared document, its structural operations and its mirrored list. */
  ydoc: unknown;
  ops: unknown;
  list: readonly unknown[] | null;
}): { useYjs: boolean; awaitingDoc: boolean } {
  const { provider, connectionStatus, ydoc, ops, list } = input;
  const syncState = useProviderSynced(provider, {
    giveUpMs: SYNC_WAIT_MS,
    offline: connectionStatus === "offline",
  });
  const documentPresent = ydoc !== null && ops !== null;
  const useYjs =
    storiesSource({
      liveReady: documentPresent && list !== null,
      syncState,
      liveCount: list?.length ?? 0,
    }) === "live";
  return { useYjs, awaitingDoc: documentPresent && !useYjs };
}
