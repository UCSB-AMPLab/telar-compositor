/**
 * useInlineAutosave — shared debounced autosave hook for inline editing.
 *
 * Manages local state, debounce timer, and fetcher submission for inline
 * editable fields. Used by InlineTextField and InlineTextArea to eliminate
 * duplicated debounce logic.
 *
 * Submits: { intent, field, value, entityId } to the nearest route action.
 * Default debounce: 1500ms.
 */

import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";

export interface AutosaveOptions {
  initialValue: string;
  fieldName: string;
  entityId: number;
  intent: string;
  debounceMs?: number;
}

export function useInlineAutosave({
  initialValue,
  fieldName,
  entityId,
  intent,
  debounceMs = 1500,
}: AutosaveOptions) {
  const fetcher = useFetcher();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function handleChange(newValue: string) {
    setValue(newValue);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      fetcher.submit(
        { intent, field: fieldName, value: newValue, entityId: String(entityId) },
        { method: "post" }
      );
    }, debounceMs);
  }

  return { value, handleChange, fetcher };
}
