/**
 * PageLanguageChoice — the publish page's question for each page held in
 * more than one language: which version to keep.
 *
 * One block per page, naming its files, with one choice per version and none
 * chosen to begin with: the publish waits until every page has one. A version
 * other than the page's own says that the page takes its text and its file
 * is deleted, since the page keeps its own file name and address.
 *
 * Tailwind token classes only (no hardcoded hex).
 *
 * @version v1.5.5-beta
 */

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { listOf } from "~/lib/page-language-names";
import type { PageLanguageChoices, PageLanguageGroup, PageLanguageVersion } from "~/lib/page-language-choice";

interface PageLanguageChoiceProps {
  groups: readonly PageLanguageGroup[];
  choices: PageLanguageChoices;
  /** The kept file chosen for the page whose own file is `pageFile`. */
  onChoose: (pageFile: string, keptFile: string) => void;
  disabled?: boolean;
  className?: string;
}

function GroupChoice({ group, chosen, onChoose, disabled }: {
  group: PageLanguageGroup;
  chosen: string | undefined;
  onChoose: (keptFile: string) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation("publish");
  const id = useId();
  const versions: PageLanguageVersion[] = [group.page, ...group.others];
  const page = group.page.title || group.page.file;
  const files = listOf(versions.map((v) => v.file), i18n?.language ?? "en");
  const two = versions.length === 2;
  return (
    <div
      role="group"
      aria-labelledby={`${id}-heading`}
      data-testid={`page-language-${group.page.file}`}
      className="rounded-lg bg-white border border-amber-300 border-l-4 px-4 py-3"
    >
      <p id={`${id}-heading`} className="font-heading font-semibold text-sm text-charcoal">
        {two ? t("language_choice.heading", { page }) : t("language_choice.heading_more", { page, number: versions.length })}
      </p>
      <p className="mt-1 font-body text-sm text-charcoal/80">
        {two ? t("language_choice.body", { files }) : t("language_choice.body_more", { files, number: versions.length })}
      </p>
      <div className="mt-2 space-y-2">
        {versions.map((version) => {
          const inputId = `${id}-${version.file}`;
          const note = version === group.page ? null : t("language_choice.keep_other_note", { page: group.page.file, file: version.file });
          return (
            <div key={version.file} className="flex items-start gap-2">
              <input
                id={inputId}
                type="radio"
                name={id}
                value={version.file}
                checked={chosen === version.file}
                onChange={() => onChoose(version.file)}
                disabled={disabled}
                aria-describedby={note ? `${inputId}-note` : undefined}
                className="accent-terracotta mt-1 cursor-pointer"
              />
              <div>
                <label htmlFor={inputId} className="block font-body text-sm text-charcoal cursor-pointer">
                  {t("language_choice.keep", { file: version.file })}
                  {version.title && <span className="text-charcoal/60"> · {version.title}</span>}
                </label>
                {note && (
                  <p id={`${inputId}-note`} className="font-body text-xs text-charcoal/60">{note}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PageLanguageChoice({ groups, choices, onChoose, disabled, className = "" }: PageLanguageChoiceProps) {
  if (groups.length === 0) return null;
  return (
    <div className={`space-y-3 ${className}`}>
      {groups.map((group) => (
        <GroupChoice
          key={group.page.file}
          group={group}
          chosen={choices[group.page.file]}
          onChoose={(keptFile) => onChoose(group.page.file, keptFile)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
