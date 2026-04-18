/**
 * GlossaryEmptyState — empty state for the Glossary editor.
 *
 * Shows a BookMarked icon in a periwinkle circle, a heading, a description,
 * and a "+ New Term" button that calls the onCreateNew callback.
 */

import { BookMarked } from "lucide-react";
import { useTranslation } from "react-i18next";

interface GlossaryEmptyStateProps {
  onCreateNew: () => void;
}

export function GlossaryEmptyState({ onCreateNew }: GlossaryEmptyStateProps) {
  const { t } = useTranslation("glossary");

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-full bg-periwinkle flex items-center justify-center mb-4">
        <BookMarked className="w-6 h-6 text-charcoal" />
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
        className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
      >
        {t("new_term_button")}
      </button>
    </div>
  );
}
