/**
 * A string filed under the wrong language.
 *
 * `i18n-parity.test.ts` holds that both catalogues have the same keys and no
 * empty value. A crossed pair passes it: the English value sits in the Spanish
 * file and the Spanish one in the English file, both keys present, both values
 * different. So this test reads each value for the language it is in.
 *
 * - An English value must not carry Spanish orthography (á é í ó ú ñ ü ¿ ¡) or
 *   a Spanish-only function word.
 * - A Spanish value must not carry an English-only function word. Loanwords and
 *   product names ("commit", "workflow", "GitHub") are ordinary in Colombian UI
 *   copy, and none of them is on the list.
 *
 * The lists hold only words that cannot be the other language's: "con", "sin",
 * "hay" and "ya" are English words too, and "has" is Spanish. At one word the
 * catalogues trip neither list today, apart from the excused key below.
 *
 * A value with nothing to translate (interpolation, markup, punctuation, URLs)
 * is skipped by construction: the words are read from what is left once those
 * are removed.
 *
 * What this cannot see: a crossed pair of values with no function word and no
 * accent, such as "Account" and "Cuenta". Catching those needs a lexicon, which
 * this is not. An English value with an accented loanword ("café") would trip
 * the orthography check and needs an excuse below. A subtly wrong translation is
 * the revisor-espanol pass's job, not this test's.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOCALES = join(process.cwd(), "app", "i18n", "locales");

/** Words that occur in Spanish UI prose and not in English. */
const SPANISH_ONLY = new Set(
  ("el la los las del que para una por este esta estos estas sus tus pero " +
    "cuando donde también está están puedes tienes aquí sobre entre desde " +
    "hasta muy más eso esto").split(" "),
);

/** Words that occur in English UI prose and not in Spanish. */
const ENGLISH_ONLY = new Set(
  ("the and your you with this that from for are will have was were which " +
    "into when there their they would").split(" "),
);

const SPANISH_ORTHOGRAPHY = /[áéíóúñü¿¡]/i;

/**
 * Keys whose value is deliberately in the other language, each with its
 * reason. A key here must still trip the check it is excused from, or it is
 * stale and fails below.
 */
const DELIBERATELY_OTHER_LANGUAGE: Record<string, { in: "en" | "es"; why: string }> = {
  "onboarding:create_site.form.language_es": {
    in: "en",
    why: "a language picker names each language in itself, so Spanish is 'Español' in the English file",
  },
};

type Catalogue = Map<string, string>;

function leaves(value: unknown, prefix: string, out: Catalogue): void {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      leaves(v, prefix.endsWith(":") ? `${prefix}${k}` : `${prefix}.${k}`, out);
    }
    return;
  }
  out.set(prefix, String(value));
}

function loadCatalogue(lang: "en" | "es"): Catalogue {
  const out: Catalogue = new Map();
  const dir = join(LOCALES, lang);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    leaves(JSON.parse(readFileSync(join(dir, file), "utf8")), `${file.replace(/\.json$/, "")}:`, out);
  }
  return out;
}

/** The prose left once interpolation, markup, URLs and code spans are removed. */
export function proseOf(value: string): string {
  return value
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`[^`]*`/g, " ");
}

/** The words of a value; a token holding a digit, such as a course code, is not a word. */
function wordsOf(value: string): string[] {
  const tokens = proseOf(value).toLowerCase().match(/[a-z0-9áéíóúñü]+/g) ?? [];
  return tokens.filter((token) => !/\d/.test(token));
}

/** Why an English value reads as Spanish, or null. */
export function spanishInEnglish(value: string): string | null {
  if (SPANISH_ORTHOGRAPHY.test(proseOf(value))) return "Spanish orthography";
  const found = new Set(wordsOf(value).filter((w) => SPANISH_ONLY.has(w)));
  return found.size > 0 ? `Spanish words: ${[...found].join(", ")}` : null;
}

/** Why a Spanish value reads as English, or null. */
export function englishInSpanish(value: string): string | null {
  const found = new Set(wordsOf(value).filter((w) => ENGLISH_ONLY.has(w)));
  return found.size > 0 ? `English words: ${[...found].join(", ")}` : null;
}

const catalogues = { en: loadCatalogue("en"), es: loadCatalogue("es") };
const detectors = { en: spanishInEnglish, es: englishInSpanish };

describe("what counts as a word", () => {
  it("a course code is not read as a word", () => {
    expect(spanishInEnglish("Thanks to the INT 138LA students")).toBeNull();
    expect(spanishInEnglish("Thanks to la clase")).toBe("Spanish words: la");
  });
});

describe("every value is in the language of its catalogue", () => {
  for (const lang of ["en", "es"] as const) {
    it(`${lang}: no value reads as the other language`, () => {
      const misfiled: string[] = [];
      for (const [key, value] of catalogues[lang]) {
        const reason = detectors[lang](value);
        const excused = DELIBERATELY_OTHER_LANGUAGE[key]?.in === lang;
        if (reason && !excused) misfiled.push(`${key}: ${JSON.stringify(value)} (${reason})`);
      }
      expect(misfiled, "a value in the wrong language's catalogue").toEqual([]);
    });
  }

  it("every excused key still exists and still needs the excuse", () => {
    const stale: string[] = [];
    for (const [key, entry] of Object.entries(DELIBERATELY_OTHER_LANGUAGE)) {
      const value = catalogues[entry.in].get(key);
      if (value === undefined || !detectors[entry.in](value)) stale.push(key);
    }
    expect(stale).toEqual([]);
  });

  it("every excused key says why", () => {
    for (const entry of Object.values(DELIBERATELY_OTHER_LANGUAGE)) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

describe("the detectors", () => {
  it("catch both halves of a crossed pair", () => {
    const en = "Guarda los cambios para que el sitio se actualice";
    const es = "Save your changes so that the site updates";
    expect(spanishInEnglish(en)).not.toBeNull();
    expect(englishInSpanish(es)).not.toBeNull();
  });

  it("catch a short Spanish value by its orthography", () => {
    expect(spanishInEnglish("Configuración")).not.toBeNull();
  });

  it("catch a short crossed value carrying one function word", () => {
    expect(englishInSpanish("Save your changes")).not.toBeNull();
    expect(spanishInEnglish("Guarda los cambios")).not.toBeNull();
  });

  it("let loanwords and product names stand in Spanish copy", () => {
    expect(englishInSpanish("Abre el commit en GitHub")).toBeNull();
    expect(englishInSpanish("Publica con el workflow de la plantilla")).toBeNull();
  });

  it("read no English word that is also Spanish, and no Spanish word that is also English", () => {
    expect(englishInSpanish("Todavía no has elegido un tema")).toBeNull();
    expect(spanishInEnglish("Mark each claim as pro or con, and flag any logical sin")).toBeNull();
  });

  it("read nothing into interpolation, markup or URLs", () => {
    expect(englishInSpanish("{{the}} {{and}} <b>ok</b> https://example.org/the/and")).toBeNull();
    expect(spanishInEnglish("{{configuración}} and more")).toBeNull();
  });
});
