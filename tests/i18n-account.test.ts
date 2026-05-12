/**
 * This file holds the parity test for the `account` i18n namespace.
 *
 * Asserts:
 *   - EN and ES files share the same key set (including nested keys, e.g.
 *     `preferences.section_heading`).
 *   - No value is empty in either locale.
 *   - For any EN value containing {{...}} interpolation tokens, the ES value
 *     preserves the same token set (e.g. {{name}}, {{date}}).
 *
 * An earlier release introduced a nested `preferences` object. The helpers
 * traverse the namespace recursively so EN-only nested keys cannot slip in.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect } from "vitest";
import en from "../app/i18n/locales/en/account.json";
import es from "../app/i18n/locales/es/account.json";

/** Extract the sorted, deduplicated set of {{tokens}} from a string. */
function extractPlaceholders(value: string): string[] {
  const matches = value.match(/\{\{\s*[^}]+?\s*\}\}/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.trim()))).sort();
}

type JsonNode = string | { [k: string]: JsonNode };

/** Flatten a nested locale object into dot-notation `key.subkey` -> string. */
function flattenLeaves(
  node: JsonNode,
  prefix = "",
): Array<[string, string]> {
  if (typeof node === "string") {
    return [[prefix, node]];
  }
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(...flattenLeaves(v, path));
  }
  return out;
}

const enLeaves = flattenLeaves(en as JsonNode);
const esLeaves = flattenLeaves(es as JsonNode);
const enMap = new Map(enLeaves);
const esMap = new Map(esLeaves);

describe("account namespace parity", () => {
  it("EN and ES have the same key set (including nested)", () => {
    const enKeys = [...enMap.keys()].sort();
    const esKeys = [...esMap.keys()].sort();
    expect(esKeys).toEqual(enKeys);
  });

  it("all values are non-empty strings in EN", () => {
    for (const [key, value] of enMap) {
      expect(typeof value, `en.account.${key}`).toBe("string");
      expect(value.length, `en.account.${key}`).toBeGreaterThan(0);
    }
  });

  it("all values are non-empty strings in ES", () => {
    for (const [key, value] of esMap) {
      expect(typeof value, `es.account.${key}`).toBe("string");
      expect(value.length, `es.account.${key}`).toBeGreaterThan(0);
    }
  });

  it("interpolation placeholders are preserved across locales", () => {
    for (const [key, enValue] of enMap) {
      const enTokens = extractPlaceholders(enValue);
      if (enTokens.length === 0) continue;
      const esValue = esMap.get(key) ?? "";
      const esTokens = extractPlaceholders(esValue);
      expect(esTokens, `es.account.${key} placeholders`).toEqual(enTokens);
    }
  });
});
