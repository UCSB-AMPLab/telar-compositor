/**
 * ChecksMayBeBehindNotice — the line under the checks saying they may not
 * include the author's latest edits.
 *
 * Shown for a finished check whose snapshot of the document did not reach D1;
 * hidden while the page cannot read the site's state or the check itself
 * failed, since those pages say so in its place.
 *
 * Tailwind token classes only (no hardcoded hex).
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";

interface ChecksMayBeBehindNoticeProps {
  /** The latest answer to the checks request. */
  result: { ok: boolean; intent: string; snapshotOk?: boolean } | null | undefined;
  stateUnreadable: boolean;
  validationFailed: boolean;
}

export function ChecksMayBeBehindNotice({ result, stateUnreadable, validationFailed }: ChecksMayBeBehindNoticeProps) {
  const { t } = useTranslation("publish");
  if (stateUnreadable || validationFailed) return null;
  if (result?.ok !== true || result.intent !== "run-validation" || result.snapshotOk !== false) return null;
  return <p className="font-body text-sm text-charcoal/60 mt-3">{t("checks.may_be_behind")}</p>;
}
