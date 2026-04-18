/**
 * Unit tests for the bundled historical migration manifests.
 *
 * Covers: validateBundledManifests (every bundled manifest passes the DSL
 * validator), chain contiguity (each to_version matches the next from_version),
 * no duplicates, and spot-checks on expected operations per manifest.
 *
 * Catches hand-authoring regressions at CI time rather than upgrade time.
 */

import { describe, it, expect } from "vitest";
import {
  BUNDLED_MANIFESTS,
  validateBundledManifests,
} from "~/../migrations";
import { chainManifests } from "~/lib/upgrade.server";

describe("BUNDLED_MANIFESTS", () => {
  it("validates without throwing", () => {
    expect(() => validateBundledManifests()).not.toThrow();
  });

  it("contains exactly 5 historical manifests", () => {
    expect(BUNDLED_MANIFESTS.length).toBe(5);
  });

  it("has no duplicate from_version values", () => {
    const froms = BUNDLED_MANIFESTS.map((m) => m.from_version);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it("has no duplicate to_version values", () => {
    const tos = BUNDLED_MANIFESTS.map((m) => m.to_version);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it("forms a contiguous chain (each to_version matches next from_version)", () => {
    // Walk the chain by following from→to pointers, not by string sort
    // (semver string ordering would misplace prerelease suffixes).
    const byFrom = new Map(BUNDLED_MANIFESTS.map((m) => [m.from_version, m]));
    let current = "0.9.2-beta";
    let steps = 0;
    while (byFrom.has(current) && steps < BUNDLED_MANIFESTS.length + 1) {
      const next = byFrom.get(current)!;
      current = next.to_version;
      steps += 1;
    }
    expect(steps).toBe(BUNDLED_MANIFESTS.length);
    expect(current).toBe("1.2.0");
  });

  it("chains from 0.9.2-beta to 1.2.0 via chainManifests", () => {
    const chain = chainManifests("0.9.2-beta", "1.2.0", BUNDLED_MANIFESTS);
    expect(chain.length).toBe(5);
    expect(chain[0].from_version).toBe("0.9.2-beta");
    expect(chain[chain.length - 1].to_version).toBe("1.2.0");
  });

  it("v094_to_v100 contains config_update_value for max_viewer_cards", () => {
    const m = BUNDLED_MANIFESTS.find((x) => x.from_version === "0.9.4-beta")!;
    expect(m).toBeDefined();
    const op = m.operations.find(
      (o) => o.type === "config_update_value" && o.key === "max_viewer_cards",
    );
    expect(op).toBeDefined();
  });

  it("v100_to_v110 contains config_add_field for collection_mode", () => {
    const m = BUNDLED_MANIFESTS.find((x) => x.from_version === "1.0.0-beta")!;
    expect(m).toBeDefined();
    const op = m.operations.find(
      (o) => o.type === "config_add_field" && o.key === "collection_mode",
    );
    expect(op).toBeDefined();
  });

  it("v110_to_v120 contains csv_add_column with bilingual column names", () => {
    const m = BUNDLED_MANIFESTS.find((x) => x.from_version === "1.1.0")!;
    expect(m).toBeDefined();
    const op = m.operations.find((o) => o.type === "csv_add_column");
    expect(op).toBeDefined();
    // csv_add_column.column is bilingual { en, es }
    expect((op as { column: unknown }).column).toEqual({
      en: "show_sections",
      es: "mostrar_secciones",
    });
  });
});
