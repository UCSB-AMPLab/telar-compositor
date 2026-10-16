/**
 * StepDoneParts — the pieces of the onboarding done screen: the heading and
 * description, the first-build note with the site's address, the list of
 * settings left unfixed after "Skip for now" on the settings check with its
 * recheck button, and the button to Start. After a skip that button completes
 * onboarding first and goes to Start once the completion is confirmed.
 *
 * @version v1.5.5-beta
 */

import { useEffect } from "react";
import { useNavigate, useNavigation } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import type { UnfixedSetting } from "./StepDone";

/** The line for each unfixed setting, keyed so every catalogue key is written out. */
const UNFIXED_LINE_KEYS: Record<UnfixedSetting, string> = {
  sheets: "step_done.unfixed_sheets",
  pages: "step_done.unfixed_pages",
  url: "step_done.unfixed_url",
};

interface UnfixedSettingsListProps {
  unfixed: readonly UnfixedSetting[];
  onRecheck?: () => void;
  rechecking: boolean;
}

/** The settings left unfixed, and the button that checks them again. */
export function UnfixedSettingsList({ unfixed, onRecheck, rechecking }: UnfixedSettingsListProps) {
  const { t } = useTranslation("onboarding");
  if (unfixed.length === 0) return null;
  return (
    <>
      <ul className="mb-8 max-w-md space-y-3 text-left" data-testid="unfixed-settings">
        {unfixed.map((setting) => (
          <li key={setting} className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 font-body text-sm text-amber-900">
            {t(UNFIXED_LINE_KEYS[setting])}
          </li>
        ))}
      </ul>
      {onRecheck && (
        <Button variant="secondary" onClick={onRecheck} loading={rechecking} className="mb-4">
          {t("step_done.recheck")}
        </Button>
      )}
    </>
  );
}

interface DoneContinueProps {
  skipped: boolean;
  onContinue?: () => void;
  continuing: boolean;
  completed: boolean;
  continueFailed: boolean;
}

/** The refusal line and the button to Start; with skipped settings the button completes onboarding first. */
export function DoneContinue({ skipped, onContinue, continuing, completed, continueFailed }: DoneContinueProps) {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();
  // Onboarding sits outside the app layout and its loading overlay, and Start
  // can take seconds to load: the button shows that it is working, and a second
  // press cannot restart the load.
  const opening = useNavigation().location?.pathname === "/start";
  // Skipped settings leave onboarding open: Continue completes it.
  const completesOnContinue = skipped && onContinue !== undefined;

  useEffect(() => {
    if (completesOnContinue && completed) navigate("/start");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completesOnContinue, completed]);

  return (
    <>
      {completesOnContinue && continueFailed && (
        <p role="alert" className="mb-4 max-w-sm font-body text-sm text-red-700">
          {t("step_done.continue_failed")}
        </p>
      )}
      <Button
        variant="primary"
        loading={opening || (completesOnContinue && (continuing || completed))}
        onClick={() => (completesOnContinue ? onContinue?.() : navigate("/start"))}
      >
        {t("step_done.go_to_start")}
      </Button>
    </>
  );
}

/** The heading and description; skipped settings change both, and a created site has its own description. */
export function DoneHeading({ skipped, created }: { skipped: boolean; created: boolean }) {
  const { t } = useTranslation("onboarding");
  return (
    <>
      <h2 className="font-heading font-semibold text-2xl text-charcoal mb-2">
        {t(skipped ? "step_done.heading_skipped" : "step_done.heading")}
      </h2>
      <p className="font-body text-sm text-gray-500 mb-6 max-w-sm">
        {t(skipped ? "step_done.description_skipped" : created ? "step_done.created_description" : "step_done.description")}
      </p>
    </>
  );
}

/** The first-build note with the site's own address; shown only when the caller says the build was started. */
export function FirstBuildNote({ visible, siteUrl }: { visible: boolean; siteUrl?: string }) {
  const { t } = useTranslation("onboarding");
  if (!visible || !siteUrl) return null;
  return (
    <div className="mb-8 max-w-sm rounded-lg bg-cream-dark/60 px-4 py-3">
      <p className="font-body text-xs text-gray-500 mb-1">
        {t("step_done.first_build_note")}
      </p>
      <span className="font-body text-sm text-charcoal break-all">{siteUrl}</span>
    </div>
  );
}
