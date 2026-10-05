/**
 * This file is the hook that binds a Y.Text instance to React
 * state — the bridge between the Yjs collaborative document and
 * any React component that needs to render and edit a shared text
 * value.
 *
 * Mutations go directly into the Yjs shared type and sync to all
 * clients automatically. The observer pattern ensures all clients
 * — including the local one — see the canonical Y.Text value
 * rather than optimistic local state. On SSR or pre-connection
 * (yText is null) the hook falls back to `initialValue` and
 * updates local state directly so the field remains usable.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useState, useCallback, useRef } from "react";
import * as Y from "yjs";

/**
 * useCollaborativeText — bind a Y.Text to React state.
 *
 * @param yText         The Y.Text instance from the Y.Doc.
 *                      Pass null during SSR or before the WebSocket connects.
 * @param initialValue  The value from the D1 SSR render used until yText is available.
 * @param defaultValues Optional list of strings that should be DISPLAYED as
 *                      empty (so a placeholder takes over). The underlying
 *                      Y.Text is left untouched until the user edits — at
 *                      which point handleChange's full-replace semantics
 *                      cleanly overwrites the legacy default with their
 *                      input. Used to suppress display of
 *                      v1.2.1 frontmatter literals captured-at-import that
 *                      no longer round-trip via the v1.3.0 framework's
 *                      lang packs (see _app.homepage.tsx).
 * @returns { value, handleChange } — value reflects Yjs state (or "" when
 *          the live state matches a default); handleChange writes to Y.Text.
 */
export function useCollaborativeText(
  yText: Y.Text | null,
  initialValue: string,
  defaultValues?: readonly string[]
): {
  value: string;
  handleChange: (newValue: string) => void;
  currentValue: () => string;
  lastWriteIsOwn: () => boolean;
} {
  const [rawValue, setRawValue] = useState(initialValue);
  // The same text the state holds, kept for a caller that has to know what the
  // document says NOW: a remote edit updates the document and SCHEDULES the
  // render that shows it, so a caller reading the rendered value in between
  // reads text the document has already moved past.
  const liveValue = useRef(initialValue);
  // The origin this binding's own transactions carry, and whether the latest
  // change to the text was one of them. Judged by transaction and not by
  // value: a collaborator who deletes a character and types the same one back
  // leaves the text equal to this binding's last write, and their edit is
  // still theirs.
  const ownOrigin = useRef({});
  const ownWriteIsLatest = useRef(false);

  useEffect(() => {
    if (!yText) return;

    // Sync initial state from the live Yjs doc.
    // The doc may already have edits from other clients since the SSR render.
    liveValue.current = yText.toString();
    setRawValue(liveValue.current);
    ownWriteIsLatest.current = false;

    const observer = (event: Y.YTextEvent) => {
      ownWriteIsLatest.current = event.transaction.origin === ownOrigin.current;
      liveValue.current = yText.toString();
      setRawValue(liveValue.current);
    };
    yText.observe(observer);
    return () => yText.unobserve(observer);
  }, [yText]);

  const handleChange = useCallback(
    (newValue: string) => {
      if (!yText) {
        // Fallback: local-only state before Yjs connects (SSR, pre-connection).
        liveValue.current = newValue;
        ownWriteIsLatest.current = true;
        setRawValue(newValue);
        return;
      }
      // Atomic delete + insert — prevents partial-state divergence under concurrent edits.
      // The observer fires after the transaction and updates React state.
      yText.doc?.transact(() => {
        yText.delete(0, yText.length);
        yText.insert(0, newValue);
      }, ownOrigin.current);
    },
    [yText]
  );

  // Display filter: when the current value matches a known default, render
  // as empty so the placeholder takes over. The underlying Y.Text retains
  // the value (no destructive mutation); the next user edit replaces it
  // cleanly via handleChange's full-replace transaction.
  const displayed = useCallback(
    (raw: string) => (defaultValues && defaultValues.includes(raw) ? "" : raw),
    [defaultValues],
  );
  const value = displayed(rawValue);

  /**
   * What the field holds at the moment of the call — the shared document
   * itself where there is one, past any render still to come.
   */
  const currentValue = useCallback(
    () => displayed(yText ? yText.toString() : liveValue.current),
    [displayed, yText],
  );

  /**
   * Whether the latest change to the text was this binding's own write. Before
   * the connection the value is local and every change to it is this one's.
   */
  const lastWriteIsOwn = useCallback(() => ownWriteIsLatest.current, []);

  return { value, handleChange, currentValue, lastWriteIsOwn };
}

/**
 * What the hook returns. A component that renders a field it may unmount
 * (InPlaceText) holds the binding itself and passes it to the field, so a
 * draft kept before the Y.Text connects outlives the field.
 */
export type CollaborativeText = ReturnType<typeof useCollaborativeText> & {
  /** Set by an owner that closes the field itself: the field registers the settle the owner runs before it reads the draft. */
  registerSettle?: (settle: () => void) => () => void;
};
