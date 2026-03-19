/**
 * PublishProgressBar — 3-step wizard progress indicator for the Publish page.
 *
 * Steps: Review, Checks, Publish. Completed steps show a green CheckCircle.
 * Current step is highlighted with periwinkle bg.
 */

import { CheckCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export type PublishStep = "review" | "checks" | "publish";

interface PublishProgressBarProps {
  currentStep: PublishStep;
  className?: string;
}

const STEPS: { key: PublishStep; i18nKey: string }[] = [
  { key: "review", i18nKey: "progress.review" },
  { key: "checks", i18nKey: "progress.checks" },
  { key: "publish", i18nKey: "progress.publish" },
];

const STEP_ORDER: Record<PublishStep, number> = {
  review: 1,
  checks: 2,
  publish: 3,
};

export function PublishProgressBar({ currentStep, className = "" }: PublishProgressBarProps) {
  const { t } = useTranslation("publish");
  const currentOrder = STEP_ORDER[currentStep];

  return (
    <nav aria-label="Publish wizard progress" className={`flex items-center justify-between ${className}`}>
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
                    ? "bg-periwinkle"
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
