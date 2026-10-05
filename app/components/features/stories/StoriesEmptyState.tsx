/**
 * The placeholder shown when a project has no stories yet — the first
 * thing an author sees on the Stories list before they have created
 * anything.
 *
 * Rather than leave the list blank, this gives the author somewhere to
 * start: an explanatory heading and description framing what a story is,
 * plus a single call-to-action button. The actual creation is owned by
 * the parent (via the onCreateNew callback) so this component stays a
 * pure presentational invitation with no knowledge of how a story comes
 * into being.
 *
 * @version v1.5.0-beta
 */

import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

interface StoriesEmptyStateProps {
  onCreateNew: () => void;
  /**
   * The shared document has not synced yet, so an empty list means "not loaded",
   * not "no stories". The invitation to create the first story is withheld.
   */
  awaitingSync?: boolean;
}

export function StoriesEmptyState({ onCreateNew, awaitingSync = false }: StoriesEmptyStateProps) {
  const { t } = useTranslation("stories");

  if (awaitingSync) {
    return (
      <div role="status" className="flex flex-col items-center justify-center py-20 text-center">
        <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse mb-3" aria-hidden="true" />
        <p className="font-body text-sm text-gray-500">{t("loading_state")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-full bg-anil flex items-center justify-center mb-4">
        <BookOpen className="w-6 h-6 text-charcoal" />
      </div>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
        {t("empty_state")}
      </h2>
      <p className="font-body text-sm text-gray-500 max-w-sm mb-6">
        {t("empty_state_description")}
      </p>
      <button
        type="button"
        onClick={onCreateNew}
        className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
      >
        {t("new_story_button")}
      </button>
    </div>
  );
}
