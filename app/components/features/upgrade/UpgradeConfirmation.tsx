/**
 * The upgrade's confirmation screen: what the commit will do to the
 * site's sheets and the answers its site will publish differently, shown
 * before anything changes, with the author's go-ahead or
 * cancel; on a site that reads Google Sheets, that its tabs were checked only
 * as they stood, or the files written and deleted where it stops reading
 * them. An upgrade with nothing to show here commits straight away.
 *
 * @version v1.5.0-beta
 */
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import type { SheetReportLine } from "~/lib/upgrade-sheets.server";
import type { PreparedUpgradeContent } from "~/lib/upgrade-signing.server";
import type { UpgradeAnswer } from "~/lib/upgrade-answers.server";
import { UpgradeAnswerList } from "./UpgradeAnswerList";
import { UpgradeSheetReport } from "./UpgradeSheetReport";
import { UpgradeSheetsSwitch } from "./UpgradeSheetsDecision";

export function UpgradeConfirmation({
  lines,
  answers,
  tabsChecked = false,
  sheetsOff = null,
  version,
  onConfirm,
  onCancel,
  className = "",
}: {
  lines: readonly SheetReportLine[];
  answers: readonly UpgradeAnswer[];
  tabsChecked?: boolean;
  sheetsOff?: PreparedUpgradeContent["sheetsOff"];
  version: string;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const { t } = useTranslation("upgrade");
  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">{t("confirmTitle")}</h2>
      <p className="font-body text-sm text-charcoal mb-4">{t("confirmIntro")}</p>
      {tabsChecked && <p className="font-body text-sm text-charcoal mb-4">{t("sheetsCheckedAsTheyStood")}</p>}
      <UpgradeSheetsSwitch sheetsOff={sheetsOff} />
      <UpgradeSheetReport lines={lines} />
      <UpgradeAnswerList answers={answers} />
      <div className="flex justify-end gap-3">
        <Button variant="secondary" type="button" onClick={onCancel}>
          {t("confirmCancel")}
        </Button>
        <Button variant="primary" type="button" onClick={onConfirm}>
          {t("confirmButton", { version })}
        </Button>
      </div>
    </div>
  );
}
