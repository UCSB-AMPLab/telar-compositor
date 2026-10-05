/**
 * OrphanRecoveryCard — the Atelier-styled recovery card on the Start tab.
 * Closes the orphan-story recovery affordance that was left unreachable when
 * the dashboard route was retired.
 *
 * An "orphan" is a {story_id}.csv sitting in the GitHub repo that the project
 * doesn't know about — usually a hand-edit on GitHub or a teammate working
 * outside the editor. The /start loader scans for these (convenor + populated
 * + non-Sheets only, fail-open) and passes the ids here purely to know the
 * card should render and show a count.
 *
 * Two non-destructive actions, both posting to the EXISTING /dashboard
 * resource-route actions (the card lives on /start, so the fetcher.submit
 * calls carry `action: "/dashboard"` — the original dashboard banner omitted
 * it because it rendered inside that route):
 *   - Restore as drafts → intent "restore-orphan-drafts" (pulls each orphan
 *     CSV back as a draft story).
 *   - Ignore → intent "ignore-orphans" (writes the ids to .compositor-ignored
 *     so the importer stops flagging them).
 *
 * The component NEVER sends the orphan ids in the form payload — the server
 * recomputes the authoritative orphan set on every action, so a tampered
 * request can't widen the restore/ignore set. Both actions are
 * additive/reversible — no confirmation modal.
 *
 * Renders only when orphanStoryCount is above zero (don't-render gate). The page
 * additionally gates it to convenor + populated before mounting.
 *
 * The card never shows what an action came to. A restore that recovers every
 * orphan removes it, since the /start loader mounts it only while orphans
 * remain, so its fetcher is keyed (`ORPHAN_RECOVERY_FETCHER_KEY`) and the page
 * shows the answer through `OrphanRecoveryOutcome`, which outlives the card.
 * A story sheet refused for columns read as one field is answered there with
 * the column picker, which reruns the restore once the choice is
 * committed.
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { useSiteFetcher } from "~/lib/page-site";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { useTranslation } from "react-i18next";
import { SheetWarnings } from "~/components/ui/SheetWarnings";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { SheetChoicesStep, choicesQuestionOf, type SheetChoicesQuestion } from "~/components/features/dashboard/SheetChoicesStep";

/** The fetcher key the card submits through and the Start page reads. */
export const ORPHAN_RECOVERY_FETCHER_KEY = "start-orphan-recovery";

/** What `restore-orphan-drafts` and `ignore-orphans` answer (/dashboard action). */
export type OrphanRecoveryAnswer =
  | { ok: true; intent: "restore-orphan-drafts"; restored: number; warnings?: SheetWarning[] }
  | { ok: true; intent: "ignore-orphans"; ignored: number }
  | {
      ok: false;
      intent: "restore-orphan-drafts" | "ignore-orphans";
      error: string;
      message?: string;
      collidingColumns?: { sheet: string; canonicalName: string; headers: string[] };
      /** The sheet a `sheet_unreadable` failure could not read. */
      sheet?: string;
      /** The path of the file a `file_unreadable` failure could not read. */
      file?: string;
      /** What the restore's reads raised before it failed. */
      warnings?: SheetWarning[];
    }
  | ({ ok: false; intent: "restore-orphan-drafts"; warnings?: SheetWarning[] } & SheetChoicesQuestion);

interface OrphanRecoveryCardProps {
  orphanStoryCount: number;
  className?: string;
}

export function OrphanRecoveryCard({
  orphanStoryCount,
  className,
}: OrphanRecoveryCardProps) {
  const { t } = useTranslation("start");
  const fetcher = useSiteFetcher({ key: ORPHAN_RECOVERY_FETCHER_KEY });

  // Don't-render gate — never a hidden/disabled card.
  if (orphanStoryCount === 0) return null;

  const count = orphanStoryCount;
  const submitting = fetcher.state !== "idle";

  // No orphan ids in the payload — the /dashboard action recomputes the set
  // server-side. action: "/dashboard" because this card renders on /start.
  function handleRestore() {
    fetcher.submit(
      { intent: "restore-orphan-drafts" },
      { method: "post", action: "/dashboard" },
    );
  }

  function handleIgnore() {
    fetcher.submit(
      { intent: "ignore-orphans" },
      { method: "post", action: "/dashboard" },
    );
  }

  return (
    <section
      role="region"
      aria-label={t("recovery.eyebrow")}
      className={`flex flex-col gap-3 rounded-lg border border-qolle bg-qolle-pale px-[16px] py-[14px] ${className ?? ""}`}
    >
      {/* Eyebrow — alert icon + "Needs your attention" */}
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 text-qolle-deep" aria-hidden="true" />
        <span className="font-heading font-semibold text-xs uppercase tracking-wider text-qolle-deep">
          {t("recovery.eyebrow")}
        </span>
      </div>

      {/* Body */}
      <p className="font-body text-sm text-charcoal">
        {t("recovery.body", { count })}
      </p>

      {/* Actions — Restore (terracotta) + Ignore (ghost) */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRestore}
          disabled={submitting}
          className="inline-flex items-center justify-center rounded-pill bg-terracotta px-4 py-1.5 font-heading font-semibold text-xs uppercase tracking-wider text-cream hover:bg-terracotta-deep disabled:bg-disabled disabled:text-fg-disabled transition-colors"
        >
          {t("recovery.primary_cta")}
        </button>
        <button
          type="button"
          onClick={handleIgnore}
          disabled={submitting}
          aria-label={t("recovery.ignore_aria")}
          className="inline-flex items-center justify-center rounded-pill border border-border-strong px-4 py-1.5 font-heading font-semibold text-xs uppercase tracking-wider text-fg-muted hover:bg-cream disabled:text-fg-disabled transition-colors"
        >
          {t("recovery.secondary_cta")}
        </button>
      </div>
    </section>
  );
}

