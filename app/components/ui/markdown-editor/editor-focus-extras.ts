/**
 * What the Markdown editor does as focus enters and leaves it, beyond its own
 * focus state: the author's presence in a named field, and where the caret
 * goes in a view just created.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";
import { setPresence } from "~/components/ui/InlineTextField";
import { useCollaborationContext } from "~/hooks/use-collaboration";

type Provider = ReturnType<typeof useCollaborationContext>["provider"];

/** Clears the author's location's field if it still names `key`: they have left the editor. */
function leavePresence(provider: Provider, key: string | undefined) {
  if (!key || !provider?.awareness) return;
  const location = provider.awareness.getLocalState()?.location as { fieldKey?: string | null } | undefined;
  if (location?.fieldKey === key) setPresence(provider, null);
}

/**
 * The author's location names `presenceKey` while focus is in the editor, as
 * an inline field's does, and stops naming it as focus leaves or the editor
 * goes, unless the location has moved on to another field.
 */
export function useEditorPresence(provider: Provider, presenceKey: string | undefined) {
  const presence = useRef({ provider, presenceKey });
  presence.current = { provider, presenceKey };
  useEffect(() => () => leavePresence(presence.current.provider, presence.current.presenceKey), []);
  return {
    enter: () => {
      const { provider: current, presenceKey: key } = presence.current;
      if (key) setPresence(current, key);
    },
    leave: () => leavePresence(presence.current.provider, presence.current.presenceKey),
  };
}

/** The caret of a view a Y.Text replaced, with the text it was in. */
interface CarriedCaret {
  doc: string;
  anchor: number;
  head: number;
}

/**
 * Focus for a view just created: the caller's caret on the first view (and
 * its Strict Mode double, which re-creates the first view for the same
 * binding), else the caret the replaced view had where the text is the same
 * (a held panel's first character written to the document), else the caret
 * at the end; for a caller that places the caret, focus alone on a view a
 * Y.Text re-created. `replaced` is told of each view a Y.Text replaces.
 */
export function useFirstViewCaret(placeCaret: ((view: EditorView) => void) | undefined) {
  const placeCaretRef = useRef(placeCaret);
  placeCaretRef.current = placeCaret;
  const caretPlacedFor = useRef<{ yText: Y.Text | null } | null>(null);
  const carriedRef = useRef<CarriedCaret | null>(null);
  const replaced = (view: EditorView) => {
    const { anchor, head } = view.state.selection.main;
    carriedRef.current = { doc: view.state.doc.toString(), anchor, head };
  };
  const focus = (view: EditorView, binding: Y.Text | null) => {
    const place = placeCaretRef.current;
    const carried = carriedRef.current;
    carriedRef.current = null;
    const placed = caretPlacedFor.current;
    if (place && (!placed || placed.yText === binding)) {
      caretPlacedFor.current = { yText: binding };
      place(view);
      return;
    }
    view.focus();
    if (carried && carried.doc === view.state.doc.toString()) view.dispatch({ selection: { anchor: carried.anchor, head: carried.head } });
    else if (!place) view.dispatch({ selection: { anchor: view.state.doc.length } });
  };
  return Object.assign(focus, { replaced });
}
