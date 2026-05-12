/**
 * ChangeSummary — entity-level change summary for the Publish wizard Review step.
 *
 * Renders expandable sections (stories, objects, pages, glossary, settings) with
 * entity counts in headers. New items in green, modified in amber, deleted in red.
 * Landing changes shown under settings. Empty sections are hidden.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, File, Image, BookOpen, Settings } from "lucide-react";
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
  description?: string;
  extraContent?: React.ReactNode;
}

function ExpandableSection({ title, icon, items, description, extraContent }: ExpandableSectionProps) {
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
          {description && (
            <p className="font-body text-xs text-gray-600 mb-2 px-2">{description}</p>
          )}
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

  // Build page items
  const pageItems: SectionItem[] = [
    ...summary.pages.new.map((p) => ({ id: p.slug, title: p.title, changeType: "new" as const })),
    ...summary.pages.modified.map((p) => ({ id: p.slug, title: p.title, changeType: "modified" as const })),
    ...summary.pages.deleted.map((p) => ({ id: p.slug, title: p.title, changeType: "deleted" as const })),
  ];

  // Build glossary items
  const glossaryItems: SectionItem[] = [
    ...summary.glossary.new.map((g) => ({ id: g.term_id, title: g.title, changeType: "new" as const })),
    ...summary.glossary.modified.map((g) => ({ id: g.term_id, title: g.title, changeType: "modified" as const })),
    ...summary.glossary.deleted.map((g) => ({ id: g.term_id, title: g.title, changeType: "deleted" as const })),
  ];

  // Build settings items. Reuse the same `auto_commit.change_<key>`
  // sentences the commit-subject builder uses, so the Review modal row
  // and the auto-generated commit headline stay verbally consistent.
  // Value-dependent keys (`lang`, `collection_mode`) carry the post-change
  // value as `s.label` from computeChangeSummary; every other managed key
  // has a single `change_<key>` form. defaultValue falls back to the raw
  // key if a future managed field is added without a matching i18n string.
  const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const settingsItems: SectionItem[] = summary.settings.changed.map((s) => {
    let i18nKey: string;
    if (s.key === "lang") {
      i18nKey = `auto_commit.change_language_to_${s.label}`;
    } else if (s.key === "collection_mode") {
      i18nKey = `auto_commit.change_collection_mode_${s.label}`;
    } else {
      i18nKey = `auto_commit.change_${s.key}`;
    }
    const sentence = t(i18nKey, { defaultValue: s.key });
    return {
      id: s.key,
      title: capitalize(sentence),
      changeType: "modified" as const,
    };
  });

  // Extra content for settings: landing changed and/or navigation changed.
  // Both are single-boolean indicators rendered as one row each, mirroring
  // the existing landing-row pattern.
  const landingRow =
    summary.landing.changed ? (
      <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-cream">
        <span className="font-body text-sm text-amber-700">{t("summary.landing")}</span>
        <span className="font-body text-xs border rounded px-1.5 py-0.5 bg-amber-50 text-amber-700 border-amber-200">
          {t("summary.modified")}
        </span>
      </div>
    ) : null;
  const navigationRow =
    summary.navigation.changed ? (
      <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-cream">
        <span className="font-body text-sm text-amber-700">{t("summary.navigation")}</span>
        <span className="font-body text-xs border rounded px-1.5 py-0.5 bg-amber-50 text-amber-700 border-amber-200">
          {t("summary.modified")}
        </span>
      </div>
    ) : null;
  const settingsExtra =
    landingRow || navigationRow ? (
      <>
        {landingRow}
        {navigationRow}
      </>
    ) : null;

  const hasSettingsContent =
    settingsItems.length > 0 || summary.landing.changed || summary.navigation.changed;

  const fileChangeItems: SectionItem[] = [
    ...summary.fileChanges.addedStoryFiles.map((id) => ({ id, title: null, changeType: "new" as const })),
    ...summary.fileChanges.removedStoryFiles.map((id) => ({ id, title: null, changeType: "deleted" as const })),
  ];

  return (
    <div className={className}>
      <p className="font-body text-sm text-gray-600 mb-4">{t("review.description")}</p>

      {summary.backCompatBootstrap && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
        >
          <p className="font-heading font-semibold text-sm text-amber-900 mb-1">
            {t("review.bootstrap_banner_title")}
          </p>
          <p className="font-body text-sm text-amber-900">
            {t("review.bootstrap_banner_body")}
          </p>
        </div>
      )}

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

      <ExpandableSection
        title={t("summary.pages")}
        icon={<File className="w-4 h-4" />}
        items={pageItems}
      />

      <ExpandableSection
        title={t("summary.glossary")}
        icon={<BookOpen className="w-4 h-4" />}
        items={glossaryItems}
      />

      {hasSettingsContent && (
        <ExpandableSection
          title={t("summary.settings")}
          icon={<Settings className="w-4 h-4" />}
          items={settingsItems}
          extraContent={settingsExtra}
        />
      )}

      <ExpandableSection
        title={t("summary.file_changes")}
        icon={<FileText className="w-4 h-4" />}
        items={fileChangeItems}
        description={t("summary.file_changes_description")}
      />
    </div>
  );
}
