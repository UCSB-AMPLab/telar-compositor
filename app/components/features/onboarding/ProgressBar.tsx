/**
 * ProgressBar — horizontal numbered step indicator for the onboarding wizard.
 *
 * Shows 4 steps: Connect, Sync, Review, Done. Current step is highlighted with
 * anil bg. Completed steps show a green CheckCircle icon.
 */

import { CheckCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

type Step = "connect" | "sync" | "review" | "done";

interface ProgressBarProps {
  currentStep: Step;
  className?: string;
}

const STEPS: { key: Step; i18nKey: string }[] = [
  { key: "connect", i18nKey: "progress.connect" },
  { key: "sync", i18nKey: "progress.sync" },
  { key: "review", i18nKey: "progress.review" },
  { key: "done", i18nKey: "progress.done" },
];

const STEP_ORDER: Record<Step, number> = {
  connect: 1,
  sync: 2,
  review: 3,
  done: 4,
};

export function ProgressBar({ currentStep, className = "" }: ProgressBarProps) {
  const { t } = useTranslation("onboarding");
  const currentOrder = STEP_ORDER[currentStep];

  return (
    <nav aria-label="Onboarding progress" className={`flex items-center justify-between ${className}`}>
      {STEPS.map((step, index) => {
        const stepOrder = STEP_ORDER[step.key];
        const isCompleted = stepOrder < currentOrder;
        const isCurrent = step.key === currentStep;
        const isFuture = stepOrder > currentOrder;

        return (
          <div key={step.key} className="flex items-center flex-1">
            {/* Step indicator */}
            <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
              {/* Circle / number / checkmark */}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                  isCompleted
                    ? "bg-green-100"
                    : isCurrent
                    ? "bg-anil"
                    : "bg-gray-100"
                }`}
                aria-current={isCurrent ? "step" : undefined}
              >
                {isCompleted ? (
                  <CheckCircle className="w-5 h-5 text-green-600" />
                ) : (
                  <span
                    className={`font-heading font-semibold text-sm ${
                      isCurrent ? "text-charcoal" : isFuture ? "text-gray-400" : "text-charcoal"
                    }`}
                  >
                    {stepOrder}
                  </span>
                )}
              </div>

              {/* Label */}
              <span
                className={`font-heading text-sm whitespace-nowrap ${
                  isCompleted
                    ? "text-green-600"
                    : isCurrent
                    ? "text-charcoal font-semibold"
                    : "text-gray-400"
                }`}
              >
                {t(step.i18nKey)}
              </span>
            </div>

            {/* Connector line (not after last step) */}
            {index < STEPS.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-2 mb-5 transition-colors ${
                  stepOrder < currentOrder ? "bg-green-300" : "bg-gray-200"
                }`}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
