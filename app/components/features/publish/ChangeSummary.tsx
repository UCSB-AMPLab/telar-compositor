/**
 * ChangeSummary — "What's changing" chips for the single-page Publish surface.
 *
 * Renders one counted chip per content type that has changes (Stories N /
 * Objects N / Glossary N / Pages N / Settings N) with the type accent icon.
 * The count is the total of new + modified + deleted for that type (settings
 * counts changed fields plus the landing/navigation booleans). Types with no
 * changes are omitted. When nothing changed, a single neutral line is shown.
 *
 * This compact chip layout replaces an earlier expandable-section review
 * render. Tailwind token classes only (no hardcoded hex).
 */

import { FileText, File, Image, BookOpen, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangeSummary as ChangeSummaryType } from "~/lib/publish.server";

interface ChangeSummaryProps {
  summary: ChangeSummaryType;
  className?: string;
}

interface Chip {
  key: string;
  label: string;
  count: number;
  icon: React.ReactNode;
}

export function ChangeSummary({ summary, className = "" }: ChangeSummaryProps) {
  const { t } = useTranslation("publish");

  const storyCount =
    summary.stories.new.length +
    summary.stories.modified.length +
    summary.stories.deleted.length;
  const objectCount =
    summary.objects.new.length +
    summary.objects.modified.length +
    summary.objects.deleted.length;
  const glossaryCount =
    summary.glossary.new.length +
    summary.glossary.modified.length +
    summary.glossary.deleted.length;
  const pageCount =
    summary.pages.new.length +
    summary.pages.modified.length +
    summary.pages.deleted.length;
  // Settings chip aggregates the per-field config changes plus the landing
  // and navigation single-boolean indicators — these all live under "Site
  // settings" conceptually and map to the single Settings chip.
  const settingsCount =
    summary.settings.changed.length +
    (summary.landing.changed ? 1 : 0) +
    (summary.navigation.changed ? 1 : 0);

  const chips: Chip[] = [
    {
      key: "stories",
      label: t("chips.stories"),
      count: storyCount,
      icon: <FileText className="w-4 h-4" />,
    },
    {
      key: "objects",
      label: t("chips.objects"),
      count: objectCount,
      icon: <Image className="w-4 h-4" />,
    },
    {
      key: "glossary",
      label: t("chips.glossary"),
      count: glossaryCount,
      icon: <BookOpen className="w-4 h-4" />,
    },
    {
      key: "pages",
      label: t("chips.pages"),
      count: pageCount,
      icon: <File className="w-4 h-4" />,
    },
    {
      key: "settings",
      label: t("chips.settings"),
      count: settingsCount,
      icon: <Settings className="w-4 h-4" />,
    },
  ].filter((chip) => chip.count > 0);

  if (chips.length === 0) {
    return (
      <p className={`font-body text-sm text-charcoal/60 ${className}`}>
        {t("chips.nothing_changing")}
      </p>
    );
  }

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-2 rounded-full border border-cream-dark bg-cream px-3 py-1.5 font-heading text-sm text-charcoal"
        >
          <span className="text-terracotta">{chip.icon}</span>
          <span>{chip.label}</span>
          <span className="inline-flex items-center justify-center rounded-full bg-cream-dark px-2 py-0.5 font-body text-xs text-charcoal">
            {chip.count}
          </span>
        </span>
      ))}
    </div>
  );
}
