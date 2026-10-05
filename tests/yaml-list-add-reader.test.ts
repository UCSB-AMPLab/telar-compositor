/**
 * `yaml_list_add` finds the top-level key where Jekyll's YAML reader finds it:
 * after a BOM or a `---` line, at the indentation of a mapping
 * indented as a whole, plain or quoted, with spaces before its colon, and in
 * the first document only. Mirrors the framework's
 * `TestExcludeWhereJekyllReadsIt` (the framework
 * `tests/unit/test_migration_v180_sources.py`); the framework writes
 * each group's comment block, which the manifest does not carry, so the
 * expected bytes here are the framework's without those comments and in the
 * manifest's order.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { load, loadAll } from "js-yaml";
import { applyYamlListAdd, YamlListAddError } from "~/lib/yaml-list-add.server";
import type { YamlListAddOp } from "~/lib/manifest-schema.server";
import { sameYamlValue } from "~/lib/yaml.server";

const VALUES = ["telar-content/texts/", "tests/", "pytest.ini", "vitest.config.js"];
const OP: YamlListAddOp = { type: "yaml_list_add", file: "_config.yml", key: "exclude", values: VALUES };

const BOM = "﻿";
const ALL_FOUR = VALUES.map((value) => `  - ${value}\n`).join("");
const FLOW = VALUES.join(", ");

function indented(block: string, by = "  "): string {
  return block.split(/(?<=\n)/).filter(Boolean).map((line) => by + line).join("");
}

const withCrlfEndings = (text: string) => text.replace(/\n/g, "\r\n");

function runEdit(text: string): string {
  const files = new Map([["_config.yml", text]]);
  applyYamlListAdd(files, OP);
  return files.get("_config.yml")!;
}

/** The first document of `text`, the one Jekyll reads. */
function firstDocumentOf(text: string): Record<string, unknown> {
  const docs = loadAll(text.replace(/^﻿/, ""), undefined, { json: true });
  return (docs[0] ?? {}) as Record<string, unknown>;
}

function excludeItemsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined || typeof value === "object" ? [] : [value];
}

function withoutExclude(mapping: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mapping).filter(([key]) => key !== "exclude"));
}

