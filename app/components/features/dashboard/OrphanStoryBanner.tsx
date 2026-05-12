/**
 * This file renders the dashboard banner that shows up when a story file
 * exists in the GitHub repo but nothing in the project knows about it.
 *
 * The usual cause is that someone deleted a row from `project.csv`
 * directly on GitHub (or pulled it via another tool), but the per-story
 * CSV the row pointed to is still sitting in the repo. The compositor's
 * importer notices the mismatch and the dashboard surfaces it here so
 * the user can decide what to do.
 *
 * Two choices — Restore as drafts pulls each orphan CSV's content back
 * into the project as new draft stories that the user can then edit and
 * re-publish; Ignore writes the orphan IDs into a `.compositor-ignored`
 * file in the repo so the importer stops flagging them on every sync.
 *
 * Both actions go through the parent dashboard route. The component
 * never sends the orphan IDs in the form payload — the server
 * recomputes the authoritative orphan set on every action, so a
 * tampered request can't trick the compositor into fetching arbitrary
 * files or blacklisting arbitrary IDs.
 *
 * @version v1.2.0-beta
 */

import { AlertCircle } from "lucide-react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";

interface OrphanStoryBannerProps {
  orphanStoryIds: string[];
  className?: string;
}

export default function OrphanStoryBanner({
  orphanStoryIds,
  className,
}: OrphanStoryBannerProps) {
  const { t } = useTranslation("dashboard");
  const fetcher = useFetcher();

  if (orphanStoryIds.length === 0) return null;

  const count = orphanStoryIds.length;
  const submitting = fetcher.state !== "idle";

  function handleRestore() {
    fetcher.submit({ intent: "restore-orphan-drafts" }, { method: "post" });
  }

  function handleIgnore() {
    fetcher.submit({ intent: "ignore-orphans" }, { method: "post" });
  }

  return (
    <section
      role="region"
      aria-label="Orphan story files"
      className={`flex flex-col md:flex-row md:items-center gap-3 md:gap-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 ${className ?? ""}`}
    >
      <AlertCircle
        className="w-5 h-5 shrink-0 text-amber-700"
        aria-hidden="true"
      />
      <p className="font-body text-sm flex-1">
        {t("orphan_banner.count_text", { count })}
      </p>
      <div className="flex items-center gap-4 md:shrink-0">
        <button
          type="button"
          onClick={handleRestore}
          disabled={submitting}
          className="inline-flex items-center justify-center rounded-full bg-terracotta px-4 py-1.5 font-heading text-xs font-semibold uppercase tracking-wider text-cream hover:bg-terracotta/90 disabled:opacity-50 transition-colors"
        >
          {t("orphan_banner.primary_cta")}
        </button>
        <button
          type="button"
          onClick={handleIgnore}
          disabled={submitting}
          className="font-body text-sm text-amber-900 underline-offset-2 hover:underline disabled:opacity-50 transition-colors"
        >
          {t("orphan_banner.secondary_cta")}
        </button>
      </div>
    </section>
  );
}
