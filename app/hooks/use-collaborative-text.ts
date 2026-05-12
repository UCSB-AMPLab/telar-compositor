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
 * @version v1.2.0-beta
 */

import { useEffect, useState, useCallback } from "react";
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
): { value: string; handleChange: (newValue: string) => void } {
  const [rawValue, setRawValue] = useState(initialValue);

  useEffect(() => {
    if (!yText) return;

    // Sync initial state from the live Yjs doc.
    // The doc may already have edits from other clients since the SSR render.
    setRawValue(yText.toString());

    const observer = () => setRawValue(yText.toString());
    yText.observe(observer);
    return () => yText.unobserve(observer);
  }, [yText]);

  const handleChange = useCallback(
    (newValue: string) => {
      if (!yText) {
        // Fallback: local-only state before Yjs connects (SSR, pre-connection).
        setRawValue(newValue);
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

  // Display filter: when the current value matches a known default, render
  // as empty so the placeholder takes over. The underlying Y.Text retains
  // the value (no destructive mutation); the next user edit replaces it
  // cleanly via handleChange's full-replace transaction.
  const value =
    defaultValues && defaultValues.includes(rawValue) ? "" : rawValue;

  return { value, handleChange };
}
