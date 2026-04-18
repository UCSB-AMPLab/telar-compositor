/**
 * useCollaborativeText — binds a Y.Text instance to React state.
 *
 * Replaces the old HTTP-based autosave hook. Instead of debounced HTTP posts,
 * mutations go directly into the Yjs shared type and sync to all clients automatically.
 *
 * The observer pattern ensures all clients — including the local one — see
 * the canonical Y.Text value rather than optimistic local state. On SSR or
 * pre-connection (yText is null) the hook falls back to initialValue and
 * updates local state directly so the field remains usable.
 */

import { useEffect, useState, useCallback } from "react";
import * as Y from "yjs";

/**
 * useCollaborativeText — bind a Y.Text to React state.
 *
 * @param yText         The Y.Text instance from the Y.Doc.
 *                      Pass null during SSR or before the WebSocket connects.
 * @param initialValue  The value from the D1 SSR render used until yText is available.
 * @returns { value, handleChange } — value reflects Yjs state; handleChange writes to Y.Text.
 */
export function useCollaborativeText(
  yText: Y.Text | null,
  initialValue: string
): { value: string; handleChange: (newValue: string) => void } {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (!yText) return;

    // Sync initial state from the live Yjs doc.
    // The doc may already have edits from other clients since the SSR render.
    setValue(yText.toString());

    const observer = () => setValue(yText.toString());
    yText.observe(observer);
    return () => yText.unobserve(observer);
  }, [yText]);

  const handleChange = useCallback(
    (newValue: string) => {
      if (!yText) {
        // Fallback: local-only state before Yjs connects (SSR, pre-connection).
        setValue(newValue);
        return;
      }
      // Atomic delete + insert — prevents partial-state divergence under concurrent edits.
      // The observer fires after the transaction and updates React state.
      yText.doc?.transact(() => {
        yText.delete(0, yText.length);
        yText.insert(0, newValue);
      });
    },
    [yText]
  );

  return { value, handleChange };
}
