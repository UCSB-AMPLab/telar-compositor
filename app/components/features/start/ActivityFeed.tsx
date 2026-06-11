/**
 * ActivityFeed — the right-rail activity card on the Start tab. Shows up to the
 * last 5 coarse activity rows (one per save / create / sync / publish) for the
 * active project, newest first.
 *
 * Each row: a presence-coloured 22px avatar (GitHub avatar URL + initials
 * fallback, the Header.tsx pattern) + the actor's name and verb + the linked
 * entity target (anil-ink text, anil underline) + a mono relative-time meta
 * line (useRelativeTime). Rows are separated by 1px top-rules (first row none).
 *
 * Below the feed: a "See all activity →" link — rendered with NO destination
 * (deferred). In the empty state (zero rows) the card shows an italic fg-muted
 * first-run message and NO "See all" link.
 *
 * Fail-open: the loader returns [] on any scan/query failure, so this card
 * simply renders the empty message rather than an error banner (the no-error-
 * banner design decision). An optional `failed` flag swaps the first-run copy
 * for a quieter "Activity unavailable" line while keeping that decision.
 *
 * Design tokens only — avatar backgrounds come from member presence colours
 * (never hardcoded hex); a neutral token background is used when a row has no
 * presence colour.
 *
 * @version v1.3.6-beta
 */

import { useTranslation } from "react-i18next";
import { useRelativeTime } from "~/lib/use-relative-time";
import type { RecentActivityRow } from "~/lib/activity.server";
import { activityEntityLabel } from "~/lib/activity-display";

export interface ActivityFeedProps {
  rows: RecentActivityRow[];
  /** Optional presence colour per actor user id (project_members palette). */
  presenceColors?: Record<number, string | null | undefined>;
  /** True on a real loader failure — swaps the first-run copy for a quieter line. */
  failed?: boolean;
  className?: string;
}

/** Two-letter initials from a display name (avatar fallback). */
function initialsOf(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ActivityRow({
  row,
  presenceColor,
  withRule,
}: {
  row: RecentActivityRow;
  presenceColor?: string | null;
  withRule: boolean;
}) {
  // `config` is loaded alongside `start` so config-field labels (resolved via
  // the `config:` prefix in activity-display) are available on this tab.
  const { t } = useTranslation(["start", "config"]);
  const actorName =
    row.actor_github_name || row.actor_github_login || t("activity.someone");
  // verb and entity_type are stable English enum values (activity.server
  // ACTIVITY_VERBS / ACTIVITY_ENTITY_TYPES) — translate them for display, with
  // the raw token as defaultValue so a legacy out-of-set row degrades to the
  // token rather than a visible key string.
  const verbLabel = t(`activity.verb.${row.verb}`, { defaultValue: row.verb });
  const entityTypeLabel = t(`activity.entity.${row.entity_type}`, {
    defaultValue: row.entity_type,
  });
  // Resolve the human label — config field keys → Config-tab labels, missing
  // titles → "untitled"; a raw slug/id is never shown (see activity-display).
  const entityLabel = activityEntityLabel(row, t);
  const bgStyle = presenceColor ? { backgroundColor: presenceColor } : undefined;
  // Client-only relative timestamp (see useRelativeTime); empty until mount.
  const relative = useRelativeTime(row.created_at);

  return (
    <li
      className={`flex items-start gap-2 ${
        withRule ? "border-t border-border pt-2 mt-2" : ""
      }`}
    >
      {/* Avatar — presence-coloured 22px, white initials fallback. */}
      <span className="relative shrink-0">
        <img
          src={`https://avatars.githubusercontent.com/u/${row.actor_github_id ?? 0}?s=56`}
          alt={actorName}
          className="w-[22px] h-[22px] rounded-full object-cover bg-anil"
          style={bgStyle}
          onError={(e) => {
            const target = e.currentTarget;
            target.style.display = "none";
            const sibling = target.nextElementSibling as HTMLElement | null;
            if (sibling) sibling.style.display = "flex";
          }}
        />
        <span
          className="w-[22px] h-[22px] rounded-full bg-anil text-charcoal font-heading font-semibold text-xs items-center justify-center hidden"
          style={bgStyle}
          aria-hidden="true"
        >
          {initialsOf(row.actor_github_name)}
        </span>
      </span>

      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="font-body text-sm text-charcoal">
          <span className="font-medium">{actorName}</span> {verbLabel}{" "}
          <span className="text-anil-ink underline decoration-anil underline-offset-2">
            {entityLabel}
          </span>
        </span>
        <span className="font-mono text-xs text-fg-muted">
          {relative ? `${relative} · ` : ""}{entityTypeLabel}
        </span>
      </span>
    </li>
  );
}

export function ActivityFeed({
  rows,
  presenceColors,
  failed = false,
  className = "",
}: ActivityFeedProps) {
  const { t } = useTranslation("start");
  const isEmpty = rows.length === 0;

  return (
    <section
      className={`rounded-lg border border-border bg-surface px-[20px] py-[16px] ${className}`}
    >
      <h2 className="mb-3 font-heading font-semibold text-xs uppercase tracking-wider text-fg-muted">
        {t("section.activity")}
      </h2>

      {isEmpty ? (
        <p className="font-body text-sm italic text-fg-muted">
          {failed ? t("activity.fail_open") : t("activity.empty")}
        </p>
      ) : (
        <>
          <ul className="flex flex-col">
            {rows.map((row, i) => (
              <ActivityRow
                key={row.id}
                row={row}
                presenceColor={
                  row.actor_user_id != null
                    ? presenceColors?.[row.actor_user_id]
                    : undefined
                }
                withRule={i > 0}
              />
            ))}
          </ul>
          {/* "See all activity" — destination deferred (no target). */}
          <button
            type="button"
            className="mt-3 font-heading font-semibold text-xs uppercase tracking-wider text-anil-ink hover:underline underline-offset-2"
          >
            {t("activity.see_all")} →
          </button>
        </>
      )}
    </section>
  );
}
