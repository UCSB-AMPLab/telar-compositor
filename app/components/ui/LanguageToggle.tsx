/**
 * LanguageToggle — EN/ES language switcher.
 *
 * Shows the OTHER language as the toggle label (click to switch).
 * Submits a form to /api/locale to update the locale cookie server-side.
 */

import { Form } from "react-router";
import { useTranslation } from "react-i18next";

interface LanguageToggleProps {
  className?: string;
}

export function LanguageToggle({ className = "" }: LanguageToggleProps) {
  const { i18n } = useTranslation();
  const currentLang = i18n.language?.startsWith("es") ? "es" : "en";
  const otherLang = currentLang === "en" ? "es" : "en";
  const otherLabel = otherLang.toUpperCase();

  return (
    <Form method="post" action="/api/locale">
      <input type="hidden" name="locale" value={otherLang} />
      <button
        type="submit"
        className={`font-heading font-semibold text-xs uppercase tracking-wider text-charcoal hover:opacity-70 transition-opacity ${className}`}
        aria-label={`Switch to ${otherLabel}`}
      >
        {otherLabel}
      </button>
    </Form>
  );
}
