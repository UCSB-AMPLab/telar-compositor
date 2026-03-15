/**
 * StepDone — success confirmation step.
 *
 * Large green checkmark, success heading, and link to the dashboard.
 */

import { CheckCircle } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";

interface StepDoneProps {
  onDone: () => void;
  className?: string;
}

export function StepDone({ onDone: _onDone, className = "" }: StepDoneProps) {
  const { t } = useTranslation("onboarding");

  return (
    <div className={`flex flex-col items-center text-center py-8 ${className}`}>
      <CheckCircle className="w-16 h-16 text-green-500 mb-5" aria-hidden="true" />

      <h2 className="font-heading font-semibold text-2xl text-charcoal mb-2">
        {t("step_done.heading")}
      </h2>
      <p className="font-body text-sm text-gray-500 mb-8 max-w-sm">
        {t("step_done.description")}
      </p>

      <Link to="/dashboard">
        <Button variant="primary">
          {t("step_done.go_to_dashboard")}
        </Button>
      </Link>
    </div>
  );
}
