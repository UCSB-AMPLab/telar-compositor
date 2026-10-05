/**
 * KeptDraftNotice — the text an author typed in a Markdown field before its
 * shared text loaded, offered back: applying it replaces the shared text it
 * was kept for (and no other) with it, and discarding drops it.
 *
 * @version v1.5.0-beta
 */
import type * as Y from "yjs";
import { useTranslation } from "react-i18next";

/** Replaces the whole of `target` with `draft`, in one transaction. */
function replaceShared(target: Y.Text, draft: string) {
  target.doc?.transact(() => {
    target.delete(0, target.length);
    target.insert(0, draft);
  });
}

export function KeptDraftNotice({
  draft,
  target,
  onClose,
  disabled = false,
}: {
  draft: string;
  target: Y.Text;
  onClose: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("editor");
  return (
    <div role="status" data-testid="kept-draft" className="font-body text-xs mt-1 text-gray-600">
      <p>{t("kept_draft.message")}</p>
      <button type="button" data-testid="kept-draft-apply" disabled={disabled} className="underline mr-3" onClick={() => {
          replaceShared(target, draft);
          onClose();
        }}>
        {t("kept_draft.apply")}
      </button>
      <button type="button" data-testid="kept-draft-discard" disabled={disabled} className="underline" onClick={onClose}>
        {t("kept_draft.discard")}
      </button>
    </div>
  );
}
