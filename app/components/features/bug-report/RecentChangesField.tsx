/**
 * This file renders the bug-report panel's optional recent-changes question:
 * a set of checkboxes naming things done to the repository outside the
 * Compositor that commonly lie behind a failure.
 *
 * "None of these" and "I'm not sure" each exclude every other answer:
 * choosing one clears the rest, and choosing any other answer clears them.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";
import { RECENT_CHANGES, type RecentChange } from "./build-issue-body";

const EXCLUSIVE: ReadonlySet<RecentChange> = new Set(["none", "unsure"]);

/** The selection after `change` is toggled in `selected`. */
export function toggleRecentChange(
  selected: ReadonlyArray<RecentChange>,
  change: RecentChange,
): RecentChange[] {
  if (selected.includes(change)) return selected.filter((c) => c !== change);
  if (EXCLUSIVE.has(change)) return [change];
  return [...selected.filter((c) => !EXCLUSIVE.has(c)), change];
}

/** i18n key of each answer's label. */
const LABEL_KEYS: Record<RecentChange, string> = {
  renamed: "recent_change_renamed",
  edited: "recent_change_edited",
  settings: "recent_change_settings",
  upgraded: "recent_change_upgraded",
  none: "recent_change_none",
  unsure: "recent_change_unsure",
};

interface RecentChangesFieldProps {
  selected: ReadonlyArray<RecentChange>;
  onChange: (next: RecentChange[]) => void;
}

export function RecentChangesField({ selected, onChange }: RecentChangesFieldProps) {
  const { t } = useTranslation("bug-report");
  return (
    <fieldset className="mt-4">
      <legend className="block font-heading text-sm text-charcoal">
        {t("recent_changes_label")}
      </legend>
      <div className="mt-1 space-y-1">
        {RECENT_CHANGES.map((change) => (
          <label
            key={change}
            className="flex items-start gap-2 font-body text-sm text-charcoal"
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(change)}
              onChange={() => onChange(toggleRecentChange(selected, change))}
            />
            <span>{t(LABEL_KEYS[change])}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-1">{t("recent_changes_why")}</p>
    </fieldset>
  );
}
