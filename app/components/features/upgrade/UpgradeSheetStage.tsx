/**
 * Where the Upgrade page's flow meets the sheet stage: the screens
 * between prepare and commit, and the done screen's account of the sheets, of
 * a switch away from Google Sheets, and of the answers the upgraded site
 * publishes differently.
 *
 * @version v1.5.0-beta
 */
import type { PreparedUpgrade, SignedUpgradeChallenge } from "~/lib/upgrade-signing.server";
import type { UpgradeAnswer } from "~/lib/upgrade-answers.server";
import { UpgradeAnswerList } from "./UpgradeAnswerList";
import type { ChoiceNotice, OfferedGroup, SheetReportLine, SubmittedChoice, TabsRefused } from "~/lib/upgrade-sheets.server";
import type { PreparedUpgradeContent } from "~/lib/upgrade-signing.server";
import { UpgradeColumnPicker } from "./UpgradeColumnPicker";
import { UpgradeConfirmation } from "./UpgradeConfirmation";
import { hasSheetReportLines, UpgradeSheetReport } from "./UpgradeSheetReport";
import { UpgradeSheetsDecision, UpgradeSheetsSwitch } from "./UpgradeSheetsDecision";
import { UpgradeSyncNeeded } from "./UpgradeSyncNeeded";

export type UpgradeFlowStage = "review" | "upgrading" | "choices" | "sheets" | "confirm" | "building" | "done";

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
 * Whether a prepared upgrade has something to show before it commits: a line
 * of its repair report, an answer, Google Sheets tabs checked only as they
 * stood, or the switch away from Google Sheets.
 */
export function needsConfirmation(prepared: PreparedUpgrade): boolean {
  return (
    hasSheetReportLines(prepared.sheetReport ?? []) ||
    (prepared.answers ?? []).length > 0 ||
    prepared.tabsChecked === true ||
    Boolean(prepared.sheetsOff)
  );
}

/**
 * The screens between prepare and commit: the column picker for a question,
 * the Google Sheets offer, the confirmation for a prepared upgrade with
 * something to show; nothing at any other stage.
 */
export function UpgradeSheetQuestion({
  stage,
  question,
  sheetsQuestion,
  awaitingConfirmation,
  onChoose,
  onCancelChoices,
  onSheetsAnswer,
  onConfirm,
  onCancelConfirmation,
}: {
  stage: UpgradeFlowStage;
  question: ChoiceQuestion | null;
  sheetsQuestion: SheetsQuestion | null;
  awaitingConfirmation: PreparedUpgrade | null;
  onChoose: (choices: SubmittedChoice[]) => void;
  onCancelChoices: () => void;
  onSheetsAnswer: (answer: "off" | "keep") => void;
  onConfirm: (prepared: PreparedUpgrade) => void;
  onCancelConfirmation: () => void;
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
  if (stage === "confirm" && awaitingConfirmation) {
    return (
      <UpgradeConfirmation
        lines={awaitingConfirmation.sheetReport}
        answers={awaitingConfirmation.answers ?? []}
        tabsChecked={awaitingConfirmation.tabsChecked === true}
        sheetsOff={awaitingConfirmation.sheetsOff ?? null}
        version={awaitingConfirmation.newVersion}
        onConfirm={() => onConfirm(awaitingConfirmation)}
        onCancel={onCancelConfirmation}
      />
    );
  }
  return null;
}

/** The done screen's account of the sheets: the sync line when one is needed, the switch from Google Sheets, the report, then the answers. */
export function UpgradeSheetOutcome({
  lines,
  syncNeeded,
  answers,
  sheetsOff = null,
}: {
  lines: SheetReportLine[];
  syncNeeded: boolean;
  answers: UpgradeAnswer[];
  sheetsOff?: PreparedUpgradeContent["sheetsOff"];
}) {
  return (
    <>
      {syncNeeded && <UpgradeSyncNeeded />}
      <UpgradeSheetsSwitch sheetsOff={sheetsOff} done />
      <UpgradeSheetReport lines={lines} />
      <UpgradeAnswerList answers={answers} />
    </>
  );
}
