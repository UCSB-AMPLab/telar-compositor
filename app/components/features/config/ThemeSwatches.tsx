/**
 * ThemeSwatches — theme color picker for the config editor.
 *
 * Shows swatches for each available Telar theme (from the repo's
 * _data/themes/ folder). Selected theme gets a anil ring.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ThemeOption {
  theme_id: string;
  name: string | null;
  swatch_color: string | null;
}

interface ThemeSwatchesProps {
  name: string;
  value: string;
  themes: ThemeOption[];
  onChange?: (value: string) => void;
}

export function ThemeSwatches({ name, value: initialValue, themes, onChange }: ThemeSwatchesProps) {
  const { t } = useTranslation(["config", "common"]);
  const [selected, setSelected] = useState(initialValue || themes[0]?.theme_id || "");
  useEffect(() => { setSelected(initialValue || themes[0]?.theme_id || ""); }, [initialValue, themes]);

  if (themes.length === 0) {
    return (
      <div>
        <p className="text-xs font-body text-gray-400 italic">{t("config:themes_none")}</p>
        <input type="hidden" name={name} value={selected} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-3 flex-wrap">
        {themes.map((theme) => (
          <button
            key={theme.theme_id}
            type="button"
            onClick={() => {
              setSelected(theme.theme_id);
              onChange?.(theme.theme_id);
            }}
            className="flex flex-col items-center gap-1"
            aria-pressed={selected === theme.theme_id}
          >
            <span
              className={`w-8 h-8 rounded-full block transition-all ${
                selected === theme.theme_id
                  ? "ring-2 ring-anil ring-offset-2"
                  : "ring-1 ring-gray-200"
              }`}
              style={{ backgroundColor: theme.swatch_color || "#999" }}
            />
            <span className="text-xs font-body text-gray-500">{theme.name || t("common:untitled")}</span>
          </button>
        ))}
      </div>
      <input type="hidden" name={name} value={selected} />
    </div>
  );
}
