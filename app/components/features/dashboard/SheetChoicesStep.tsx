/**
 * The column picker where the sync or the orphan restore found a sheet with
 * columns Telar reads as one field, more than one of them holding values.
 * The choice goes to the /dashboard action's `choose-columns`,
 * which commits the repaired sheets to the repository; `onChosen` then runs
 * the sync or the restore again. Sheets that changed while the author chose
 * come back as a fresh question, with the picker's notice saying so. The
 * objects page, whose sync dialog has no step for it, shows it in a dialog of
 * its own (`SheetChoicesDialog`).
 *
 * @version v1.5.0-beta
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSiteFetcher } from "~/lib/page-site";
import { Dialog } from "~/components/ui/Dialog";
import { UpgradeColumnPicker } from "~/components/features/upgrade/UpgradeColumnPicker";
import type { ChooseColumnsAnswer, SheetChoicesQuestion } from "~/lib/sheet-choices.server";
import type { SubmittedChoice } from "~/lib/upgrade-sheets.server";

export type { SheetChoicesQuestion };

/** The picker's question in an action's answer, where it refused a sheet for columns read as one field. */
export function choicesQuestionOf(answer: { ok: boolean; error?: string }): SheetChoicesQuestion | null {
  return !answer.ok && answer.error === "needs_choices" && "challenge" in answer ? (answer as unknown as SheetChoicesQuestion) : null;
}

export function SheetChoicesStep({
  question,
  onChosen,
  onCancel,
  className = "",
}: {
  question: SheetChoicesQuestion;
  onChosen: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const { t } = useTranslation("upgrade");
  const fetcher = useSiteFetcher<ChooseColumnsAnswer>();
  const [current, setCurrent] = useState(question);
  const [notApplied, setNotApplied] = useState<string | null>(null);
  const answer = fetcher.data;

  useEffect(() => {
    if (fetcher.state !== "idle" || !answer) return;
    if (answer.ok) onChosen();
    else if (answer.error === "needs_choices") setCurrent(answer);
    else setNotApplied(answer.sheet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, fetcher.state]);

  function submitColumnChoices(choices: SubmittedChoice[]) {
    setNotApplied(null);
    fetcher.submit(
      { intent: "choose-columns", sheet_challenge: current.challenge, sheet_choices: JSON.stringify(choices) },
      { method: "post", action: "/dashboard" },
    );
  }

  return (
    <div className={className}>
      {notApplied !== null && (
        <p role="alert" className="font-body text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
          {t("columnPickerNotApplied", { sheet: notApplied })}
        </p>
      )}
      <UpgradeColumnPicker
        groups={current.groups}
        notice={current.notice}
        intro={t("columnPickerIntroSite")}
        onSubmit={submitColumnChoices}
        onCancel={onCancel}
      />
    </div>
  );
}

/** The picker in a dialog of its own, for a page whose sync has no step to show it in; nothing without a question. */
export function SheetChoicesDialog({
  question,
  onChosen,
  onClose,
}: {
  question: SheetChoicesQuestion | null;
  onChosen: () => void;
  onClose: () => void;
}) {
  if (!question) return null;
  return (
    <Dialog open onClose={onClose} className="w-full max-w-2xl p-0 overflow-hidden">
      <SheetChoicesStep question={question} onChosen={onChosen} onCancel={onClose} />
    </Dialog>
  );
}
