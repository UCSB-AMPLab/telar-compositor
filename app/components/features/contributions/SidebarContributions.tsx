/**
 * The reader's own row of the contribution record, inside the collaboration
 * panel.
 *
 * The panel shows one person — you — where the standalone record shows everyone.
 * That is the whole difference, and it is deliberate: a compact panel that
 * listed five people's numbers side by side in a 320px column would be a
 * leaderboard whatever the copy said, and there is no room in it for the caveats
 * that keep the full record honest. So the panel answers "how am I doing" and
 * links to the record for "how is the group doing".
 *
 * Every number is still shown against the group's total, as a track filled to
 * your share of it, because a count with nothing to scale it says very little in
 * a group of five.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";

import { CONTRIBUTION_KINDS } from "~/lib/contributions";
import type { MemberContribution } from "~/lib/contributions";
import { asClock, tint } from "./ShareBar";

const MEASURES = ["added", "edited", "words"] as const;

/** The fallback for a member with no presence colour assigned yet. */
const NO_COLOUR = "#9CA3AF";

export interface SidebarContributionsProps {
  /** Undefined until the record has loaded. */
  members?: MemberContribution[];
  currentUserId?: number;
  /** Where the full record lives. */
  recordHref: string;
}

/** A share of the group, as a percentage, or null when there is nothing to share. */
function shareOf(mine: number, group: number): number | null {
  if (group <= 0) return null;
  return Math.min(100, Math.round((mine / group) * 100));
}

export function SidebarContributions({
  members,
  currentUserId,
  recordHref,
}: SidebarContributionsProps) {
  const { t } = useTranslation("contributions");
  // The panel keeps its shape while the record is in flight. Rendering nothing
  // and then three sections would move the team list under the reader's cursor,
  // and an unloaded measure is exactly what the em dash already means.
  const you = members?.find((m) => m.userId === currentUserId);

  const colour = you?.color ?? NO_COLOUR;
  const groupEditing = members?.reduce((a, m) => a + m.editingSeconds, 0) ?? 0;
  const writingShare = you ? shareOf(you.writingSeconds, you.editingSeconds) : null;
  const editingShare = you ? shareOf(you.editingSeconds, groupEditing) : null;

  /** The group's total for one measure of one kind. */
  const groupTotal = (kind: (typeof CONTRIBUTION_KINDS)[number], measure: typeof MEASURES[number]) =>
    members?.reduce((a, m) => a + (m.kinds[kind][measure] ?? 0), 0) ?? 0;

  return (
    <>
      <section
        aria-labelledby="sb-yours"
        className="border-b border-gray-100 px-4 pb-3 pt-4"
      >
        <h3
          id="sb-yours"
          className="mb-3 flex items-center gap-2 font-heading text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-subtle"
        >
          {t("sidebar.yours")}
          <span className="flex items-center gap-1.5 normal-case tracking-normal text-fg-muted">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: colour }}
            />
            {you?.displayName ?? ""}
          </span>
        </h3>

        <div className="grid grid-cols-[1fr_repeat(3,48px)] gap-x-1.5">
          <span className="border-b border-border pb-[3px]" />
          {MEASURES.map((measure) => (
            <span
              key={measure}
              className="border-b border-border pb-[3px] text-right text-[10.5px] text-fg-subtle"
            >
              {t(`measures.${measure}`)}
            </span>
          ))}

          {CONTRIBUTION_KINDS.map((kind) => (
            <div key={kind} className="contents">
              <span className="border-b border-cream-dark py-[5px] text-[12.5px]">
                {t(`kinds.${kind}`)}
              </span>
              {MEASURES.map((measure) => {
                const mine = you?.kinds[kind][measure] ?? null;
                const share = mine === null ? null : shareOf(mine, groupTotal(kind, measure));
                return (
                  <span key={measure} className="border-b border-cream-dark py-[5px]">
                    <span
                      className={`block text-right text-[12.5px] tabular-nums ${
                        mine === null || mine === 0 ? "text-fg-faint" : ""
                      }`}
                    >
                      {mine === null ? t("uncounted") : mine}
                    </span>
                    {/* Filled from the right, so the fill ends under the number
                        it belongs to rather than drifting away from it. */}
                    <span className="mt-[3px] flex h-[3px] justify-end bg-cream-dark">
                      {share !== null && (
                        <span
                          className="block h-full"
                          style={{ width: `${share}%`, background: colour }}
                        />
                      )}
                    </span>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="sb-your-time"
        className="border-b border-gray-100 px-4 pb-3 pt-4"
      >
        <h3
          id="sb-your-time"
          className="mb-3 font-heading text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-subtle"
        >
          {t("sidebar.yourTime")}
        </h3>

        <div className="grid grid-cols-2 gap-3">
          {([
            ["sidebar.timeEditing", you?.editingSeconds ?? 0],
            ["sidebar.ofWhichWriting", you?.writingSeconds ?? 0],
          ] as const).map(([key, seconds]) => (
            <div key={key}>
              <div className="text-[10.5px] text-fg-subtle">{t(key)}</div>
              <div className="font-heading text-[20px] font-semibold leading-[1.1] tabular-nums">
                {asClock(seconds)}
              </div>
            </div>
          ))}
        </div>

        {/* One bar, not two: writing is a part of editing, and two bars would
            read as two separate activities. */}
        <div className="mt-2.5 flex h-2.5 overflow-hidden rounded-[2px] bg-cream-dark">
          {you && you.editingSeconds > 0 && (
            <>
              <span style={{ flex: you.writingSeconds, background: colour }} />
              <span
                style={{
                  flex: Math.max(0, you.editingSeconds - you.writingSeconds),
                  background: tint(colour),
                }}
              />
            </>
          )}
        </div>
        <div className="mt-[3px] flex h-[3px] bg-cream-dark">
          {editingShare !== null && (
            <span className="block h-full" style={{ width: `${editingShare}%`, background: colour }} />
          )}
        </div>

        <p className="mt-1.5 text-[11px] leading-[1.4] text-fg-subtle">
          {t("sidebar.barCaption")}
          <br />
          {t("sidebar.lineCaption")}
        </p>
        {writingShare !== null && <span className="sr-only">{writingShare}%</span>}
      </section>

      <a
        href={recordHref}
        className="block px-4 py-3 font-heading text-[13px] text-terracotta no-underline hover:text-terracotta-deep"
      >
        {t("sidebar.fullRecord")}
      </a>
    </>
  );
}
