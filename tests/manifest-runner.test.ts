/**
 * Unit tests for manifest-runner.server.ts
 *
 * Covers behaviour of each of the 9 operation types, chaining across multiple
 * manifests, bilingual field resolution, and scope-allowlist
 * enforcement for regex_replace.
 *
 * All tests are pure: no I/O, no network, no DB. Fixtures are inline strings.
 */

import { describe, it, expect } from "vitest";
import {
  applyManifestChain,
  applyOperation,
  matchGlob,
  escapeRegex,
} from "~/lib/manifest-runner.server";
import type {
  Manifest,
  Operation,
  ManualStep,
} from "~/lib/manifest-schema.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function files(...entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

function wrap(
  ops: Operation[],
  manualSteps: { en: ManualStep[]; es: ManualStep[] } = { en: [], es: [] },
): Manifest {
  return {
    schema_version: 1,
    from_version: "0.0.0",
    to_version: "0.0.1",
    description: "test",
    operations: ops,
    manual_steps: manualSteps,
  };
}

// ---------------------------------------------------------------------------
// config_add_field
// ---------------------------------------------------------------------------

describe("config_add_field", () => {
  it("adds key after anchor line", () => {
    const f = files(["_config.yml", "telar_language: en\nbaseurl: /foo"]);
    const op: Operation = {
      type: "config_add_field",
      key: "collection_mode",
      value: "false",
      after_key: "telar_language",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe(
      "telar_language: en\ncollection_mode: false\nbaseurl: /foo",
    );
  });

  it("preserves trailing comment when comment is provided", () => {
    const f = files(["_config.yml", "telar_language: en"]);
    const op: Operation = {
      type: "config_add_field",
      key: "collection_mode",
      value: "false",
      after_key: "telar_language",
      comment: "Set to true if this is a collection site",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe(
      "telar_language: en\ncollection_mode: false  # Set to true if this is a collection site",
    );
  });

  it("is idempotent when skip_if_exists is default true", () => {
    const f = files(["_config.yml", "telar_language: en"]);
    const op: Operation = {
      type: "config_add_field",
      key: "collection_mode",
      value: "false",
      after_key: "telar_language",
    };
    applyOperation(f, op, "en", []);
    const firstRun = f.get("_config.yml");
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe(firstRun);
  });

  it("forces add when skip_if_exists is false even if key already exists", () => {
    const f = files([
      "_config.yml",
      "telar_language: en\ncollection_mode: false",
    ]);
    const op: Operation = {
      type: "config_add_field",
      key: "collection_mode",
      value: "true",
      after_key: "telar_language",
      skip_if_exists: false,
    };
    applyOperation(f, op, "en", []);
    const out = f.get("_config.yml")!;
    expect(out.match(/collection_mode/g)?.length).toBe(2);
  });

  it("is a no-op when after_key is not found", () => {
    const f = files(["_config.yml", "title: Example"]);
    const before = f.get("_config.yml");
    const op: Operation = {
      type: "config_add_field",
      key: "collection_mode",
      value: "false",
      after_key: "nonexistent_key",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe(before);
  });

  it("is a no-op when _config.yml is absent", () => {
    const f = files();
    const op: Operation = {
      type: "config_add_field",
      key: "collection_mode",
      value: "false",
      after_key: "telar_language",
    };
    applyOperation(f, op, "en", []);
    expect(f.has("_config.yml")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config_update_value
// ---------------------------------------------------------------------------

describe("config_update_value", () => {
  it("replaces matching value preserving indent", () => {
    const f = files(["_config.yml", "story_interface:\n  max_viewer_cards: 10"]);
    const op: Operation = {
      type: "config_update_value",
      key: "max_viewer_cards",
      old_value: "10",
      new_value: "8",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe(
      "story_interface:\n  max_viewer_cards: 8",
    );
  });

  it("is a no-op when old_value doesn't match", () => {
    const f = files(["_config.yml", "  max_viewer_cards: 5"]);
    const before = f.get("_config.yml");
    const op: Operation = {
      type: "config_update_value",
      key: "max_viewer_cards",
      old_value: "10",
      new_value: "8",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe(before);
  });

  it("tolerates a trailing comment on the original line", () => {
    const f = files([
      "_config.yml",
      "  max_viewer_cards: 10 # previous default",
    ]);
    const op: Operation = {
      type: "config_update_value",
      key: "max_viewer_cards",
      old_value: "10",
      new_value: "8",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe("  max_viewer_cards: 8");
  });

  it("is a no-op when _config.yml is absent", () => {
    const f = files();
    const op: Operation = {
      type: "config_update_value",
      key: "x",
      old_value: "1",
      new_value: "2",
    };
    applyOperation(f, op, "en", []);
    expect(f.has("_config.yml")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config_rename_field
// ---------------------------------------------------------------------------

describe("config_rename_field", () => {
  it("renames key preserving value and trailing comment", () => {
    const f = files([
      "_config.yml",
      "old_key: some_value # a note",
    ]);
    const op: Operation = {
      type: "config_rename_field",
      old_key: "old_key",
      new_key: "new_key",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe("new_key: some_value # a note");
  });

  it("preserves indent when renaming indented keys", () => {
    const f = files(["_config.yml", "  old_key: value"]);
    const op: Operation = {
      type: "config_rename_field",
      old_key: "old_key",
      new_key: "new_key",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe("  new_key: value");
  });

  it("is a no-op when old_key is missing", () => {
    const f = files(["_config.yml", "other_key: value"]);
    const before = f.get("_config.yml");
    const op: Operation = {
      type: "config_rename_field",
      old_key: "old_key",
      new_key: "new_key",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// csv_add_column
// ---------------------------------------------------------------------------

describe("csv_add_column", () => {
  it("adds English column to English header when lang=en", () => {
    const f = files([
      "_data/project.csv",
      "order,story_id,title,private\n1,s1,Story,FALSE",
    ]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "TRUE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    const out = f.get("_data/project.csv")!;
    expect(out.split("\n")[0]).toBe(
      "order,story_id,title,private,show_sections",
    );
    expect(out.split("\n")[1]).toBe("1,s1,Story,FALSE,TRUE");
  });

  it("adds Spanish column when lang=es", () => {
    const f = files([
      "_data/proyecto.csv",
      "orden,historia_id,titulo,privado\n1,s1,Historia,FALSE",
    ]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/proyecto.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "TRUE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "es", []);
    expect(f.get("_data/proyecto.csv")!.split("\n")[0]).toBe(
      "orden,historia_id,titulo,privado,mostrar_secciones",
    );
  });

  it("places the new column right after the anchor column", () => {
    const f = files([
      "_data/project.csv",
      "order,story_id,private,title\n1,s1,FALSE,Story",
    ]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "TRUE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    const header = f.get("_data/project.csv")!.split("\n")[0];
    expect(header).toBe("order,story_id,private,show_sections,title");
  });

  it("falls back to other-language anchor when site-language anchor is absent", () => {
    // English site but the CSV header still uses Spanish anchor "privado"
    const f = files([
      "_data/project.csv",
      "orden,historia_id,privado,titulo\n1,s1,FALSE,Historia",
    ]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "TRUE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    const header = f.get("_data/project.csv")!.split("\n")[0];
    expect(header).toBe(
      "orden,historia_id,privado,show_sections,titulo",
    );
  });

  it("appends to the end when neither anchor variant is found", () => {
    const f = files([
      "_data/project.csv",
      "order,story_id\n1,s1",
    ]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_data/project.csv")!.split("\n")[0]).toBe(
      "order,story_id,show_sections",
    );
  });

  it("skips when the English column is already present", () => {
    const f = files([
      "_data/project.csv",
      "order,private,show_sections\n1,FALSE,TRUE",
    ]);
    const before = f.get("_data/project.csv");
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "FALSE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_data/project.csv")).toBe(before);
  });

  it("skips when the Spanish column is already present (cross-language idempotency)", () => {
    const f = files([
      "_data/project.csv",
      "orden,privado,mostrar_secciones\n1,FALSE,TRUE",
    ]);
    const before = f.get("_data/project.csv");
    // English site running the op — must still skip because Spanish variant is present
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "FALSE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_data/project.csv")).toBe(before);
  });

  it("fills data rows with empty string when default is empty", () => {
    const f = files([
      "_data/project.csv",
      "order,private\n1,FALSE\n2,TRUE",
    ]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    const rows = f.get("_data/project.csv")!.split("\n");
    expect(rows[1]).toBe("1,FALSE,");
    expect(rows[2]).toBe("2,TRUE,");
  });

  it("fills data rows with default value when provided", () => {
    const f = files([
      "_data/project.csv",
      "order,private\n1,FALSE\n2,TRUE",
    ]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "TRUE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    const rows = f.get("_data/project.csv")!.split("\n");
    expect(rows[1]).toBe("1,FALSE,TRUE");
    expect(rows[2]).toBe("2,TRUE,TRUE");
  });

  it("matches both variants of a brace glob against files present in the map", () => {
    const f = files(
      ["_data/project.csv", "order,private\n1,FALSE"],
      ["_data/proyecto.csv", "orden,privado\n1,FALSE"],
    );
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/{project,proyecto}.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "TRUE",
      after: { en: "private", es: "privado" },
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_data/project.csv")!.split("\n")[0]).toContain(
      "show_sections",
    );
    // Note: lang=en writes English column name into both files even when the
    // second file's header is Spanish. Site language is the authority.
    expect(f.get("_data/proyecto.csv")!.split("\n")[0]).toContain(
      "show_sections",
    );
  });
});

// ---------------------------------------------------------------------------
// csv_rename_column
// ---------------------------------------------------------------------------

describe("csv_rename_column", () => {
  it("renames from an English header", () => {
    const f = files([
      "_data/project.csv",
      "order,byline,title\n1,A.B.,Story",
    ]);
    const op: Operation = {
      type: "csv_rename_column",
      file_glob: "_data/project.csv",
      old_name: { en: "byline", es: "firma" },
      new_name: { en: "author", es: "autor" },
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_data/project.csv")!.split("\n")[0]).toBe(
      "order,author,title",
    );
  });

  it("renames from a Spanish header when English variant is missing", () => {
    const f = files([
      "_data/project.csv",
      "orden,firma,titulo\n1,A.B.,Historia",
    ]);
    const op: Operation = {
      type: "csv_rename_column",
      file_glob: "_data/project.csv",
      old_name: { en: "byline", es: "firma" },
      new_name: { en: "author", es: "autor" },
    };
    applyOperation(f, op, "es", []);
    expect(f.get("_data/project.csv")!.split("\n")[0]).toBe(
      "orden,autor,titulo",
    );
  });

  it("is a no-op when neither variant is present", () => {
    const f = files(["_data/project.csv", "order,title\n1,Story"]);
    const before = f.get("_data/project.csv");
    const op: Operation = {
      type: "csv_rename_column",
      file_glob: "_data/project.csv",
      old_name: { en: "byline", es: "firma" },
      new_name: { en: "author", es: "autor" },
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_data/project.csv")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Bilingual two-row header pattern
// ---------------------------------------------------------------------------

describe("csv_add_column bilingual two-row header", () => {
  // Real Telar project.csv convention:
  //   row 0: English column names
  //   row 1: Spanish column names
  //   row 2: comments (# ...)
  //   row 3+: data
  const bilingualCsv = [
    "order,story_id,title,subtitle,byline,protected",
    "orden,id_historia,titulo,subtitulo,firma,protegido",
    "#,# Optional semantic ID,Story title,Optional subtitle,Optional attribution,yes to protect with key",
    "1,my-story,My Story,,A.B.,",
  ].join("\n");

  it("writes en to row 0 and es to row 1 when lang=en", () => {
    const f = files(["_data/project.csv", bilingualCsv]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "",
      after: { en: "protected", es: "protegido" },
    };
    applyOperation(f, op, "en", []);
    const lines = f.get("_data/project.csv")!.split("\n");
    expect(lines[0]).toBe(
      "order,story_id,title,subtitle,byline,protected,show_sections",
    );
    expect(lines[1]).toBe(
      "orden,id_historia,titulo,subtitulo,firma,protegido,mostrar_secciones",
    );
    // row 2 (comments) gets the op.default — empty string
    expect(lines[2].endsWith(",")).toBe(true);
    // data row preserved + default appended
    expect(lines[3]).toBe("1,my-story,My Story,,A.B.,,");
  });

  it("writes es to row 0 and en to row 1 when headers are reversed", () => {
    const reversed = [
      "orden,id_historia,titulo,subtitulo,firma,protegido",
      "order,story_id,title,subtitle,byline,protected",
      "1,my-story,My Story,,A.B.,",
    ].join("\n");
    const f = files(["_data/project.csv", reversed]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "",
      after: { en: "protected", es: "protegido" },
    };
    applyOperation(f, op, "es", []);
    const lines = f.get("_data/project.csv")!.split("\n");
    expect(lines[0]).toBe(
      "orden,id_historia,titulo,subtitulo,firma,protegido,mostrar_secciones",
    );
    expect(lines[1]).toBe(
      "order,story_id,title,subtitle,byline,protected,show_sections",
    );
  });

  it("treats row 1 as data when its anchor cell does not match the other-language anchor", () => {
    // Row 1 does not mirror row 0 — it's a real data row, not a Spanish header.
    const monolingualWithData = [
      "order,title,protected",
      "1,First Story,",
      "2,Second Story,yes",
    ].join("\n");
    const f = files(["_data/project.csv", monolingualWithData]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "",
      after: { en: "protected", es: "protegido" },
    };
    applyOperation(f, op, "en", []);
    const lines = f.get("_data/project.csv")!.split("\n");
    expect(lines[0]).toBe("order,title,protected,show_sections");
    // Row 1 is a data row — gets op.default, NOT the Spanish column name
    expect(lines[1]).toBe("1,First Story,,");
    expect(lines[2]).toBe("2,Second Story,yes,");
  });

  it("bilingual detection requires the anchor to be present — appended-to-end falls back to single-row behaviour", () => {
    // No `protected` column at all, so anchor is missing. Column appends to end.
    // With no anchor we cannot confirm the bilingual structure, so the second
    // row is treated as a regular data row.
    const csv = [
      "order,story_id,title",
      "orden,id_historia,titulo",
      "1,s,Story",
    ].join("\n");
    const f = files(["_data/project.csv", csv]);
    const op: Operation = {
      type: "csv_add_column",
      file_glob: "_data/project.csv",
      column: { en: "show_sections", es: "mostrar_secciones" },
      default: "",
      after: { en: "protected", es: "protegido" },
    };
    applyOperation(f, op, "en", []);
    const lines = f.get("_data/project.csv")!.split("\n");
    expect(lines[0]).toBe("order,story_id,title,show_sections");
    // Row 1 treated as data — gets the default, not the Spanish variant
    expect(lines[1]).toBe("orden,id_historia,titulo,");
  });
});

describe("csv_rename_column bilingual two-row header", () => {
  const bilingualCsv = [
    "order,byline,title",
    "orden,firma,titulo",
    "1,A.B.,My Story",
  ].join("\n");

  it("renames row 0 to en and row 1 to es when lang=en", () => {
    const f = files(["_data/project.csv", bilingualCsv]);
    const op: Operation = {
      type: "csv_rename_column",
      file_glob: "_data/project.csv",
      old_name: { en: "byline", es: "firma" },
      new_name: { en: "author", es: "autor" },
    };
    applyOperation(f, op, "en", []);
    const lines = f.get("_data/project.csv")!.split("\n");
    expect(lines[0]).toBe("order,author,title");
    expect(lines[1]).toBe("orden,autor,titulo");
    expect(lines[2]).toBe("1,A.B.,My Story");
  });

  it("renames row 0 to es and row 1 to en when headers are reversed", () => {
    const reversed = [
      "orden,firma,titulo",
      "order,byline,title",
      "1,A.B.,My Story",
    ].join("\n");
    const f = files(["_data/project.csv", reversed]);
    const op: Operation = {
      type: "csv_rename_column",
      file_glob: "_data/project.csv",
      old_name: { en: "byline", es: "firma" },
      new_name: { en: "author", es: "autor" },
    };
    applyOperation(f, op, "es", []);
    const lines = f.get("_data/project.csv")!.split("\n");
    expect(lines[0]).toBe("orden,autor,titulo");
    expect(lines[1]).toBe("order,author,title");
  });

  it("falls back to single-row rename when row 1 is a data row", () => {
    const monolingual = [
      "order,byline,title",
      "1,A.B.,My Story",
    ].join("\n");
    const f = files(["_data/project.csv", monolingual]);
    const op: Operation = {
      type: "csv_rename_column",
      file_glob: "_data/project.csv",
      old_name: { en: "byline", es: "firma" },
      new_name: { en: "author", es: "autor" },
    };
    applyOperation(f, op, "en", []);
    const lines = f.get("_data/project.csv")!.split("\n");
    expect(lines[0]).toBe("order,author,title");
    expect(lines[1]).toBe("1,A.B.,My Story");
  });
});

// ---------------------------------------------------------------------------
// file_delete
// ---------------------------------------------------------------------------

describe("file_delete", () => {
  it("removes the path from files and adds it to deletions", () => {
    const f = files([
      "docs/old.md",
      "deprecated",
    ], [
      "docs/keep.md",
      "kept",
    ]);
    const deletions: string[] = [];
    const op: Operation = {
      type: "file_delete",
      paths: ["docs/old.md"],
    };
    applyOperation(f, op, "en", deletions);
    expect(f.has("docs/old.md")).toBe(false);
    expect(f.has("docs/keep.md")).toBe(true);
    expect(deletions).toEqual(["docs/old.md"]);
  });

  it("deduplicates repeat deletions of the same path across calls", () => {
    const f = files(["docs/old.md", "x"]);
    const deletions: string[] = [];
    const op: Operation = {
      type: "file_delete",
      paths: ["docs/old.md"],
    };
    applyOperation(f, op, "en", deletions);
    applyOperation(f, op, "en", deletions);
    expect(deletions).toEqual(["docs/old.md"]);
  });

  it("handles multiple paths in a single op", () => {
    const f = files(["a.md", "a"], ["b.md", "b"], ["c.md", "c"]);
    const deletions: string[] = [];
    const op: Operation = {
      type: "file_delete",
      paths: ["a.md", "c.md"],
    };
    applyOperation(f, op, "en", deletions);
    expect(f.has("a.md")).toBe(false);
    expect(f.has("b.md")).toBe(true);
    expect(f.has("c.md")).toBe(false);
    expect(deletions).toEqual(["a.md", "c.md"]);
  });
});

// ---------------------------------------------------------------------------
// gitignore_add
// ---------------------------------------------------------------------------

describe("gitignore_add", () => {
  it("creates .gitignore when absent", () => {
    const f = files();
    const op: Operation = {
      type: "gitignore_add",
      patterns: [".DS_Store"],
    };
    applyOperation(f, op, "en", []);
    expect(f.get(".gitignore")).toBe(".DS_Store\n");
  });

  it("appends patterns to an existing .gitignore", () => {
    const f = files([".gitignore", "node_modules\n"]);
    const op: Operation = {
      type: "gitignore_add",
      patterns: [".DS_Store"],
    };
    applyOperation(f, op, "en", []);
    expect(f.get(".gitignore")).toBe("node_modules\n.DS_Store\n");
  });

  it("is idempotent — does not double-add a pattern", () => {
    const f = files([".gitignore", ".DS_Store\n"]);
    const before = f.get(".gitignore");
    const op: Operation = {
      type: "gitignore_add",
      patterns: [".DS_Store"],
    };
    applyOperation(f, op, "en", []);
    expect(f.get(".gitignore")).toBe(before);
  });

  it("adds a leading newline when .gitignore lacks a trailing newline", () => {
    const f = files([".gitignore", "node_modules"]);
    const op: Operation = {
      type: "gitignore_add",
      patterns: [".DS_Store"],
    };
    applyOperation(f, op, "en", []);
    expect(f.get(".gitignore")).toBe("node_modules\n.DS_Store\n");
  });

  it("inserts a section_comment header before new patterns", () => {
    const f = files([".gitignore", "node_modules\n"]);
    const op: Operation = {
      type: "gitignore_add",
      patterns: [".DS_Store", "*.log"],
      section_comment: "Local dev artefacts",
    };
    applyOperation(f, op, "en", []);
    expect(f.get(".gitignore")).toBe(
      "node_modules\n\n# Local dev artefacts\n.DS_Store\n*.log\n",
    );
  });
});

// ---------------------------------------------------------------------------
// regex_replace
// ---------------------------------------------------------------------------

describe("regex_replace", () => {
  it("applies the replacement to all matched files", () => {
    const f = files(
      ["docs/a.md", "old text"],
      ["docs/b.md", "old text again"],
    );
    const op: Operation = {
      type: "regex_replace",
      file_glob: "**/*.md",
      search: "old",
      replace: "new",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("docs/a.md")).toBe("new text");
    expect(f.get("docs/b.md")).toBe("new text again");
  });

  it("uses the default global flag so all occurrences are replaced", () => {
    const f = files(["docs/a.md", "foo foo foo"]);
    const op: Operation = {
      type: "regex_replace",
      file_glob: "**/*.md",
      search: "foo",
      replace: "bar",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("docs/a.md")).toBe("bar bar bar");
  });

  it("operates on _config.yml when glob targets it", () => {
    const f = files(["_config.yml", "title: Old\nbaseurl: /old"]);
    const op: Operation = {
      type: "regex_replace",
      file_glob: "_config.yml",
      search: "Old",
      replace: "New",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_config.yml")).toBe("title: New\nbaseurl: /old");
  });

  it("throws on out-of-scope glob targeting .git/", () => {
    const f = files([".git/config", "secret"]);
    const op: Operation = {
      type: "regex_replace",
      file_glob: ".git/config",
      search: "secret",
      replace: "public",
    };
    expect(() => applyOperation(f, op, "en", [])).toThrow(
      /outside scope allowlist/,
    );
  });

  it("throws when a glob matches an unsupported file extension", () => {
    // An unallowed path entry in the files map
    const f = files(["secrets.env", "TOKEN=abc"]);
    const op: Operation = {
      type: "regex_replace",
      file_glob: "secrets.env",
      search: "abc",
      replace: "xyz",
    };
    expect(() => applyOperation(f, op, "en", [])).toThrow(
      /outside scope allowlist/,
    );
  });
});

// ---------------------------------------------------------------------------
// create_directory
// ---------------------------------------------------------------------------

describe("create_directory", () => {
  it("creates a .gitkeep at the given path", () => {
    const f = files();
    const op: Operation = {
      type: "create_directory",
      path: "_media",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_media/.gitkeep")).toBe("");
  });

  it("normalises a trailing slash on the path", () => {
    const f = files();
    const op: Operation = {
      type: "create_directory",
      path: "_media/",
    };
    applyOperation(f, op, "en", []);
    expect(f.has("_media/.gitkeep")).toBe(true);
    expect(f.has("_media//.gitkeep")).toBe(false);
  });

  it("does not overwrite an existing .gitkeep", () => {
    const f = files(["_media/.gitkeep", "preserved content"]);
    const op: Operation = {
      type: "create_directory",
      path: "_media",
    };
    applyOperation(f, op, "en", []);
    expect(f.get("_media/.gitkeep")).toBe("preserved content");
  });
});

// ---------------------------------------------------------------------------
// applyManifestChain
// ---------------------------------------------------------------------------

describe("applyManifestChain", () => {
  it("applies manifests in order — output of m1 is input of m2", () => {
    const m1: Manifest = wrap([
      {
        type: "config_add_field",
        key: "collection_mode",
        value: "false",
        after_key: "telar_language",
      },
    ]);
    const m2: Manifest = wrap([
      {
        type: "config_update_value",
        key: "collection_mode",
        old_value: "false",
        new_value: "true",
      },
    ]);
    const initial = files(["_config.yml", "telar_language: en"]);
    const result = applyManifestChain([m1, m2], initial, "en");
    expect(result.files.get("_config.yml")).toBe(
      "telar_language: en\ncollection_mode: true",
    );
  });

  it("concatenates manual steps in English when lang=en", () => {
    const m1: Manifest = wrap([], {
      en: [{ description: "Step A" }],
      es: [{ description: "Paso A" }],
    });
    const m2: Manifest = wrap([], {
      en: [{ description: "Step B", doc_url: "https://example.com/b" }],
      es: [{ description: "Paso B" }],
    });
    const result = applyManifestChain([m1, m2], new Map(), "en");
    expect(result.manualSteps).toEqual([
      { description: "Step A" },
      { description: "Step B", doc_url: "https://example.com/b" },
    ]);
  });

  it("concatenates manual steps in Spanish when lang=es", () => {
    const m1: Manifest = wrap([], {
      en: [{ description: "Step A" }],
      es: [{ description: "Paso A" }],
    });
    const m2: Manifest = wrap([], {
      en: [{ description: "Step B" }],
      es: [{ description: "Paso B" }],
    });
    const result = applyManifestChain([m1, m2], new Map(), "es");
    expect(result.manualSteps).toEqual([
      { description: "Paso A" },
      { description: "Paso B" },
    ]);
  });

  it("returns an independent Map — mutating result does not affect input", () => {
    const initial = files(["a.md", "content"]);
    const result = applyManifestChain([], initial, "en");
    result.files.set("a.md", "mutated");
    expect(initial.get("a.md")).toBe("content");
  });

  it("passes lang through to bilingual ops in the chain", () => {
    const manifest: Manifest = wrap([
      {
        type: "csv_add_column",
        file_glob: "_data/project.csv",
        column: { en: "show_sections", es: "mostrar_secciones" },
        default: "TRUE",
        after: { en: "private", es: "privado" },
      },
    ]);
    const initial = files([
      "_data/project.csv",
      "order,private\n1,FALSE",
    ]);
    const resultEs = applyManifestChain([manifest], initial, "es");
    expect(resultEs.files.get("_data/project.csv")!.split("\n")[0]).toContain(
      "mostrar_secciones",
    );
  });

  it("accumulates deletions across manifests", () => {
    const m1: Manifest = wrap([
      { type: "file_delete", paths: ["old/a.md"] },
    ]);
    const m2: Manifest = wrap([
      { type: "file_delete", paths: ["old/b.md"] },
    ]);
    const initial = files(["old/a.md", "a"], ["old/b.md", "b"]);
    const result = applyManifestChain([m1, m2], initial, "en");
    expect(result.deletions).toEqual(["old/a.md", "old/b.md"]);
  });

  it("returns empty manualSteps when no manifests contribute any", () => {
    const result = applyManifestChain([], new Map(), "en");
    expect(result.manualSteps).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.files.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchGlob + escapeRegex
// ---------------------------------------------------------------------------

describe("matchGlob", () => {
  it("matches an exact path", () => {
    expect(matchGlob("_data/project.csv", "_data/project.csv")).toBe(true);
    expect(matchGlob("_data/project.csv", "_data/other.csv")).toBe(false);
  });

  it("matches **/*.csv across nested directories", () => {
    expect(matchGlob("**/*.csv", "a.csv")).toBe(true);
    expect(matchGlob("**/*.csv", "_data/project.csv")).toBe(true);
    expect(matchGlob("**/*.csv", "_data/nested/deep.csv")).toBe(true);
    expect(matchGlob("**/*.csv", "_data/project.yml")).toBe(false);
  });

  it("matches brace expansion for both variants", () => {
    expect(matchGlob("_data/{project,proyecto}.csv", "_data/project.csv")).toBe(
      true,
    );
    expect(
      matchGlob("_data/{project,proyecto}.csv", "_data/proyecto.csv"),
    ).toBe(true);
    expect(matchGlob("_data/{project,proyecto}.csv", "_data/other.csv")).toBe(
      false,
    );
  });

  it("matches brace expansion combined with **", () => {
    expect(
      matchGlob("**/{project,proyecto}.csv", "_data/stories/project.csv"),
    ).toBe(true);
    expect(
      matchGlob("**/{project,proyecto}.csv", "_data/stories/proyecto.csv"),
    ).toBe(true);
  });
});

describe("escapeRegex", () => {
  it("escapes regex metacharacters for literal use", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
    expect(escapeRegex("(group)")).toBe("\\(group\\)");
    expect(escapeRegex("[chars]")).toBe("\\[chars\\]");
  });

  it("leaves plain alphanumerics unchanged", () => {
    expect(escapeRegex("abc123")).toBe("abc123");
  });
});
