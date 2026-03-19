/**
 * ChangeSummary — entity-level change summary for the Publish wizard Review step.
 *
 * Renders 3 expandable sections (stories, objects, settings) with entity counts
 * in headers. New items in green, modified in amber, deleted in red.
 * Landing changes shown under settings. Empty sections are hidden.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Image, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangeSummary as ChangeSummaryType } from "~/lib/publish.server";

interface ChangeSummaryProps {
  summary: ChangeSummaryType;
  className?: string;
}

interface SectionItem {
  id: string;
  title: string | null;
  changeType: "new" | "modified" | "deleted";
}

function SectionRow({ item }: { item: SectionItem }) {
  const { t } = useTranslation("publish");

  const colorClass =
    item.changeType === "new"
      ? "text-green-700"
      : item.changeType === "modified"
      ? "text-amber-700"
      : "text-red-700";

  const badgeClass =
    item.changeType === "new"
      ? "bg-green-50 text-green-700 border-green-200"
      : item.changeType === "modified"
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-red-50 text-red-700 border-red-200";

  const label =
    item.changeType === "new"
      ? t("summary.new")
      : item.changeType === "modified"
      ? t("summary.modified")
      : t("summary.deleted");

  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-cream">
      <span className={`font-body text-sm ${colorClass}`}>
        {item.title ?? item.id}
      </span>
      <span className={`font-body text-xs border rounded px-1.5 py-0.5 ${badgeClass}`}>
        {label}
      </span>
    </div>
  );
}

interface ExpandableSectionProps {
  title: string;
  icon: React.ReactNode;
  items: SectionItem[];
  extraContent?: React.ReactNode;
}

function ExpandableSection({ title, icon, items, extraContent }: ExpandableSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const total = items.length;

  if (total === 0 && !extraContent) return null;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden mb-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-cream-dark hover:bg-cream transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-charcoal">{icon}</span>
          <span className="font-heading font-semibold text-sm text-charcoal">{title}</span>
          {total > 0 && (
            <span className="font-body text-xs bg-gray-200 text-gray-600 rounded-full px-2 py-0.5">
              {total}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-400" />
        )}
      </button>

      {expanded && (
        <div className="px-3 py-2">
          {items.map((item) => (
            <SectionRow key={item.id} item={item} />
          ))}
          {extraContent}
        </div>
      )}
    </div>
  );
}

export function ChangeSummary({ summary, className = "" }: ChangeSummaryProps) {
  const { t } = useTranslation("publish");

  // Build story items
  const storyItems: SectionItem[] = [
    ...summary.stories.new.map((s) => ({ id: s.story_id, title: s.title, changeType: "new" as const })),
    ...summary.stories.modified.map((s) => ({ id: s.story_id, title: s.title, changeType: "modified" as const })),
    ...summary.stories.deleted.map((s) => ({ id: s.story_id, title: s.title, changeType: "deleted" as const })),
  ];

  // Build object items
  const objectItems: SectionItem[] = [
    ...summary.objects.new.map((o) => ({ id: o.object_id, title: o.title, changeType: "new" as const })),
    ...summary.objects.modified.map((o) => ({ id: o.object_id, title: o.title, changeType: "modified" as const })),
    ...summary.objects.deleted.map((o) => ({ id: o.object_id, title: o.title, changeType: "deleted" as const })),
  ];

  // Build settings items (just a count indicator, no IDs)
  const settingsItems: SectionItem[] = summary.settings.changed.map((s) => ({
    id: s.key,
    title: s.label,
    changeType: "modified" as const,
  }));

  // Extra content for settings: landing changed
  const landingExtra =
    summary.landing.changed ? (
      <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-cream">
        <span className="font-body text-sm text-amber-700">{t("summary.landing")}</span>
        <span className="font-body text-xs border rounded px-1.5 py-0.5 bg-amber-50 text-amber-700 border-amber-200">
          {t("summary.modified")}
        </span>
      </div>
    ) : null;

  const hasSettingsContent = settingsItems.length > 0 || summary.landing.changed;

  return (
    <div className={className}>
      <p className="font-body text-sm text-gray-600 mb-4">{t("review.description")}</p>

      <ExpandableSection
        title={t("summary.stories")}
        icon={<FileText className="w-4 h-4" />}
        items={storyItems}
      />

      <ExpandableSection
        title={t("summary.objects")}
        icon={<Image className="w-4 h-4" />}
        items={objectItems}
      />

      {hasSettingsContent && (
        <ExpandableSection
          title={t("summary.settings")}
          icon={<Settings className="w-4 h-4" />}
          items={settingsItems}
          extraContent={landingExtra}
        />
      )}
    </div>
  );
}
