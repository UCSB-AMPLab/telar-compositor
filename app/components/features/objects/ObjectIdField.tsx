/**
 * The object page's ID field: the ID, the warning when the site reads another
 * row as this object, and the Change ID button that opens the rename dialog.
 *
 * The button is offered to whoever the `rename-object` action admits, the
 * convenor or whoever created the object, and never on a course item, whose ID
 * the course preload would bring back; there the field says why instead.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ObjectRenameFacts } from "~/lib/object-rename-id";
import { ObjectRenameDialog } from "~/components/features/objects/ObjectRenameDialog";

interface ObjectIdFieldProps {
  objectDbId: number;
  objectId: string;
  /** The convenor, or whoever created the object. */
  canRename: boolean;
  isCourseItem: boolean;
  facts: ObjectRenameFacts;
}

export function ObjectIdField({ objectDbId, objectId, canRename, isCourseItem, facts }: ObjectIdFieldProps) {
  const { t } = useTranslation("objects");
  const [open, setOpen] = useState(false);
  const offered = canRename && !isCourseItem;

  return (
    <div>
      <label htmlFor="field-object-id" className="block font-body text-xs font-medium text-gray-600 mb-1">
        {t("upload_object_id")}
      </label>
      {facts.shared && (
        <p className="font-body text-xs text-amber-700 mb-1">
          {t("site_id_shared", { others: facts.shared.others.join(", "), shown: facts.shared.shown })}
        </p>
      )}
      <div className="flex items-center gap-2">
        <p
          id="field-object-id"
          className="flex-1 min-w-0 font-mono text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
          title={objectId}
        >
          {objectId}
        </p>
        {offered && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 font-heading font-semibold text-xs uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-4 py-2 hover:bg-cream transition-colors"
          >
            {t("rename_button")}
          </button>
        )}
      </div>
      {canRename && isCourseItem && (
        <p className="font-body text-xs text-gray-400 mt-1">{t("course_item_rename_refused")}</p>
      )}
      {open && (
        <ObjectRenameDialog objectDbId={objectDbId} objectId={objectId} facts={facts} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
