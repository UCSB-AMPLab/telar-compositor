/**
 * DeleteStoryDialog — confirmation modal for story deletion.
 *
 * Warns the user that deleting a story removes it and all its steps
 * from the compositor. The published site is unaffected until the next publish.
 */

import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";

interface DeleteStoryDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  storyTitle: string;
  stepCount: number;
}

export function DeleteStoryDialog({
  open,
  onClose,
  onConfirm,
  storyTitle,
  stepCount,
}: DeleteStoryDialogProps) {
  const { t } = useTranslation("dashboard");

  return (
    <Dialog open={open} onClose={onClose}>
      <h2 className="font-heading font-semibold text-lg text-gray-900 mb-2">
        {t("delete_story.title")}
      </h2>
      <p className="font-body text-sm text-gray-600 mb-6">
        {t("delete_story.body", { title: storyTitle, count: stepCount })}
      </p>
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 font-body text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-body font-medium text-sm rounded-md transition-colors"
        >
          {t("delete_story.confirm")}
        </button>
      </div>
    </Dialog>
  );
}
