/**
 * PublishingRows — the vertical 7-step publish list (the pill popover body):
 * dispatch + the six real BUILD_PHASES, stacked, plus the activeStep progress
 * bar. Pure presentation; takes already-resolved steps from resolvePublishSteps.
 *
 * @version v1.3.0-beta
 */

import { Check, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PublishStep } from "~/components/features/site-status/build-phase-collapse";

export interface PublishingRowsProps {
  steps: PublishStep[];
  /** 1-based index of the active step, for the progress-bar fill. */
  activeStep: number;
  totalSteps: number;
  className?: string;
}

export function PublishingRows({ steps, activeStep, totalSteps, className = "" }: PublishingRowsProps) {
  const { t } = useTranslation("popover");

  return (
    <div className={className}>
      <div className="flex flex-col" style={{ gap: "10px" }}>
        {steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            label={t(step.labelKey.replace(/^popover\./, ""))}
            activeWord={t("publishing.active")}
          />
        ))}
      </div>

      {/* Progress bar: track cream-dark, fill anil-deep, 4px tall */}
      <div
        className="bg-cream-dark overflow-hidden"
        style={{ height: "4px", borderRadius: "9999px", marginTop: "4px" }}
      >
        <div
          className="bg-anil-deep h-full"
          style={{ width: `${(activeStep / totalSteps) * 100}%`, borderRadius: "9999px" }}
        />
      </div>
    </div>
  );
}

function StepRow({
  step,
  label,
  activeWord,
}: {
  step: PublishStep;
  label: string;
  activeWord: string;
}) {
  const done = step.status === "completed";
  const active = step.status === "in_progress";
  const failed = step.status === "failed";

  const swatchTokens = done
    ? "bg-chilca text-surface"
    : failed
      ? "bg-terracotta text-surface"
      : active
        ? "bg-anil-pale text-anil-ink"
        : "bg-cream-dark text-fg-muted border border-border";

  const swatchStyle: React.CSSProperties = {
    width: "22px",
    height: "22px",
    borderRadius: "5px",
    ...(active ? { boxShadow: "0 0 0 3px rgba(91,107,175,0.18)" } : {}),
  };

  const labelClass =
    done || active || failed
      ? "font-heading font-semibold text-charcoal"
      : "font-heading text-fg-muted";

  return (
    <div data-phase-row className="flex items-center" style={{ gap: "9px", padding: "7px 0" }}>
      <span className={`flex items-center justify-center shrink-0 ${swatchTokens}`} style={swatchStyle} aria-hidden="true">
        {done ? <Check className="w-3.5 h-3.5" /> : failed ? <X className="w-3.5 h-3.5" /> : active ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
      </span>
      <span className={labelClass} style={{ fontSize: "12.5px", fontWeight: done || active || failed ? 600 : 400 }}>
        {label}
        {active ? ` · ${activeWord}` : ""}
      </span>
    </div>
  );
}
