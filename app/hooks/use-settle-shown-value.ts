/**
 * This file brings the shared text a field is bound to into line with what the
 * field shows, where an input method may have changed the field without a
 * change event. Used by InlineTextArea and InlineTextField.
 *
 * @version v1.5.0-beta
 */

import { useLayoutEffect, useRef, type RefObject } from "react";
import type { CollaborativeText } from "~/hooks/use-collaborative-text";

/**
 * Brings the shared text into line with what a field shows, when an input
 * method may have changed the field without saying so. A cancelled
 * composition puts the field back as it was and, on some methods, sends no
 * change for it, so the shared text keeps the provisional characters, every
 * collaborator has them, and the field draws them back on its next render.
 *
 * Writes only over this binding's own last write. The write replaces the
 * whole value, which every other editor receives, so where anyone else has
 * changed the text since, the field cannot tell which of the two is current
 * and leaves the shared text as it is.
 *
 * And only while the text is still what the field last rendered (`rendered`).
 * The element is evidence of what the author sees only against that render:
 * an owner that sets the text and closes the field in one update unmounts an
 * element still holding the value before it.
 *
 * Returns the value the write replaced, or null when nothing was written.
 */
function settleShownValue(
  shown: string,
  rendered: string,
  text: CollaborativeText,
): string | null {
  const held = text.currentValue();
  if (shown === held || held !== rendered || !text.lastWriteIsOwn()) return null;
  text.handleChange(shown);
  return held;
}

/**
 * The settle for one field, run where a composition may have ended
 * unannounced: the field calls the returned function at the composition's end
 * and before it is left, and the hook runs it once more when the field
 * unmounts, since an in-place field can be closed by its owner without a blur
 * (the alt-text chip closes on its own click). The element is taken at mount,
 * so the unmount run does not depend on the ref still being attached.
 *
 * `onSettled` receives the value a write replaced and the value written.
 */
export function useSettleShownValue(
  boxRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  rendered: string,
  text: CollaborativeText,
  onSettled?: (replaced: string, shown: string) => void,
): () => void {
  const settleBox = (box: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (!box) return;
    const replaced = settleShownValue(box.value, rendered, text);
    if (replaced !== null) onSettled?.(replaced, box.value);
  };
  const latest = useRef(settleBox);
  latest.current = settleBox;
  useLayoutEffect(() => {
    const box = boxRef.current;
    // An owner that closes the field asks it to settle first (`registerSettle`).
    const unregister = text.registerSettle?.(() =>
      latest.current(boxRef.current ?? box),
    );
    return () => {
      unregister?.();
      latest.current(box);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxRef]);
  return () => latest.current(boxRef.current);
}
