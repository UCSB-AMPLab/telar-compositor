/**
 * use-version-change-toast — dashboard toast for external version drift.
 *
 * Watches the data from a sync fetcher (see `_app.dashboard.tsx` action
 * `compute-full-sync-diff` intent) and, when the returned diff surfaces a
 * `versionChange`, fires a toast via `useToast`:
 *
 *   direction="ahead"  -> info toast — repo moved forward of D1 (external
 *                         upgrade via scripts/upgrade.py or GitHub Actions;
 *                         D1 will be silently healed by applyFullSyncChanges
 *                         The toast simply informs the user.
 *   direction="behind" -> warning toast — compositor has a newer version
 *                         than the repo. Auto-apply is deliberately blocked
 *                         the toast asks the user to verify.
 *
 * The effect is keyed on the `syncFetcherData` reference, so passing the
 * same fetcher `.data` across renders fires the toast exactly once.
 *
 * Extracted from `_app.dashboard.tsx` to keep the toast-firing logic
 * testable in isolation (see tests/dashboard-sync-toast.test.tsx).
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "~/hooks/use-toast";

/**
 * Shape of the slice of sync-fetcher data this hook cares about. The
 * dashboard's sync action returns richer data, but only `ok` and the
 * nested `versionChange` field are relevant here. Typed loosely with
 * `unknown`/optional chains so the hook is defensive against partial
 * responses and fetcher idle states.
 */
export interface VersionChangeData {
  ok?: boolean;
  diff?: {
    config?: {
      versionChange?: {
        direction: "ahead" | "behind";
        repoVersion: string;
        d1Version: string | null;
      } | null;
    };
  };
}

/**
 * Reacts to `versionChange` on a sync-fetcher result and surfaces a toast.
 * Safe to call with `undefined`, fetcher-idle data, or `ok: false` — the
 * effect bails out without firing.
 */
export function useVersionChangeToast(
  syncFetcherData: VersionChangeData | undefined | null,
): void {
  const { showToast } = useToast();
  const { t } = useTranslation("upgrade");

  useEffect(() => {
    if (!syncFetcherData?.ok) return;
    const vc = syncFetcherData.diff?.config?.versionChange;
    if (!vc) return;
    if (vc.direction === "ahead") {
      showToast({
        type: "info",
        message: t("externalUpgradeToast", { version: vc.repoVersion }),
      });
    } else if (vc.direction === "behind") {
      showToast({
        type: "warning",
        message: t("externalDowngradeToast", {
          repo: vc.repoVersion,
          d1: vc.d1Version ?? "?",
        }),
      });
    }
  }, [syncFetcherData, showToast, t]);
}
