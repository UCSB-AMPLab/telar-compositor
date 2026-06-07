/**
 * OutOfSyncPopover — the divergence body of the Site Status pill. Renders three
 * diff chips (+ added / ~ changed / – removed) whose counts come from
 * `aggregateSyncDiff(FullSyncDiff)`, a `Review changes` anil primary action (the
 * recommended path — deep-links to the existing SyncConfirmModal `?sync=1` flow
 * on the dashboard), and a `Keep my version` ghost button.
 *
 * `Keep my version` reuses the EXISTING `accept-divergence` intent on the
 * dashboard action (requireOwner-gated server-side) via a POST fetcher exactly
 * as SyncConfirmModal does — it introduces NO new intent and NO D1 write.
 *
 * Both actions surface only for convenors — out-of-sync renders only for
 * convenors today (mirrors `SyncBanner`), and the server gate is authoritative.
 * The chip palette deliberately DIFFERS from the pill: added is chilca (not the
 * pill's qolle), per the design system's colour contract.
 *
 * `FullSyncDiff` is imported type-only so no `.server` runtime reaches the
 * client bundle.
 *
 * @version v1.3.0-beta
 */

import { Link, useFetcher } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FullSyncDiff } from "~/lib/sync.server";
import { aggregateSyncDiff } from "~/components/features/site-status/site-status-diff";

export interface OutOfSyncPopoverProps {
  diff: FullSyncDiff;
  /**
   * Deep-link target that opens the existing SyncConfirmModal Review flow on
   * the dashboard (the `?sync=1` path — SyncConfirmModal.tsx:243). Defaults to
   * the dashboard sync trigger.
   */
  reviewTo?: string;
  className?: string;
}

export function OutOfSyncPopover({
  diff,
  reviewTo = "/dashboard?sync=1",
  className = "",
}: OutOfSyncPopoverProps) {
  const { t } = useTranslation("popover");
  // Reuse the existing accept-divergence intent — NOT a new one. Posts to the
  // dashboard action exactly like SyncConfirmModal's applyFetcher.
  const acceptFetcher = useFetcher();

  const { added, changed, removed } = aggregateSyncDiff(diff);

  function handleKeepMine() {
    // The pill is global (mounted in the Header on every authenticated route),
    // but only the dashboard action handles `accept-divergence`. Target it
    // explicitly so the intent always reaches its handler — a bare POST would
    // hit the current route's action and 400/no-op everywhere but /dashboard.
    // The dashboard action resolves the active project from the session, so a
    // cross-route POST is safe.
    acceptFetcher.submit(
      { intent: "accept-divergence" },
      { method: "post", action: "/dashboard" },
    );
  }

  return (
    <div className={className}>
      {/* Head */}
      <div className="border-b border-border" style={{ padding: "14px 18px 12px" }}>
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {t("out_of_sync.title")}
        </h3>
        <p className="font-body text-fg-muted" style={{ fontSize: "12px", marginTop: "2px", lineHeight: 1.45 }}>
          {t("out_of_sync.body")}
        </p>
      </div>

      {/* Body: What-changed label + three diff chips */}
      <div style={{ padding: "12px 18px 14px" }}>
        <p
          className="font-heading font-semibold text-charcoal uppercase"
          style={{ fontSize: "11px", letterSpacing: "0.04em", marginBottom: "8px" }}
        >
          {t("out_of_sync.diff_label")}
        </p>
        <div className="flex flex-wrap" style={{ gap: "8px" }}>
          <DiffChip
            tokens="bg-chilca-pale text-chilca-deep"
            symbol="+"
            label={t("out_of_sync.added", { n: added })}
          />
          <DiffChip
            tokens="bg-qolle-pale text-qolle-deep"
            symbol="~"
            label={t("out_of_sync.changed", { n: changed })}
          />
          <DiffChip
            tokens="bg-terracotta-pale text-terracotta"
            symbol="–"
            label={t("out_of_sync.removed", { n: removed })}
          />
        </div>
      </div>

      {/* Footer: ghost Keep-my-version (left) + anil Review-changes (right) */}
      <div
        className="border-t border-border bg-cream flex items-center justify-end"
        style={{ padding: "11px 14px 12px", gap: "8px" }}
      >
        <button
          type="button"
          onClick={handleKeepMine}
          disabled={acceptFetcher.state !== "idle"}
          className="font-heading font-semibold bg-surface border border-border text-charcoal hover:bg-cream transition-colors disabled:opacity-60"
          style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "0.375rem" }}
        >
          {t("out_of_sync.keep_mine")}
        </button>
        <Link
          to={reviewTo}
          className="font-heading font-semibold inline-flex items-center gap-1.5 bg-anil text-charcoal hover:bg-anil-hover transition-colors"
          style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "9999px" }}
        >
          {t("out_of_sync.review")}
          <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function DiffChip({ tokens, symbol, label }: { tokens: string; symbol: string; label: string }) {
  return (
    <span
      className={`font-heading font-semibold inline-flex items-center gap-1 uppercase ${tokens}`}
      style={{ fontSize: "11px", letterSpacing: "0.03em", padding: "4px 10px", borderRadius: "9999px" }}
    >
      <span aria-hidden="true">{symbol}</span>
      {label}
    </span>
  );
}
