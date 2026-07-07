/**
 * UnpublishedPopover — the change-manifest body of the Site Status pill. Given a
 * single `ChangeSummary` (the same one the publish flow uses — single source of
 * truth), it renders one section per non-empty content type (Stories / Objects /
 * Glossary / Pages / Site settings) with item titles + `— modified` / `— added`
 * tags, a `Review all changes →` linky, and a terracotta `Publish` action.
 *
 * The Publish action is a NAVIGATION to `/publish` (where the existing publish
 * flow confirms), NOT a one-click commit. Section icons take their per-type tint
 * from the design system's colour contract (stories anil-ink, objects chilca,
 * glossary caracol, pages/settings fg-muted).
 *
 * `ChangeSummary` is imported type-only so no `.server` runtime reaches the
 * client bundle. The popover is a pure renderer — the pill fetches the summary
 * on open and passes it down.
 *
 * @version v1.4.0-beta
 */

import { Link } from "react-router";
import {
  BookOpen,
  Image,
  BookA,
  FileText,
  Settings,
  ArrowRight,
  Upload,
  Info,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsConvenor } from "~/hooks/use-role";
import type { ChangeSummary } from "~/lib/publish.server";
import { settingsChangeI18nKey, SETTINGS_CHANGE_FALLBACK_KEY } from "~/lib/settings-change-i18n";

export interface UnpublishedPopoverProps {
  summary: ChangeSummary;
  /** Optional last-published timestamp for the "Since last published" sub-line. */
  lastPublishedAt?: string | null;
  className?: string;
}

/** One rendered manifest row: a title and its modified|added disposition. */
interface ManifestItem {
  key: string;
  title: string;
  disposition: "modified" | "added";
}

interface ManifestSection {
  id: "stories" | "objects" | "glossary" | "pages" | "settings";
  labelKey: string;
  icon: LucideIcon;
  /** Tailwind tint class for the section icon. */
  tint: string;
  items: ManifestItem[];
}

/**
 * Formats an ISO timestamp into a short label; degrades to em-dash. Locale is
 * passed explicitly so the date matches the UI language; timezone stays local
 * (this shows a time of day). Client-only — the pill fetches the summary on
 * open, so this never participates in SSR hydration.
 */
function fmtTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Builds the manifest sections from the ChangeSummary. `new` entries map to the
 * "added" disposition; `modified` to "modified". `deleted` entries are counted
 * toward the total but not rendered as a removable item row here (the brief's
 * unpublished manifest shows what will publish; deletions surface in the full
 * Review flow). Empty sections are omitted by the caller via items.length.
 */
function buildSections(
  summary: ChangeSummary,
  resolveSetting: (entry: { key: string; label: string; value?: string }) => string,
  labels: { landingPage: string; navigation: string },
): ManifestSection[] {
  const titleOr = (title: string | null, fallback: string) =>
    title && title.trim().length > 0 ? title : fallback;

  // Stories
  const storyItems: ManifestItem[] = [
    ...summary.stories.new.map((s) => ({
      key: `story-new-${s.story_id}`,
      title: titleOr(s.title, s.story_id),
      disposition: "added" as const,
    })),
    ...summary.stories.modified.map((s) => ({
      key: `story-mod-${s.story_id}`,
      title: titleOr(s.title, s.story_id),
      disposition: "modified" as const,
    })),
  ];

  // Objects
  const objectItems: ManifestItem[] = [
    ...summary.objects.new.map((o) => ({
      key: `object-new-${o.object_id}`,
      title: titleOr(o.title, o.object_id),
      disposition: "added" as const,
    })),
    ...summary.objects.modified.map((o) => ({
      key: `object-mod-${o.object_id}`,
      title: titleOr(o.title, o.object_id),
      disposition: "modified" as const,
    })),
  ];

  // Glossary
  const glossaryItems: ManifestItem[] = [
    ...summary.glossary.new.map((g) => ({
      key: `term-new-${g.term_id}`,
      title: titleOr(g.title, g.term_id),
      disposition: "added" as const,
    })),
    ...summary.glossary.modified.map((g) => ({
      key: `term-mod-${g.term_id}`,
      title: titleOr(g.title, g.term_id),
      disposition: "modified" as const,
    })),
  ];

  // Pages
  const pageItems: ManifestItem[] = [
    ...summary.pages.new.map((p) => ({
      key: `page-new-${p.slug}`,
      title: titleOr(p.title, p.slug),
      disposition: "added" as const,
    })),
    ...summary.pages.modified.map((p) => ({
      key: `page-mod-${p.slug}`,
      title: titleOr(p.title, p.slug),
      disposition: "modified" as const,
    })),
  ];

  // Site settings (config fields + landing + navigation flags)
  const settingItems: ManifestItem[] = [
    ...summary.settings.changed.map((c) => ({
      key: `setting-${c.key}`,
      title: resolveSetting(c),
      disposition: "modified" as const,
    })),
  ];
  if (summary.landing.changed) {
    settingItems.push({ key: "setting-landing", title: labels.landingPage, disposition: "modified" });
  }
  if (summary.navigation.changed) {
    settingItems.push({ key: "setting-navigation", title: labels.navigation, disposition: "modified" });
  }

  const all: ManifestSection[] = [
    { id: "stories", labelKey: "unpublished.section.stories", icon: BookOpen, tint: "text-anil-ink", items: storyItems },
    { id: "objects", labelKey: "unpublished.section.objects", icon: Image, tint: "text-chilca", items: objectItems },
    { id: "glossary", labelKey: "unpublished.section.glossary", icon: BookA, tint: "text-caracol", items: glossaryItems },
    { id: "pages", labelKey: "unpublished.section.pages", icon: FileText, tint: "text-fg-muted", items: pageItems },
    { id: "settings", labelKey: "unpublished.section.settings", icon: Settings, tint: "text-fg-muted", items: settingItems },
  ];

  return all.filter((s) => s.items.length > 0);
}

