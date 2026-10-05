/**
 * Where the collaboration provider stands on delivering the document's state:
 * `"synced"` once it has received it at least once, `"waiting"` while it may
 * still arrive, and `"gave-up"` when the connection is offline or `giveUpMs`
 * has passed without it. Until it syncs the shared arrays are empty, and empty
 * means "not loaded yet" rather than "has none", so a list that can be empty
 * asks this before it says so. A provider that syncs after giving up moves to
 * `"synced"`.
 *
 * A null provider (no collaboration in this render) counts as synced: the
 * caller is then reading loader data, which is complete.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useState } from "react";
import type { WebsocketProvider } from "y-websocket";

export type ProviderSyncState = "synced" | "waiting" | "gave-up";

export function useProviderSynced(
  provider: WebsocketProvider | null,
  { giveUpMs, offline = false }: { giveUpMs: number; offline?: boolean },
): ProviderSyncState {
  const [synced, setSynced] = useState<boolean>(() => provider === null || provider.synced);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!provider) {
      setSynced(true);
      return;
    }
    setSynced(provider.synced);
    setTimedOut(false);
    const onSync = (isSynced: boolean) => {
      if (isSynced) setSynced(true);
    };
    provider.on("sync", onSync);
    const timer = setTimeout(() => setTimedOut(true), giveUpMs);
    return () => {
      provider.off("sync", onSync);
      clearTimeout(timer);
    };
  }, [provider, giveUpMs]);

  if (synced) return "synced";
  return offline || timedOut ? "gave-up" : "waiting";
}
