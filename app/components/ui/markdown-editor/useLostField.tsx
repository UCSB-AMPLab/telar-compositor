/**
 * useLostField — the toolbar's view of a lost widget field (fieldFocus.ts).
 * While the field the toolbar was acting on has gone away, `lost` is true:
 * the formatting buttons carry `aria-disabled`, and a press on one calls
 * `refuse`, which shows `FieldGoneNotice` until the author puts the caret
 * somewhere again.
 *
 * @version v1.5.0-beta
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { EditorView } from "@codemirror/view";
import { LOST, focusedField, subscribeFieldFocus } from "./fieldFocus";

export interface LostField {
  lost: boolean;
  refused: boolean;
  refuse: () => void;
}

const never = () => () => {};

export function useLostField(view: EditorView | null): LostField {
  const lost = useSyncExternalStore(
    view ? (listener) => subscribeFieldFocus(view, listener) : never,
    () => (view ? focusedField(view) === LOST : false),
    () => false,
  );
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!lost) setRefused(false);
  }, [lost]);
  return { lost, refused: lost && refused, refuse: () => setRefused(true) };
}

/** Why a formatting button did nothing, shown after a refused press. */
export function FieldGoneNotice({ field }: { field: LostField }) {
  const { t } = useTranslation("editor");
  if (!field.refused) return null;
  return (
    <p role="alert" className="text-xs font-body px-4 mb-2">
      {t("panel.fieldGone")}
    </p>
  );
}
