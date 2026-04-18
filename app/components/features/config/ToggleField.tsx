/**
 * ToggleField — toggle switch with label and optional help text.
 *
 * Uses local state for the visual toggle. Optional onChange callback
 * fires immediately on toggle for auto-save integration.
 */

import { useEffect, useState } from "react";

interface ToggleFieldProps {
  label: string;
  name: string;
  checked: boolean;
  help?: string;
  onChange?: (name: string, value: boolean) => void;
}

export function ToggleField({ label, name, checked: initialChecked, help, onChange }: ToggleFieldProps) {
  const [checked, setChecked] = useState(initialChecked);
  useEffect(() => { setChecked(initialChecked); }, [initialChecked]);

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between">
        <span className="font-body font-medium text-sm text-charcoal">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => {
            const next = !checked;
            setChecked(next);
            onChange?.(name, next);
          }}
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
      <input type="hidden" name={name} value={checked ? "true" : "false"} />
    </div>
  );
}
