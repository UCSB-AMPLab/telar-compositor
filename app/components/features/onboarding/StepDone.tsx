/**
 * StepDone — success confirmation step.
 *
 * Large green checkmark, success heading, and a link to Start (`/start`),
 * the page that walks a new site through its first steps.
 *
 * For sites created in the wizard (`created`), the copy reflects that the
 * compositor set the site up (not "imported"). The first-build note and the
 * site's own URL show only where the build was started (`buildStarted`) and
 * the setup was not skipped. Imported sites get the "imported successfully"
 * wording.
 *
 * After "Skip for now" on the settings check, the screen does not say the
 * setup is complete: it lists the settings left unfixed and where each is
 * fixed. Onboarding is still open on that screen; Continue completes it, and
 * the screen goes to Start once the completion is confirmed.
 *
 * @version v1.5.5-beta
 */

import { CheckCircle } from "lucide-react";
import { DoneContinue, DoneHeading, FirstBuildNote, UnfixedSettingsList } from "./StepDoneParts";

/** A setting the site-configuration check found wrong and the author chose to leave. */
export type UnfixedSetting = "sheets" | "pages" | "url";

interface StepDoneProps {
  onDone: () => void;
  /** True when the site was created in the wizard (vs. imported). */
  created?: boolean;
  /** The site's public URL — shown only on the created path, where it's authoritative. */
  siteUrl?: string;
  /** Settings the author skipped fixing; empty or absent when none were left. */
  unfixed?: readonly UnfixedSetting[];
  /** Asks the server to check the settings again; offered only while settings are left unfixed. */
  onRecheck?: () => void;
  /** The settings check is waiting on the server. */
  rechecking?: boolean;
  /** True only when the first build was started, which the first-build note claims. */
  buildStarted?: boolean;
  /** Completes onboarding when the author continues past skipped settings. */
  onContinue?: () => void;
  /** The completion is waiting on the server. */
  continuing?: boolean;
  /** The server confirmed the completion; the screen then goes to Start. */
  completed?: boolean;
  /** The server refused the completion. */
  continueFailed?: boolean;
  className?: string;
}

export function StepDone({
  onDone: _onDone,
  created = false,
  siteUrl,
  unfixed = [],
  onRecheck,
  rechecking = false,
  buildStarted = false,
  onContinue,
  continuing = false,
  completed = false,
  continueFailed = false,
  className = "",
}: StepDoneProps) {
  const skipped = unfixed.length > 0;

  return (
    <div className={`flex flex-col items-center text-center py-8 ${className}`}>
      <CheckCircle className="w-16 h-16 text-green-500 mb-5" aria-hidden="true" />

      <DoneHeading skipped={skipped} created={created} />

      <UnfixedSettingsList unfixed={unfixed} onRecheck={onRecheck} rechecking={rechecking} />

      <FirstBuildNote visible={created && buildStarted && !skipped} siteUrl={siteUrl} />

      <DoneContinue
        skipped={skipped}
        onContinue={onContinue}
        continuing={continuing}
        completed={completed}
        continueFailed={continueFailed}
      />
    </div>
  );
}
