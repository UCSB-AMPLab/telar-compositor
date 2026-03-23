/**
 * InlineTextArea — shared inline textarea with debounced autosave.
 *
 * Extracted from the dashboard route for reuse in the story editor and
 * any other route that needs debounced autosave on a multi-line field.
 *
 * Submits: { intent, field, value, entityId } to the nearest route action.
 * Debounce: 1500ms (via useInlineAutosave hook).
 */

import { useInlineAutosave } from "~/hooks/use-inline-autosave";

export interface InlineTextAreaProps {
  initialValue: string;
  fieldName: string;
  entityId: number;
  intent: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  rows?: number;
  bordered?: boolean;
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
  bordered,
}: InlineTextAreaProps) {
  const { value, handleChange } = useInlineAutosave({
    initialValue,
    fieldName,
    entityId,
    intent,
  });

  const borderClass = bordered
    ? "rounded-md border border-gray-200 px-3 py-2 bg-white hover:border-gray-300 focus:border-periwinkle focus:ring-1 focus:ring-periwinkle"
    : "border-b border-transparent hover:border-gray-200 focus:border-periwinkle";

  return (
    <textarea
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={`w-full bg-transparent focus:outline-none resize-none transition-colors ${borderClass} ${inputClassName} ${className}`}
    />
  );
}
