/**
 * The story's ID on its title card. Whoever may delete the story may change
 * it: the typed value is held to `storyIdProblem`, and an accepted one first
 * shows what changing it does to the story's address, in a panel shaped like
 * the glossary's rename prompt, with the change made only on confirm. The
 * route writes the new ID to the document.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { storyIdProblem, type StoryIdProblem } from "~/lib/story-id";

interface StoryIdFieldProps {
  storyId: string;
  /** Every story's ID in the document, this one's included. */
  storyIds: readonly string[];
  canRename: boolean;
  onRename: (newId: string) => void;
}

type Refusal = Exclude<StoryIdProblem["code"], "unchanged">;

const REFUSAL_KEYS: Record<Refusal, string> = {
  invalid: "title_card.story_id_invalid",
  taken: "title_card.story_id_taken",
  reserved: "title_card.story_id_reserved",
};

export function StoryIdField({ storyId, storyIds, canRename, onRename }: StoryIdFieldProps) {
  const { t } = useTranslation("editor");
  const [value, setValue] = useState(storyId);
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ code: Refusal; id: string } | null>(null);

  function checkTypedStoryId() {
    const candidate = value.trim();
    const problem = storyIdProblem(candidate, storyId, storyIds);
    setPending(problem === null ? candidate : null);
    setRefusal(problem === null || problem.code === "unchanged" ? null : { code: problem.code, id: candidate });
  }

  function keepStoryId() {
    setPending(null);
    setValue(storyId);
  }

  function confirmStoryIdChange() {
    if (pending !== null) onRename(pending);
    setPending(null);
  }

  return (
    <div>
      <label htmlFor="story-id" className="font-body text-xs font-medium text-gray-500 uppercase tracking-wider">
        {t("title_card.story_id_label")}
      </label>
      {canRename ? (
        <input
          id="story-id"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={checkTypedStoryId}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="mt-1 block font-mono text-xs text-charcoal bg-surface rounded-md border border-gray-200 px-2.5 py-1.5 w-full max-w-xs"
        />
      ) : (
        <p className="mt-1 font-mono text-xs text-charcoal">{storyId}</p>
      )}
      {refusal && (
        <p role="alert" className="mt-2 font-body text-xs text-terracotta">
          {t(REFUSAL_KEYS[refusal.code], { id: refusal.id })}
        </p>
      )}
      {pending !== null && (
        <div role="group" className="mt-3 rounded-md bg-qolle-pale text-qolle-deep px-4 py-3">
          <p className="font-body text-sm mb-3">{t("title_card.story_id_warning", { old: storyId, new: pending })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirmStoryIdChange}
              className="font-heading font-semibold text-xs uppercase tracking-wider text-charcoal bg-anil hover:bg-anil-hover rounded-full px-3.5 py-1.5 transition-colors"
            >
              {t("title_card.story_id_confirm")}
            </button>
            <button
              type="button"
              onClick={keepStoryId}
              className="font-heading font-semibold text-xs uppercase tracking-wider text-qolle-deep border border-qolle-deep/30 rounded-full px-3.5 py-1.5 hover:bg-qolle-deep/10 transition-colors"
            >
              {t("title_card.story_id_keep", { old: storyId })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