/** Total change count — the single source of truth for the title. */
function totalChanges(sections: ManifestSection[]): number {
  return sections.reduce((sum, s) => sum + s.items.length, 0);
}

export function UnpublishedPopover({ summary, lastPublishedAt, className = "" }: UnpublishedPopoverProps) {
  const { t, i18n } = useTranslation(["popover", "publish"]);
  // Setting labels live in the `publish` namespace (auto_commit.*) and are
  // resolved through the same helper the commit-message builder uses, so the
  // popover and the commit subject always show identical, translated labels for
  // a given change — never a raw field key. The generic fallback guards any
  // unmapped future field.
  const resolveSetting = (entry: { key: string; label: string; value?: string }) =>
    t(`publish:auto_commit.${settingsChangeI18nKey(entry)}`, {
      defaultValue: t(`publish:auto_commit.${SETTINGS_CHANGE_FALLBACK_KEY}`),
    });
  // Convenors get the Publish navigation CTA; collaborators (who can never
  // reach /publish — the tab is hidden and the route redirects them) get a
  // non-actionable "Ask convenor to publish" note instead. This is the
  // collaborator's only publish-related affordance now that the Publish tab is
  // gone. Informational only — no server action.
  const isConvenor = useIsConvenor();

  const sections = buildSections(summary, resolveSetting, {
    landingPage: t("unpublished.landing_page"),
    navigation: t("unpublished.navigation"),
  });
  const total = totalChanges(sections);
  const title =
    total === 1 ? t("unpublished.title_one") : t("unpublished.title_other", { n: total });

  return (
    <div className={className}>
      {/* Head */}
      <div className="border-b border-border" style={{ padding: "14px 18px 12px" }}>
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {title}
        </h3>
        <p className="font-body text-fg-muted" style={{ fontSize: "12px", marginTop: "2px" }}>
          {t("unpublished.since", { time: fmtTime(lastPublishedAt, i18n.language) })}
        </p>
      </div>

      {/* Body: one section per non-empty content type */}
      <div style={{ padding: "12px 18px 14px" }}>
        {sections.map((section, i) => (
          <Section
            key={section.id}
            section={section}
            label={t(section.labelKey)}
            modifiedTag={t("unpublished.modified")}
            addedTag={t("unpublished.added")}
            dashed={i > 0}
          />
        ))}
      </div>

      {/* Footer: convenor gets the review-link + Publish CTA; collaborators get
          a non-actionable "Ask convenor to publish" note. Both the review link
          and the Publish CTA navigate to /publish, which a collaborator cannot
          reach, so the whole footer differs by role. */}
      {isConvenor ? (
        <div
          className="border-t border-border bg-cream flex items-center justify-between"
          style={{ padding: "11px 14px 12px" }}
        >
          <Link
            to="/publish"
            className="font-heading font-semibold inline-flex items-center gap-1 text-anil-ink hover:underline"
            style={{ fontSize: "12.5px" }}
          >
            {t("unpublished.review")}
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
          <Link
            to="/publish"
            className="font-heading font-semibold inline-flex items-center gap-1.5 bg-terracotta text-surface hover:bg-terracotta-deep transition-colors"
            style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "9999px" }}
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            {t("unpublished.publish")}
          </Link>
        </div>
      ) : (
        <div
          className="border-t border-border bg-cream flex items-center gap-1.5"
          style={{ padding: "11px 14px 12px" }}
        >
          <Info className="w-3.5 h-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
          <span className="font-body text-fg-muted" style={{ fontSize: "12.5px" }}>
            {t("common:role.ask_convenor_publish")}
          </span>
        </div>
      )}
    </div>
  );
}

function Section({
  section,
  label,
  modifiedTag,
  addedTag,
  dashed,
}: {
  section: ManifestSection;
  label: string;
  modifiedTag: string;
  addedTag: string;
  dashed: boolean;
}) {
  const Icon = section.icon;
  return (
    <div
      className={dashed ? "border-t border-dashed border-border" : ""}
      style={{ padding: "9px 0" }}
    >
      <div className="flex items-center" style={{ gap: "6px" }}>
        <Icon className={`w-3.5 h-3.5 shrink-0 ${section.tint}`} aria-hidden="true" />
        <span
          className="font-heading font-semibold text-charcoal uppercase"
          style={{ fontSize: "11px", letterSpacing: "0.04em" }}
        >
          {label}
        </span>
        <span className="font-body text-fg-muted" style={{ fontSize: "12px" }}>
          {section.items.length}
        </span>
      </div>
      <ul className="flex flex-col" style={{ paddingLeft: "22px", gap: "6px", marginTop: "6px" }}>
        {section.items.map((item) => (
          <li key={item.key} className="flex items-baseline" style={{ gap: "6px" }}>
            <span className="font-body text-charcoal" style={{ fontSize: "12px" }}>
              {item.title}
            </span>
            <span className="font-mono text-fg-muted" style={{ fontSize: "10px" }}>
              — {item.disposition === "modified" ? modifiedTag : addedTag}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
