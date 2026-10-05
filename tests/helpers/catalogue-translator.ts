/**
 * A `t` backed by the locale JSON on disk, for tests that assert the sentence
 * a screen shows rather than the key it looked up.
 *
 * The component suites mock `t` to echo its key, which is the right stub for
 * asserting wiring but blind to three things this change turns on: whether a
 * key resolves at all, which plural form `count` selects, and whether two
 * screens that must read alike actually do. Echoing `t` reports agreement
 * between two screens that both call the same key even when one of them
 * interpolates a different fallback into it.
 *
 * This is the real i18next, initialised from the real files, so plural
 * selection and interpolation are the ones production performs. Both locales
 * are loaded so a Spanish assertion needs no second instance.
 *
 * @version v1.5.0-beta
 */

import { createInstance, type ResourceLanguage, type TFunction } from "i18next";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const localesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "app",
  "i18n",
  "locales",
);

export type CatalogueLanguage = "en" | "es";

/** Every namespace file in one locale directory, keyed by namespace name. */
function loadLocale(language: CatalogueLanguage): ResourceLanguage {
  const dir = join(localesDir, language);
  const bundle: ResourceLanguage = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    bundle[file.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, file), "utf-8"));
  }
  return bundle;
}

/**
 * A `t` fixed to `namespace` and `language`, resolving against the shipped
 * catalogues. Keys carrying their own namespace (`common:untitled`) still
 * cross over, as they do in the app.
 */
export function catalogueT(namespace: string, language: CatalogueLanguage = "en"): TFunction {
  const instance = createInstance({
    lng: language,
    fallbackLng: "en",
    resources: { en: loadLocale("en"), es: loadLocale("es") },
    interpolation: { escapeValue: false },
  });
  // Resources are supplied inline rather than through a backend, so init
  // finishes before this call returns and the returned `t` is usable at once.
  void instance.init();
  return instance.getFixedT(language, namespace);
}
