/**
 * ToggleField — toggle switch with label and optional help text.
 *
 * Uses a hidden input for form submission and local state for the visual toggle.
 */

import { useState } from "react";

interface ToggleFieldProps {
  label: string;
  name: string;
  checked: boolean;
  help?: string;
}

export function ToggleField({ label, name, checked: initialChecked, help }: ToggleFieldProps) {
  const [checked, setChecked] = useState(initialChecked);

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between">
        <span className="font-body font-medium text-sm text-charcoal">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => setChecked((v) => !v)}
          className={`relative w-10 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-periwinkle focus:ring-offset-1 ${
            checked ? "bg-periwinkle" : "bg-gray-200"
          }`}
        >
          <span
            className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transform transition-transform ${
              checked ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>
      {help && <p className="text-xs text-gray-400 mt-1">{help}</p>}
      {/* Hidden input for form submission */}
      <input type="hidden" name={name} value={checked ? "true" : "false"} />
    </div>
  );
}
