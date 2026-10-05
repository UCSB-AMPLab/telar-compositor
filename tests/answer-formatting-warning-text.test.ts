/**
 * This file pins the sentence an author actually reads when an answer uses
 * formatting the build flattens, in both locales, against the real catalogues.
 *
 * The check names the kinds by key, because it runs on the server with no
 * locale; the words and the conjunction that joins them are the renderer's,
 * and a join written by hand would read "listas, encabezados and citas" in one
 * language or the other. Every other test in the suite mocks `t` to echo its
 * key, so nothing else would catch a catalogue that lost the formatter
 * annotation or a list that came back joined the English way.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createInstance, type i18n } from "i18next";

import { checkMessage } from "~/components/features/publish/ValidationChecks";
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

describe("the formatting warning as a reader sees it", () => {
  // The page's own path end to end, not a copy of any part of it: the kinds
  // are named from their keys, the values are stood aside while i18next works,
  // and what an author wrote comes back afterwards.
  const sentence = (instance: i18n, kinds: string[]) =>
    checkMessage(
      instance.t.bind(instance) as (key: string, values?: Record<string, unknown>) => string,
      {
        code: "step_answer_has_formatting",
        message: "step_answer_has_formatting",
        params: { number: "3", story: "The Weavers", kinds },
      },
    );

  it("joins three kinds with English's own conjunction", () => {
    expect(sentence(en, ["list", "heading", "blockquote"])).toBe(
      'The answer for step 3 of "The Weavers" uses lists, headings, and block quotes, ' +
        "but answers are text only — the published site will show the words without that formatting.",
    );
  });

  it("joins three kinds with Spanish's own conjunction", () => {
    expect(sentence(es, ["list", "heading", "blockquote"])).toBe(
      'La respuesta del paso 3 de "The Weavers" usa listas, encabezados y citas, ' +
        "pero las respuestas son solo texto — el sitio publicado mostrará las palabras sin ese formato.",
    );
  });

  it("joins two kinds without a comma before the conjunction", () => {
    expect(sentence(en, ["list", "rule"])).toContain("uses lists and horizontal rules,");
    expect(sentence(es, ["list", "rule"])).toContain("usa listas y líneas divisorias,");
  });

  it("names one kind alone, with no conjunction at all", () => {
    expect(sentence(en, ["heading"])).toContain("uses headings,");
    expect(sentence(es, ["heading"])).toContain("usa encabezados,");
  });

  it("selects the plural form of a blocked kind by its count", () => {
    const one = { number: "3", story: "The Weavers", count: 1 };
    expect(en.t("checks.step_answer_has_table", one)).toContain("has a table");
    expect(es.t("checks.step_answer_has_table", one)).toContain("tiene una tabla");
    const many = { ...one, count: 4 };
    expect(en.t("checks.step_answer_has_table", many)).toContain("has 4 tables");
    expect(es.t("checks.step_answer_has_table", many)).toContain("tiene 4 tablas");
  });
});

describe("a story title that looks like interpolation syntax", () => {
  // i18next replaces a matched placeholder with String.replace, which finds
  // the FIRST occurrence of that text in the whole message rather than the one
  // it matched. A title carrying `{{count}}` is therefore substituted with the
  // count, and the message's own placeholder is left standing.
  const TITLE = "{{count}} <img src=x>";
  const params = { number: "3", story: TITLE, count: 2 };

  it.each([
    ["English", () => en, "has 2 tables"],
    ["Spanish", () => es, "tiene 2 tablas"],
  ])("renders the title literally and the count as a number in %s", (_l, get, counted) => {
    const instance = get();

    // The page's own path, end to end: a copy of the preparation or of the
    // restoration would pass while the page did something else.
    const out = checkMessage(
      instance.t.bind(instance) as (key: string, values?: Record<string, unknown>) => string,
      { code: "step_answer_has_table", message: "step_answer_has_table", params },
    );

    expect(out).toContain(counted);
    // Byte for byte, with nothing stripped: the title reads as it was written
    // and carries no character an author did not type.
    expect(out).toContain(`"${TITLE}"`);
    expect(out).not.toContain("\u200b");
  });
});

// A stand-in only works while it stands for nothing else. An author who types
// one of these into a title is not attacking anything in particular — but a
// stand-in that appears in the text it protects, or one restored into a value
// that is then read as another stand-in, renders a title nobody wrote.
describe("a title that carries the machinery's own stand-in", () => {
  const render = (instance: i18n, params: Record<string, string | number>) =>
    checkMessage(
      instance.t.bind(instance) as (key: string, values?: Record<string, unknown>) => string,
      { code: "glossary_reserved_column", message: "glossary_reserved_column", params },
    );

  it("renders a value equal to a stand-in as itself", () => {
    const id = "\u0000v0\u0000";

    const out = render(en, { id, column: "{{count}}" });

    expect(out).toContain(`"${id}"`);
    expect(out).toContain('"{{count}}"');
  });

  it("renders a value carrying another value's stand-in as itself", () => {
    const id = "{{x}}\u0000v1\u0000";

    const out = render(en, { id, column: "{{y}}" });

    expect(out).toContain(`"${id}"`);
    expect(out).toContain('"{{y}}"');
  });

  it("renders a list of authored names literally, however they are spelled", () => {
    const columns = ["{{count}}", "\u0000v0\u0000", "credit"];

    const out = checkMessage(
      en.t.bind(en) as (key: string, values?: Record<string, unknown>) => string,
      {
        code: "objects_colliding_columns",
        message: "objects_colliding_columns",
        params: { columns },
      },
    );

    for (const column of columns) expect(out).toContain(column);
  });
});
