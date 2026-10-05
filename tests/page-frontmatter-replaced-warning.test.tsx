// @vitest-environment jsdom
/**
 * The publish review, before a publish, for a page whose stored settings the
 * publish cannot read: the checks the review runs (`runPrePublishValidation`)
 * rendered by the review's own component through the real i18next and the
 * real catalogues. The warning names the page; a page whose block cannot take
 * its title shows its blocker, and no warning beside it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { createInstance, type i18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

import { ValidationChecks } from "~/components/features/publish/ValidationChecks";
import { runPrePublishValidation } from "~/lib/publish.server";
import enPublish from "~/i18n/locales/en/publish.json";
import esPublish from "~/i18n/locales/es/publish.json";

const instances: Record<string, i18n> = {};

beforeAll(async () => {
  for (const lng of ["en", "es"]) {
    const instance = createInstance();
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: "en",
      ns: ["publish"],
      defaultNS: "publish",
      resources: { en: { publish: enPublish }, es: { publish: esPublish } },
      interpolation: { escapeValue: false },
    });
    instances[lng] = instance;
  }
});

afterEach(cleanup);

/** A page whose block does not parse, and one whose block no edit can retitle. */
const PAGES = [
  { slug: "about", title: 'Café "x"', frontmatter: "\ntitle: [About\n" },
  { slug: "acerca", title: "Sobre", frontmatter: "\n{title: Acerca, language: es}\n" },
];

function renderReplacedWarning(lng: string) {
  const validation = runPrePublishValidation({
    headSha: "h", currentRepoHead: "h", stories: [], steps: [], objects: [], glossary: [], pages: PAGES,
  });
  render(
    <I18nextProvider i18n={instances[lng]}>
      <MemoryRouter>
        <ValidationChecks validation={validation} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe("the publish review, for a page whose settings cannot be read", () => {
  it("warns that publishing keeps only its title, naming the page", () => {
    renderReplacedWarning("en");
    expect(screen.getByText(
      'The settings of the page "Café "x"" can\'t be read. Publishing will keep only its title and remove its other settings.',
    )).toBeTruthy();
  });

  it("warns in Spanish too", () => {
    renderReplacedWarning("es");
    expect(screen.getByText(
      'No se pueden leer los ajustes de la página "Café "x"". Al publicar, se conservará solo el título y se quitarán los demás ajustes.',
    )).toBeTruthy();
  });

  it("shows an unwritable page its blocker and no warning", () => {
    renderReplacedWarning("en");
    expect(screen.getByText(/The title of page "Sobre" is written in a form/)).toBeTruthy();
    expect(screen.queryByText(/The settings of the page "Sobre"/)).toBeNull();
    expect(screen.getAllByText(/can't be read\. Publishing will keep only its title/)).toHaveLength(1);
  });
});
