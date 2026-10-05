/**
 * The upgrade page names its site, through the real i18next and the real
 * catalogues in both languages.
 *
 * @version v1.5.0-beta
 */

// @vitest-environment jsdom

import React from "react";
import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { createInstance, type i18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

import { SiteLine } from "~/components/features/upgrade/SiteLine";
import enUpgrade from "~/i18n/locales/en/upgrade.json";
import esUpgrade from "~/i18n/locales/es/upgrade.json";

const instances: Record<string, i18n> = {};

beforeAll(async () => {
  for (const lng of ["en", "es"]) {
    const instance = createInstance();
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: "en",
      ns: ["upgrade"],
      defaultNS: "upgrade",
      resources: { en: { upgrade: enUpgrade }, es: { upgrade: esUpgrade } },
      interpolation: { escapeValue: false },
    });
    instances[lng] = instance;
  }
});

describe.each([
  ["en", "This upgrade is for the site student/my-site."],
  ["es", "Esta actualización es para el sitio student/my-site."],
])("in %s", (lng, sentence) => {
  it("names the repository, set apart in monospace", () => {
    const { container } = render(
      <I18nextProvider i18n={instances[lng]}>
        <SiteLine repo="student/my-site" />
      </I18nextProvider>,
    );

    expect(container.textContent).toBe(sentence);
    const site = container.querySelector("span.font-mono");
    expect(site?.textContent).toBe("student/my-site");
  });
});
