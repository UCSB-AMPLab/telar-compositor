/**
 * Client-side i18next initialisation.
 *
 * Reads initial locale from the <html lang> attribute set by the server
 * to prevent hydration mismatches. Uses cookie-based language detection
 * for subsequent navigation.
 */

import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { supportedLanguages, fallbackLanguage, defaultNS } from "~/i18n/config";

const lng =
  typeof document !== "undefined"
    ? document.documentElement.lang || fallbackLanguage
    : fallbackLanguage;

export async function initI18nClient() {
  await i18next
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      lng,
      fallbackLng: fallbackLanguage,
      supportedLngs: [...supportedLanguages],
      defaultNS,
      detection: {
        order: ["htmlTag", "cookie", "navigator"],
        caches: ["cookie"],
        cookieOptions: {
          sameSite: "lax",
          secure: location.protocol === "https:",
        },
      },
      interpolation: {
        escapeValue: false, // React already escapes values
      },
    });

  return i18next;
}
