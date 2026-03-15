/**
 * FieldWithHelp — labelled form field with optional help text.
 *
 * Supports text, textarea, number, and select input types.
 */

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
}

const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-sm font-body focus:border-periwinkle focus:ring-1 focus:ring-periwinkle outline-none";

export function FieldWithHelp({
  label,
  name,
  type = "text",
  value,
  help,
  options = [],
  className = "",
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
          rows={3}
          className={inputClass}
        />
      ) : type === "select" ? (
        <select id={name} name={name} defaultValue={value as string} className={inputClass}>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={name}
          name={name}
          type={type}
          defaultValue={value as string | number}
          className={inputClass}
        />
      )}
      {help && <p className="text-xs text-gray-400 mt-1">{help}</p>}
    </div>
  );
}
