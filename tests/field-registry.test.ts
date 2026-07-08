/**
 * Self-checks for the field registry (app/lib/field-registry.ts): internal
 * consistency of the declarations themselves, independent of any subsystem.
 * The subsystem coverage suites (field-registry-*.test.ts) verify that the
 * code honors these declarations; this file verifies the declarations are
 * well-formed enough to be worth honoring — unique names, no header or
 * column collisions, no silent exclusions (every exclusion carries a reason),
 * and structural encodings only where the harness expects them.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect } from "vitest";
import {
  FIELD_REGISTRY,
  STRUCTURAL_ENCODINGS,
  isExcluded,
  type EntityDecl,
  type FieldDecl,
} from "../app/lib/field-registry";

const allFields: Array<{ entity: EntityDecl["entity"]; field: FieldDecl }> = FIELD_REGISTRY.flatMap(
  (e) => e.fields.map((field) => ({ entity: e.entity, field })),
);

describe("field registry self-checks", () => {
  it("declares eight entities with unique names", () => {
    const names = FIELD_REGISTRY.map((e) => e.entity);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(8);
  });

  it("field names are unique within each entity and match their D1 column", () => {
    for (const entity of FIELD_REGISTRY) {
      const names = entity.fields.map((f) => f.name);
      expect(new Set(names).size, `${entity.entity} has duplicate field names`).toBe(names.length);
      for (const f of entity.fields) {
        expect(f.d1.column, `${entity.entity}.${f.name} canonical-name rule`).toBe(f.name);
      }
    }
  });

  it("every exclusion carries a non-empty reason (absence is never silent)", () => {
    for (const { entity, field } of allFields) {
      const label = `${entity}.${field.name}`;
      for (const axis of [field.ydoc, field.publish, field.import, field.sync, field.hash]) {
        if (isExcluded(axis)) {
          expect(axis.reason.trim().length, `${label} has an unexplained exclusion`).toBeGreaterThan(
            10,
          );
        }
      }
      if (!isExcluded(field.ydoc)) {
        for (const mech of [
          field.ydoc.coldLoad,
          field.ydoc.update,
          field.ydoc.writeback,
        ]) {
          if (mech !== undefined) {
            expect(
              mech.reason.trim().length,
              `${label} has an unexplained ydoc mechanism deviation`,
            ).toBeGreaterThan(10);
          }
        }
        const insert = field.ydoc.insert;
        if (insert !== undefined) {
          expect(
            insert.reason.trim().length,
            `${label} has an unexplained ydoc insert deviation`,
          ).toBeGreaterThan(10);
        }
      }
    }
  });

  it("publish keys collide only through structural encodings", () => {
    // Two fields may share a publish column only when at least one of them is
    // a structural encoding of that column (e.g. step `kind` is encoded in
    // the emptiness of the `object` cell that `object_id` owns).
    const byFileAndKey = new Map<string, Array<{ label: string; structural: boolean }>>();
    for (const { entity, field } of allFields) {
      if (isExcluded(field.publish)) continue;
      const slot = `${field.publish.file}::${field.publish.key}`;
      const list = byFileAndKey.get(slot) ?? [];
      list.push({
        label: `${entity}.${field.name}`,
        structural: STRUCTURAL_ENCODINGS.has(field.publish.encoding),
      });
      byFileAndKey.set(slot, list);
    }
    for (const [slot, claimants] of byFileAndKey) {
      if (claimants.length > 1) {
        const nonStructural = claimants.filter((c) => !c.structural);
        expect(
          nonStructural.length,
          `${slot} claimed verbatim by ${claimants.map((c) => c.label).join(", ")}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("import headers collide only through structural encodings", () => {
    for (const entity of FIELD_REGISTRY) {
      const byHeader = new Map<string, Array<{ label: string; structural: boolean }>>();
      for (const field of entity.fields) {
        if (isExcluded(field.import)) continue;
        for (const header of field.import.headers) {
          const list = byHeader.get(header) ?? [];
          list.push({
            label: `${entity.entity}.${field.name}`,
            structural: STRUCTURAL_ENCODINGS.has(field.import.encoding),
          });
          byHeader.set(header, list);
        }
      }
      for (const [header, claimants] of byHeader) {
        if (claimants.length > 1) {
          const nonStructural = claimants.filter((c) => !c.structural);
          expect(
            nonStructural.length,
            `${entity.entity} header "${header}" claimed verbatim by ${claimants
              .map((c) => c.label)
              .join(", ")}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("non-structural participations always name at least one concrete location", () => {
    for (const { entity, field } of allFields) {
      const label = `${entity}.${field.name}`;
      if (!isExcluded(field.import) && !STRUCTURAL_ENCODINGS.has(field.import.encoding)) {
        if (field.import.encoding !== "frontmatter" && field.import.encoding !== "md-body") {
          expect(
            field.import.headers.length,
            `${label} imports non-structurally but declares no headers`,
          ).toBeGreaterThan(0);
        }
      }
      if (!isExcluded(field.publish) && field.publish.key.startsWith("(")) {
        const shapeLevel =
          STRUCTURAL_ENCODINGS.has(field.publish.encoding) || field.publish.encoding === "md-body";
        expect(shapeLevel, `${label} uses a placeholder publish key without a structural encoding`).toBe(
          true,
        );
      }
    }
  });

  it("sync key roles exist exactly for the three keyed diff entities", () => {
    const keyed = allFields.filter(
      ({ field }) => !isExcluded(field.sync) && field.sync.role === "key",
    );
    expect(keyed.map(({ entity, field }) => `${entity}.${field.name}`).sort()).toEqual([
      "glossary.term_id",
      "objects.object_id",
      "stories.story_id",
    ]);
  });
});
