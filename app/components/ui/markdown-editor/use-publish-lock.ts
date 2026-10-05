/**
 * The Markdown editor's publish lock: while a publish holds the document, an
 * editor that writes to it is read-only. An editor with a Y.Text writes to it
 * as it is typed; a held panel's editor writes to it on its first content
 * (use-pending-layers.ts). The lock lives in a readOnly compartment the view
 * is created with, and is set again for each view a Y.Text re-creates.
 *
 * @version v1.5.0-beta
 */

import { useEffect, type RefObject } from "react";
import { EditorState, type Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";

/** Whether the editor is locked, which the hook applies to its view. */
export function usePublishLock(
  view: RefObject<EditorView | null>,
  compartment: Compartment,
  { isPublishing, binding, lockWhilePublishing }: { isPublishing: boolean; binding: Y.Text | null; lockWhilePublishing?: boolean },
): boolean {
  const locked = isPublishing && (!!binding || !!lockWhilePublishing);
  useEffect(() => {
    view.current?.dispatch({ effects: compartment.reconfigure(EditorState.readOnly.of(locked)) });
  }, [view, compartment, locked, binding]);
  return locked;
}
