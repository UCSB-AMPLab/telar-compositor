/**
 * Which of a site's own glossary kinds the framework would leave out, and why,
 * field by field: what the kinds dialog shows and what a save refuses.
 *
 * The expected results in FRAMEWORK were produced once by running these same
 * fixtures through the framework's `_site_kind_problem`, in the order
 * `_site_kinds_for` runs it (scripts/telar/glossary_kinds.py at the framework
 * main b0cac927, with that checkout's .venv python), and are frozen here, so
 * this file runs without the checkout. The framework reports the first
 * problem it finds; `firstProblem` reads ours in the same order.
 *
 * CORE is the framework's `_data/glossary_kinds.yml` at that commit, its ids
 * and values verbatim, with each `panel_label` written as the English label
 * the language file gives it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  parseGlossaryKinds,
  serializeSiteKinds,
  storedSiteKinds,
  validateSiteKinds,
  withSiteKinds,
  type KindProblem,
  type SiteKindProblems,
} from "~/lib/glossary-kinds";

const CORE = `
- id: term
  default: true
  values: [term, término, key term, palabra clave]
  panel_label: Key term
- id: source
  values: [source, fuente, primary source, fuente primaria]
  panel_label: Primary source
- id: entity
  values: [entity, entities, person, people, character, characters, group,
           groups, organization, organisation, organizations, institution,
           institutions, community, communities, family, families,
           corporate body, corporate bodies, agent, agents,
           entidad, entidades, persona, personas, personaje, personajes,
           grupo, grupos, organización, organizaciones, institución,
           instituciones, colectivo, colectivos, comunidad, comunidades,
           familia, familias, entidad corporativa, entidades corporativas,
           agente, agentes]
  panel_label: Person or entity
- id: place
  values: [place, places, site, sites, territory, territories,
           lugar, lugares, sitio, sitios, territorio, territorios]
  panel_label: Place
`;

const coreKinds = parseGlossaryKinds(CORE, null, null);
const CORE_LABELS: Record<string, string> = Object.fromEntries(coreKinds.core.map((o) => [o.id, o.label]));

const FIXTURES: Record<string, unknown[]> = {
  required: [
    { id: "", label: "A", heading: "A" },
    { id: "x", heading: "H" },
    { id: "y", label: "L" },
    { id: "z", label: "  ", heading: "H" },
    { id: 5, label: "A", heading: "A" },
    { id: "w", label: 5, heading: "H" },
  ],
  "folded across case and accent": [
    { id: "Especie", label: "E", heading: "E" },
    { id: "ESPÉCIE", label: "F", heading: "F" },
  ],
  "folded across underscore and hyphen": [
    { id: "fuente-x", label: "A", heading: "A" },
    { id: "b", label: "B", heading: "B", values: ["Fuente_X"] },
  ],
  "a core id": [{ id: "Place", label: "S", heading: "S" }],
  "a core value": [{ id: "s", label: "S", heading: "S", values: ["ok", "Fuente_Primaria"] }],
  "an earlier site kind, not a later one": [
    { id: "a", label: "A", heading: "A", values: ["x"] },
    { id: "b", label: "B", heading: "B", values: ["X_"] },
  ],
  "a rejected earlier kind takes nothing": [
    { id: "a", heading: "A", values: ["x"] },
    { id: "b", label: "B", heading: "B", values: ["x"] },
  ],
  "a kind's own repeated value": [{ id: "a", label: "A", heading: "A", values: ["a", "A", "b", "B"] }],
  values: [
    { id: "s1", label: "S", heading: "S", values: "taxon" },
    { id: "s2", label: "S", heading: "S", values: [null] },
    { id: "s3", label: "S", heading: "S", values: [{ a: 1 }] },
    { id: "s4", label: "S", heading: "S", values: null },
    { id: "s5", label: "S", heading: "S", values: [7, true] },
  ],
  "not a mapping": ["text", { id: "ok", label: "A", heading: "A" }],
};

type Frozen = null | [KindProblem["key"]] | [KindProblem["key"], string, string];

/** The framework's verdict on each fixture: null for accepted, else the problem, the value and the owning kind's id. */
const FRAMEWORK: Record<string, Frozen[]> = {
  required: [
    ["kind_error_id_required"],
    ["kind_error_label_required"],
    ["kind_error_heading_required"],
    ["kind_error_label_required"],
    ["kind_error_id_required"],
    ["kind_error_label_required"],
  ],
  "folded across case and accent": [null, ["kind_error_id_taken", "ESPÉCIE", "Especie"]],
  "folded across underscore and hyphen": [null, ["kind_error_value_taken", "Fuente_X", "fuente-x"]],
  "a core id": [["kind_error_id_taken", "Place", "place"]],
  "a core value": [["kind_error_value_taken", "Fuente_Primaria", "source"]],
  "an earlier site kind, not a later one": [null, ["kind_error_value_taken", "X_", "a"]],
  "a rejected earlier kind takes nothing": [["kind_error_label_required"], null],
  "a kind's own repeated value": [null],
  values: [["kind_error_values_not_list"], ["kind_error_values_not_list"], ["kind_error_values_not_list"], null, null],
  "not a mapping": [["kind_error_id_required"], null],
};

const ORDER: KindProblem["key"][] = [
  "kind_error_id_required",
  "kind_error_label_required",
  "kind_error_heading_required",
  "kind_error_values_not_list",
  "kind_error_id_taken",
  "kind_error_value_taken",
];

function firstProblem(problems: SiteKindProblems): KindProblem | null {
  const all = Object.values(problems) as KindProblem[];
  return all.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key))[0] ?? null;
}