// Input, and the bytes the operation writes: the framework's READER_CASES.
const READER_CASES: Array<[string, string, string]> = [
  ["bom-scalar", `${BOM}exclude: vendor\n`, `${BOM}exclude:\n  - vendor\n${ALL_FOUR}`],
  ["bom-null", `${BOM}exclude: null\n`, `${BOM}exclude:\n${ALL_FOUR}`],
  ["bom-crlf", `${BOM}exclude: vendor\r\ntitle: x\r\n`,
    `${BOM}exclude:\r\n  - vendor\r\n${withCrlfEndings(ALL_FOUR)}title: x\r\n`],
  ["bom-comment-first", `${BOM}# My site\nexclude: vendor\n`, `${BOM}# My site\nexclude:\n  - vendor\n${ALL_FOUR}`],
  ["bom-block", `${BOM}exclude:\n  - vendor\n`, `${BOM}exclude:\n  - vendor\n${ALL_FOUR}`],
  ["bom-flow", `${BOM}exclude: [vendor]\n`, `${BOM}exclude: [vendor, ${FLOW}]\n`],
  ["indented-scalar", "  exclude: vendor\n", `  exclude:\n    - vendor\n${indented(ALL_FOUR)}`],
  ["indented-scalar-comment", "  title: x\n  exclude: vendor # gems\n  other: 1\n",
    `  title: x\n  exclude: # gems\n    - vendor\n${indented(ALL_FOUR)}  other: 1\n`],
  ["indented-null", "  exclude: ~\n  other: 1\n", `  exclude:\n${indented(ALL_FOUR)}  other: 1\n`],
  ["indented-bare", "  exclude:\n  other: 1\n", `  exclude:\n${indented(ALL_FOUR)}  other: 1\n`],
  ["indented-block", "  title: x\n  exclude:\n    - vendor\n  other: 1\n",
    `  title: x\n  exclude:\n    - vendor\n${indented(ALL_FOUR)}  other: 1\n`],
  ["indented-block-at-key", "  exclude:\n  - vendor\n  other: 1\n", `  exclude:\n  - vendor\n${ALL_FOUR}  other: 1\n`],
  ["indented-flow", "  exclude: [vendor] # built\n  other: 1\n", `  exclude: [vendor, ${FLOW}] # built\n  other: 1\n`],
  ["indented-continued", "  exclude: two\n    lines\n  other: 1\n",
    `  exclude:\n    - "two lines"\n${indented(ALL_FOUR)}  other: 1\n`],
  ["indented-bom-crlf", `${BOM}  exclude: vendor\r\n  other: 1\r\n`,
    `${BOM}  exclude:\r\n    - vendor\r\n${withCrlfEndings(indented(ALL_FOUR))}  other: 1\r\n`],
  ["nested-only", "sass:\n  exclude: vendor\ntitle: x\n", `sass:\n  exclude: vendor\ntitle: x\n\nexclude:\n${ALL_FOUR}`],
  ["nested-after", "exclude: vendor\nsass:\n  exclude: x\n", `exclude:\n  - vendor\n${ALL_FOUR}sass:\n  exclude: x\n`],
  ["indented-nested-before", "  sass:\n    exclude: x\n  exclude: vendor\n",
    `  sass:\n    exclude: x\n  exclude:\n    - vendor\n${indented(ALL_FOUR)}`],
  ["indented-nested-after", "  exclude: [a]\n  sass:\n    exclude: x\n", `  exclude: [a, ${FLOW}]\n  sass:\n    exclude: x\n`],
  ["document-start", "---\nexclude: vendor\n", `---\nexclude:\n  - vendor\n${ALL_FOUR}`],
  ["document-start-indented", "---\n  exclude: vendor\n", `---\n  exclude:\n    - vendor\n${indented(ALL_FOUR)}`],
  ["bom-document-start", `${BOM}--- # site\nexclude: vendor\n`, `${BOM}--- # site\nexclude:\n  - vendor\n${ALL_FOUR}`],
  ["indented-absent", "  title: x\n", `  title: x\n\n  exclude:\n${indented(ALL_FOUR)}`],
  ["indented-absent-no-final-newline", "  title: x", `  title: x\n\n  exclude:\n${indented(ALL_FOUR)}`],
  ["indented-absent-bom", `${BOM}  title: x\n`, `${BOM}  title: x\n\n  exclude:\n${indented(ALL_FOUR)}`],
  ["indented-absent-document-start", "---\n    title: x\n",
    `---\n    title: x\n\n    exclude:\n${indented(ALL_FOUR, "    ")}`],
  ["indented-absent-crlf", "  title: x\r\n  other: 1\r\n",
    `  title: x\r\n  other: 1\r\n\r\n  exclude:\r\n${withCrlfEndings(indented(ALL_FOUR))}`],
  ["indented-absent-nested", "  sass:\n    exclude: vendor\n  title: x\n",
    `  sass:\n    exclude: vendor\n  title: x\n\n  exclude:\n${indented(ALL_FOUR)}`],
  ["double-quoted-key-flow", '"exclude": [vendor]\n', `"exclude": [vendor, ${FLOW}]\n`],
  ["single-quoted-key-spaced", "'exclude' : vendor\n", `'exclude' :\n  - vendor\n${ALL_FOUR}`],
  ["spaced-key-block", "exclude  :\n  - a\ntitle: x\n", `exclude  :\n  - a\n${ALL_FOUR}title: x\n`],
  ["double-quoted-key-null", '"exclude": ~ # none\n', `"exclude": # none\n${ALL_FOUR}`],
  ["indented-quoted-key-continued", `${BOM}  title: x\n  "exclude" : two\n    lines\n`,
    `${BOM}  title: x\n  "exclude" :\n    - "two lines"\n${indented(ALL_FOUR)}`],
  ["quoted-key-comment", "'exclude' : vendor # gems\n", `'exclude' : # gems\n  - vendor\n${ALL_FOUR}`],
  ["escaped-key-block", '"exclu\\x64e":\n  - vendor\n', `"exclu\\x64e":\n  - vendor\n${ALL_FOUR}`],
  ["escaped-key-scalar", '"\\x65xclude" : vendor # gems\n', `"\\x65xclude" : # gems\n  - vendor\n${ALL_FOUR}`],
  ["escaped-key-flow", '  "excl\\u0075de": [vendor]\n', `  "excl\\u0075de": [vendor, ${FLOW}]\n`],
  ["escaped-key-null", '"exclud\\x65": null\ntitle: x\n', `"exclud\\x65":\n${ALL_FOUR}title: x\n`],
  ["single-quoted-key-doubled-quote", "exclude: vendor\n'exclude''': [a]\n",
    `exclude:\n  - vendor\n${ALL_FOUR}'exclude''': [a]\n`],
  ["quoted-other-key-with-colon", 'exclude: [a]\n"exclude: no": [b]\n', `exclude: [a, ${FLOW}]\n"exclude: no": [b]\n`],
  ["escaped-other-key", 'exclude: [a]\n"exclude\\x21": [b]\n', `exclude: [a, ${FLOW}]\n"exclude\\x21": [b]\n`],
  ["document-end", "title: x\n...\n", `title: x\n\nexclude:\n${ALL_FOUR}...\n`],
  ["document-end-comment-after", "title: x\n... # end\n# after\n", `title: x\n\nexclude:\n${ALL_FOUR}... # end\n# after\n`],
  ["document-end-indented-crlf", "  title: x\r\n...\r\n",
    `  title: x\r\n\r\n  exclude:\r\n${withCrlfEndings(indented(ALL_FOUR))}...\r\n`],
  ["document-end-list", "exclude: [a]\n...\n", `exclude: [a, ${FLOW}]\n...\n`],
  ["multi-document-flow", "---\nexclude: [vendor]\n---\ntitle: x\n", `---\nexclude: [vendor, ${FLOW}]\n---\ntitle: x\n`],
  ["multi-document-scalar", "---\nexclude: vendor\n---\nexclude: other\n",
    `---\nexclude:\n  - vendor\n${ALL_FOUR}---\nexclude: other\n`],
  ["multi-document-absent", "title: x\n...\n---\nexclude: y\n", `title: x\n\nexclude:\n${ALL_FOUR}...\n---\nexclude: y\n`],
  ["multi-document-absent-no-end", `${BOM}title: x\n--- # two\nexclude: y\n`,
    `${BOM}title: x\n\nexclude:\n${ALL_FOUR}--- # two\nexclude: y\n`],
];

