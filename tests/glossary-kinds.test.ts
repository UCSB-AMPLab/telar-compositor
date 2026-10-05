/**
 * The kinds a site offers a glossary entry: what the site's files give, how a
 * stored value is matched to one, and that the match agrees with the
 * framework's own `resolve_kind`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { load } from "js-yaml";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NO_GLOSSARY_KINDS,
  foldKindValue,
  kindOfValue,
  parseGlossaryKinds,
  readKind,
  siteLanguage,
} from "~/lib/glossary-kinds";
import { FRAMEWORK_PYTHON, FRAMEWORK_SCRIPTS_DIR, describeWithFramework, frameworkCheckoutPresent } from "./helpers/framework-checkout";

const FRAMEWORK_DATA = join(FRAMEWORK_SCRIPTS_DIR, "..", "_data");
// Read at collection time even when the block is skipped, so an absent checkout reads as empty.
const coreKindsFile = () => (frameworkCheckoutPresent ? readFileSync(join(FRAMEWORK_DATA, "glossary_kinds.yml"), "utf-8") : "");
const langFileOf = (lang: string) =>
  frameworkCheckoutPresent ? readFileSync(join(FRAMEWORK_DATA, "languages", `${lang}.yml`), "utf-8") : "";

const CONFIG = `
title: Test
glossary:
  kinds:
    - id: species
      label: Especie
      heading: Especies
      values: [taxon, taxa]
    - id: tribe
      label: Tribe
      heading: Tribes
      values: [person]
    - id: nolabel
      heading: No label
    - id: Place
      label: Shadow
      heading: Shadow
`;

describeWithFramework("parseGlossaryKinds", () => {
  const kinds = parseGlossaryKinds(coreKindsFile(), CONFIG, langFileOf("en"));

  it("lists the core kinds in page order, then the site's, each under its label", () => {
    expect(kinds.available).toBe(true);
    expect(kinds.options.map((o) => [o.id, o.label])).toEqual([
      ["term", "Key term"],
      ["source", "Primary source"],
      ["entity", "Person or entity"],
      ["place", "Place"],
      ["species", "Especie"],
    ]);
  });

  it("gives each core kind the callout icon the core kinds file names, and a site kind none", () => {
    expect(kinds.options.map((o) => [o.id, o.icon])).toEqual([
      ["term", "bookmark"],
      ["source", "document"],
      ["entity", "person"],
      ["place", "pin"],
      ["species", undefined],
    ]);
  });

  it("labels the core kinds in the site's language, with the labels the site's own file holds", () => {
    const es = parseGlossaryKinds(coreKindsFile(), null, langFileOf("es"));
    const panels = (load(langFileOf("es")) as { panels: Record<string, string> }).panels;
    const expected = ["term", "source", "entity", "place"].map((id) => panels[`glossary_kind_${id}`]);
    expect(expected.every((label) => typeof label === "string" && label.length > 0)).toBe(true);
    expect(es.options.map((o) => o.label)).toEqual(expected);
    expect(es.options.map((o) => o.label)).not.toEqual(es.options.map((o) => o.id));
  });

  it("leaves out a site kind without a label, or whose id or values another kind owns", () => {
    expect(kinds.options.map((o) => o.id)).not.toContain("tribe");
    expect(kinds.options.map((o) => o.id)).not.toContain("nolabel");
    expect(kinds.options.map((o) => o.id)).not.toContain("Place");
  });

  it("offers no kinds for a site without the core kinds file, or with one that does not parse", () => {
    expect(parseGlossaryKinds(null, CONFIG, langFileOf("en"))).toEqual(NO_GLOSSARY_KINDS);
    expect(parseGlossaryKinds("{ not: [a list", CONFIG, null)).toEqual(NO_GLOSSARY_KINDS);
  });

  it("offers the core kinds alone when the config does not parse", () => {
    const core = parseGlossaryKinds(coreKindsFile(), "glossary: [unclosed", langFileOf("en"));
    expect(core.options.map((o) => o.id)).toEqual(["term", "source", "entity", "place"]);
  });

  it("keeps a value that names no kind as written and reads it as the default kind", () => {
    expect(kindOfValue(kinds, "Fuente??")).toBeUndefined();
    expect(readKind(kinds, "Fuente??")?.id).toBe("term");
    expect(readKind(kinds, "")?.id).toBe("term");
    expect(kindOfValue(kinds, "")?.id).toBe("term");
  });
});

describe("foldKindValue", () => {
  it("folds case, accents, underscores, hyphens and repeated spaces", () => {
    expect(foldKindValue("  Fuente_Primaria ")).toBe("fuente primaria");
    expect(foldKindValue("PRIMARY--source")).toBe("primary source");
    expect(foldKindValue("Organización")).toBe("organizacion");
  });
});

describeWithFramework("agreement with the framework's resolve_kind", () => {
  const VALUES = [
    "term", "Término", "KEY_TERM", "", "  ", "fuente   primaria", "Primary-Source", "SOURCE",
    "persona", "Entities", "corporate_body", "Organización", "PLACES", "Lugar", "territorio",
    "species", "Taxon", " TAXA ", "Especie", "tribe", "nonsense", "source?", "Fuente primaria.",
  ];

  it("resolves every value to the kind the framework resolves it to", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinds-"));
    writeFileSync(join(dir, "_config.yml"), CONFIG);
    const script = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
      "from telar.glossary_kinds import resolve_kind",
      "print(json.dumps([resolve_kind(v, warn=False) for v in json.load(sys.stdin)]))",
    ].join("\n");
    const out = execFileSync(FRAMEWORK_PYTHON, ["-c", script], {
      cwd: dir,
      input: JSON.stringify(VALUES),
      encoding: "utf-8",
    });
    const framework = JSON.parse(out.trim().split("\n").at(-1) as string) as string[];
    const kinds = parseGlossaryKinds(coreKindsFile(), CONFIG, langFileOf("en"));
    expect(VALUES.map((v) => readKind(kinds, v)?.id)).toEqual(framework);
  });
});

describe("siteLanguage", () => {
  it("names the language the way the framework reads telar_language", () => {
    expect(siteLanguage("telar_language: es\n")).toBe("es");
    expect(siteLanguage("telar_language: pt-BR\n")).toBe("pt-BR");
    expect(siteLanguage("title: x\n")).toBe("en");
    expect(siteLanguage(null)).toBe("en");
    expect(siteLanguage("{ unclosed")).toBe("en");
  });

  it("reads English for a name that could leave _data/languages", () => {
    expect(siteLanguage('telar_language: "../x"\n')).toBe("en");
    expect(siteLanguage('telar_language: "a/b"\n')).toBe("en");
  });
});

/** Runs a snippet in the framework's venv with `sys.path` set, JSON in and JSON out. */
function frameworkJson(body: string, cwd: string, input: unknown): unknown {
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    body,
  ].join("\n");
  const out = execFileSync(FRAMEWORK_PYTHON, ["-c", script], {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf-8",
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string);
}