/** The label a frozen owner id is shown under: a core kind's, or the fixture's site kind's. */
function ownerLabel(kinds: unknown[], owner: string): string {
  const site = kinds.find((k) => (k as { id?: unknown }).id === owner) as { label: string } | undefined;
  return site ? site.label : CORE_LABELS[owner];
}

describe("validateSiteKinds against the framework's verdicts", () => {
  it.each(Object.keys(FIXTURES))("%s", (name) => {
    const list = FIXTURES[name];
    const mine = validateSiteKinds(coreKinds.core, list).map((problems) => {
      const first = firstProblem(problems);
      if (!first) return null;
      return first.value === undefined ? [first.key] : [first.key, first.value, first.kind];
    });
    const expected = FRAMEWORK[name].map((f) => (f && f.length === 3 ? [f[0], f[1], ownerLabel(list, f[2])] : f));
    expect(mine).toEqual(expected);
  });
});

describe("validateSiteKinds, field by field", () => {
  it("names every missing field of a kind, not only the first", () => {
    expect(validateSiteKinds(coreKinds.core, [{ id: " ", label: "", heading: null }])).toEqual([
      {
        id: { key: "kind_error_id_required" },
        label: { key: "kind_error_label_required" },
        heading: { key: "kind_error_heading_required" },
      },
    ]);
  });

  it("puts a taken id on the id and a taken value on the values", () => {
    const [byId, byValue] = validateSiteKinds(coreKinds.core, [
      { id: "lugar", label: "L", heading: "L" },
      { id: "own", label: "O", heading: "O", values: ["Términó"] },
    ]);
    expect(byId).toEqual({ id: { key: "kind_error_id_taken", value: "lugar", kind: "Place" } });
    expect(byValue).toEqual({ values: { key: "kind_error_value_taken", value: "Términó", kind: "Key term" } });
  });

  it("accepts an empty list", () => {
    expect(validateSiteKinds(coreKinds.core, [])).toEqual([]);
  });
});

describe("the stored form", () => {
  it("writes each kind's four fields trimmed, in a fixed order, and nothing else", () => {
    const stored = serializeSiteKinds([
      { values: ["x", 7, true], heading: " H ", from: "old", label: " L ", id: " k " },
    ]);
    expect(stored).toBe('[{"id":"k","label":"L","heading":"H","values":["x","7","True"]}]');
  });

  it("keeps scalar values as text in the stored form, and a list as a list", () => {
    const stored = serializeSiteKinds([
      { id: "a", label: "A", heading: "A", values: "taxon" },
      { id: "b", label: "B", heading: "B", values: ["taxon"] },
    ]);
    expect(stored).toBe('[{"id":"a","label":"A","heading":"A","values":"taxon"},{"id":"b","label":"B","heading":"B","values":["taxon"]}]');
  });

  it("validates a stored scalar-values kind as not a list, and still drafts it as a list", () => {
    const stored = storedSiteKinds(serializeSiteKinds([{ id: "a", label: "A", heading: "A", values: "taxon" }]));
    const kinds = withSiteKinds(coreKinds, stored ?? []);
    expect(kinds.site.map((k) => [k.values, k.problems])).toEqual([[["taxon"], { values: { key: "kind_error_values_not_list" } }]]);
  });

  it("reads null, and anything but a JSON list, as no stored kinds", () => {
    expect(storedSiteKinds(null)).toBeNull();
    expect(storedSiteKinds("{broken")).toBeNull();
    expect(storedSiteKinds('{"id":"a"}')).toBeNull();
    expect(storedSiteKinds("[]")).toEqual([]);
  });

  it("keeps values that are not a list as their text in the draft, still marked", () => {
    const kinds = withSiteKinds(coreKinds, [
      { id: "s1", label: "S", heading: "S", values: "taxon" },
      { id: "s2", label: "S", heading: "S", values: ["taxon", null, { a: 1 }] },
      { id: "s3", label: "S", heading: "S", values: { a: 1 } },
    ]);
    expect(kinds.site.map((k) => [k.values, k.problems])).toEqual([
      [["taxon"], { values: { key: "kind_error_values_not_list" } }],
      [["taxon", "null", '{"a":1}'], { values: { key: "kind_error_values_not_list" } }],
      [['{"a":1}'], { values: { key: "kind_error_values_not_list" } }],
    ]);
    expect(kinds.options.map((o) => o.id)).not.toContain("s1");
  });

  it("reads a list that holds itself as an empty text, still marked, and keeps every other kind", () => {
    const config = [
      "glossary:",
      "  kinds:",
      "    - {id: loop, label: Loop, heading: Loops, values: &loop [*loop]}",
      "    - {id: species, label: Species, heading: Species}",
    ].join("\n");
    const kinds = parseGlossaryKinds(CORE, config, null);
    expect(kinds.available).toBe(true);
    expect(kinds.site.map((k) => [k.id, k.values, k.problems])).toEqual([
      ["loop", [""], { values: { key: "kind_error_values_not_list" } }],
      ["species", [], {}],
    ]);
    expect(kinds.options.map((o) => o.id)).toEqual([...coreKinds.core.map((o) => o.id), "species"]);
  });

  it("offers the accepted site kinds after the core ones and keeps every kind as written", () => {
    const kinds = withSiteKinds(coreKinds, [
      { id: "species", label: "Species", heading: "Species" },
      { id: "Place", label: "P", heading: "P" },
    ]);
    expect(kinds.options.map((o) => o.id)).toEqual(["term", "source", "entity", "place", "species"]);
    expect(kinds.site.map((k) => [k.id, Object.keys(k.problems)])).toEqual([["species", []], ["Place", ["id"]]]);
  });
});
