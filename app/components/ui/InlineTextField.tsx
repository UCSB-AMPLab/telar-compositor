/**
 * InlineTextField — shared inline text input with debounced autosave.
 *
 * Extracted from the dashboard route for reuse in the story editor and
 * any other route that needs debounced autosave on a single-line field.
 *
 * Submits: { intent, field, value, entityId } to the nearest route action.
 * Debounce: 1500ms (via useInlineAutosave hook).
 */

import { useInlineAutosave } from "~/hooks/use-inline-autosave";

export interface InlineTextFieldProps {
  initialValue: string;
  fieldName: string;
  entityId: number;
  intent: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  bordered?: boolean;
}

export function InlineTextField({
  initialValue,
  fieldName,
  entityId,
  intent,
  placeholder,
  className = "",
  inputClassName = "",
  bordered,
}: InlineTextFieldProps) {
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
    <input
      type="text"
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-transparent focus:outline-none transition-colors ${borderClass} ${inputClassName} ${className}`}
    />
  );
}
