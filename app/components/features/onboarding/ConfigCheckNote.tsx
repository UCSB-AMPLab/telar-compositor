/**
 * ConfigCheckNote — what the wizard says when the site-configuration check
 * did not run: GitHub could not be read (asked again, by itself and on
 * request), GitHub refused the Pages read (asked again on request, once the
 * permission is granted), or the site to check could not be found (nothing to
 * ask again).
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";
import { isUnreachableAnswer } from "~/lib/unreachable-write";

export type ConfigCheckNoteState = "unreachable" | "pages_refused" | "not_found" | null;

/** The note an answer to the check calls for; none while the check is running. */
export function configCheckNoteState(answer: unknown, running: boolean): ConfigCheckNoteState {
  const failed = answer as { ok?: boolean; reason?: string } | null | undefined;
  if (running || !failed || failed.ok !== false) return null;
  if (isUnreachableAnswer(answer)) return "unreachable";
  return failed.reason ? "pages_refused" : "not_found";
}

const NOTE_KEY = {
  unreachable: "site_config.check_failed",
  pages_refused: "site_config.check_pages_refused",
  not_found: "site_config.check_not_found",
} as const;

export function ConfigCheckNote({ state, onRetry }: { state: ConfigCheckNoteState; onRetry: () => void }) {
  const { t } = useTranslation("onboarding");
  if (!state) return null;
  return (
    <div role="status" className="font-body text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-6">
      <p>{t(NOTE_KEY[state])}</p>
      {state !== "not_found" && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 font-heading font-semibold text-sm underline underline-offset-2 hover:text-amber-950"
        >
          {t("site_config.check_retry")}
        </button>
      )}
    </div>
  );
}
