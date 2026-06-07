/**
 * OtherProjectsRibbon — the bottom "Your other projects" ribbon on the Start
 * tab. A 3-up grid of the user's OTHER projects (the active one filtered out),
 * each tile showing the project name, a status pill, and a mono recency line
 * ("edited 3d ago").
 *
 * Data comes from getUserProjectsWithStats — already user-scoped (returns only
 * the caller's memberships, no cross-user leakage) and pre-sorted
 * most-recently-edited first.
 *
 * Status pill is derived from the project's publish state:
 *   - never published (no last_published_at)            → Draft   (pill--draft)
 *   - local changes not yet published (head ≠ published) → Unpublished (pill--mark)
 *   - otherwise                                          → In sync (pill--ok)
 *
 * Renders nothing when there are no other projects (don't-render). The page
 * additionally gates it to the populated state.
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.3.0-beta
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useRelativeTime } from "~/lib/use-relative-time";
import type { PillVariant } from "./WorkflowTile";

/** Minimal shape consumed from getUserProjectsWithStats. */
export interface OtherProjectStat {
  id: number;
  github_repo_full_name: string;
  head_sha: string | null;
  published_sha: string | null;
  last_published_at: string | null;
  last_edited_at: string | null;
}

export interface OtherProjectsRibbonProps {
  projects: OtherProjectStat[];
  /** The active project id — filtered out so only OTHER projects show. */
  activeProjectId: number;
  className?: string;
}

const PILL_CLASSES: Record<PillVariant, string> = {
  ok: "bg-chilca-pale text-chilca-deep",
  draft: "bg-qolle-pale text-qolle-deep",
  mark: "bg-terracotta-pale text-terracotta",
  info: "bg-anil-pale text-anil-ink",
  soft: "bg-cream-dark text-fg-muted",
};

function statusFor(p: OtherProjectStat): { variant: PillVariant; key: string } {
  if (!p.last_published_at) return { variant: "draft", key: "pill_draft" };
  if (p.head_sha && p.published_sha && p.head_sha !== p.published_sha) {
    return { variant: "mark", key: "pill_unpublished_some" };
  }
  return { variant: "ok", key: "pill_in_sync" };
}

/**
 * One project card. Extracted from the ribbon's map so the client-only
 * `useRelativeTime` hook (see its module) is called at component top level,
 * not inside a loop callback.
 */
function OtherProjectCard({ p }: { p: OtherProjectStat }) {
  const { t } = useTranslation("start");
  const status = statusFor(p);
  const editedRelative = useRelativeTime(p.last_edited_at);

  return (
    <Link
      to="/start"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-[16px] py-[14px] hover:bg-cream hover:border-border-strong transition-colors"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-heading font-semibold text-sm text-charcoal truncate">
          {p.github_repo_full_name}
        </span>
        <span
          className={`inline-flex items-center rounded-pill px-2 py-0.5 font-heading font-semibold text-xs ${PILL_CLASSES[status.variant]}`}
        >
          {t(`other_projects.${status.key}`)}
        </span>
      </div>
      <span className="font-mono text-xs text-fg-muted">
        {editedRelative
          ? t("other_projects.edited_relative", { relative: editedRelative })
          : ""}
      </span>
    </Link>
  );
}

export function OtherProjectsRibbon({
  projects,
  activeProjectId,
  className = "",
}: OtherProjectsRibbonProps) {
  const { t } = useTranslation("start");
  const others = projects.filter((p) => p.id !== activeProjectId);

  // Don't-render when there are no other projects.
  if (others.length === 0) return null;

  return (
    <section
      className={`rounded-lg border border-border bg-surface px-[28px] py-[24px] ${className}`}
    >
      <h2 className="mb-4 font-heading font-semibold text-xs uppercase tracking-wider text-fg-muted">
        {t("section.other_projects", { N: others.length })}
      </h2>

      {/* 3-up grid, 10px gap (design-locked exception). */}
      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 min-[1000px]:grid-cols-3">
        {others.map((p) => (
          <OtherProjectCard key={p.id} p={p} />
        ))}
      </div>
    </section>
  );
}
