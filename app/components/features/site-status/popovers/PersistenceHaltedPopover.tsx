/**
 * PersistenceHaltedPopover — the body of the site-status pill's
 * `persistence-halted` state: what has stopped, why, and the convenor's one way
 * out of it.
 *
 * It is mounted by the halt the client remembers, by a restore still in flight
 * and by the outcome of one, NOT by the pill's derived state, so that neither a
 * state read, an admission arriving before the action's response, nor a pill
 * re-derivation can take the outcome or the retry off the screen while the
 * convenor is reading it.
 *
 * Every member sees what happened, the reason in plain words, and a Check again
 * that reads the state once — the one refresh available after the automatic
 * reads have stopped. A collaborator is told whose job the restore is. The
 * convenor gets the action with its cost stated before the click, behind a
 * confirm inside the popover: the reset discards everything since the last save
 * and reconnects everyone editing. The confirm carries the project and the
 * generation the last successful read named, and is disabled while none is held,
 * so a stale generation is never resent in a loop.
 *
 * No editing lock is added anywhere: the copy says saving has stopped and warns
 * what that costs, and the editing surfaces stay as they are.
 *
 * Mirrors RepoUnavailablePopover's head/body/footer geometry; terracotta tones;
 * `popover` namespace. Light mode only; lucide-react only; `~/` imports.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { HaltSnapshot } from "~/hooks/use-persistence-halt";
import type { ResetOutcome } from "~/routes/api.persistence";

/** The reasons the object names. Anything else renders the generic line. */
const KNOWN_REASONS = [
  "enforcement_failed",
  "fence_refused",
  "apply_failed",
  "log_corrupt",
  "bad_halt",
] as const;

export interface PersistenceHaltedPopoverProps {
  halt: HaltSnapshot | null;
  stateUnreadable: boolean;
  /** The generation of the last successful read; null while none is held. */
  confirmedGeneration: number | null;
  /** What the last applied read answered; null when none could be read. */
  lastReadHalted: boolean | null;
  /** A read proves a halt above the generation the restore was confirmed for. */
  haltedAgain: boolean;
  outcome: ResetOutcome | null;
  submitting: boolean;
  userRole: "convenor" | "collaborator" | "instructor" | null;
  onCheckAgain: () => void;
  onRestore: (generation: number) => void;
  className?: string;
}

/** The reason key for a reason word, falling back to the generic line. */
function reasonKeyFor(reason: string | null): string {
  const known = (KNOWN_REASONS as readonly string[]).includes(reason ?? "");
  return `site_status.halted.reason.${known ? reason : "other"}`;
}

