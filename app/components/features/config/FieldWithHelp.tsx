/**
 * FieldWithHelp — labelled form field with optional help text.
 *
 * Supports text, textarea, number, and select input types.
 * Optional onChange callback fires on blur (text/textarea/number) or
 * on change (select) for auto-save integration.
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
  onChange?: (name: string, value: string) => void;
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
  onChange,
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
          defaultValue={value as string | number}
          className={inputClass}
          onBlur={(e) => onChange?.(name, e.target.value)}
        />
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
