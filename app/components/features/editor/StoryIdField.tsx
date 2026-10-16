/**
 * The story's ID, in the story settings. Whoever may delete the story may
 * change it: the editor takes only the characters the framework accepts in a
 * story ID, the typed value is held to `storyIdProblem`, and an accepted one
 * first shows what changing it does to the story's address, with the change
 * made only on confirm. The route writes the new ID to the document.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";

import { LockedIdField } from "~/components/ui/LockedIdField";
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

/** What a story ID may hold: lowercase letters, digits, hyphen and underscore, with a space typed as a hyphen and an accented letter as its plain form. */
function filterStoryId(raw: string): string {
  return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

export function StoryIdField({ storyId, storyIds, canRename, onRename }: StoryIdFieldProps) {
  const { t } = useTranslation("editor");

  function storyIdMessage(candidate: string): string | null {
    const found = storyIdProblem(candidate, storyId, storyIds);
    if (found === null || found.code === "unchanged") return null;
    return t(REFUSAL_KEYS[found.code], { id: candidate });
  }

  return (
    <LockedIdField
      label={t("title_card.story_id_label")}
      inputId="story-id"
      value={storyId}
      canChange={canRename}
      addressNote={t("title_card.story_id_address", { id: storyId })}
      filterTyped={filterStoryId}
      problem={storyIdMessage}
      consequences={(candidate) => <p>{t("title_card.story_id_warning", { old: storyId, new: candidate })}</p>}
      onConfirm={onRename}
    />
  );
}
