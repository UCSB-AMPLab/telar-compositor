/**
 * The contribution record: what every member of a project has put into it.
 *
 * It exists so that a group and its instructor can look at the same evidence and
 * reach their own conclusions about how the work was shared. It is not a score,
 * a ranking or a leaderboard, and three things in here enforce that rather than
 * merely asking for it. People are in alphabetical order and there is no sort by
 * value anywhere. Every bar is normalised inside one kind and one measure, so no
 * two kinds share an axis. And there is no total across measures and no
 * per-person total across kinds — the numbers are deliberately left
 * un-addable.
 *
 * Every measure carries its caveat where it is shown, and the caveats do not
 * collapse. A number without its qualification is the failure mode this screen
 * is most exposed to: `added` partly records who holds the upload permission,
 * `edited` says nothing about how much, and `words` measure length rather than
 * quality.
 *
 * Rendered both as the standalone page and as its print/PDF form.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";

import { CONTRIBUTION_KINDS } from "~/lib/contributions";
import type { ContributionKind, MemberContribution } from "~/lib/contributions";
import { NestedTimeBar, ShareBar, asClock, tint } from "./ShareBar";

/** The fallback for a member with no presence colour assigned yet. */
const NO_COLOUR = "#9CA3AF";

/** The three content measures, in the order they are shown. */
const MEASURES = ["added", "edited", "words"] as const;
type Measure = (typeof MEASURES)[number];

export interface ContributionRecordProps {
  projectTitle: string;
  members: MemberContribution[];
  /** False on a project whose work predates the word and time measures. */
  hasWordsAndTime: boolean;
}

function colourOf(member: MemberContribution): string {
  return member.color ?? NO_COLOUR;
}

/** A person's dot, the same colour their cursor uses in the editor. */
function Dot({ color, size = 9 }: { color: string; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: color }}
    />
  );
}

/**
 * A person's name, and for someone who is no longer a member a label saying
 * so: their credit stays on the record as part of the project's history.
 */
function MemberName({ member }: { member: MemberContribution }) {
  const { t } = useTranslation("contributions");
  if (!member.former) return <>{member.displayName}</>;
  return (
    <>
      {member.displayName}
      <span className="text-[12px] text-fg-subtle">{t("former_member")}</span>
    </>
  );
}