const SITE_CONFIGS: Record<string, string> = {
  valid: "glossary:\n  kinds:\n    - {id: species, label: Species, heading: Species, values: [taxon, taxa]}\n",
  "values as a string": "glossary:\n  kinds:\n    - {id: species, label: S, heading: S, values: taxon}\n",
  "values null": "glossary:\n  kinds:\n    - {id: species, label: S, heading: S, values: null}\n",
  "values with a null": "glossary:\n  kinds:\n    - {id: species, label: S, heading: S, values: [taxon, null]}\n",
  "values with a mapping": "glossary:\n  kinds:\n    - {id: species, label: S, heading: S, values: [{a: b}]}\n",
  "values numbers and booleans": "glossary:\n  kinds:\n    - {id: species, label: S, heading: S, values: [7, true]}\n",
  "missing label": "glossary:\n  kinds:\n    - {id: species, heading: S}\n",
  "missing heading": "glossary:\n  kinds:\n    - {id: species, label: S}\n",
  "blank label": "glossary:\n  kinds:\n    - {id: species, label: '  ', heading: S}\n",
  "label not a string": "glossary:\n  kinds:\n    - {id: species, label: 5, heading: S}\n",
  "taken id": "glossary:\n  kinds:\n    - {id: Place, label: S, heading: S}\n",
  "taken value": "glossary:\n  kinds:\n    - {id: species, label: S, heading: S, values: [Lugar]}\n",
  "taken by an earlier site kind": "glossary:\n  kinds:\n    - {id: a, label: A, heading: A, values: [x]}\n    - {id: b, label: B, heading: B, values: [X_]}\n",
  "id among its own values": "glossary:\n  kinds:\n    - {id: a, label: A, heading: A, values: [a, A]}\n",
  "id padded": "glossary:\n  kinds:\n    - {id: ' pad ', label: ' L ', heading: H}\n",
  "id blank": "glossary:\n  kinds:\n    - {id: '', label: A, heading: A}\n",
  "id not a string": "glossary:\n  kinds:\n    - {id: 5, label: A, heading: A}\n",
  "entry not a mapping": "glossary:\n  kinds:\n    - just text\n    - {id: ok, label: A, heading: A}\n",
  "kinds not a list": "glossary:\n  kinds: {id: a}\n",
  "glossary not a mapping": "glossary: [a, b]\n",
  "no glossary": "title: x\n",
};

describeWithFramework("agreement with the framework's acceptance of site kinds", () => {
  it("accepts the same site kinds, in the same order, with the same labels and values", () => {
    const names = Object.keys(SITE_CONFIGS);
    const framework = frameworkJson(
      [
        "import os, tempfile",
        "from telar.glossary_kinds import site_kinds, _fold",
        "out = []",
        "for config in json.load(sys.stdin):",
        "    os.chdir(tempfile.mkdtemp())",
        "    open('_config.yml', 'w').write(config)",
        "    out.append([{'id': k['id'], 'label': k['label'], 'aliases': [_fold(v) for v in [k['id'], *k['values']]]} for k in site_kinds()])",
        "print(json.dumps(out))",
      ].join("\n"),
      tmpdir(),
      names.map((n) => SITE_CONFIGS[n]),
    ) as Array<Array<{ id: string; label: string; aliases: string[] }>>;
    names.forEach((name, i) => {
      const kinds = parseGlossaryKinds(coreKindsFile(), SITE_CONFIGS[name], langFileOf("en"));
      const mine = kinds.options.slice(4).map((o) => ({ id: o.id, label: o.label, aliases: o.aliases }));
      expect(mine, name).toEqual(framework[i]);
    });
  });
});

describeWithFramework("agreement with the framework's _fold", () => {
  const VALUES = [
    "Straße", "STRASSE", "strasse", "ſource", "Σίσυφος", "ΣΊΣΥΦΟΣ", "ς", "İstanbul", "ǅ", "ﬁle", "Ĳ",
    "e\u0301", "कि", "  A_b-C  ", "Primary\u00a0Source", "ǰ", "ΐ", "Ꭰ", "ẞ", "\u0345x",
  ];

  it("folds every value as the framework folds it", () => {
    const framework = frameworkJson(
      "from telar.glossary_kinds import _fold\nprint(json.dumps([_fold(v) for v in json.load(sys.stdin)]))",
      tmpdir(),
      VALUES,
    ) as string[];
    expect(VALUES.map(foldKindValue)).toEqual(framework);
  });
});
