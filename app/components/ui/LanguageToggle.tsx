/**
 * LanguageToggle — EN/ES language switcher.
 *
 * Two-pill toggle matching telar.org style: both languages shown,
 * active one highlighted, inactive one dimmed.
 */

import { useTranslation } from "react-i18next";

interface LanguageToggleProps {
  className?: string;
  /** Use light variant for dark backgrounds (e.g. sign-in left panel) */
  variant?: "default" | "light";
}

export function LanguageToggle({
  className = "",
  variant = "default",
}: LanguageToggleProps) {
  const { i18n } = useTranslation();
  const currentLang = i18n.language?.startsWith("es") ? "es" : "en";

  const langs = [
    { code: "en", label: "EN" },
    { code: "es", label: "ES" },
  ] as const;

  const activeClass =
    variant === "light"
      ? "bg-cream text-charcoal border-cream"
      : "bg-charcoal text-white border-charcoal";

  const inactiveClass =
    variant === "light"
      ? "bg-transparent text-white/70 border-white/30 hover:border-white/60 hover:text-white"
      : "bg-transparent text-charcoal/50 border-charcoal/20 hover:border-charcoal/40 hover:text-charcoal/80";

  return (
    <div className={`flex gap-1 ${className}`}>
      {langs.map(({ code, label }) => {
        const isActive = currentLang === code;
        if (isActive) {
          return (
            <span
              key={code}
              className={`px-3.5 py-1.5 rounded-full font-body text-sm font-medium ${activeClass}`}
            >
              {label}
            </span>
          );
        }
        return (
          <form key={code} method="post" action="/api/locale">
            <input type="hidden" name="locale" value={code} />
            <button
              type="submit"
              className={`px-3.5 py-1.5 rounded-full border font-body text-sm font-medium transition-all duration-200 cursor-pointer ${inactiveClass}`}
              aria-label={`Switch to ${label}`}
            >
              {label}
            </button>
          </form>
        );
      })}
    </div>
  );
}
