/**
 * This file is the client-side entry point — hydrates the
 * SSR-rendered HTML into a live React app, wires up i18next with the
 * browser-language detector, and attaches the global error-capture
 * listeners so uncaught errors flow through the bug-report pipeline.
 *
 * @version v1.2.0-beta
 */

import i18next from "i18next";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { HydratedRouter } from "react-router/dom";
import I18nextBrowserLanguageDetector from "i18next-browser-languagedetector";
import resources from "~/i18n/locales";
import { attachListeners } from "~/lib/error-capture";

async function main() {
  attachListeners();
  await i18next
    .use(initReactI18next)
    .use(I18nextBrowserLanguageDetector)
    .init({
      resources,
      fallbackLng: "en",
      defaultNS: "common",
      detection: {
        order: ["htmlTag"],
        caches: [],
      },
      // React already escapes text content automatically when rendering;
      // i18next's default HTML-escape pass is redundant and breaks
      // legitimate characters (e.g. the slash in "Coordinador/a" or
      // "juancobo/telar-uat-es" becomes "&#x2F;").
      interpolation: { escapeValue: false },
    });

  startTransition(() => {
    hydrateRoot(
      document,
      <I18nextProvider i18n={i18next}>
        <StrictMode>
          <HydratedRouter />
        </StrictMode>
      </I18nextProvider>,
    );
  });
}

main().catch(console.error);
