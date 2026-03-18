/**
 * InlineTextArea — shared inline textarea with debounced autosave.
 *
 * Extracted from the dashboard route for reuse in the story editor and
 * any other route that needs debounced autosave on a multi-line field.
 *
 * Submits: { intent, field, value, entityId } to the nearest route action.
 * Debounce: 1500ms.
 */

import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";

export interface InlineTextAreaProps {
  initialValue: string;
  fieldName: string;
  entityId: number;
  intent: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  rows?: number;
}

export function InlineTextArea({
  initialValue,
  fieldName,
  entityId,
  intent,
  placeholder,
  className = "",
  inputClassName = "",
  rows = 3,
}: InlineTextAreaProps) {
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

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newValue = e.target.value;
    setValue(newValue);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      fetcher.submit(
        { intent, field: fieldName, value: newValue, entityId: String(entityId) },
        { method: "post" }
      );
    }, 1500);
  }

  return (
    <textarea
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      rows={rows}
      className={`w-full bg-transparent border-b border-transparent hover:border-gray-200 focus:border-periwinkle focus:outline-none resize-none transition-colors ${inputClassName} ${className}`}
    />
  );
}
