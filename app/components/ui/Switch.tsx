/**
 * Switch — pill-shaped toggle component.
 *
 * Renders a WCAG-compliant toggle using role="switch" and aria-checked.
 * Used for draft/private toggles in the Stories list view.
 */

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      onPointerDown={(e) => e.stopPropagation()}
      className={`
        relative inline-flex h-5 w-9 items-center rounded-full transition-colors
        ${checked ? "bg-periwinkle" : "bg-gray-200"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${className}
      `}
    >
      <span
        className={`
          inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform
          ${checked ? "translate-x-4" : "translate-x-0.5"}
        `}
      />
    </button>
  );
}
