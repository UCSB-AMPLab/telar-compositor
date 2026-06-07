/**
 * WorkflowMap — the 2×3 workflow-map spine on the Start tab.
 *
 * Renders six WorkflowTile entries in STEP order (Configure · Objects ·
 * Stories · Glossary · Pages · Publish) with real per-step counts from the
 * /start loader. The Publish tile is LOCKED (don't-render the action — no nav,
 * "Convenor-only" soft pill) for collaborators, gated on useIsConvenor().
 *
 * In the empty (first-run) state every tile dims and shows its empty pill;
 * the locked Publish tile keeps its locked treatment regardless of state.
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.3.0-beta
 */

import { Settings, Image, BookOpen, BookA, FileText, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsConvenor } from "~/hooks/use-role";
import { WorkflowTile } from "./WorkflowTile";
import type { PillVariant } from "./WorkflowTile";

export interface WorkflowCounts {
  configured: boolean;
  objects: number;
  objectsUnused: number;
  stories: number;
  storyDrafts: number;
  terms: number;
  pages: number;
}

export interface WorkflowMapProps {
  counts: WorkflowCounts;
  /** Publish "N to ship" — sourced from the _app shell unpublishedCount. */
  unpublishedCount: number;
  /** First-run flag — dims all (non-locked) tiles. */
  empty: boolean;
  /** Open the DocsDrawer at a tile's DOC key (docs-footer click). */
  onOpenDoc?: (docKey: string) => void;
  className?: string;
}

export function WorkflowMap({
  counts,
  unpublishedCount,
  empty,
  onOpenDoc,
  className = "",
}: WorkflowMapProps) {
  const { t } = useTranslation("start");
  const isConvenor = useIsConvenor();

  // Per-tile descriptors. Populated vs empty pill resolved per the state
  // variants table; tip text transcribed verbatim from the design spec.
  type TileDef = {
    step: number;
    to: string;
    icon: typeof Settings;
    iconTint: string;
    title: string;
    pillLabel: string;
    pillVariant: PillVariant;
    tip: string;
    docKey: string;
  };

  const tiles: TileDef[] = [
    {
      step: 1,
      to: "/config",
      icon: Settings,
      iconTint: "text-fg-muted",
      title: t("tile.configure"),
      pillLabel: empty || !counts.configured ? t("pill.not_started") : t("pill.done"),
      pillVariant: empty || !counts.configured ? "soft" : "ok",
      tip: t("tip.configure"),
      docKey: "configure",
    },
    {
      step: 2,
      to: "/objects",
      icon: Image,
      iconTint: "text-chilca",
      title: t("tile.objects"),
      pillLabel: empty
        ? t("pill.empty")
        : t("pill.objects_unused", { N: counts.objects, U: counts.objectsUnused }),
      pillVariant: empty ? "soft" : "ok",
      tip: t("tip.objects"),
      docKey: "objects",
    },
    {
      step: 3,
      to: "/stories",
      icon: BookOpen,
      iconTint: "text-anil-deep",
      title: t("tile.stories"),
      pillLabel: empty
        ? t("pill.none_yet")
        : t("pill.stories_drafts", { N: counts.stories, D: counts.storyDrafts }),
      pillVariant: empty ? "soft" : "draft",
      tip: t("tip.stories"),
      docKey: "stories",
    },
    {
      step: 4,
      to: "/glossary",
      icon: BookA,
      iconTint: "text-caracol",
      title: t("tile.glossary"),
      pillLabel: empty ? t("pill.empty") : t("pill.terms", { N: counts.terms }),
      pillVariant: empty ? "soft" : "ok",
      tip: t("tip.glossary"),
      docKey: "glossary",
    },
    {
      step: 5,
      to: "/pages",
      icon: FileText,
      iconTint: "text-qolle",
      title: t("tile.pages"),
      pillLabel: empty ? t("pill.landing_only") : t("pill.pages", { N: counts.pages }),
      pillVariant: empty ? "soft" : "ok",
      tip: t("tip.pages"),
      docKey: "pages",
    },
  ];

  return (
    <section
      className={`rounded-lg border border-border bg-surface px-[28px] py-[24px] ${className}`}
    >
      <div className="mb-4">
        <h2 className="font-heading font-semibold text-xs uppercase tracking-wider text-fg-muted">
          {t("section.workflow_map")}
        </h2>
        <p className="font-body text-sm italic text-fg-subtle">{t("workflow.hint")}</p>
      </div>

      {/* 2×3 grid, 10px gap (design-locked exception) */}
      <div className="grid grid-cols-2 gap-[10px]">
        {tiles.map((tile) => (
          <WorkflowTile
            key={tile.step}
            step={tile.step}
            to={tile.to}
            icon={tile.icon}
            iconTint={tile.iconTint}
            title={tile.title}
            pillLabel={tile.pillLabel}
            pillVariant={tile.pillVariant}
            tip={tile.tip}
            docKey={tile.docKey}
            docLabel={t("workflow.learn_more")}
            onOpenDoc={onOpenDoc}
            empty={empty}
          />
        ))}

        {/* Publish tile — step 6. Locked (don't-render action) for collaborators. */}
        <WorkflowTile
          step={6}
          to="/publish"
          icon={Upload}
          iconTint="text-terracotta"
          title={t("tile.publish")}
          pillLabel={
            !isConvenor
              ? t("pill.convenor_only")
              : empty
                ? t("pill.nothing_to_publish")
                : t("pill.to_ship", { count: unpublishedCount, N: unpublishedCount })
          }
          pillVariant={!isConvenor ? "soft" : empty ? "soft" : "mark"}
          tip={
            !isConvenor
              ? t("tip.publish_collaborator")
              : t("tip.publish_convenor")
          }
          docKey="publish"
          docLabel={t("workflow.learn_more")}
          onOpenDoc={onOpenDoc}
          empty={empty}
          locked={!isConvenor}
        />
      </div>
    </section>
  );
}
