/**
 * Unit tests for manifest-schema.server.ts
 *
 * Covers: validateManifest (valid + invalid inputs for each of the 10 op types)
 * and resolveBilingual.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  validateManifest,
  resolveBilingual,
  ManifestValidationError,
  type Manifest,
} from "~/lib/manifest-schema.server";
import { releaseDateForUpgrade } from "~/lib/upgrade.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValid(
  ops: unknown[] = [
    {
      type: "config_add_field",
      key: "foo",
      value: "bar",
      after_key: "baseline",
    },
  ],
): unknown {
  return {
    schema_version: 1,
    from_version: "1.0.0-beta",
    to_version: "1.1.0",
    description: "Test manifest",
    operations: ops,
    manual_steps: { en: [], es: [] },
  };
}

function expectValidationError(
  fn: () => unknown,
  expectedPath: string,
): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ManifestValidationError);
  expect((caught as ManifestValidationError).path).toBe(expectedPath);
}

// ---------------------------------------------------------------------------
// validateManifest — valid inputs
// ---------------------------------------------------------------------------

describe("validateManifest (valid inputs)", () => {
  it("accepts a minimal manifest with one config_add_field operation", () => {
    const input = makeValid();
    const result: Manifest = validateManifest(input);
    expect(result).toBe(input);
    expect(result.schema_version).toBe(1);
    expect(result.operations).toHaveLength(1);
  });

  it("accepts a manifest with all 9 operation types", () => {
    const ops = [
      {
        type: "config_add_field",
        key: "a",
        value: "b",
        after_key: "c",
      },
      {
        type: "config_update_value",
        key: "a",
        old_value: "1",
        new_value: "2",
      },
      {
        type: "config_rename_field",
        old_key: "old",
        new_key: "new",
      },
      {
        type: "csv_add_column",
        file_glob: "**/project.csv",
        column: { en: "col", es: "columna" },
        default: "",
        after: { en: "after", es: "despues" },
      },
      {
        type: "csv_rename_column",
        file_glob: "**/project.csv",
        old_name: { en: "o", es: "o" },
        new_name: { en: "n", es: "n" },
      },
      {
        type: "file_delete",
        paths: ["a.js", "b.js"],
      },
      {
        type: "gitignore_add",
        patterns: ["_site/"],
        section_comment: "Generated",
      },
      {
        type: "regex_replace",
        file_glob: "**/*.md",
        search: "foo",
        replace: "bar",
      },
      {
        type: "create_directory",
        path: "components/texts/pages",
      },
    ];
    const input = makeValid(ops);
    expect(() => validateManifest(input)).not.toThrow();
  });

  it("accepts a manifest with manual_steps entries in both languages", () => {
    const input = {
      ...(makeValid() as object),
      manual_steps: {
        en: [{ description: "x", doc_url: "https://telar.org/docs" }],
        es: [{ description: "a" }],
      },
    };
    expect(() => validateManifest(input)).not.toThrow();
  });

  it("accepts a framework-only manifest with empty operations array", () => {
    const input = makeValid([]);
    expect(() => validateManifest(input)).not.toThrow();
  });

  it("accepts config_add_field with optional comment and skip_if_exists", () => {
    const input = makeValid([
      {
        type: "config_add_field",
        key: "collection_mode",
        value: "false",
        after_key: "telar_language",
        comment: "Collection mode toggle",
        skip_if_exists: true,
      },
    ]);
    expect(() => validateManifest(input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateManifest — invalid inputs
// ---------------------------------------------------------------------------

describe("validateManifest (invalid inputs)", () => {
  it("rejects non-object input", () => {
    expectValidationError(() => validateManifest("not an object"), "");
  });

  it("rejects null input", () => {
    expectValidationError(() => validateManifest(null), "");
  });

  it("rejects array input", () => {
    expectValidationError(() => validateManifest([]), "");
  });

  it("rejects missing schema_version", () => {
    const bad = makeValid() as Record<string, unknown>;
    delete bad.schema_version;
    expectValidationError(() => validateManifest(bad), "/schema_version");
  });

  it("rejects schema_version as string '1' (must be number 1)", () => {
    const bad = { ...(makeValid() as object), schema_version: "1" };
    expectValidationError(() => validateManifest(bad), "/schema_version");
  });

  it("rejects schema_version not equal to 1", () => {
    const bad = { ...(makeValid() as object), schema_version: 2 };
    expectValidationError(() => validateManifest(bad), "/schema_version");
  });

  it("rejects missing from_version", () => {
    const bad = makeValid() as Record<string, unknown>;
    delete bad.from_version;
    expectValidationError(() => validateManifest(bad), "/from_version");
  });

  it("rejects missing to_version", () => {
    const bad = makeValid() as Record<string, unknown>;
    delete bad.to_version;
    expectValidationError(() => validateManifest(bad), "/to_version");
  });

  it("rejects missing description", () => {
    const bad = makeValid() as Record<string, unknown>;
    delete bad.description;
    expectValidationError(() => validateManifest(bad), "/description");
  });

  it("rejects missing operations", () => {
    const bad = makeValid() as Record<string, unknown>;
    delete bad.operations;
    expectValidationError(() => validateManifest(bad), "/operations");
  });

  it("rejects non-array operations", () => {
    const bad = { ...(makeValid() as object), operations: {} };
    expectValidationError(() => validateManifest(bad), "/operations");
  });

  it("rejects missing manual_steps", () => {
    const bad = makeValid() as Record<string, unknown>;
    delete bad.manual_steps;
    expectValidationError(() => validateManifest(bad), "/manual_steps");
  });

  it("rejects operation with unknown type", () => {
    const bad = makeValid([{ type: "unknown_op" }]);
    expectValidationError(() => validateManifest(bad), "/operations/0/type");
  });

  it("rejects operation with missing type", () => {
    const bad = makeValid([{ key: "foo" }]);
    expectValidationError(() => validateManifest(bad), "/operations/0/type");
  });

  it("rejects an operation type that is only a name every object inherits", () => {
    for (const type of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expectValidationError(() => validateManifest(makeValid([{ type }])), "/operations/0/type");
    }
  });

  // --- yaml_list_add ---

  const listAdd = (fields: Record<string, unknown>) =>
    makeValid([{ type: "yaml_list_add", file: "_config.yml", key: "exclude", values: ["tests/"], ...fields }]);

  it("accepts yaml_list_add with a file in scope, a key and string values", () => {
    expect(() => validateManifest(listAdd({}))).not.toThrow();
    expect(() => validateManifest(listAdd({ file: "_data/extra.yaml", values: [] }))).not.toThrow();
  });

  it("rejects yaml_list_add without file, key or values, or with the wrong types", () => {
    expectValidationError(() => validateManifest(listAdd({ file: undefined })), "/operations/0/file");
    expectValidationError(() => validateManifest(listAdd({ file: 3 })), "/operations/0/file");
    expectValidationError(() => validateManifest(listAdd({ key: ["exclude"] })), "/operations/0/key");
    expectValidationError(() => validateManifest(listAdd({ values: "tests/" })), "/operations/0/values");
    expectValidationError(() => validateManifest(listAdd({ values: ["tests/", 1] })), "/operations/0/values/1");
  });

  it("rejects yaml_list_add on a file outside the scope allowlist", () => {
    for (const file of ["/etc/config.yml", "../_config.yml", ".git/config.yml", "scripts/build.py", "Gemfile"]) {
      expectValidationError(() => validateManifest(listAdd({ file })), "/operations/0/file");
    }
  });

  // --- config_add_field ---

  it("rejects config_add_field without key", () => {
    const bad = makeValid([
      { type: "config_add_field", value: "v", after_key: "a" },
    ]);
    expectValidationError(() => validateManifest(bad), "/operations/0/key");
  });

  it("rejects config_add_field without value", () => {
    const bad = makeValid([
      { type: "config_add_field", key: "k", after_key: "a" },
    ]);
    expectValidationError(() => validateManifest(bad), "/operations/0/value");
  });

  it("rejects config_add_field without after_key", () => {
    const bad = makeValid([
      { type: "config_add_field", key: "k", value: "v" },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/after_key",
    );
  });

  // --- config_update_value ---

  it("rejects config_update_value without old_value", () => {
    const bad = makeValid([
      { type: "config_update_value", key: "k", new_value: "n" },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/old_value",
    );
  });

  it("rejects config_update_value without new_value", () => {
    const bad = makeValid([
      { type: "config_update_value", key: "k", old_value: "o" },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/new_value",
    );
  });

  // --- config_rename_field ---

  it("rejects config_rename_field without new_key", () => {
    const bad = makeValid([
      { type: "config_rename_field", old_key: "o" },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/new_key",
    );
  });

  it("rejects config_rename_field without old_key", () => {
    const bad = makeValid([
      { type: "config_rename_field", new_key: "n" },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/old_key",
    );
  });

  // --- csv_add_column ---

  it("rejects csv_add_column without column", () => {
    const bad = makeValid([
      {
        type: "csv_add_column",
        file_glob: "**/x.csv",
        default: "",
        after: { en: "a", es: "a" },
      },
    ]);
    expectValidationError(() => validateManifest(bad), "/operations/0/column");
  });

  it("rejects csv_add_column without file_glob", () => {
    const bad = makeValid([
      {
        type: "csv_add_column",
        column: { en: "c", es: "c" },
        default: "",
        after: { en: "a", es: "a" },
      },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/file_glob",
    );
  });

  it("rejects csv_add_column without default", () => {
    const bad = makeValid([
      {
        type: "csv_add_column",
        file_glob: "**/x.csv",
        column: { en: "c", es: "c" },
        after: { en: "a", es: "a" },
      },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/default",
    );
  });

  it("rejects csv_add_column without after", () => {
    const bad = makeValid([
      {
        type: "csv_add_column",
        file_glob: "**/x.csv",
        column: { en: "c", es: "c" },
        default: "",
      },
    ]);
    expectValidationError(() => validateManifest(bad), "/operations/0/after");
  });

  // --- csv_rename_column ---

  it("rejects csv_rename_column without old_name", () => {
    const bad = makeValid([
      {
        type: "csv_rename_column",
        file_glob: "**/x.csv",
        new_name: { en: "n", es: "n" },
      },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/old_name",
    );
  });

  it("rejects csv_rename_column without new_name", () => {
    const bad = makeValid([
      {
        type: "csv_rename_column",
        file_glob: "**/x.csv",
        old_name: { en: "o", es: "o" },
      },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/new_name",
    );
  });

  // --- file_delete ---

  it("rejects file_delete without paths", () => {
    const bad = makeValid([{ type: "file_delete" }]);
    expectValidationError(() => validateManifest(bad), "/operations/0/paths");
  });

  it("rejects file_delete with non-array paths", () => {
    const bad = makeValid([{ type: "file_delete", paths: "a.js" }]);
    expectValidationError(() => validateManifest(bad), "/operations/0/paths");
  });

  // --- gitignore_add ---

  it("rejects gitignore_add without patterns", () => {
    const bad = makeValid([{ type: "gitignore_add" }]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/patterns",
    );
  });

  // --- regex_replace ---

  it("rejects regex_replace without search", () => {
    const bad = makeValid([
      { type: "regex_replace", file_glob: "**/*.md", replace: "x" },
    ]);
    expectValidationError(() => validateManifest(bad), "/operations/0/search");
  });

  it("rejects regex_replace without replace", () => {
    const bad = makeValid([
      { type: "regex_replace", file_glob: "**/*.md", search: "x" },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/replace",
    );
  });

  it("rejects regex_replace with non-string file_glob", () => {
    const bad = makeValid([
      {
        type: "regex_replace",
        file_glob: 123,
        search: "x",
        replace: "y",
      },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/file_glob",
    );
  });

  // --- create_directory ---

  it("rejects create_directory without path", () => {
    const bad = makeValid([{ type: "create_directory" }]);
    expectValidationError(() => validateManifest(bad), "/operations/0/path");
  });

  // --- bilingual + manual_steps shape ---

  it("rejects bilingual object missing `es`", () => {
    const bad = makeValid([
      {
        type: "csv_add_column",
        file_glob: "**/x.csv",
        column: { en: "c" },
        default: "",
        after: { en: "a", es: "a" },
      },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/column/es",
    );
  });

  it("rejects bilingual object missing `en`", () => {
    const bad = makeValid([
      {
        type: "csv_add_column",
        file_glob: "**/x.csv",
        column: { es: "c" },
        default: "",
        after: { en: "a", es: "a" },
      },
    ]);
    expectValidationError(
      () => validateManifest(bad),
      "/operations/0/column/en",
    );
  });

  it("rejects manual_steps without both en and es", () => {
    const bad = {
      ...(makeValid() as object),
      manual_steps: { en: [] },
    };
    expectValidationError(() => validateManifest(bad), "/manual_steps/es");
  });

  it("rejects manual_steps entry without description", () => {
    const bad = {
      ...(makeValid() as object),
      manual_steps: { en: [{ doc_url: "https://x" }], es: [] },
    };
    expectValidationError(
      () => validateManifest(bad),
      "/manual_steps/en/0/description",
    );
  });
});

// ---------------------------------------------------------------------------
// validateManifest — manual step kind
// ---------------------------------------------------------------------------

describe("validateManifest (manual step kind)", () => {
  const withKind = (kind: unknown): unknown => ({
    ...(makeValid() as object),
    manual_steps: { en: [{ description: "x", kind }], es: [] },
  });

  it("accepts each known kind, and one this build does not know", () => {
    for (const kind of ["action", "optional", "note", "some-future-kind"]) {
      expect(() => validateManifest(withKind(kind))).not.toThrow();
    }
  });

  it("rejects a kind that is not a string", () => {
    expectValidationError(() => validateManifest(withKind(1)), "/manual_steps/en/0/kind");
  });
});

// ---------------------------------------------------------------------------
// validateManifest — manual step audience
// ---------------------------------------------------------------------------

describe("validateManifest (manual step audience)", () => {
  function withAudience(audience: unknown): unknown {
    return {
      ...(makeValid() as object),
      manual_steps: {
        en: [{ description: "x", audience }],
        es: [],
      },
    };
  }

  it("accepts an audience value this build doesn't recognise, without throwing", () => {
    const input = withAudience("some-future-value");
    expect(() => validateManifest(input)).not.toThrow();
  });

  it("rejects a non-string audience (number)", () => {
    const bad = withAudience(42);
    expectValidationError(
      () => validateManifest(bad),
      "/manual_steps/en/0/audience",
    );
  });

  it("rejects a non-string audience (object)", () => {
    const bad = withAudience({});
    expectValidationError(
      () => validateManifest(bad),
      "/manual_steps/en/0/audience",
    );
  });

  it("still accepts each known audience value", () => {
    for (const audience of ["all", "compositor", "local", "google-sheets"]) {
      const input = withAudience(audience);
      expect(() => validateManifest(input)).not.toThrow();
    }
  });

  it("accepts a step with no audience key at all", () => {
    const input = {
      ...(makeValid() as object),
      manual_steps: { en: [{ description: "x" }], es: [] },
    };
    expect(() => validateManifest(input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveBilingual
// ---------------------------------------------------------------------------

describe("resolveBilingual", () => {
  it("returns en variant when lang=en", () => {
    expect(resolveBilingual({ en: "a", es: "b" }, "en")).toBe("a");
  });

  it("returns es variant when lang=es", () => {
    expect(resolveBilingual({ en: "a", es: "b" }, "es")).toBe("b");
  });

  it("returns scalar unchanged when value is a string", () => {
    expect(resolveBilingual("scalar", "en")).toBe("scalar");
    expect(resolveBilingual("scalar", "es")).toBe("scalar");
  });

  it("returns scalar unchanged when value is undefined (via type cast)", () => {
    expect(resolveBilingual(undefined as unknown as string, "en")).toBe(
      undefined,
    );
  });
});

// A manifest may declare the date of the release it installs.
describe("validateManifest (release_date)", () => {
  const withDate = (release_date: unknown) => ({ ...(makeValid() as object), release_date });

  it("accepts a manifest with no release_date, as every one before v1.8.0 is", () => {
    expect(() => validateManifest(makeValid())).not.toThrow();
  });

  it("accepts a date written YYYY-MM-DD and keeps it", () => {
    expect(validateManifest(withDate("2026-09-09")).release_date).toBe("2026-09-09");
    expect(validateManifest(withDate("2028-02-29")).release_date).toBe("2028-02-29");
  });

  it("rejects a date in any other shape, or not a string", () => {
    for (const bad of ["2026-9-9", "09/09/2026", "2026-09-09T00:00:00Z", 20260909]) {
      expectValidationError(() => validateManifest(withDate(bad)), "/release_date");
    }
  });

  it("rejects a date the calendar does not have", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2025-02-29"]) {
      expectValidationError(() => validateManifest(withDate(bad)), "/release_date");
    }
  });
});

describe("releaseDateForUpgrade", () => {
  const manifest = (release_date?: string) =>
    ({ ...(makeValid() as object), ...(release_date ? { release_date } : {}) }) as Manifest;

  it("takes the date the last manifest of the chain declares", () => {
    expect(releaseDateForUpgrade([manifest("2026-03-01"), manifest("2026-09-09")], "2026-09-10T01:07:36Z")).toBe(
      "2026-09-09",
    );
  });

  it("falls back to the publication day when the last manifest declares none", () => {
    expect(releaseDateForUpgrade([manifest("2026-03-01"), manifest()], "2026-09-10T01:07:36Z")).toBe("2026-09-10");
  });
});
