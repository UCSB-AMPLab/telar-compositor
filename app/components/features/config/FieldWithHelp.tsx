/**
 * FieldWithHelp — labelled form field with optional help text.
 *
 * Supports text, textarea, number, and select input types.
 * Optional onChange callback fires on blur (text/textarea/number) or
 * on change (select) for auto-save integration.
 *
 * `onInput` fires on every keystroke instead, for a caller that has to know a
 * field is dirty before it is left: a browser navigation away from a focused
 * field never blurs it, so a guard armed on blur alone never sees the edit.
 * It carries no value to save — saving on each keystroke is what blur exists
 * to avoid — so a caller wanting both passes both.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useState } from "react";

interface SelectOption {
  value: string;
  label: string;
}

interface FieldWithHelpProps {
  label: string;
  name: string;
  type?: "text" | "textarea" | "number" | "select";
  value: string | number;
  help?: string;
  options?: SelectOption[];
  className?: string;
  /** Bounds for a number input, so the browser refuses what the action would. */
  min?: number;
  max?: number;
  /**
   * Why the last save refused this field, shown in place of the help text.
   * A field with no rejection to report passes nothing.
   */
  error?: string;
  onChange?: (name: string, value: string) => void;
  /** Fires on every keystroke, for a dirty flag that cannot wait for blur. */
  onInput?: (name: string, value: string) => void;
  /**
   * Extra attributes for the `<input>`. The story key passes
   * `data-paste-verbatim`, so paste cleaning (`app/lib/paste-cleaning.ts`)
   * leaves a pasted credential exactly as pasted.
   */
  inputAttributes?: Record<`data-${string}`, string>;
}

const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-sm font-body focus:border-anil";

export function FieldWithHelp({
  label,
  name,
  type = "text",
  value,
  help,
  options = [],
  className = "",
  min,
  max,
  error,
  onChange,
  onInput,
  inputAttributes,
}: FieldWithHelpProps) {
  return (
    <div className={`mb-4 ${className}`}>
      <label htmlFor={name} className="font-body font-medium text-sm text-charcoal mb-1 block">
        {label}
      </label>
      {type === "textarea" ? (
        <textarea
          id={name}
          name={name}
          defaultValue={value as string}
          rows={6}
          className={inputClass}
          onInput={(e) => onInput?.(name, (e.target as HTMLTextAreaElement).value)}
          onBlur={(e) => onChange?.(name, e.target.value)}
        />
      ) : type === "select" ? (
        <ControlledSelect
          id={name}
          name={name}
          value={value as string}
          options={options}
          className={inputClass}
          onChange={(v) => onChange?.(name, v)}
        />
      ) : (
        <input
          id={name}
          name={name}
          type={type}
          min={min}
          max={max}
          defaultValue={value as string | number}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${name}-error` : undefined}
          className={inputClass}
          {...inputAttributes}
          onInput={(e) => onInput?.(name, (e.target as HTMLInputElement).value)}
          onBlur={(e) => onChange?.(name, e.target.value)}
        />
      )}
      {error && (
        <p id={`${name}-error`} role="alert" className="text-xs text-terracotta mt-1">
          {error}
        </p>
      )}
      {help && <p className="text-xs text-gray-400 mt-1">{help}</p>}
    </div>
  );
}

function ControlledSelect({
  id,
  name,
  value: propValue,
  options,
  className,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  options: SelectOption[];
  className: string;
  onChange?: (value: string) => void;
}) {
  const [selected, setSelected] = useState(propValue);
  useEffect(() => { setSelected(propValue); }, [propValue]);

  return (
    <select
      id={id}
      name={name}
      value={selected}
      onChange={(e) => {
        setSelected(e.target.value);
        onChange?.(e.target.value);
      }}
      className={className}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
