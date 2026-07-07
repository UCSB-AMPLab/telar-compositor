/**
 * Locale parity guard. Every EN translation namespace must have an ES counterpart
 * with the SAME set of leaf keys, and no value (in either locale) may be empty.
 *
 * The component/UI tests mock `t` to echo the key, so a key referenced in TSX but
 * missing from a locale JSON — or present in EN but dropped from ES — passes those
 * tests silently. This test closes that gap: it reads the actual JSON files.
 *
 * @version v1.4.0-beta
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const enDir = join(here, "..", "app", "i18n", "locales", "en");
const esDir = join(here, "..", "app", "i18n", "locales", "es");

/** Collect every leaf key path (dot-joined) from a nested translation object. */
function leafKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...leafKeys(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/** Collect [keyPath, value] pairs for every leaf. */
function leafEntries(obj: unknown, prefix = ""): Array<[string, unknown]> {
  if (obj === null || typeof obj !== "object") return [[prefix, obj]];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...leafEntries(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

function loadJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf-8"));
}

const enFiles = readdirSync(enDir).filter((f) => f.endsWith(".json"));

describe("i18n locale parity (en ⇄ es)", () => {
  it("has the same set of namespace files in en and es", () => {
    const esFiles = readdirSync(esDir).filter((f) => f.endsWith(".json")).sort();
    expect(enFiles.slice().sort()).toEqual(esFiles);
  });

  for (const file of enFiles) {
    it(`${file}: en and es have identical key sets`, () => {
      const en = leafKeys(loadJson(enDir, file)).sort();
      const es = leafKeys(loadJson(esDir, file)).sort();
      const missingInEs = en.filter((k) => !es.includes(k));
      const extraInEs = es.filter((k) => !en.includes(k));
      expect({ missingInEs, extraInEs }).toEqual({ missingInEs: [], extraInEs: [] });
    });

    it(`${file}: no empty string values in either locale`, () => {
      const empties: string[] = [];
      for (const dir of [enDir, esDir]) {
        for (const [key, val] of leafEntries(loadJson(dir, file))) {
          if (typeof val === "string" && val.trim() === "") {
            empties.push(`${dir.endsWith("/en") ? "en" : "es"}:${file}:${key}`);
          }
        }
      }
      expect(empties).toEqual([]);
    });
  }
});