export function ContributionRecord({
  projectTitle,
  members,
  hasWordsAndTime,
}: ContributionRecordProps) {
  const { t, i18n } = useTranslation("contributions");

  const today = new Date().toLocaleDateString(i18n.language, {
    day: "numeric", month: "long", year: "numeric",
  });

  const editingTotal = members.reduce((a, m) => a + m.editingSeconds, 0);
  const writingTotal = members.reduce((a, m) => a + m.writingSeconds, 0);

  /** One measure of one kind, per person, for the bar. */
  const sharesFor = (kind: ContributionKind, measure: Measure) =>
    members.map((m) => ({
      userId: m.userId,
      color: colourOf(m),
      value: m.kinds[kind][measure] ?? 0,
    }));

  /** The group's total for one measure of one kind, or null if uncounted. */
  const totalFor = (kind: ContributionKind, measure: Measure): number | null => {
    const values = members.map((m) => m.kinds[kind][measure]);
    return values.every((v) => v === null)
      ? null
      : values.reduce<number>((a, v) => a + (v ?? 0), 0);
  };

  return (
    <div className="mx-auto max-w-[1000px] px-12 pb-10 pt-11 text-[15px] leading-[1.55] text-charcoal">
      <header className="mb-5 border-b-2 border-charcoal pb-3.5">
        <h1 className="mb-[3px] font-heading text-[25px] tracking-[-0.01em]">{projectTitle}</h1>
        <div className="text-[13px] text-fg-muted">
          {t("meta", { date: today, count: members.filter((m) => !m.former).length })}
        </div>
      </header>

      <p className="mb-[22px] max-w-[66ch]">{t("intro")}</p>

      <h2 className="font-heading text-[18px] tracking-[-0.01em]">{t("made.heading")}</h2>
      <p className="text-[13.5px] text-fg-muted">{t("made.subhead")}</p>

      <dl className="mb-[22px] mt-3 grid max-w-[70ch] grid-cols-[90px_1fr] gap-x-4 gap-y-2 text-[13.5px] leading-[1.5] text-fg-muted">
        {MEASURES.map((measure) => (
          <div key={measure} className="contents">
            <dt className="font-heading text-[11px] font-semibold uppercase tracking-[0.05em] text-charcoal">
              {t(`measures.${measure}`)}
            </dt>
            <dd>{t(`definitions.${measure}`)}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 rounded-md bg-cream px-3.5 py-[11px]">
        {members.map((member) => (
          <span key={member.userId} className="flex items-center gap-1.5 text-[13.5px]">
            <Dot color={colourOf(member)} size={11} />
            <MemberName member={member} />
          </span>
        ))}
        <span className="ml-auto text-[12px] text-fg-subtle">{t("legend")}</span>
      </div>

      {!hasWordsAndTime && (
        <p className="mt-3.5 rounded-md border border-dashed border-border-strong bg-cream px-4 py-3 text-[13.5px] text-fg-muted">
          {t("predatesCollection")}
        </p>
      )}

      {CONTRIBUTION_KINDS.map((kind) => (
        <section
          key={kind}
          className="grid grid-cols-[120px_1fr] gap-x-5 border-b border-border pb-5 pt-[22px]"
          // Kept whole across a page break: a heading stranded from its own
          // table is the one thing printing this reliably got wrong.
          style={{ breakInside: "avoid" }}
        >
          <h3 className="font-heading text-[13px] font-semibold uppercase tracking-[0.05em]">
            {t(`kinds.${kind}`)}
          </h3>
          <div>
            <div className="flex flex-col gap-[5px]">
              {MEASURES.map((measure) => {
                const total = totalFor(kind, measure);
                return (
                  <ShareBar
                    key={measure}
                    label={t(`measures.${measure}`)}
                    shares={total === null ? [] : sharesFor(kind, measure)}
                    total={total === null ? t("uncounted") : String(total)}
                    uncounted={total === null}
                  />
                );
              })}
            </div>

            <div className="pl-[72px]">
            <table className="mt-3 w-full text-[13.5px]">
              <thead>
                <tr>
                  <th className="border-b border-border pb-[3px]" />
                  {MEASURES.map((measure) => (
                    <th
                      key={measure}
                      className="w-[72px] border-b border-border pb-[3px] text-right text-[11px] font-normal text-fg-subtle"
                    >
                      {t(`measures.${measure}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId} className="border-b border-cream-dark">
                    <td className="py-1">
                      <span className="flex items-center gap-1.5">
                        <Dot color={colourOf(member)} />
                        <MemberName member={member} />
                      </span>
                    </td>
                    {MEASURES.map((measure) => {
                      const value = member.kinds[kind][measure];
                      return (
                        <td
                          key={measure}
                          className={`py-1 text-right tabular-nums ${
                            value === null || value === 0 ? "text-fg-faint" : "text-charcoal"
                          }`}
                        >
                          {value === null ? t("uncounted") : value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </section>
      ))}

      {/* Time is a different kind of measure from the three above — those
          describe what is in the site, this describes how long people spent on
          it — so it sits behind its own rule and its own heading rather than
          becoming a sixth kind block. */}
      <section className="mt-9 border-t-2 border-charcoal pt-[22px]" style={{ breakInside: "avoid" }}>
        <h2 className="font-heading text-[18px] tracking-[-0.01em]">{t("time.heading")}</h2>
        <p className="max-w-[66ch] text-[13.5px] text-fg-muted">{t("time.caveat")}</p>

        <div className="mt-4 grid grid-cols-[120px_1fr] gap-x-5 pb-5">
          <h3 className="font-heading text-[13px] font-semibold uppercase tracking-[0.05em]">
            {t("time.row")}
          </h3>
          <div>
            <NestedTimeBar
              label={t("time.editing")}
              people={members.map((m) => ({
                userId: m.userId,
                color: colourOf(m),
                editing: m.editingSeconds,
                writing: m.writingSeconds,
              }))}
              total={asClock(editingTotal)}
            />

            <div className="mt-1.5 flex gap-4 pl-[72px] text-[11.5px] text-fg-subtle">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-[1px] bg-fg-muted" />
                {t("time.writingLegend", { total: asClock(writingTotal) })}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-[1px]"
                  style={{ background: tint("#6B7280") }}
                />
                {t("time.otherEditing")}
              </span>
            </div>

            <div className="pl-[72px]">
            <table className="mt-3 w-full text-[13.5px]">
              <thead>
                <tr>
                  <th className="border-b border-border pb-[3px]" />
                  {["editing", "writing", "writingShare"].map((column) => (
                    <th
                      key={column}
                      className="w-[96px] border-b border-border pb-[3px] text-right text-[11px] font-normal text-fg-subtle"
                    >
                      {t(`time.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const share = member.editingSeconds > 0
                    ? Math.round((member.writingSeconds / member.editingSeconds) * 100)
                    : null;
                  return (
                    <tr key={member.userId} className="border-b border-cream-dark">
                      <td className="py-1">
                        <span className="flex items-center gap-1.5">
                          <Dot color={colourOf(member)} />
                          <MemberName member={member} />
                        </span>
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {asClock(member.editingSeconds)}
                      </td>
                      <td
                        className={`py-1 text-right tabular-nums ${
                          member.writingSeconds === 0 ? "text-fg-faint" : ""
                        }`}
                      >
                        {asClock(member.writingSeconds)}
                      </td>
                      <td className="py-1">
                        <span className="flex items-center justify-end gap-2">
                          {share !== null && (
                            <span className="inline-block h-[5px] w-7 overflow-hidden rounded-[1px] bg-cream-dark">
                              <span
                                className="block h-full"
                                style={{ width: `${share}%`, background: colourOf(member) }}
                              />
                            </span>
                          )}
                          <span className={`tabular-nums ${share === null ? "text-fg-faint" : ""}`}>
                            {share === null ? t("uncounted") : `${share}%`}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
