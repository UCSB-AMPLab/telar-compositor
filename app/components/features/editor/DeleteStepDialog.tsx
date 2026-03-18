/**
 * DeleteStepDialog — confirmation modal for step deletion.
 *
 * Shows the step number, question text, and a warning if the step has layers.
 * Follows the same pattern as DeleteStoryDialog in the dashboard.
 */

import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";

interface DeleteStepDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  step: { step_number: number; question: string | null } | null;
  layerCount: number;
}

export function DeleteStepDialog({
  open,
  onClose,
  onConfirm,
  step,
  layerCount,
}: DeleteStepDialogProps) {
  const { t } = useTranslation("editor");

  if (!step) return null;

  return (
    <Dialog open={open} onClose={onClose}>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-3">
        {t("delete_step.title")}
      </h2>
      <p className="font-body text-charcoal mb-1">
        {t("delete_step.body", {
          number: step.step_number,
          question: step.question || t("step.question_placeholder"),
        })}
      </p>
      {layerCount > 0 && (
        <p className="font-body text-sm text-red-600 mt-2">
          {t("delete_step.layer_warning", { count: layerCount })}
        </p>
      )}
      <div className="flex justify-end gap-3 mt-6">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 font-heading font-semibold text-sm text-charcoal hover:bg-gray-100 rounded"
        >
          {t("delete_step.cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 font-heading font-semibold text-sm text-white bg-red-600 hover:bg-red-700 rounded"
        >
          {t("delete_step.confirm")}
        </button>
      </div>
    </Dialog>
  );
}
