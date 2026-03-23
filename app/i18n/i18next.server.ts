/**
 * Server-side i18next setup using remix-i18next v7.
 *
 * Locale cookie is httpOnly: false so client JS can read the locale value
 * without a round-trip. sameSite: lax ensures the cookie survives the
 * GitHub OAuth redirect round-trip (cross-site redirect).
 */

import { createCookie } from "react-router";
import { RemixI18Next } from "remix-i18next/server";
import { supportedLanguages, fallbackLanguage, defaultNS } from "~/i18n/config";

/** Cookie config exported for testing */
export const localeCookieConfig = {
  httpOnly: false,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 365, // 1 year
};

export const localeCookie = createCookie("locale", localeCookieConfig);

const i18nServer = new RemixI18Next({
  detection: {
    supportedLanguages: [...supportedLanguages],
    fallbackLanguage,
    cookie: localeCookie,
  },
  i18next: {
    defaultNS,
    fallbackLng: fallbackLanguage,
    supportedLngs: [...supportedLanguages],
  },
  backend: {
    loadPath: "./public/locales/{{lng}}/{{ns}}.json",
  },
});

/** Resolve locale for a request (used in root loader) */
export async function getLocale(request: Request): Promise<string> {
  return i18nServer.getLocale(request);
}