/** A failed restore's or ignore's sentence, one per failure code. */
function failureSentence(
  answer: Extract<OrphanRecoveryAnswer, { ok: false }>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (answer.error === "colliding_columns" && answer.collidingColumns) {
    return t("recovery.colliding_columns", {
      sheet: answer.collidingColumns.sheet,
      columns: answer.collidingColumns.headers.map((h) => `"${h}"`).join(", "),
    });
  }
  if (answer.error === "sheet_unreadable" && answer.sheet) return t("recovery.sheet_unreadable", { sheet: answer.sheet });
  if (answer.error === "file_unreadable" && answer.file) return t("recovery.file_unreadable", { file: answer.file });
  if (answer.error === "ignore_list_unreadable") return t("recovery.ignore_list_unreadable");
  if (answer.error === "no_project") return t("recovery.site_not_found");
  return t("recovery.action_failed");
}

/**
 * A story sheet the restore refused for columns read as one field: the author
 * chooses, the choice is committed, and the restore runs again on the card's
 * fetcher. Cancelling puts the picker away until the next answer.
 */
function OrphanColumnChoices({ question, className }: { question: SheetChoicesQuestion; className?: string }) {
  const fetcher = useSiteFetcher({ key: ORPHAN_RECOVERY_FETCHER_KEY });
  const [dismissed, setDismissed] = useState<SheetChoicesQuestion | null>(null);
  if (question === dismissed) return null;
  const restoreAfterChoice = () => fetcher.submit({ intent: "restore-orphan-drafts" }, { method: "post", action: "/dashboard" });
  return <SheetChoicesStep className={className} question={question} onChosen={restoreAfterChoice} onCancel={() => setDismissed(question)} />;
}

/**
 * The body of the outcome notice, or null when the answer needs none: a
 * successful ignore, or a restore that brought everything back without warnings.
 */
function outcomeBody(answer: OrphanRecoveryAnswer, t: (key: string, options?: Record<string, unknown>) => string): React.ReactNode {
  if (!answer.ok) {
    return (
      <>
        <p className="font-body text-sm text-charcoal">{failureSentence(answer, t)}</p>
        <SheetWarnings warnings={answer.warnings ?? []} defaultOpen />
      </>
    );
  }
  if (answer.intent !== "restore-orphan-drafts") return null;
  const warnings = answer.warnings ?? [];
  if (answer.restored !== 0 && warnings.length === 0) return null;
  const heading = answer.restored === 0 ? "recovery.nothing_restored" : "recovery.warnings_heading";
  return (
    <>
      <p className="font-body text-sm text-charcoal">{t(heading)}</p>
      <SheetWarnings warnings={warnings} defaultOpen />
    </>
  );
}

/**
 * What the last restore or ignore came to, for the Start page to show whether
 * or not the card is still mounted. A failure's raw message is never shown:
 * each failure code has its own sentence, followed by the warnings the reads
 * raised before it failed.
 */
export function OrphanRecoveryOutcome({ answer, className }: { answer: OrphanRecoveryAnswer | undefined; className?: string }) {
  const { t } = useTranslation("start");
  if (!answer) return null;
  const question = choicesQuestionOf(answer);
  if (question) return <OrphanColumnChoices question={question} className={className} />;
  // The layout's notice speaks for a write refused because the site changed.
  if (isSiteChanged(answer)) return null;
  const body = outcomeBody(answer, t);
  if (body === null) return null;
  return (
    <section
      role="status"
      className={`flex flex-col gap-3 rounded-lg border border-qolle bg-qolle-pale px-[16px] py-[14px] ${className ?? ""}`}
    >
      {body}
    </section>
  );
}
