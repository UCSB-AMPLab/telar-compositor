/**
 * RenameImpactPanel — the slug-aware rename impact prompt.
 *
 * An inline `qolle-pale` panel rendered below the Term ID field ONLY when the
 * effective slug changes AND existing `[[old]]` links point to it
 * (`count > 0`). It asks whether to rewrite those links to the new slug:
 *
 *   "{count} links point to {old}. Update them to {new} too?"
 *   [ Update links ]   [ Keep slug as {old} ]
 *
 * Two buttons ONLY — there is no dismiss/abort control (brief rule: the author
 * can also just keep typing). `onUpdate` runs the one-transaction
 * `rewriteGlossaryLinks`;
 * `onKeep` leaves existing links untouched and applies the slug to this term
 * alone. Pure presentation — the route owns the Yjs writes.
 *
 * @version v1.3.0-beta
 */

import { useTranslation } from "react-i18next";

interface RenameImpactPanelProps {
  /** Occurrence count of `[[old]]` across the three link-bearing surfaces. */
  count: number;
  /** The current (old) slug the links point to. */
  oldId: string;
  /** The new slug the term is being renamed to. */
  newId: string;
  /** Rewrite every `[[old]]`→`[[new]]` in one transaction. */
  onUpdate: () => void;
  /** Keep existing links untouched; apply the slug to this term only. */
  onKeep: () => void;
  className?: string;
}

export function RenameImpactPanel({
  count,
  oldId,
  newId,
  onUpdate,
  onKeep,
  className = "",
}: RenameImpactPanelProps) {
  const { t } = useTranslation("glossary");

  return (
    <div
      className={`mt-3 rounded-md bg-qolle-pale text-qolle-deep px-4 py-3 ${className}`}
      role="group"
    >
      <p className="font-body text-sm mb-3">
        {t("rename_prompt", { count, old: oldId, new: newId })}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onUpdate}
          className="font-heading font-semibold text-xs uppercase tracking-wider text-charcoal bg-anil hover:bg-anil-hover rounded-full px-3.5 py-1.5 transition-colors"
        >
          {t("rename_update")}
        </button>
        <button
          type="button"
          onClick={onKeep}
          className="font-heading font-semibold text-xs uppercase tracking-wider text-qolle-deep border border-qolle-deep/30 rounded-full px-3.5 py-1.5 hover:bg-qolle-deep/10 transition-colors"
        >
          {t("rename_keep", { old: oldId })}
        </button>
      </div>
    </div>
  );
}
