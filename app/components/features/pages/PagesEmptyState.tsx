/**
 * This file renders the empty-state card for the Pages editor — a
 * `FileText` icon in a anil circle, a heading, a description,
 * and a "+ New Page" button that calls the `onCreateNew` callback.
 *
 * Follows the `StoriesEmptyState` pattern exactly.
 *
 * When the user's Yjs page count is zero AND the connected repo
 * has importable pages, the parent route renders the sibling
 * `PagesRepoImportEmptyState` instead. Both variants share the
 * same outer layout, anil circle, `FileText` icon, and font
 * tokens so the screen feels like one empty state with an extra
 * import section.
 *
 * @version v1.3.0-beta
 */

import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

interface PagesEmptyStateProps {
  onCreateNew: () => void;
}

export function PagesEmptyState({ onCreateNew }: PagesEmptyStateProps) {
  const { t } = useTranslation("pages");

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-full bg-anil flex items-center justify-center mb-4">
        <FileText className="w-6 h-6 text-charcoal" />
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
        {t("new_page_button")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PagesRepoImportEmptyState — repo-import variant of the empty state.
// ---------------------------------------------------------------------------

export interface ImportablePage {
  slug: string;
  title: string;
}

interface PagesRepoImportEmptyStateProps {
  pages: ImportablePage[];
  onImportAll: () => void;
  onImportOne: (slug: string) => void;
  isImporting: boolean;
  importingSlugs: Set<string>;
}

/**
 * PagesRepoImportEmptyState — sibling of PagesEmptyState rendered when the
 * user's Yjs page count is zero AND the connected repo contains one or more
 * `telar-content/texts/pages/*.md` files.
 *
 * Reuses the anil circle, FileText icon, and font tokens from
 * PagesEmptyState so the screen feels like one empty state with an extra
 * import section. Each row has a per-page Import button; the primary CTA is
 * an "Import all" pill button reusing the same anil classes.
 *
 * No silent auto-import — every import requires an explicit click
 * .
 */
export function PagesRepoImportEmptyState({
  pages,
  onImportAll,
  onImportOne,
  isImporting,
  importingSlugs,
}: PagesRepoImportEmptyStateProps) {
  const { t } = useTranslation("pages");

  return (
    <div className="flex flex-col items-center py-20 text-center px-6">
      <div className="w-14 h-14 rounded-full bg-anil flex items-center justify-center mb-4">
        <FileText className="w-6 h-6 text-charcoal" />
      </div>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
        {t("repo_pages_found", { count: pages.length })}
      </h2>
      <p className="font-body text-sm text-gray-500 max-w-sm mb-6">
        {t("repo_pages_description")}
      </p>

      {/* Per-page list — rounded panel mirrors CommitAndBuildModal urlMismatch */}
      <ul className="w-full max-w-md mb-6 border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
        {pages.map((page) => {
          const rowImporting = importingSlugs.has(page.slug);
          return (
            <li key={page.slug} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="text-left min-w-0 flex-1">
                <p className="font-heading font-semibold text-sm text-charcoal truncate">
                  {page.title || page.slug}
                </p>
                <p className="font-mono text-xs text-gray-400 truncate">{page.slug}</p>
              </div>
              <button
                type="button"
                onClick={() => onImportOne(page.slug)}
                disabled={isImporting || rowImporting}
                className="shrink-0 font-heading font-semibold text-xs uppercase tracking-wider text-charcoal hover:bg-cream-dark border border-gray-200 rounded-full px-3 py-1 transition-colors disabled:opacity-40"
              >
                {rowImporting ? t("import_in_progress") : t("import_one_button")}
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={onImportAll}
        disabled={isImporting}
        className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors disabled:opacity-40"
      >
        {isImporting ? t("import_in_progress") : t("import_all_button")}
      </button>
    </div>
  );
}
