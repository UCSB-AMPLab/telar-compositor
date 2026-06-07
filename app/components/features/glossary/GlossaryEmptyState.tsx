/**
 * GlossaryEmptyState — the first-time empty state for the Glossary editor.
 *
 * Shown when a project has no glossary terms yet. It introduces the feature
 * with a single clear action rather than a wall of explanation: a BookA icon
 * inside an anil-pale halo, intro copy that surfaces the `[[term_id]]`
 * reference syntax as an inline code chip, and one "New term" call to action.
 */

import { BookA } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

interface GlossaryEmptyStateProps {
  onCreateNew: () => void;
}

export function GlossaryEmptyState({ onCreateNew }: GlossaryEmptyStateProps) {
  const { t } = useTranslation("glossary");

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-full bg-anil-pale flex items-center justify-center mb-4">
        <BookA className="w-6 h-6 text-charcoal" />
      </div>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
        {t("empty_title")}
      </h2>
      <p className="font-body text-sm text-fg-muted max-w-sm mb-6">
        {/* The [[term_id]] token renders as an inline code chip. */}
        <Trans
          t={t}
          i18nKey="empty_body"
          components={{
            chip: (
              <code className="font-mono text-xs text-charcoal bg-cream-dark rounded px-1 py-0.5" />
            ),
          }}
        />
      </p>
      <button
        type="button"
        onClick={onCreateNew}
        className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
      >
        {t("empty_cta")}
      </button>
    </div>
  );
}
