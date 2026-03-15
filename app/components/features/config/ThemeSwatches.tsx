/**
 * ThemeSwatches — theme color picker for the config editor.
 *
 * Shows swatches for each available Telar theme. Selected theme gets a
 * periwinkle ring. Hidden input holds the value for form submission.
 */

import { useState } from "react";

interface Theme {
  id: string;
  label: string;
  /** Representative swatch colour (hex) for visual preview */
  color: string;
}

const THEMES: Theme[] = [
  { id: "trama", label: "Trama", color: "#883C36" },
  { id: "trama-azul", label: "Azul", color: "#3B6EA8" },
  { id: "trama-verde", label: "Verde", color: "#3A7D44" },
  { id: "trama-morado", label: "Morado", color: "#6B4EA8" },
];

interface ThemeSwatchesProps {
  name: string;
  value: string;
}

export function ThemeSwatches({ name, value: initialValue }: ThemeSwatchesProps) {
  const [selected, setSelected] = useState(initialValue || "trama");

  return (
    <div>
      <div className="flex gap-3 flex-wrap">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            onClick={() => setSelected(theme.id)}
            className="flex flex-col items-center gap-1"
            aria-pressed={selected === theme.id}
          >
            <span
              className={`w-8 h-8 rounded-full block transition-all ${
                selected === theme.id
                  ? "ring-2 ring-periwinkle ring-offset-2"
                  : "ring-1 ring-gray-200"
              }`}
              style={{ backgroundColor: theme.color }}
            />
            <span className="text-xs font-body text-gray-500">{theme.label}</span>
          </button>
        ))}
      </div>
      <input type="hidden" name={name} value={selected} />
    </div>
  );
}
