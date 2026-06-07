/**
 * OrphanRecoveryCard — the Atelier-styled recovery card on the Start tab.
 * Closes the orphan-story recovery affordance that was left unreachable when
 * the dashboard route was retired.
 *
 * An "orphan" is a {story_id}.csv sitting in the GitHub repo that the project
 * doesn't know about — usually a hand-edit on GitHub or a teammate working
 * outside the editor. The /start loader scans for these (convenor + populated
 * + non-Sheets only, fail-open) and passes the ids here purely to know the
 * card should render and show a count.
 *
 * Two non-destructive actions, both posting to the EXISTING /dashboard
 * resource-route actions (the card lives on /start, so the fetcher.submit
 * calls carry `action: "/dashboard"` — the original dashboard banner omitted
 * it because it rendered inside that route):
 *   - Restore as drafts → intent "restore-orphan-drafts" (pulls each orphan
 *     CSV back as a draft story).
 *   - Ignore → intent "ignore-orphans" (writes the ids to .compositor-ignored
 *     so the importer stops flagging them).
 *
 * The component NEVER sends the orphan ids in the form payload — the server
 * recomputes the authoritative orphan set on every action, so a tampered
 * request can't widen the restore/ignore set. Both actions are
 * additive/reversible — no confirmation modal.
 *
 * Renders only when orphanStoryIds is non-empty (don't-render gate). The page
 * additionally gates it to convenor + populated before mounting.
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.3.0-beta
 */

import { AlertCircle } from "lucide-react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

interface OrphanRecoveryCardProps {
  orphanStoryIds: string[];
  className?: string;
}

export function OrphanRecoveryCard({
  orphanStoryIds,
  className,
}: OrphanRecoveryCardProps) {
  const { t } = useTranslation("start");
  const fetcher = useFetcher();

  // Don't-render gate — never a hidden/disabled card.
  if (orphanStoryIds.length === 0) return null;

  const count = orphanStoryIds.length;
  const submitting = fetcher.state !== "idle";

  // No orphan ids in the payload — the /dashboard action recomputes the set
  // server-side. action: "/dashboard" because this card renders on /start.
  function handleRestore() {
    fetcher.submit(
      { intent: "restore-orphan-drafts" },
      { method: "post", action: "/dashboard" },
    );
  }

  function handleIgnore() {
    fetcher.submit(
      { intent: "ignore-orphans" },
      { method: "post", action: "/dashboard" },
    );
  }

  return (
    <section
      role="region"
      aria-label={t("recovery.eyebrow")}
      className={`flex flex-col gap-3 rounded-lg border border-qolle bg-qolle-pale px-[16px] py-[14px] ${className ?? ""}`}
    >
      {/* Eyebrow — alert icon + "Needs your attention" */}
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 text-qolle-deep" aria-hidden="true" />
        <span className="font-heading font-semibold text-xs uppercase tracking-wider text-qolle-deep">
          {t("recovery.eyebrow")}
        </span>
      </div>

      {/* Body */}
      <p className="font-body text-sm text-charcoal">
        {t("recovery.body", { N: count })}
      </p>

      {/* Actions — Restore (terracotta) + Ignore (ghost) */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRestore}
          disabled={submitting}
          className="inline-flex items-center justify-center rounded-pill bg-terracotta px-4 py-1.5 font-heading font-semibold text-xs uppercase tracking-wider text-cream hover:bg-terracotta-deep disabled:bg-disabled disabled:text-fg-disabled transition-colors"
        >
          {t("recovery.primary_cta")}
        </button>
        <button
          type="button"
          onClick={handleIgnore}
          disabled={submitting}
          aria-label={t("recovery.ignore_aria")}
          className="inline-flex items-center justify-center rounded-pill border border-border-strong px-4 py-1.5 font-heading font-semibold text-xs uppercase tracking-wider text-fg-muted hover:bg-cream disabled:text-fg-disabled transition-colors"
        >
          {t("recovery.secondary_cta")}
        </button>
      </div>
    </section>
  );
}
