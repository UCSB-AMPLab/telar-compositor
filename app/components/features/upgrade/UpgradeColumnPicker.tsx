/**
 * The upgrade's column picker: where a sheet has more than one
 * column that Telar reads as the same field and more than one of them holds
 * values, the author chooses the column to keep in each group, and the
 * upgrade deletes the others; the sync, the first import and the orphan
 * restore show it too, with their own `intro`. Columns are named by their position in the
 * sheet as first read, which is what the server replays.
 *
 * @version v1.5.0-beta
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import type { ChoiceNotice, OfferedGroup, SubmittedChoice } from "~/lib/upgrade-sheets.server";

const NOTICE_KEYS: Record<ChoiceNotice, string> = {
  sheets_changed: "columnPickerSheetsChanged",
  further_choices: "columnPickerFurther",
  choice_needed: "columnPickerChoiceNeeded",
};

function groupKey(group: OfferedGroup): string {
  return `${group.file}|${group.positions.join(",")}`;
}

function PickerGroup({
  group,
  keep,
  onChoose,
}: {
  group: OfferedGroup;
  keep: number | undefined;
  onChoose: (position: number) => void;
}) {
  const { t } = useTranslation("upgrade");
  return (
    <fieldset className="border border-gray-200 rounded-lg p-4">
      <legend className="font-heading font-semibold text-sm text-charcoal px-1">
        {t("columnPickerGroup", { sheet: group.sheet, field: group.claim })}
      </legend>
      {group.needsChoice && <p className="font-body text-sm text-amber-900 mb-2">{t("columnPickerNeedsChoice")}</p>}
      <div className="flex flex-col gap-3">
        {group.columns.map((column) => (
          <label key={column.position} className="flex items-start gap-2 font-body text-sm text-charcoal">
            <input
              type="radio"
              name={groupKey(group)}
              checked={keep === column.position}
              onChange={() => onChoose(column.position)}
              className="mt-1"
            />
            <span>
              <span className="font-semibold">
                {t("columnPickerColumn", { position: String(column.position + 1), header: column.header })}
              </span>
              <span className="block text-gray-600">
                {column.values.length > 0
                  ? t("columnPickerValues", { values: column.values.join(", ") })
                  : t("columnPickerEmpty")}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function UpgradeColumnPicker({
  groups,
  notice,
  onSubmit,
  onCancel,
  intro,
  className = "",
}: {
  groups: OfferedGroup[];
  notice: ChoiceNotice | null;
  /** What choosing does where the picker is shown; the upgrade's own text by default. */
  intro?: string;
  onSubmit: (choices: SubmittedChoice[]) => void;
  onCancel: () => void;
  className?: string;
}) {
  const { t } = useTranslation("upgrade");
  // The choices belong to the groups they were made in: a fresh question (the
  // sheets changed, or more groups came up) starts with nothing chosen, even
  // where its groups name the same columns.
  const [choices, setChoices] = useState<{ groups: OfferedGroup[]; kept: Record<string, number> }>({ groups, kept: {} });
  const kept = choices.groups === groups ? choices.kept : {};
  const setKept = (update: (current: Record<string, number>) => Record<string, number>) =>
    setChoices({ groups, kept: update(kept) });
  const complete = groups.every((group) => kept[groupKey(group)] !== undefined);

  function submitChoices() {
    onSubmit(groups.map((group) => ({ file: group.file, positions: group.positions, keep: kept[groupKey(group)] })));
  }

  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">{t("columnPickerTitle")}</h2>
      {notice && (
        <p className="font-body text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
          {t(NOTICE_KEYS[notice])}
        </p>
      )}
      <p className="font-body text-sm text-charcoal mb-4">{intro ?? t("columnPickerIntro")}</p>
      <div className="flex flex-col gap-4 mb-6">
        {groups.map((group) => (
          <PickerGroup
            key={groupKey(group)}
            group={group}
            keep={kept[groupKey(group)]}
            onChoose={(position) => setKept((current) => ({ ...current, [groupKey(group)]: position }))}
          />
        ))}
      </div>
      <div className="flex justify-end gap-3">
        <Button variant="secondary" type="button" onClick={onCancel}>
          {t("columnPickerCancel")}
        </Button>
        <Button variant="primary" type="button" onClick={submitChoices} disabled={!complete}>
          {t("columnPickerContinue")}
        </Button>
      </div>
    </div>
  );
}
