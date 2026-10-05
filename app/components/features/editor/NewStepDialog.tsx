/**
 * The keep-or-choose dialog, shown once for a step that was seeded from the
 * step before it.
 *
 * A new step starts from the object, page and position of the last step that
 * used one, which is right often enough to be the default and wrong often
 * enough to be asked about; the two answers are keeping the inherited object or
 * picking another. Dismissing counts as keeping, because the seed is already
 * written and the dialog only offers to replace it, and the explicit close
 * control follows the same path as Escape and the backdrop.
 *
 * The dialog is a named modal in its own right — the `Dialog` primitive
 * provides neither modal semantics nor focus containment — so it takes its
 * role, its label and its focus rules from `useModalFocus`, with initial focus
 * on Keep.
 *
 * @version v1.5.0-beta
 */

import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Dialog } from "~/components/ui/Dialog";
import { useModalFocus } from "~/lib/modal-focus";

export function NewStepDialog({
  open,
  objectTitle,
  onKeep,
  onChoose,
}: {
  open: boolean;
  objectTitle: string | null;
  onKeep: () => void;
  onChoose: () => void;
}) {
  const { t } = useTranslation("editor");
  const { t: tCommon } = useTranslation("common");
  const titleId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);

  const { containerRef, dialogProps } = useModalFocus({
    open,
    onClose: onKeep,
    labelledBy: titleId,
    initialFocusRef: keepRef,
  });

  if (!open) return null;

  return (
    <Dialog open={open} onClose={onKeep} managesOwnFocus>
      <div ref={containerRef} {...dialogProps} tabIndex={-1}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 id={titleId} className="font-heading font-semibold text-charcoal text-base">
            {t("step.new_step_dialog.title")}
          </h2>
          {/* Closing is keeping: the seed is already written, and this dialog
              only offers to replace it. */}
          <button
            type="button"
            onClick={onKeep}
            aria-label={tCommon("close")}
            className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-charcoal hover:bg-gray-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="font-body text-sm text-charcoal/80 mb-5">
          {t("step.new_step_dialog.body", {
            title: objectTitle ?? tCommon("untitled"),
          })}
        </p>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onChoose}
            className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal border border-gray-200 rounded-full px-5 py-2 hover:bg-gray-50 transition-colors"
          >
            {t("step.new_step_dialog.choose")}
          </button>
          <button
            type="button"
            ref={keepRef}
            onClick={onKeep}
            className="font-heading font-semibold text-sm uppercase tracking-wider text-white bg-anil rounded-full px-5 py-2 hover:opacity-90 transition-opacity"
          >
            {t("step.new_step_dialog.keep")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
