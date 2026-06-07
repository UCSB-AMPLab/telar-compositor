/**
 * PublishingStepper — the Publish-page in-progress tracker: a header (spinner +
 * "Building your site · step n of 7" + a Watch-on-GitHub link) over a horizontal
 * rail of 7 nodes (dispatch + the six real BUILD_PHASES). Pure presentation;
 * takes the already-resolved step model from resolvePublishSteps. Terminal
 * (published/failed) states are owned by the Publish page's success/failure
 * cards, so this component only renders the running state — a failed node is
 * still drawn if a phase fails mid-build before the page swaps to its card.
 *
 * @version v1.3.0-beta
 */

import { ArrowUpRight, Check, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PublishStep } from "~/components/features/site-status/build-phase-collapse";

export interface PublishingStepperProps {
  steps: PublishStep[];
  /** 1-based index of the active step, for the caption. */
  activeStep: number;
  totalSteps: number;
  /** GitHub Actions run URL for the Watch-on-GitHub link (null until known). */
  buildUrl?: string | null;
  className?: string;
}

export function PublishingStepper({
  steps,
  activeStep,
  totalSteps,
  buildUrl,
  className = "",
}: PublishingStepperProps) {
  const { t } = useTranslation("popover");

  return (
    <div className={`rounded-lg bg-anil-pale border border-anil px-5 py-4 ${className}`}>
      {/* Header: spinner + running caption + Watch on GitHub */}
      <div className="flex items-center justify-between gap-3 mb-5">
        <span className="font-heading font-semibold text-sm text-anil-ink inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
          {t("publishing.building", { step: activeStep, total: totalSteps })}
        </span>
        <a
          href={buildUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!buildUrl}
          onClick={(e) => {
            if (!buildUrl) e.preventDefault();
          }}
          className="font-heading font-semibold text-xs text-anil-ink inline-flex items-center gap-1 border border-anil bg-surface rounded-md px-2.5 py-1.5 whitespace-nowrap hover:underline"
        >
          {t("publishing.watch_github")}
          <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      </div>

      {/* Horizontal rail of 7 nodes */}
      <div className="flex items-start">
        {steps.map((step, i) => (
          <StepNode
            key={step.id}
            step={step}
            index={i}
            isLast={i === steps.length - 1}
            label={t(step.labelKey.replace(/^popover\./, ""))}
          />
        ))}
      </div>
    </div>
  );
}

function StepNode({
  step,
  index,
  isLast,
  label,
}: {
  step: PublishStep;
  index: number;
  isLast: boolean;
  label: string;
}) {
  const done = step.status === "completed";
  const active = step.status === "in_progress";
  const failed = step.status === "failed";

  const nodeTokens = done
    ? "bg-chilca text-surface"
    : failed
      ? "bg-terracotta text-surface"
      : active
        ? "bg-surface text-anil-deep border-2 border-anil-deep"
        : "bg-cream-dark text-fg-muted border border-border";

  const nodeStyle: React.CSSProperties = {
    width: "28px",
    height: "28px",
    borderRadius: "9999px",
    ...(active ? { boxShadow: "0 0 0 4px rgba(91,107,175,0.2)" } : {}),
  };

  // Connector to the NEXT node fills chilca only when THIS step is done.
  const connectorClass = done ? "bg-chilca" : "bg-cream-dark";

  const labelClass =
    done || active || failed
      ? "font-heading text-charcoal"
      : "font-heading text-fg-muted";

  return (
    <div className="relative flex flex-col items-center" style={{ flex: 1 }}>
      {!isLast && (
        <span
          aria-hidden="true"
          className={`absolute ${connectorClass}`}
          style={{ top: "13px", left: "50%", width: "100%", height: "2px" }}
        />
      )}
      <span
        data-step-node
        className={`relative z-10 flex items-center justify-center font-heading font-bold ${nodeTokens}`}
        style={nodeStyle}
        aria-hidden="true"
      >
        {done ? (
          <Check className="w-3.5 h-3.5" />
        ) : failed ? (
          <X className="w-3.5 h-3.5" />
        ) : active ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <span style={{ fontSize: "13px" }}>{index + 1}</span>
        )}
      </span>
      <span
        className={`text-center ${labelClass}`}
        style={{ fontSize: "11.5px", marginTop: "7px", maxWidth: "82px", lineHeight: 1.2 }}
      >
        {label}
      </span>
    </div>
  );
}
