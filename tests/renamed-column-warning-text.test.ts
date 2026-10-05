/**
 * The renamed-column warnings as a reader sees them, in both locales, rendered
 * through the page's own `checkMessage` against the real catalogues.
 *
 * The component suite echoes keys, so nothing there would catch a catalogue
 * string that lost a placeholder, or a count parameter that i18next took for
 * a plural and resolved against keys that do not exist.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createInstance, type i18n } from "i18next";

import { checkMessage } from "~/components/features/publish/ValidationChecks";
import type { ValidationItem } from "~/lib/publish.server";
import enPublish from "~/i18n/locales/en/publish.json";
import esPublish from "~/i18n/locales/es/publish.json";

let en: i18n;
let es: i18n;

beforeAll(async () => {
  const build = async (lng: string) => {
    const instance = createInstance();
    await instance.init({
      lng,
      fallbackLng: "en",
      ns: ["publish"],
      defaultNS: "publish",
      resources: { en: { publish: enPublish }, es: { publish: esPublish } },
      interpolation: { escapeValue: false },
    });
    return instance;
  };
  en = await build("en");
  es = await build("es");
});

const sentence = (instance: i18n, item: ValidationItem) =>
  checkMessage(instance.t.bind(instance) as (key: string, values?: Record<string, unknown>) => string, item);

const PAIR: ValidationItem = {
  code: "renamed_duplicate_column",
  message: "renamed_duplicate_column",
  entityId: "objects.csv/notes",
  params: { file: "objects.csv", column: "notes", renamed: "notes_1" },
};

const TRIPLE: ValidationItem = {
  code: "renamed_duplicate_columns",
  message: "renamed_duplicate_columns",
  entityId: "objects.csv/notes",
  params: { file: "objects.csv", column: "notes", total: 3, renamed: '"notes_1", "notes_2"' },
};

describe("the renamed-column warning", () => {
  it("reads in English for two columns", () => {
    expect(sentence(en, PAIR)).toBe(
      'Two columns in objects.csv were both called "notes". The second is saved as "notes_1".',
    );
  });

  it("reads in Spanish for two columns", () => {
    expect(sentence(es, PAIR)).toBe(
      'En objects.csv hay dos columnas llamadas "notes". Al publicar, la segunda quedará con el nombre "notes_1".',
    );
  });

  it("reads in English for three columns", () => {
    expect(sentence(en, TRIPLE)).toBe(
      '3 columns in objects.csv were all called "notes". All but the first are saved under new names: "notes_1", "notes_2".',
    );
  });

  it("reads in Spanish for three columns", () => {
    expect(sentence(es, TRIPLE)).toBe(
      'En objects.csv hay 3 columnas llamadas "notes". Al publicar, todas menos la primera quedarán con nombres nuevos: "notes_1", "notes_2".',
    );
  });

  it("keeps a column name that carries interpolation syntax as the author wrote it", () => {
    const item = { ...PAIR, params: { file: "weavers.csv", column: "{{renamed}}", renamed: "{{renamed}}_1" } };
    expect(sentence(en, item)).toBe(
      'Two columns in weavers.csv were both called "{{renamed}}". The second is saved as "{{renamed}}_1".',
    );
  });
});