/** A halt's `at` as a short local label; absent when the marker carried none. */
function formatAt(at: number | null, locale: string): string | null {
  if (at === null) return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The title and one-line explanation. Carries no state of its own. */
function HaltedHead({ t }: { t: TFunction<"popover"> }) {
  return (
    <div className="border-b border-border" style={{ padding: "14px 18px 12px" }}>
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-terracotta shrink-0" aria-hidden="true" />
        <h3
          className="font-heading font-bold text-charcoal"
          style={{ fontSize: "14px", letterSpacing: "-0.005em" }}
        >
          {t("site_status.halted.title")}
        </h3>
      </div>
      <p
        className="font-body text-fg-muted"
        style={{ fontSize: "12px", marginTop: "6px", lineHeight: 1.45 }}
      >
        {t("site_status.halted.body")}
      </p>
    </div>
  );
}

/** The reason, when it started, how legible the state is now, and the outcome. */
function HaltedBody({
  t,
  halt,
  since,
  stateUnreadable,
  isConvenor,
  outcome,
  haltedAgain,
  standing,
  observed,
}: {
  t: TFunction<"popover">;
  halt: HaltSnapshot | null;
  since: string | null;
  stateUnreadable: boolean;
  isConvenor: boolean;
  outcome: ResetOutcome | null;
  haltedAgain: boolean;
  /** Whether the halt these lines describe is one the latest read still reports. */
  standing: boolean;
  /** The generation of the latest read, shown with an unsettled outcome. */
  observed: number | null;
}) {
  return (
    <div style={{ padding: "12px 18px 14px" }}>
      {halt && standing && (
        <p
          className="font-body text-charcoal"
          style={{ fontSize: "12px", lineHeight: 1.45 }}
          data-testid="halted-reason"
        >
          {t(reasonKeyFor(halt.reason))}
        </p>
      )}
      {since && standing && (
        <p
          className="font-body text-fg-muted"
          style={{ fontSize: "12px", marginTop: "4px" }}
          data-testid="halted-since"
        >
          {t("site_status.halted.since", { time: since })}
        </p>
      )}
      {stateUnreadable && (
        <p
          className="font-body text-fg-muted"
          style={{ fontSize: "12px", marginTop: "4px" }}
          data-testid="halted-unreadable"
        >
          {t("site_status.halted.unreadable_state")}
        </p>
      )}
      <OutcomeLine
        outcome={outcome}
        haltedAgain={haltedAgain}
        stateUnreadable={stateUnreadable}
        halt={halt}
        observed={observed}
      />
      {isConvenor && (
        <p
          className="font-body text-fg-muted"
          style={{ fontSize: "12px", marginTop: "8px", lineHeight: 1.45 }}
        >
          {t("site_status.halted.restore_cost")}
        </p>
      )}
    </div>
  );
}

/** Check again for everyone; the restore for the convenor alone. */
function HaltedFooter({
  t,
  isConvenor,
  onCheckAgain,
  confirming,
  setConfirming,
  confirmedGeneration,
  projectId,
  submitting,
  onRestore,
}: {
  t: TFunction<"popover">;
  isConvenor: boolean;
  onCheckAgain: () => void;
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  confirmedGeneration: number | null;
  projectId: number | null;
  submitting: boolean;
  onRestore: (generation: number) => void;
}) {
  return (
    <div
      className="border-t border-border bg-cream flex items-center justify-between"
      style={{ padding: "11px 14px 12px", gap: "8px" }}
    >
      <button
        type="button"
        onClick={onCheckAgain}
        className="font-heading font-semibold inline-flex items-center gap-1 text-anil-ink hover:underline"
        style={{ fontSize: "12.5px" }}
        data-testid="halted-check-again"
      >
        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
        {t("site_status.halted.check_again")}
      </button>

      {isConvenor ? (
        <RestoreControl
          confirming={confirming}
          setConfirming={setConfirming}
          confirmedGeneration={confirmedGeneration}
          projectId={projectId}
          submitting={submitting}
          onRestore={onRestore}
        />
      ) : (
        <p className="font-body text-fg-muted" style={{ fontSize: "12px", lineHeight: 1.45 }}>
          {t("site_status.halted.ask_convenor")}
        </p>
      )}
    </div>
  );
}

export function PersistenceHaltedPopover({
  halt,
  stateUnreadable,
  confirmedGeneration,
  lastReadHalted,
  haltedAgain,
  outcome,
  submitting,
  userRole,
  onCheckAgain,
  onRestore,
  className = "",
}: PersistenceHaltedPopoverProps) {
  const { t, i18n } = useTranslation("popover");
  const [confirming, setConfirming] = useState(false);
  const isConvenor = userRole === "convenor";
  const since = formatAt(halt?.at ?? null, i18n.language);
  // A read that came back healthy retires the reason and the time: they name a
  // halt the object has stopped reporting.
  const standing = lastReadHalted !== false;

  return (
    <div className={className} data-testid="persistence-halted-popover">
      <HaltedHead t={t} />
      <HaltedBody
        t={t}
        halt={halt}
        since={since}
        stateUnreadable={stateUnreadable}
        isConvenor={isConvenor}
        outcome={outcome}
        haltedAgain={haltedAgain}
        standing={standing}
        observed={confirmedGeneration}
      />
      <HaltedFooter
        t={t}
        isConvenor={isConvenor}
        onCheckAgain={onCheckAgain}
        confirming={confirming}
        setConfirming={setConfirming}
        confirmedGeneration={confirmedGeneration}
        projectId={halt?.projectId ?? null}
        submitting={submitting}
        onRestore={onRestore}
      />
    </div>
  );
}

/** The line for a landed reset: whether the rebuild raised a halt of its own. */
function landedLine(
  t: TFunction<"popover">,
  haltedAgain: boolean,
  stateUnreadable: boolean,
  halt: HaltSnapshot | null,
): string {
  if (haltedAgain) {
    return t("site_status.halted.restored_halted_again", {
      reason: t(reasonKeyFor(halt?.reason ?? null)),
    });
  }
  // The unreadable notice has its own line in the body, and the reconnection
  // the long string promises is not something an unreadable state can claim.
  if (stateUnreadable) return t("site_status.halted.restored_short");
  return t("site_status.halted.restored");
}

/**
 * The line for one outcome.
 *
 * A landed reset is not a healthy project: the rebuilt document can raise a halt
 * of its own under the generation the reset advanced to, and a read above that
 * generation is what proves it. An uncertain reset stays uncertain whatever the
 * readback shows, because the generation moves before the rebuild.
 */
function outcomeLine(
  t: TFunction<"popover">,
  outcome: ResetOutcome,
  haltedAgain: boolean,
  stateUnreadable: boolean,
  halt: HaltSnapshot | null,
): string {
  switch (outcome.kind) {
    case "landed":
      return landedLine(t, haltedAgain, stateUnreadable, halt);
    case "stale":
      return t("site_status.halted.stale");
    case "retry":
      return t("site_status.halted.retry");
    case "uncertain":
      return t("site_status.halted.uncertain");
    case "failed":
      return t("site_status.halted.failed", { status: outcome.status });
    default:
      return "";
  }
}

/**
 * The two outcomes that ask the convenor to look at the state before trying
 * again are the two that have to say which state was looked at.
 */
function showsObserved(outcome: ResetOutcome, observed: number | null): boolean {
  return observed !== null && (outcome.kind === "stale" || outcome.kind === "uncertain");
}

/** What the last restore attempt did, and the state that was read after it. */
function OutcomeLine({
  outcome,
  haltedAgain,
  stateUnreadable,
  halt,
  observed,
}: {
  outcome: ResetOutcome | null;
  haltedAgain: boolean;
  stateUnreadable: boolean;
  halt: HaltSnapshot | null;
  observed: number | null;
}) {
  const { t } = useTranslation("popover");
  if (outcome === null) return null;

  return (
    <>
      <p
        className="font-body text-charcoal"
        style={{ fontSize: "12px", marginTop: "8px", lineHeight: 1.45 }}
        role="status"
        data-testid="halted-outcome"
        data-outcome={outcome.kind}
      >
        {outcomeLine(t, outcome, haltedAgain, stateUnreadable, halt)}
      </p>
      {showsObserved(outcome, observed) && (
        <p
          className="font-body text-fg-muted"
          style={{ fontSize: "12px", marginTop: "4px" }}
          data-testid="halted-observed"
        >
          {t("site_status.halted.observed", { generation: observed })}
        </p>
      )}
    </>
  );
}

/**
 * The two-step restore: the labelled button, then a confirm that carries the
 * project and the generation. Both are disabled while the action is in flight,
 * and the confirm is disabled while no generation the object confirmed is held.
 */
function RestoreControl({
  confirming,
  setConfirming,
  confirmedGeneration,
  projectId,
  submitting,
  onRestore,
}: {
  confirming: boolean;
  setConfirming: (v: boolean) => void;
  confirmedGeneration: number | null;
  projectId: number | null;
  submitting: boolean;
  onRestore: (generation: number) => void;
}) {
  const { t } = useTranslation("popover");
  const armed = confirmedGeneration !== null && !submitting;

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={submitting}
        className="font-heading font-semibold inline-flex items-center gap-1.5 bg-terracotta text-surface hover:bg-terracotta-deep transition-colors disabled:opacity-50"
        style={{
          fontSize: "11px",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "6px 14px",
          borderRadius: "9999px",
        }}
        data-testid="halted-restore"
      >
        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        {t("site_status.halted.restore_button")}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (confirmedGeneration === null) return;
        setConfirming(false);
        onRestore(confirmedGeneration);
      }}
      disabled={!armed}
      className="font-heading font-semibold inline-flex items-center gap-1.5 bg-terracotta text-surface hover:bg-terracotta-deep transition-colors disabled:opacity-50"
      style={{
        fontSize: "11px",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "6px 14px",
        borderRadius: "9999px",
      }}
      data-testid="halted-restore-confirm"
      data-project-id={projectId ?? ""}
      data-generation={confirmedGeneration ?? ""}
    >
      {t("site_status.halted.restore_confirm")}
    </button>
  );
}
