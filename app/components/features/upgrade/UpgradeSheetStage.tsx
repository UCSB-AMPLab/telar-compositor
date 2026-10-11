/**
 * Where the Upgrade page's flow meets the sheet stage: the questions prepare
 * asks before it can commit, and the done screen's account of the sheets, of
 * a switch away from Google Sheets, and of the answers the upgraded site
 * publishes differently.
 *
 * @version v1.5.3-beta
 */
import { useTranslation } from "react-i18next";
import type { SignedUpgradeChallenge } from "~/lib/upgrade-signing.server";
import type { UpgradeAnswer } from "~/lib/upgrade-answers.server";
import { UpgradeAnswerList } from "./UpgradeAnswerList";
import type { ChoiceNotice, OfferedGroup, SheetReportLine, SubmittedChoice, TabsRefused } from "~/lib/upgrade-sheets.server";
import type { PreparedUpgradeContent } from "~/lib/upgrade-signing.server";
import { UpgradeColumnPicker } from "./UpgradeColumnPicker";
import { UpgradeSheetReport } from "./UpgradeSheetReport";
import { UpgradeSheetsDecision, UpgradeSheetsSwitch } from "./UpgradeSheetsDecision";
import { UpgradeSyncNeeded } from "./UpgradeSyncNeeded";

export type UpgradeFlowStage = "review" | "upgrading" | "choices" | "sheets" | "building" | "done";

/** The offer to stop reading Google Sheets, as prepare made it. */
export interface SheetsQuestion {
  challenge: SignedUpgradeChallenge;
  detail: TabsRefused;
  notice: "sheets_changed" | null;
}

/** A question prepare asked, as the column picker shows it. */
export interface ChoiceQuestion {
  challenge: SignedUpgradeChallenge;
  groups: OfferedGroup[];
  notice: ChoiceNotice | null;
}

/**
 * The questions between prepare and commit: the column picker, and the Google
 * Sheets offer; nothing at any other stage. A prepared upgrade commits
 * without a further screen, because the review screen has already listed
 * what it changes and everything else is reported once it lands.
 */
export function UpgradeSheetQuestion({
  stage,
  question,
  sheetsQuestion,
  onChoose,
  onCancelChoices,
  onSheetsAnswer,
}: {
  stage: UpgradeFlowStage;
  question: ChoiceQuestion | null;
  sheetsQuestion: SheetsQuestion | null;
  onChoose: (choices: SubmittedChoice[]) => void;
  onCancelChoices: () => void;
  onSheetsAnswer: (answer: "off" | "keep") => void;
}) {
  if (stage === "sheets" && sheetsQuestion) {
    return (
      <UpgradeSheetsDecision
        detail={sheetsQuestion.detail}
        notice={sheetsQuestion.notice}
        onSwitchOff={() => onSheetsAnswer("off")}
        onKeep={() => onSheetsAnswer("keep")}
      />
    );
  }
  if (stage === "choices" && question) {
    return (
      <UpgradeColumnPicker groups={question.groups} notice={question.notice} onSubmit={onChoose} onCancel={onCancelChoices} />
    );
  }
  return null;
}

/**
 * The done screen's account of the sheets: the sync line when one is needed,
 * the switch from Google Sheets, that the Google Sheets tabs were checked only
 * as they stood, the report, then the answers.
 */
export function UpgradeSheetOutcome({
  lines,
  syncNeeded,
  answers,
  sheetsOff = null,
  tabsChecked = false,
}: {
  lines: SheetReportLine[];
  syncNeeded: boolean;
  answers: UpgradeAnswer[];
  sheetsOff?: PreparedUpgradeContent["sheetsOff"];
  tabsChecked?: boolean;
}) {
  const { t } = useTranslation("upgrade");
  return (
    <>
      {syncNeeded && <UpgradeSyncNeeded />}
      <UpgradeSheetsSwitch sheetsOff={sheetsOff} done />
      {tabsChecked && <p className="font-body text-sm text-charcoal mb-4">{t("sheetsCheckedAsTheyStood")}</p>}
      <UpgradeSheetReport lines={lines} />
      <UpgradeAnswerList answers={answers} />
    </>
  );
}