// Inputs refused as they are without a BOM or indentation: the framework's
// READER_FAILURES, less its tab after the colon, which only PyYAML refuses.
const READER_FAILURES: Array<[string, string]> = [
  ["bom-tagged-null", `${BOM}exclude: !!null\n`],
  ["bom-map", `${BOM}exclude:\n  vendor: true\n`],
  ["indented-tagged-null", "  exclude: !!null\n  other: 1\n"],
  ["indented-map", "  exclude:\n    vendor: true\n  other: 1\n"],
  ["indented-flow-map", "  exclude: {vendor: true}\n"],
  ["flow-mapping-absent", "{title: x}\n"],
];

describe("yaml_list_add — the key where Jekyll's reader finds it", () => {
  for (const [name, text, written] of READER_CASES) {
    it(`${name}: finds the key and changes only it`, () => {
      const before = firstDocumentOf(text);
      const out = runEdit(text);
      expect(out).toBe(written);
      const after = firstDocumentOf(out);
      expect(after.exclude).toEqual([...excludeItemsOf(before.exclude), ...VALUES]);
      expect(sameYamlValue(withoutExclude(after), withoutExclude(before))).toBe(true);
      expect(runEdit(out)).toBe(out);
    });
  }

  for (const [name, text] of READER_FAILURES) {
    it(`${name}: still refused, the file as it was`, () => {
      const files = new Map([["_config.yml", text]]);
      expect(() => applyYamlListAdd(files, OP)).toThrow(YamlListAddError);
      expect(files.get("_config.yml")).toBe(text);
    });
  }

  it("ends the first document at a `...` line that comes before any content", () => {
    expect(runEdit("...\nexclude: a\n")).toBe(`exclude:\n${ALL_FOUR}...\nexclude: a\n`);
    expect(runEdit("# c\n...\ntitle: x\n")).toBe(`# c\n\nexclude:\n${ALL_FOUR}...\ntitle: x\n`);
    expect(runEdit("--- # s\n...\nexclude: a\n")).toBe(`--- # s\n\nexclude:\n${ALL_FOUR}...\nexclude: a\n`);
  });

  it("rewrites a scalar after a tab, which js-yaml and Jekyll read and PyYAML refuses", () => {
    expect(runEdit("exclude:\tvendor\n")).toBe(`exclude:\n  - vendor\n${ALL_FOUR}`);
    expect(load(runEdit("exclude:\tvendor\n"), { json: true })).toEqual({ exclude: ["vendor", ...VALUES] });
  });
});
