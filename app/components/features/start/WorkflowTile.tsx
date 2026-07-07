/**
 * WorkflowTile — a single step tile in the Start-tab workflow map.
 *
 * Each tile shows `STEP · n` (mono), a tinted lucide icon, the step title with
 * an inline status pill, a meta line, an italic hover tip (dashed top-rule),
 * and a docs footer. The footer opens the DocsDrawer at this tile's DOC key
 * (onOpenDoc) and calls stopPropagation so the whole-tile surface Link does
 * NOT also navigate. When onOpenDoc is omitted the footer renders inert (the
 * DOC key stays as a data attribute for testing).
 *
 * The whole tile is a link to its surface route (Objects, Stories, …) EXCEPT:
 *   - `empty` variant: dimmed (opacity 0.85, cream bg, italic fg-subtle meta).
 *   - `locked` variant (collaborator Publish): cursor-default, NO link, a soft
 *     "Convenor-only" pill. This is don't-render of the *action* — never a
 *     disabled button.
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.4.0-beta
 */

import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Status-pill recipe — bg + ink token pairs. */
export type PillVariant = "ok" | "draft" | "mark" | "info" | "soft";

const PILL_CLASSES: Record<PillVariant, string> = {
  ok: "bg-chilca-pale text-chilca-deep",
  draft: "bg-qolle-pale text-qolle-deep",
  mark: "bg-terracotta-pale text-terracotta",
  info: "bg-anil-pale text-anil-ink",
  soft: "bg-cream-dark text-fg-muted",
};

export interface WorkflowTileProps {
  /** STEP ordinal (1–6). */
  step: number;
  /** Surface route this tile links to (e.g. "/objects"). */
  to: string;
  icon: LucideIcon;
  /** Tailwind text-* token for the icon tint (e.g. "text-chilca"). */
  iconTint: string;
  title: string;
  /** Inline status-pill label + variant. */
  pillLabel: string;
  pillVariant: PillVariant;
  /** Italic hover tip. */
  tip: string;
  /** Docs deep-link key (DOC map) — the footer opens the drawer at this key. */
  docKey: string;
  /** Docs footer label. */
  docLabel: string;
  /** Open the DocsDrawer at docKey (footer click; stopPropagation). */
  onOpenDoc?: (docKey: string) => void;
  /** Dim treatment — first-run / empty project. */
  empty?: boolean;
  /** Locked treatment — collaborator Publish tile (no action). */
  locked?: boolean;
  className?: string;
}

export function WorkflowTile({
  step,
  to,
  icon: Icon,
  iconTint,
  title,
  pillLabel,
  pillVariant,
  tip,
  docKey,
  docLabel,
  onOpenDoc,
  empty = false,
  locked = false,
  className = "",
}: WorkflowTileProps) {
  const { t } = useTranslation("start");
  // Empty applies to all tiles except the locked Publish tile
  // (`empty && !t.locked`).
  const dim = empty && !locked;

  const base =
    "group relative flex flex-col gap-2 rounded-lg border border-border bg-surface px-[16px] py-[14px] text-left transition-colors";
  const interactive = locked
    ? "cursor-default"
    : "hover:bg-cream hover:border-border-strong cursor-pointer";
  const dimmed = dim || locked ? "bg-cream opacity-[0.85]" : "";
  const titleTone = locked ? "text-fg-muted" : "text-charcoal";

  const inner = (
    <>
      {/* Top row: STEP · n (mono) + tinted icon */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-wider text-fg-muted">
          {`${t("workflow_tile.step")} · ${step}`}
        </span>
        <Icon className={`w-4 h-4 ${locked ? "text-fg-muted" : iconTint}`} aria-hidden="true" />
      </div>

      {/* Title + status pill */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`font-heading font-semibold text-base ${titleTone}`}>{title}</span>
        <span
          className={`inline-flex items-center rounded-pill px-2 py-0.5 font-heading font-semibold text-xs ${PILL_CLASSES[pillVariant]}`}
        >
          {pillLabel}
        </span>
      </div>

      {/* Hover tip — dashed top-rule, italic */}
      <p
        className={`border-t border-dashed border-border pt-2 font-body text-sm italic ${
          dim ? "text-fg-subtle" : "text-fg-muted"
        }`}
      >
        {tip}
      </p>

      {/* Docs footer — opens the DocsDrawer at docKey. stopPropagation so the
          whole-tile surface Link does not also navigate.
          preventDefault guards against the anchor default when nested in a Link. */}
      <button
        type="button"
        data-doc-key={docKey}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onOpenDoc?.(docKey);
        }}
        className="inline-flex items-center gap-1 border-t border-dashed border-border pt-2 text-left font-mono text-xs text-anil-ink hover:underline"
      >
        {docLabel}
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </button>
    </>
  );

  const classes = `${base} ${interactive} ${dimmed} ${className}`.trim();

  // Locked tile: no navigation target (don't-render the action).
  if (locked) {
    return (
      <div className={classes} aria-disabled="true">
        {inner}
      </div>
    );
  }

  return (
    <Link to={to} className={classes}>
      {inner}
    </Link>
  );
}
