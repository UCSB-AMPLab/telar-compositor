/**
 * StepDone — success confirmation step.
 *
 * Large green checkmark, success heading, and a link to Site settings
 * (`/config`). Onboarding owns workflow education and deposits the
 * user on Site settings, where the "next: add your first object →" hint
 * lives.
 *
 * For sites created in the wizard (`created`), the copy reflects that the
 * compositor set the site up (not "imported") and that the first public
 * build is still running, with the site's own URL surfaced. Imported sites
 * keep the original "imported successfully" wording.
 *
 * @version v1.4.0-beta
 */

import { CheckCircle } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";

interface StepDoneProps {
  onDone: () => void;
  /** True when the site was created in the wizard (vs. imported). */
  created?: boolean;
  /** The site's public URL — shown only on the created path, where it's authoritative. */
  siteUrl?: string;
  className?: string;
}

export function StepDone({ onDone: _onDone, created = false, siteUrl, className = "" }: StepDoneProps) {
  const { t } = useTranslation("onboarding");

  return (
    <div className={`flex flex-col items-center text-center py-8 ${className}`}>
      <CheckCircle className="w-16 h-16 text-green-500 mb-5" aria-hidden="true" />

      <h2 className="font-heading font-semibold text-2xl text-charcoal mb-2">
        {t("step_done.heading")}
      </h2>
      <p className="font-body text-sm text-gray-500 mb-6 max-w-sm">
        {t(created ? "step_done.created_description" : "step_done.description")}
      </p>

      {created && siteUrl && (
        <div className="mb-8 max-w-sm rounded-lg bg-cream-dark/60 px-4 py-3">
          <p className="font-body text-xs text-gray-500 mb-1">
            {t("step_done.first_build_note")}
          </p>
          <span className="font-body text-sm text-charcoal break-all">{siteUrl}</span>
        </div>
      )}

      <Link to="/config">
        <Button variant="primary">
          {t("step_done.go_to_settings")}
        </Button>
      </Link>
    </div>
  );
}
