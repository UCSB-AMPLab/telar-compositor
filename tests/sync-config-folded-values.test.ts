/**
 * The sync reads each managed top-level `_config.yml` value from the parsed
 * document where the file parses (TEL-772): a value folded over several lines,
 * or a block scalar, reads whole, as the publish writer reads it. A file that
 * does not parse is read line by line, as before, and a single-line value
 * reads exactly as the line walk read it, so a site that has not changed
 * shows no change.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect } from "vitest";
import { load as loadYaml } from "js-yaml";

import { CONFIG_YAML_KEY_ALIASES, MANAGED_CONFIG_FIELDS, extractConfigFields } from "~/lib/sync.server";
import { parseYamlScalar, readConfigScalar, topLevelKeyRemainder } from "~/lib/config-yaml-block.server";

/** The managed fields read from a top-level key, with the key each is read from. */
const TOP_LEVEL = MANAGED_CONFIG_FIELDS.filter(
  (field) => field !== "story_key" && field !== "glossary_kinds_json" && !(CONFIG_YAML_KEY_ALIASES[field] ?? "").includes("."),
).map((field) => [field, CONFIG_YAML_KEY_ALIASES[field] ?? field] as const);

/** The line walk's reading of a top-level key, as the sync read every file before. */
function lineReading(yaml: string, key: string): string | null {
  const raw = topLevelKeyRemainder(yaml, key);
  return raw === undefined ? null : parseYamlScalar(raw);
}

const FOLDED = `title: "Telar"
description: Telar (Spanish for 'loom') is a static site generator built on Jekyll that
  weaves together IIIF images, text, and layered contextual information.
author: First Placeholder Author, Second Placeholder Author,
  Third Placeholder Author
email: |
  someone@example.org
url: "https://example.org"
`;

describe("extractConfigFields — values over several lines", () => {
  it("reads a folded description, a folded author and a block scalar whole", () => {
    expect(() => loadYaml(FOLDED)).not.toThrow();
    const fields = extractConfigFields(FOLDED);
    expect(fields.description).toBe(
      "Telar (Spanish for 'loom') is a static site generator built on Jekyll that weaves together IIIF images, text, and layered contextual information.",
    );
    expect(fields.author).toBe("First Placeholder Author, Second Placeholder Author, Third Placeholder Author");
    expect(fields.email).toBe("someone@example.org\n");
    expect(fields.url).toBe("https://example.org");
  });

  it("reads a folded url whole through readConfigScalar too", () => {
    const yaml = 'url: "https://example.org/\n  path"\nbaseurl: ""\n';
    expect(readConfigScalar(yaml, "url")).toBe("https://example.org/ path");
    expect(readConfigScalar(yaml, "baseurl")).toBe("");
    expect(readConfigScalar(yaml, "logo")).toBeUndefined();
  });

  it("falls back to the line walk in a file that does not parse, as before", () => {
    const broken = `${FOLDED}defaults:\n\tscope: all\n`;
    expect(() => loadYaml(broken)).toThrow();
    const fields = extractConfigFields(broken);
    for (const [field, key] of TOP_LEVEL) {
      expect({ field, value: fields[field] }).toEqual({ field, value: lineReading(broken, key) });
    }
    expect(fields.description).toBe("Telar (Spanish for 'loom') is a static site generator built on Jekyll that");
  });
});

/**
 * Single-line values in the shapes a site's file holds them, each read the
 * way the line walk read it, so the sync compares them with D1 as before.
 */
const SINGLE_LINE: string[] = [
  `title: "Telar"
telar_language: "en" # Options: "en" (English), "es" (Español)
baseurl: "/telar"
url: "https://ampl.example.org"
description: "Telar (Spanish for 'loom') weaves <a href='https://example.org'>images</a> and \\"text\\"."
author: ""
email: ""
logo: ""
collection_mode: false # Set to true to show objects first
telar_theme: "trama" # Options: trama, paisajes
`,
  `title: Telar
telar_language: es
baseurl:
url: https://example.org
description: 'It''s a site'
author: Ana # a comment
email: a#b@example.org
logo: /assets/logo.png
collection_mode: true
telar_theme: paisajes
`,
  `title: 2024
telar_language: en
baseurl: # root site
url: ~
description: yes
author: 'O''Brien'
email: "a@example.org"
logo: null
collection_mode: no
telar_theme: "custom"
`,
  `title: '0042'
description: 1.50
collection_mode: True
author: "tab\\tescape"
`,
];

describe("extractConfigFields — single-line values read as the line walk read them", () => {
  it.each(SINGLE_LINE.map((yaml, i) => [i, yaml] as const))("fixture %i", (_i, yaml) => {
    expect(() => loadYaml(yaml)).not.toThrow();
    const fields = extractConfigFields(yaml);
    for (const [field, key] of TOP_LEVEL) {
      expect({ field, value: fields[field] }).toEqual({ field, value: lineReading(yaml, key) });
    }
  });

  it("covers every managed top-level field", () => {
    expect(TOP_LEVEL.map(([, key]) => key).sort()).toEqual(
      ["author", "baseurl", "collection_mode", "description", "email", "logo", "telar_language", "telar_theme", "title", "url"],
    );
  });
});

describe("a number or boolean the key's line does not hold", () => {
  it("reads an aliased boolean as its value", () => {
    const yaml = "show: &show true\ncollection_mode: *show\n";
    expect(extractConfigFields(yaml).collection_mode).toBe("true");
  });

  it("reads the top-level key, not a key-shaped line inside another value", () => {
    const yaml = 'description: "To enable the collection, set\ncollection_mode: true\nin your configuration."\ncollection_mode: false\n';
    expect(extractConfigFields(yaml).collection_mode).toBe("false");
  });
});
