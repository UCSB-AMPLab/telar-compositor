/**
 * The upgrade's offer to stop reading Google Sheets: where a
 * published tab has columns the 1.8.0 build would refuse, the author either
 * keeps Google Sheets, which stops the upgrade so the tabs can be fixed there,
 * or stops reading from it, so the tabs as they stood are saved to the
 * repository and repaired there. Also the confirmation's and the done screen's
 * account of that switch.
 *
 * @version v1.5.0-beta
 */
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import type { PreparedUpgradeContent } from "~/lib/upgrade-signing.server";
import type { TabsRefused } from "~/lib/upgrade-sheets.server";
import { SheetLineList } from "./UpgradeSheetReport";

export function UpgradeSheetsDecision({
  detail,
  notice,
  onSwitchOff,
  onKeep,
  className = "",
}: {
  detail: TabsRefused;
  notice: "sheets_changed" | null;
  onSwitchOff: () => void;
  onKeep: () => void;
  className?: string;
}) {
  const { t } = useTranslation("upgrade");
  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">{t("sheetsDecisionTitle")}</h2>
      {notice && (
        <p className="font-body text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
          {t("sheetsDecisionChanged")}
        </p>
      )}
      <p className="font-body text-sm text-charcoal mb-2">{t("sheetsDecisionIntro", { tabs: detail.tabs, count: detail.count })}</p>
      <SheetLineList items={detail.collisions.map((c) => `${c.tab}: ${c.columns.join(", ")}`)} className="text-charcoal mb-4" />
      <p className="font-body text-sm text-charcoal mb-2">{t("sheetsDecisionOffer")}</p>
      <p className="font-body text-sm text-charcoal mb-6">{t("sheetsDecisionKeepNote")}</p>
      <div className="flex justify-end gap-3">
        <Button variant="secondary" type="button" onClick={onKeep}>
          {t("sheetsDecisionKeep")}
        </Button>
        <Button variant="primary" type="button" onClick={onSwitchOff}>
          {t("sheetsDecisionSwitchOff")}
        </Button>
      </div>
    </div>
  );
}

/** The files a site that stops reading Google Sheets gets written and deleted; on the done screen, that it now publishes from the Compositor. */
export function UpgradeSheetsSwitch({ sheetsOff, done = false }: { sheetsOff: PreparedUpgradeContent["sheetsOff"]; done?: boolean }) {
  const { t } = useTranslation("upgrade");
  if (!sheetsOff) return null;
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  return (
    <div className="mb-6">
      <h3 className="font-heading font-semibold text-sm text-charcoal mb-2">{t("sheetsSwitchHeading")}</h3>
      {done && <p className="font-body text-sm text-charcoal mb-2">{t("sheetsSwitchedOffDone")}</p>}
      {sheetsOff.written.length > 0 && (
        <>
          <p className="font-body text-sm text-charcoal">{t("sheetsSwitchWritten")}</p>
          <SheetLineList items={sheetsOff.written.map(name)} className="text-charcoal mb-2" />
        </>
      )}
      {sheetsOff.deleted.length > 0 && (
        <>
          <p className="font-body text-sm text-charcoal">{t("sheetsSwitchDeleted")}</p>
          <SheetLineList items={sheetsOff.deleted.map(name)} className="text-charcoal" />
        </>
      )}
    </div>
  );
}
