/**
 * The object page's custom fields: one labelled text field for each custom
 * column the site's objects sheet has, in the sheet's order, edited through the
 * collaborative document.
 *
 * Each value is a Y.Text in the object's `custom_fields` map, bound to its
 * field as the modelled text fields are, so two people editing different
 * fields, or typing in the same one, both keep what they wrote. The server
 * makes every entry; the page never does, since two browsers making one key
 * keep only one. Before the document connects, while it holds no map for the
 * object, or for a column the server has not yet given this object an entry
 * (a column that appeared since its last pass, until its next snapshot), the
 * field shows the stored value and cannot be edited.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { parseExtraColumns } from "~/lib/extra-columns";
import { customColumnOrder } from "~/lib/object-custom-fields";
import { customFieldsOf } from "~/lib/object-custom-map";
import { InlineTextField } from "~/components/ui/InlineTextField";

export function ObjectCustomFields({
  objectDbId,
  storedBlob,
  objectId,
  sheetHeader,
}: {
  objectDbId: number;
  storedBlob: string | null;
  objectId: string;
  sheetHeader?: readonly string[] | null;
}) {
  const { t } = useTranslation("objects");
  const { ydoc } = useCollaborationContext();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const objects = ydoc?.getArray<Y.Map<unknown>>("objects") ?? null;

  useEffect(() => {
    if (!objects) return;
    objects.observeDeep(rerender);
    return () => objects.unobserveDeep(rerender);
  }, [objects]);

  const maps = objects ? objects.toArray() : [];
  const own = maps.find((m) => m.get("_id") === objectDbId) ?? null;
  const blobOf = (m: Y.Map<unknown>) => (typeof m.get("extra_columns") === "string" ? (m.get("extra_columns") as string) : null);
  const order = customColumnOrder(maps.length > 0 ? maps.map(blobOf) : [storedBlob], sheetHeader);
  if (order.length === 0) return null;

  const shown = parseExtraColumns(own ? blobOf(own) : storedBlob);
  const fields = customFieldsOf(own);

  return (
    <div>
      <hr className="border-gray-100 my-4" />
      <h3 className="font-heading font-semibold text-sm text-charcoal mb-1">{t("section_custom_fields")}</h3>
      <p className="font-body text-xs text-gray-500 mb-3">{t("custom_fields_help")}</p>
      <div className="space-y-4">
        {order.map((key, i) => {
          const id = `field-custom-${i}`;
          const yText = fields?.get(key);
          if (!(yText instanceof Y.Text)) return <StoredField key={`${objectId}:${key}`} id={id} label={key} stored={shown[key] ?? ""} />;
          return (
            <div key={`${objectId}:${key}`}>
              <label htmlFor={id} className="block font-body text-xs font-medium text-gray-600 mb-1">
                {key}
              </label>
              <InlineTextField
                id={id}
                initialValue={shown[key] ?? ""}
                yText={yText}
                inputClassName="font-body text-sm text-charcoal"
                bordered
                fieldKey={`object-${objectId}-custom-${key}`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One field as stored, read-only: the document has no entry to edit for it. */
function StoredField({ id, label, stored }: { id: string; label: string; stored: string }) {
  return (
    <div>
      <label htmlFor={id} className="block font-body text-xs font-medium text-gray-600 mb-1">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={stored}
        disabled
        readOnly
        className="w-full font-body text-sm text-charcoal border border-gray-200 rounded-lg px-3 py-2 disabled:bg-gray-50"
      />
    </div>
  );
}
