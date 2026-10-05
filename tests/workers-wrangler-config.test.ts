/**
 * `tests/workers/wrangler.jsonc` exists only so the `workers` Vitest project
 * has a Wrangler config with no `.dev.vars` beside it. That is only safe if it
 * actually describes the same Durable Object and D1 database as the root
 * `wrangler.jsonc` — a drift here would mean the workers project runs against
 * a class, migration or binding name production does not use, silently. This
 * file diffs the two configs field by field instead of trusting that they
 * were kept in sync by hand.
 *
 * Neither file is valid JSON — both carry `//` comments — so a small stripper
 * below reads them the same way Wrangler does, tracking string state so a
 * `//` or `/*` inside a quoted value is left alone. No JSONC parser is
 * vendored in this repo's `node_modules`, and pulling one in for a single
 * test is more than this is worth.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Strip line comments and star-slash-delimited block comments from a JSONC
 * document, leaving everything inside double-quoted strings untouched.
 * Trailing commas are left in place; `JSON.parse` on Node tolerates neither,
 * so `.replace(/,(\s*[}\]])/g, "$1")` runs after this before parsing.
 */
function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += ch;
      if (ch === "\\") {
        // Copy the escaped character too, so an escaped quote does not end
        // the string early.
        result += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    result += ch;
  }

  return result;
}

function readJsonc(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  const withoutComments = stripJsonComments(raw);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  assets?: unknown;
  vars?: unknown;
  d1_databases?: Array<{ binding?: string; database_name?: string }>;
  durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
  migrations?: Array<{ tag?: string; new_classes?: string[] }>;
  version_metadata?: { binding?: string };
}

const repoRoot = resolve(__dirname, "..");
const rootConfig = readJsonc(resolve(repoRoot, "wrangler.jsonc")) as WranglerConfig;
const testConfig = readJsonc(
  resolve(repoRoot, "tests/workers/wrangler.jsonc"),
) as WranglerConfig;

describe("tests/workers/wrangler.jsonc", () => {
  it("matches the root config's compatibility date and flags", () => {
    expect(testConfig.compatibility_date).toBe(rootConfig.compatibility_date);
    expect(testConfig.compatibility_flags).toEqual(rootConfig.compatibility_flags);
  });

  it("matches the root config's Durable Object binding and class", () => {
    const rootBinding = rootConfig.durable_objects?.bindings?.[0];
    const testBinding = testConfig.durable_objects?.bindings?.[0];
    expect(testBinding?.name).toBe(rootBinding?.name);
    expect(testBinding?.class_name).toBe(rootBinding?.class_name);
  });

  it("matches the root config's migration tag and declared classes", () => {
    const rootMigration = rootConfig.migrations?.[0];
    const testMigration = testConfig.migrations?.[0];
    expect(testMigration?.tag).toBe(rootMigration?.tag);
    expect(testMigration?.new_classes).toEqual(rootMigration?.new_classes);
  });

  it("matches the root config's D1 binding name", () => {
    const rootDb = rootConfig.d1_databases?.[0];
    const testDb = testConfig.d1_databases?.[0];
    expect(testDb?.binding).toBe(rootDb?.binding);
  });

  it("matches the root config's version-metadata binding", () => {
    expect(testConfig.version_metadata?.binding).toBe(
      rootConfig.version_metadata?.binding,
    );
  });

  it("has no main or assets key, and supplies only the staging environment", () => {
    expect(testConfig.main).toBeUndefined();
    expect(testConfig.assets).toBeUndefined();
    // The one var the workers project needs: the object's staging-only
    // controls are unreachable under any other environment.
    expect(testConfig.vars).toEqual({ ENVIRONMENT: "staging" });
  });
});
