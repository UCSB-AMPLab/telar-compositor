/**
 * This file pins unit tests for `app/lib/import.server.ts` — the
 * Telar Compositor import library that ingests a connected repo's CSVs
 * and markdown into the D1 row set the editor reads.
 *
 * Tests cover header detection, comment-row skipping, the typed CSV
 * mappers (`mapConfigToProjectConfig`, `mapObjectsCsv`, `mapProjectCsv`,
 * `mapStoryCsv`), markdown parsing, the v1.3.0 liquid-block recognition,
 * the kind/show_sections derivations, the `scanRepoPages` import-pages
 * path, the cascade-aware `deleteProjectCascade`, and the orphan-story
 * detection plus `.compositor-ignored` parsing.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Papa from "papaparse";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as githubServer from "~/lib/github.server";
import {
  isHeaderRow,
  isCommentRow,
  parseTelarCsv,
  mapConfigToProjectConfig,
  mapObjectsCsv,
  mapProjectCsv,
  mapStoryCsv,
  isLayerFileReference,
  resolveLayerFileReferences,
  mapGlossaryCsv,
  parseIndexMd,
  parsePageMarkdown,
  rollbackProjectImport,
  scanRepoPages,
  parseCompositorIgnored,
  detectOrphanStoryIds,
  scanRepoOrphanStoryIds,
  isSafeSiteBase,
  isSafeObjectId,
  OBJECTS_CANONICAL_SCOPE,
  GLOSSARY_CANONICAL_SCOPE,
  PROJECT_CANONICAL_SCOPE,
  STORY_CANONICAL_SCOPE,
  FRAMEWORK_COLUMN_RENAMES,
  FRAMEWORK_OBJECTS_READER,
  FRAMEWORK_GLOSSARY_COLUMN_RENAMES,
  FRAMEWORK_GLOSSARY_READER,
  importedHeader,
  FRAMEWORK_OBJECT_FIELDS,
  FRAMEWORK_STORIES_RELEASES,
  PUBLISHED_TAG_COLUMN_RENAMES,
  PUBLISHED_TAG_READER,
  collidingHeaderGroups,
  frameworkColumnName,
  resolvedColumnPosition,
  CollidingColumnsRefusal,
} from "~/lib/import.server";
import { pythonStrip } from "~/lib/column-mapping";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";
import type { SheetIssue } from "~/lib/sheet-warnings";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFramework,
  describeWithFrameworkTag,
  describeWithPython,
  frameworkGlossaryColumns,
  frameworkGlossaryTerms,
  frameworkIsHeaderRow,
  frameworkScriptsAtTag,
  frameworkObjectsRead,
  readFrameworkColumnMapping,
  readFrameworkObjectFields,
  runPython,
} from "./helpers/framework-checkout";
import { parseYaml } from "~/lib/yaml.server";
import {
  serializeStory,
  layerFileContent,
  serializeProjectCsv,
  guardAmbiguousRuleLines,
  runPrePublishValidation,
  serializeGlossaryCsv,
} from "~/lib/publish.server";
import type { StepWithLayers } from "~/lib/publish.server";
import { OBJECTS_CSV_COLUMNS, serializeObjectsCsv } from "~/lib/csv-export.server";
import {
  layers,
  steps,
  stories,
  objects,
  glossary_terms,
  project_config,
  project_themes,
  project_landing,
  project_members,
  project_invites,
  projects,
} from "~/db/schema";

/**
 * `importRepo` reaches D1 once a repository parses, so the tests that drive it
 * end to end need a database. The mock records every insert and answers the
 * chain shapes the import uses; the rest of this file touches no database, so
 * a file-wide mock costs nothing.
 */
function makeDbMock() {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const settled = {
    returning: vi.fn(async () => [{ id: 77 }]),
    onConflictDoUpdate: vi.fn(() => Promise.resolve(undefined)),
    then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
  };
  return {
    inserts,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [] as unknown[]),
          get: vi.fn(async () => undefined),
          then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return settled;
      }),
      select: vi.fn(() => ({})),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => []) })) })),
    batch: vi.fn(async () => [[]]),
  };
}

let importDb = makeDbMock();

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => importDb) }));

const fixturesDir = resolve(__dirname, "fixtures");

function readFixture(name: string) {
  return readFileSync(resolve(fixturesDir, name), "utf-8");
}

// ---------------------------------------------------------------------------
// parseIndexMd
// ---------------------------------------------------------------------------

describe("parseIndexMd", () => {
  it("parses full frontmatter + body and returns all 5 fields", () => {
    const content = `---
stories_heading: Our Stories
stories_intro: Explore our narratives
objects_heading: Objects
objects_intro: Browse the collection
---
Welcome to the site.

This is the second paragraph.`;
    const result = parseIndexMd(content);
    expect(result.stories_heading).toBe("Our Stories");
    expect(result.stories_intro).toBe("Explore our narratives");
    expect(result.objects_heading).toBe("Objects");
    expect(result.objects_intro).toBe("Browse the collection");
    expect(result.welcome_body).toBe("Welcome to the site.\n\nThis is the second paragraph.");
  });

  it("returns frontmatter fields and undefined welcome_body when no body", () => {
    const content = `---
stories_heading: Our Stories
stories_intro: Explore our narratives
objects_heading: Objects
objects_intro: Browse the collection
---`;
    const result = parseIndexMd(content);
    expect(result.stories_heading).toBe("Our Stories");
    expect(result.stories_intro).toBe("Explore our narratives");
    expect(result.welcome_body).toBeUndefined();
  });

  it("returns empty object when no frontmatter delimiters", () => {
    const content = "Welcome to the site.\n\nThis is the body without frontmatter.";
    const result = parseIndexMd(content);
    expect(result).toEqual({});
  });

  it("returns empty object for empty string", () => {
    const result = parseIndexMd("");
    expect(result).toEqual({});
  });

  it("returns empty object for null/undefined", () => {
    expect(parseIndexMd(null)).toEqual({});
    expect(parseIndexMd(undefined)).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Import-time liquid-block recognition
  // -------------------------------------------------------------------------

  it("returns welcome_body undefined when body matches v1.3.0 liquid block", () => {
    const content = `---\nlayout: index\n---\n\n{% assign lang = site.data.languages[site.telar_language] | default: site.data.languages.en %}\n<!-- EN: Default welcome content for this page comes from your language pack. -->\n\n{{ lang.index_page.welcome | markdownify }}\n`;
    expect(parseIndexMd(content).welcome_body).toBeUndefined();
  });

  it("returns user content unchanged when body is not the liquid block", () => {
    const content = `---\nlayout: index\n---\n\n## My custom welcome\n`;
    expect(parseIndexMd(content).welcome_body).toBe("## My custom welcome");
  });
});

// ---------------------------------------------------------------------------
// isHeaderRow
// ---------------------------------------------------------------------------

describe("isHeaderRow", () => {
  it("identifies bilingual header row (80%+ values match known bilingual values)", () => {
    const row = {
      object_id: "id_objeto",
      title: "titulo",
      featured: "destacado",
      creator: "creador",
      description: "descripcion",
    };
    expect(isHeaderRow(row)).toBe(true);
  });

  it("returns false for actual data row", () => {
    const row = {
      object_id: "painting-001",
      title: "The Garden",
      featured: "true",
      creator: "Claude Monet",
    };
    expect(isHeaderRow(row)).toBe(false);
  });

  it("returns false for empty row", () => {
    const row = { object_id: "", title: "", featured: "" };
    expect(isHeaderRow(row)).toBe(false);
  });

  it("identifies English canonical header row including medium_genre", () => {
    const row = {
      a: "object_id",
      b: "title",
      c: "medium_genre",
      d: "year",
      e: "subjects",
    };
    expect(isHeaderRow(row)).toBe(true);
  });

  it("identifies header row using framework-canonical tokens (medium, object_type, protected)", () => {
    const row = {
      a: "object_id",
      b: "title",
      c: "medium",
      d: "object_type",
      e: "protected",
      f: "year",
    };
    expect(isHeaderRow(row)).toBe(true);
  });

  it("returns false for a mixed real-value data row", () => {
    const row = {
      a: "painting-001",
      b: "The Garden at Giverny",
      c: "oil on canvas",
      d: "1900",
      e: "gardens, impressionism",
      f: "Musee d'Orsay",
    };
    expect(isHeaderRow(row)).toBe(false);
  });

  // A row read from a CSV with more fields than headers carries a non-string
  // value, so the classifier has to survive one whatever the parser hands it.
  // Three genuine string cells keep this row at and above the floor so the
  // case under test — the non-string cell neither throwing nor counting — is
  // exercised independently of that floor.
  it("ignores a non-string value instead of throwing", () => {
    const row = {
      a: "id_objeto",
      b: "titulo",
      c: "creador",
      d: ["surplus"] as unknown as string,
    };
    expect(() => isHeaderRow(row)).not.toThrow();
    expect(isHeaderRow(row)).toBe(true);
  });

  it("returns false for a row whose only values are non-strings", () => {
    const row = { a: ["surplus"] as unknown as string };
    expect(isHeaderRow(row)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCommentRow
// ---------------------------------------------------------------------------

describe("isCommentRow", () => {
  it("identifies rows whose first cell starts with #", () => {
    const row = { object_id: "# This is a comment", title: "" };
    expect(isCommentRow(row)).toBe(true);
  });

  it("returns false for data rows", () => {
    const row = { object_id: "painting-001", title: "The Garden" };
    expect(isCommentRow(row)).toBe(false);
  });

  it("passes over a # in any later column, as the framework's row rule does", () => {
    const row = { object_id: "painting-001", description: "# skip this" };
    expect(isCommentRow(row)).toBe(false);
  });

  it("ignores a non-string first value instead of throwing", () => {
    const row = {
      extra: ["surplus"] as unknown as string,
      object_id: "painting-001",
    };
    expect(() => isCommentRow(row)).not.toThrow();
    expect(isCommentRow(row)).toBe(false);
  });

  it("is false for a row with no cells at all", () => {
    expect(isCommentRow({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTelarCsv
// ---------------------------------------------------------------------------

describe("parseTelarCsv", () => {
  // A spreadsheet exported with a stray comma gives one row more fields than
  // the header declares. That row must not take the whole import down with it.
  describe("a row with more fields than headers", () => {
    const ragged = "object_id,title,creator\nfirst,First,Alpha\nsecond,Second,Beta,surplus\nthird,Third,Gamma\n";

    it("keeps every row, the ragged one included", () => {
      const rows = parseTelarCsv(ragged);
      expect(rows.map((r) => r.object_id)).toEqual(["first", "second", "third"]);
    });

    it("drops the surplus field rather than leaving a non-string in the row", () => {
      const rows = parseTelarCsv(ragged);
      expect(rows[1]).toEqual({ object_id: "second", title: "Second", creator: "Beta" });
    });

    it("reports the row it trimmed, naming it", () => {
      const warnings: SheetIssue[] = [];
      parseTelarCsv(ragged, (issue) => warnings.push(issue));
      expect(warnings).toEqual([{ code: "ragged_row", row: { label: "second" } }]);
    });

    it("says nothing when the surplus cells are all empty", () => {
      const warnings: SheetIssue[] = [];
      parseTelarCsv("object_id,title\nfirst,First,\nsecond,Second, ,\n", (issue) => warnings.push(issue));
      expect(warnings).toEqual([]);
    });

    it("warns for a surplus cell holding only U+FEFF, which Python's strip keeps", () => {
      const warnings: SheetIssue[] = [];
      parseTelarCsv("object_id,title\no1,One,\uFEFF\n", (issue) => warnings.push(issue));
      expect(warnings).toEqual([{ code: "ragged_row", row: { label: "o1" } }]);
    });

    it("says nothing for a surplus cell holding only U+001F, which Python's strip removes", () => {
      const warnings: SheetIssue[] = [];
      parseTelarCsv("object_id,title\no1,One,\u001f\n", (issue) => warnings.push(issue));
      expect(warnings).toEqual([]);
    });

    it("says nothing when every row fits its headers", () => {
      const warnings: SheetIssue[] = [];
      parseTelarCsv("object_id,title\nfirst,First\n", (issue) => warnings.push(issue));
      expect(warnings).toEqual([]);
    });

    it("names a ragged row by its position when it has no cell to name it by", () => {
      const warnings: SheetIssue[] = [];
      parseTelarCsv("object_id,title\n,,surplus\n", (issue) => warnings.push(issue));
      expect(warnings).toEqual([{ code: "ragged_row", row: { position: 1 } }]);
    });
  });

  // The header declares the column, so the column exists on every row, even
  // one whose own line ends before reaching that cell.
  it("gives a row with fewer fields than the header an empty string for each missing trailing cell", () => {
    const rows = parseTelarCsv("object_id,title,notes\no1,A");
    expect(rows[0]).toEqual({ object_id: "o1", title: "A", notes: "" });
  });

  describe("duplicate column names", () => {
    it("preserves both values of an exact duplicate under two distinct keys", () => {
      const rows = parseTelarCsv("object_id,title,notes,notes\no1,A,first,second");
      expect(rows[0].object_id).toBe("o1");
      expect(rows[0].title).toBe("A");
      const values = Object.entries(rows[0])
        .filter(([k]) => k === "notes" || k.startsWith("notes_"))
        .map(([, v]) => v);
      expect(values.sort()).toEqual(["first", "second"]);
    });

    it("gives three distinct keys and loses no value when a literal 'notes_1' column already exists", () => {
      const rows = parseTelarCsv("object_id,notes,notes,notes_1\no1,first,second,third");
      const keys = Object.keys(rows[0]).filter((k) => k === "notes" || k.startsWith("notes_"));
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3); // no two columns share a key
      const values = keys.map((k) => rows[0][k]).sort();
      expect(values).toEqual(["first", "second", "third"]); // no value lost
    });

    // A canonical name is the Compositor's own, and it stores one value per
    // field: the file must carry one column per canonical name or the
    // framework refuses to build it. Which column keeps the name follows the
    // framework's own rule for such a pair: the one that holds values.
    describe("two different headers claiming one canonical name", () => {
      const parseObjects = (csv: string) => {
        const warnings: SheetIssue[] = [];
        const rows = parseTelarCsv(csv, (issue) => warnings.push(issue), false, OBJECTS_CANONICAL_SCOPE);
        // These cases are about the collision; the heading report has its own tests.
        return { rows, warnings: warnings.filter((w) => w.code !== "header_spelling") };
      };

      it("keeps the one that holds values when it comes first, and says the other was empty", () => {
        const { rows, warnings } = parseObjects(
          "object_id,title,medium,object_type\no1,T,Oil,\no2,U,,\no3,V,Ink,\n",
        );
        expect(rows.map((r) => r.medium_genre)).toEqual(["Oil", "", "Ink"]);
        expect(Object.keys(rows[0])).toEqual(["object_id", "title", "medium_genre"]);
        expect(warnings).toEqual([
          {
            code: "column_collision_only_filled",
            name: "medium_genre",
            headers: ["medium", "object_type"],
            kept: "medium",
            column: 3,
          },
        ]);
      });

      it("keeps the one that holds values when it comes last", () => {
        const { rows, warnings } = parseObjects(
          "object_id,object_type,title,medium\no1,,T,Oil\no2,,U,\n",
        );
        expect(rows.map((r) => r.medium_genre)).toEqual(["Oil", ""]);
        expect(Object.keys(rows[0])).toEqual(["object_id", "title", "medium_genre"]);
        expect(warnings).toEqual([
          {
            code: "column_collision_only_filled",
            name: "medium_genre",
            headers: ["object_type", "medium"],
            kept: "medium",
            column: 4,
          },
        ]);
      });

      it("counts a cell of nothing but whitespace as empty", () => {
        const { rows } = parseObjects("object_id,medium,object_type\no1,Oil,  \n");
        expect(rows[0].medium_genre).toBe("Oil");
      });

      // Nothing is lost either way, so nothing is said; the canonical spelling
      // keeps the name so the republished file carries the name the sheet models.
      it("keeps the canonical spelling when neither holds values, wherever it sits", () => {
        const { rows, warnings } = parseObjects(
          "object_id,medio,medium_genre,object_type\no1,,,\n",
        );
        expect(Object.keys(rows[0])).toEqual(["object_id", "medium_genre"]);
        expect(warnings).toEqual([]);
        expect(
          resolvedColumnPosition(
            [["object_id", "medio", "medium_genre", "object_type"], ["o1", "", "", ""]],
            "medium_genre",
            OBJECTS_CANONICAL_SCOPE,
          ),
        ).toBe(2);
      });

      it("keeps the first when neither holds values and neither is the canonical spelling", () => {
        const { rows, warnings } = parseObjects("object_id,object_type,medium\no1,,\n");
        expect(Object.keys(rows[0])).toEqual(["object_id", "medium_genre"]);
        expect(warnings).toEqual([]);
        expect(
          resolvedColumnPosition(
            [["object_id", "object_type", "medium"], ["o1", "", ""]],
            "medium_genre",
            OBJECTS_CANONICAL_SCOPE,
          ),
        ).toBe(1);
      });

      // Whether the import keeps one, refuses the sheet, or keeps both is
      // awaiting a ruling. Until then it keeps the last column claiming the
      // name, drops the others, and warns naming every column.
      it("keeps the last by default when both hold values, and warns naming both", () => {
        const { rows, warnings } = parseObjects(
          "object_id,title,medio_genero,medium_genre\no1,T,A,B",
        );
        expect(rows[0].medium_genre).toBe("B");
        expect(Object.keys(rows[0])).toEqual(["object_id", "title", "medium_genre"]);
        expect(warnings).toEqual([
          {
            code: "column_collision_last",
            name: "medium_genre",
            headers: ["medio_genero", "medium_genre"],
            column: 4,
          },
        ]);
      });

      it("keeps the last by default when both hold values in the other order too", () => {
        const { rows, warnings } = parseObjects("object_id,medium,medium_genre\no1,B,A");
        expect(rows[0].medium_genre).toBe("A");
        expect(warnings).toHaveLength(1);
      });

      it("counts a value that sits only in a comment row as no value", () => {
        const { rows, warnings } = parseObjects(
          "object_id,medium,object_type\n# guidance,,written in the comment\no1,Oil,\n",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].medium_genre).toBe("Oil");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", kept: "medium", column: 2 });
      });

      it("counts a value that sits only in the bilingual header row as no value", () => {
        const { rows, warnings } = parseObjects(
          "object_id,title,medium,object_type\nid_objeto,titulo,,tipo_objeto\no1,T,Oil,\n",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].medium_genre).toBe("Oil");
        expect(warnings).toContainEqual(
          expect.objectContaining({ code: "column_collision_only_filled", kept: "medium", column: 3 }),
        );
      });

      // An instruction column declares its own `#` name, which no rename
      // table carries, so it never claims the canonical name however full it is.
      it("never makes a # column a candidate, however full it is", () => {
        const { rows, warnings } = parseObjects("object_id,#medium,medium\no1,a note,\n");
        expect(rows[0]).toEqual({ object_id: "o1", "#medium": "a note", medium_genre: "" });
        expect(warnings).toEqual([]);
      });

      // Differing text that folds alike is a collision under the framework's
      // grouping, not the author's repeated column.
      it("treats Title beside title as a collision and keeps the one with values", () => {
        const { rows, warnings } = parseObjects("object_id,title,Title\no1,,Kept\n");
        expect(rows[0]).toEqual({ object_id: "o1", title: "Kept" });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", kept: "Title", column: 3 });
      });

      // Both fold to the canonical name, so the first of them keeps it.
      it("keeps the first of Title and title when neither holds values", () => {
        const { rows, warnings } = parseObjects("object_id,Title,title\no1,,\n");
        expect(Object.keys(rows[0])).toEqual(["object_id", "title"]);
        expect(warnings).toEqual([]);
        expect(resolvedColumnPosition(
          [["object_id", "Title", "title"], ["o1", "", ""]], "title", OBJECTS_CANONICAL_SCOPE,
        )).toBe(1);
      });

      // The framework reads the repeat as `title.1`, a column of its own; the
      // collision is between the first `title` and `Title`. So the repeat is
      // suffixed and kept, and the rule chooses between the other two.
      it("suffixes a repeated title beside a Title, and applies the rule to the first of each", () => {
        const { rows, warnings } = parseObjects(
          "object_id,title,title,Title\no1,,second,Kept\n",
        );
        expect(rows[0]).toEqual({ object_id: "o1", title_1: "second", title: "Kept" });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", headers: ["title", "Title"] });
      });
    });

    // The framework's reader turns two identically-spelled headers into
    // `title` and `title.1` and keeps both values, and its collision check
    // does not fire for them — so folding them here would lose a value the
    // published file would have carried. Proved against the framework itself
    // in tests/objects-publish-parity.test.ts.
    it("never folds two identically-spelled headers, even under a scope", () => {
      const warnings: SheetIssue[] = [];
      const rows = parseTelarCsv(
        "object_id,title,title\no1,A,B",
        (issue) => warnings.push(issue),
        false,
        OBJECTS_CANONICAL_SCOPE,
      );
      const values = Object.entries(rows[0])
        .filter(([k]) => k === "title" || k.startsWith("title_"))
        .map(([, v]) => v);
      expect(values.sort()).toEqual(["A", "B"]);
      expect(warnings).toEqual([]);
    });

    it("folds nothing at all without a scope", () => {
      const warnings: SheetIssue[] = [];
      const rows = parseTelarCsv("object_id,medium_genre,medium\no1,A,B", (issue) => warnings.push(issue));
      expect(rows[0].medium_genre).toBe("A");
      expect(rows[0].medium_genre_1).toBe("B");
      expect(warnings).toEqual([]);
    });

    // The framework scopes its own rename table per sheet, so `step` and
    // `paso` on an objects sheet are two of the author's own columns. Neither
    // is folded into the other, and neither is RENAMED either: `paso` keeps
    // its own header rather than becoming a suffixed `step_1` the objects
    // mapper will never read and the published file will never carry.
    it("leaves a name outside this sheet's scope under the author's own header", () => {
      const rows = parseTelarCsv(
        "object_id,step,paso\no1,A,B", undefined, false, OBJECTS_CANONICAL_SCOPE,
      );
      expect(rows[0]).toEqual({ object_id: "o1", step: "A", paso: "B" });
    });

    it("does not rename a lone out-of-scope alias either", () => {
      const rows = parseTelarCsv(
        "object_id,paso\no1,B", undefined, false, OBJECTS_CANONICAL_SCOPE,
      );
      expect(rows[0]).toEqual({ object_id: "o1", paso: "B" });
    });

    it("still renames an alias the sheet does model", () => {
      const rows = parseTelarCsv(
        "object_id,medio\no1,oil", undefined, false, OBJECTS_CANONICAL_SCOPE,
      );
      expect(rows[0]).toEqual({ object_id: "o1", medium_genre: "oil" });
    });

    it("keeps the alias with values over an empty canonical spelling in either order", () => {
      const first = parseTelarCsv(
        "object_id,medium,medium_genre\no1,B,\n", undefined, false, OBJECTS_CANONICAL_SCOPE,
      );
      expect(first[0]).toEqual({ object_id: "o1", medium_genre: "B" });
      const second = parseTelarCsv(
        "object_id,medium_genre,medium\no1,,B\n", undefined, false, OBJECTS_CANONICAL_SCOPE,
      );
      expect(second[0]).toEqual({ object_id: "o1", medium_genre: "B" });
    });

    it("keeps a duplicate column's values distinct alongside a protection column, which is unaffected", () => {
      const rows = parseTelarCsv(
        "story_id,notes,notes,protected\ns1,first,second,yes",
        undefined,
        true,
      );
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
      const notesValues = Object.entries(rows[0])
        .filter(([k]) => k === "notes" || k.startsWith("notes_"))
        .map(([, v]) => v);
      expect(notesValues.sort()).toEqual(["first", "second"]);
    });
  });

  it("skips bilingual header row (row where 80%+ values match KNOWN_BILINGUAL_VALUES)", () => {
    const csv = readFixture("objects.csv");
    const rows = parseTelarCsv(csv);
    // Should not have the bilingual row (id_objeto, titulo, etc.)
    const hasBilingual = rows.some((r) => r.object_id === "id_objeto");
    expect(hasBilingual).toBe(false);
  });

  it("skips comment rows (cells starting with #)", () => {
    const csv = readFixture("objects.csv");
    const rows = parseTelarCsv(csv);
    const hasComment = rows.some((r) =>
      Object.values(r).some((v) => v.startsWith("#"))
    );
    expect(hasComment).toBe(false);
  });

  it("keeps actual data rows intact", () => {
    const csv = readFixture("objects.csv");
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].object_id).toBe("painting-001");
    expect(rows[1].object_id).toBe("sculpture-002");
  });

  // -------------------------------------------------------------------------
  // Spanish -> English header normalisation
  // -------------------------------------------------------------------------

  it("normalises Spanish objects headers to canonical English keys", () => {
    const csv = "id_objeto,titulo,medio,dimensiones\npainting-001,The Garden,oil on canvas,80x60cm";
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      object_id: "painting-001",
      title: "The Garden",
      medium_genre: "oil on canvas",
      dimensions: "80x60cm",
    });
  });

  it("normalises Spanish project headers to canonical English keys", () => {
    const csv = "orden,id_historia,privada\n1,my-story,true";
    const rows = parseTelarCsv(csv, undefined, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order: "1",
      story_id: "my-story",
      private: "true",
    });
  });

  it("normalises Spanish story headers to canonical English keys", () => {
    const csv = "paso,objeto,pregunta,boton_capa1\n1,painting-001,What is this?,More";
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step: "1",
      object: "painting-001",
      question: "What is this?",
      layer1_button: "More",
    });
  });

  it("normalises Spanish glossary headers (with accents) to canonical English keys", () => {
    const csv = "id_término,definición,términos_relacionados\nweave,A woven structure,loom";
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      term_id: "weave",
      definition: "A woven structure",
      related_terms: "loom",
    });
  });

  it("leaves an all-English CSV unchanged (regression)", () => {
    const csv = "object_id,title,medium_genre,dimensions\npainting-001,The Garden,oil,80x60";
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(["object_id", "title", "medium_genre", "dimensions"]);
    expect(rows[0]).toMatchObject({
      object_id: "painting-001",
      title: "The Garden",
      medium_genre: "oil",
      dimensions: "80x60",
    });
  });

  it("passes through an unknown custom header verbatim, case-preserved", () => {
    const csv = "object_id,Inventory_No\npainting-001,INV-42";
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("Inventory_No", "INV-42");
    expect(rows[0]).toHaveProperty("object_id", "painting-001");
  });

  it("normalises capitalised known headers (Google Sheets casing) to lowercase canonical keys", () => {
    const csv = "Title,Page\nThe Garden,about";
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("title", "The Garden");
    expect(rows[0]).toHaveProperty("page", "about");
  });

  it("skips a Spanish bilingual second row, keeping only the data row", () => {
    const csv = [
      "object_id,title,creator,description",
      "id_objeto,titulo,creador,descripcion",
      "painting-001,The Garden,Monet,A garden",
    ].join("\n");
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: "painting-001", title: "The Garden" });
  });

  // The framework drops every column whose header starts with `#` before it
  // asks whether row 2 is the bilingual header (scripts/telar/core.py), so an
  // instruction cell under such a column does not count against the row.
  it("skips a bilingual second row whose only unknown cell is under a # column", () => {
    const csv = [
      "object_id,title,creator,#notes",
      "id_objeto,titulo,creador,instructions for this column",
      "painting-001,The Garden,Monet,",
    ].join("\n");
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: "painting-001", title: "The Garden" });
  });

  it("raises no warning for a bilingual row it skips whose only unknown cell is under a # column", () => {
    const warnings: unknown[] = [];
    parseTelarCsv(
      ["object_id,title,creator,#notes", "id_objeto,titulo,creador,instructions for this column", "painting-001,The Garden,Monet,"].join("\n"),
      (issue) => warnings.push(issue),
    );
    expect(warnings).toEqual([]);
  });

  // A second row wider than the header makes pandas read its first field as
  // an index and shift every column, so no cell of it sits under `#notes`
  // there, and the row is weighed whole.
  it("weighs a second row wider than the header whole", () => {
    const csv = [
      "object_id,title,creator,#notes",
      "id_objeto,titulo,creador,ignored,unknown",
      "painting-001,The Garden,Monet,,",
    ].join("\n");
    expect(parseTelarCsv(csv).map((row) => row.object_id)).toEqual(["id_objeto", "painting-001"]);
  });

  // pandas reads the leading fields of a first record wider than the header as
  // an index, before it filters comments, so a wide comment row there shifts
  // every column and the `#` column holds no cell the test could leave out.
  it("weighs every cell when the first record after the header is wider than it", () => {
    const csv = [
      "object_id,title,creator,#notes",
      "#instruction,,,,",
      "id_objeto,titulo,creador,instructions",
      "painting-001,The Garden,Monet,",
    ].join("\n");
    expect(parseTelarCsv(csv).map((row) => row.object_id)).toEqual(["id_objeto", "painting-001"]);
  });

  // pandas does not strip a header, so ` #notes` is a column of its own there
  // and its cell counts.
  it("counts a cell under a header whose # follows a space", () => {
    const csv = [
      "object_id,title,creator, #notes",
      "id_objeto,titulo,creador,instructions for this column",
      "painting-001,The Garden,Monet,",
    ].join("\n");
    expect(parseTelarCsv(csv)).toHaveLength(2);
  });

  it("skips an English bilingual second row, keeping only the data row", () => {
    const csv = [
      "object_id,title,creator,description",
      "object_id,title,creator,description",
      "painting-001,The Garden,Monet,A garden",
    ].join("\n");
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: "painting-001", title: "The Garden" });
  });

  it("retains a sparse data row whose only populated cell equals a bilingual word", () => {
    // Glossary row with term_id="source" (a canonical English word now in
    // KNOWN_BILINGUAL_VALUES) and empty title/definition. A single populated
    // cell yields a 1/1 = 100% match and was wrongly dropped as a header row.
    const csv = ["term_id,title,definition", "source,,"].join("\n");
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].term_id).toBe("source");
  });

  // The three-cell floor at its own boundary: a bilingual row of
  // EXACTLY three populated cells is still caught on every sheet type,
  // including project mode's own token set (protection aliases).
  describe("a three-cell bilingual row is still detected and skipped, at the floor", () => {
    it("glossary: id_término,titulo,definición is skipped", () => {
      const csv = [
        "term_id,title,definition",
        "id_término,titulo,definición",
        "loom,Loom,A device for weaving.",
      ].join("\n");
      const rows = parseTelarCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].term_id).toBe("loom");
    });

    it("story: paso,objeto,pregunta is skipped", () => {
      const csv = [
        "step,object,question",
        "paso,objeto,pregunta",
        "1,painting-001,What is this?",
      ].join("\n");
      const rows = parseTelarCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].step).toBe("1");
    });

    it("objects: id_objeto,titulo,creador is skipped", () => {
      const csv = [
        "object_id,title,creator",
        "id_objeto,titulo,creador",
        "painting-001,The Garden,Monet",
      ].join("\n");
      const rows = parseTelarCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0].object_id).toBe("painting-001");
    });

    it("project: orden,id_historia,privada is skipped, using project mode's own token set", () => {
      const csv = [
        "order,story_id,private",
        "orden,id_historia,privada",
        "1,my-story,true",
      ].join("\n");
      const rows = parseTelarCsv(csv, undefined, true);
      expect(rows).toHaveLength(1);
      expect(rows[0].story_id).toBe("my-story");
    });
  });

  // Requirement 4: an ordinary data row of three or more cells is content,
  // not a header, and must still import — the floor only withholds rows
  // shorter than three from the ratio check, it does not change how a
  // longer row is judged.
  it("an ordinary three-cell data row still imports", () => {
    const csv = [
      "object_id,title,creator",
      "painting-001,The Garden,Claude Monet",
    ].join("\n");
    const rows = parseTelarCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      object_id: "painting-001",
      title: "The Garden",
      creator: "Claude Monet",
    });
  });

  // The bilingual header test is spent on the first non-comment row
  // only, never on any row after it. A glossary of cataloguing terms is built
  // entirely out of the vocabulary that test recognises (title, source,
  // creator, year, description, period, location, object, question, answer,
  // step, page), so a DATA row made of enough of them scores the same as a
  // genuine header row; only the position a header row can actually occupy
  // may be read that way.
  describe("the header test is spent once, on the first non-comment row", () => {
    it("keeps a data row of header-like cataloguing words further down the file", () => {
      // The issue's own example: a glossary term whose four cells are each,
      // on their own, an ordinary bilingual token. Testing every row reads
      // this as a second header row; testing only the position a header row
      // can occupy does not.
      const csv = [
        "term_id,title,definition,related_terms",
        "backstrap-loom,Backstrap loom,A hand-operated weaving device,weaving",
        "object,Source,Creator,Year",
      ].join("\n");
      const rows = parseTelarCsv(csv);
      expect(rows.map((r) => r.term_id)).toEqual(["backstrap-loom", "object"]);
    });

    // The test is spent on its first look, whatever it finds there — a
    // MATCH consumes it exactly as a non-match does. Without this, a second
    // header-like row further down the file is dropped a second time: this
    // CSV's real bilingual header row (`id_objeto,titulo,creador,fuente`)
    // consumes the test and is skipped as intended, but `source,Creator,
    // Title,Object` — an ordinary data row whose four cells all happen to be
    // known header tokens too — must
    // still survive, because nothing is left to spend on it.
    it("does not spend a second look on a later header-like row once the first one has matched", () => {
      const csv = [
        "object_id,title,creator,source",
        "id_objeto,titulo,creador,fuente",
        "source,Creator,Title,Object",
      ].join("\n");
      const rows = parseTelarCsv(csv);
      expect(rows.map((r) => r.object_id)).toEqual(["source"]);
    });

    it("does not let a leading comment row consume the one header test — a bilingual row right after it is still skipped", () => {
      const csv = [
        "object_id,title,creator,description",
        "#Please fill in your objects below",
        "id_objeto,titulo,creador,descripcion",
        "painting-001,The Garden,Monet,A garden",
      ].join("\n");
      const rows = parseTelarCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ object_id: "painting-001", title: "The Garden" });
    });

    it("loses no row from a file with no bilingual header row, first ordinary data row included", () => {
      const csv = [
        "object_id,title,creator",
        "painting-001,The Garden,Claude Monet",
        "painting-002,Water Lilies,Claude Monet",
      ].join("\n");
      const rows = parseTelarCsv(csv);
      expect(rows.map((r) => r.object_id)).toEqual(["painting-001", "painting-002"]);
    });

    // Four of five cells are header tokens: the row is skipped at the 80%
    // threshold, and the fifth may be content, so the author is told.
    it("warns when the header test drops a row that is not wholly headings, naming it by its first cell", () => {
      const warnings: SheetIssue[] = [];
      const csv = [
        "object_id,title,creator,description,year",
        "id_objeto,titulo,creador,descripcion,Monet 1890",
        "painting-001,The Garden,Monet,A garden,1890",
      ].join("\n");
      const rows = parseTelarCsv(csv, (issue) => warnings.push(issue));
      expect(rows.map((r) => r.object_id)).toEqual(["painting-001"]);
      expect(warnings).toEqual([{ code: "bilingual_header_row", row: { label: "id_objeto" } }]);
    });

    // Every cell a header token: the bilingual row the Compositor and the
    // framework write. Skipped as before, and nothing is said.
    it("skips a row of nothing but header tokens in silence", () => {
      const warnings: SheetIssue[] = [];
      const csv = [
        "object_id,title,creator,description",
        "id_objeto,titulo,creador,descripcion",
        "painting-001,The Garden,Monet,A garden",
      ].join("\n");
      const rows = parseTelarCsv(csv, (issue) => warnings.push(issue));
      expect(rows.map((r) => r.object_id)).toEqual(["painting-001"]);
      expect(warnings).toEqual([]);
    });

    // A comment row is `verdict.skip` too, but for reason "comment" — the
    // bilingual-header warning is worded for the OTHER reason a record is
    // skipped and must fire only for it. Neither existing warning test can
    // see this: the leading-comment test above collects no warnings at all,
    // and the no-bilingual-row test below carries no comment.
    it("says nothing about a comment row, even though it is skipped too", () => {
      const warnings: SheetIssue[] = [];
      const csv = "object_id,title,creator\n#Instructions\npainting-001,The Garden,Monet";
      const rows = parseTelarCsv(csv, (issue) => warnings.push(issue));
      expect(rows).toHaveLength(1);
      expect(warnings).toEqual([]);
    });

    it("says nothing when there is no bilingual row for the header test to drop", () => {
      const warnings: SheetIssue[] = [];
      parseTelarCsv("object_id,title\npainting-001,The Garden\n", (issue) => warnings.push(issue));
      expect(warnings).toEqual([]);
    });
  });

  // A whitespace-only line is a row pandas never creates
  // (`skip_blank_lines`, the default `read_csv` every Telar CSV is read
  // under), and so must never be the row the one header test above is spent
  // on. Verified directly against the framework's own venv before this was
  // written — `pd.read_csv` drops a delimiter-free line of nothing but
  // spaces or tabs before it becomes a DataFrame row at all, but keeps a
  // line that carries a comma (however blank each of its cells looks) and
  // keeps a delimiter-free line whose one cell holds only U+00A0 or U+0085 —
  // see `isPandasBlankLine` in import.server.ts for the full probe notes.
  describe("a whitespace-only line does not spend the header test", () => {
    // The issue's own repro: without this fix, HEAD spends the header test on
    // the blank line, so the real bilingual header row two lines down is
    // never tested and imports as an object named `id_objeto`.
    const csv = ["object_id,title,creator", "   ", "id_objeto,titulo,creador", "painting-001,The Garden,Monet"].join(
      "\n",
    );

    it("imports only the real data row, not the blank line and not the bilingual header", () => {
      const rows = parseTelarCsv(csv);
      expect(rows.map((r) => r.object_id)).toEqual(["painting-001"]);
    });

    it("still spends the header test on the bilingual row, which is wholly headings and so said nothing about", () => {
      const warnings: SheetIssue[] = [];
      const rows = parseTelarCsv(csv, (issue) => warnings.push(issue));
      expect(rows.map((r) => r.object_id)).toEqual(["painting-001"]);
      expect(warnings).toEqual([]);
    });

    it("does the same for a tab-only line", () => {
      const tabCsv = csv.replace("   ", "\t");
      expect(parseTelarCsv(tabCsv).map((r) => r.object_id)).toEqual(["painting-001"]);
    });

    // A comma anywhere in the line takes it past pandas' blank-line check,
    // whatever each cell holds — `,,` and `"   ","   ","   "` both survive as
    // ordinary rows there, fail the populated-cell floor, and so consume the
    // header test themselves (the same trade `isHeaderRow`'s own floor makes).
    // Widening the fix to any row of empty-looking cells, rather
    // than only a delimiter-free one, would silently drop a row the
    // framework keeps.
    it("still spends the test on a comma-separated row of blank cells, as the framework does", () => {
      const blankCellsCsv = [
        "object_id,title,creator",
        "   ,   ,   ",
        "id_objeto,titulo,creador",
        "painting-001,The Garden,Monet",
      ].join("\n");
      const rows = parseTelarCsv(blankCellsCsv);
      // The blank-cells row survives as a (blank) object, so it is the row
      // the one header test is spent on — leaving the true bilingual header
      // row below it untested and imported as data, exactly as `df.iloc[0]`
      // being that row leaves it for the framework.
      expect(rows.map((r) => r.object_id)).toEqual(["", "id_objeto", "painting-001"]);
    });

    // U+00A0 and U+0085 strip to nothing under `pythonStrip`, but pandas'
    // own blank-line check is narrower than `str.isspace()` and does not
    // recognise either — a lone one of them survives as its own row, so it
    // still spends the header test.
    it("still spends the test on a lone U+00A0 or U+0085 line, which pandas does not call blank", () => {
      const NBSP = " ";
      const nelCsv = ["object_id,title,creator", NEL, "id_objeto,titulo,creador", "painting-001,The Garden,Monet"].join(
        "\n",
      );
      const nbspCsv = nelCsv.replace(NEL, NBSP);
      // The lone mark row is still IMPORTED, not dropped — it is not pandas-
      // blank — but `buildRowByPosition` stores its one cell under
      // `pythonStrip`, the same strip that empties the mark on its own, so the
      // stored id reads as "" rather than as the mark itself.
      expect(parseTelarCsv(nelCsv).map((r) => r.object_id)).toEqual(["", "id_objeto", "painting-001"]);
      expect(parseTelarCsv(nbspCsv).map((r) => r.object_id)).toEqual(["", "id_objeto", "painting-001"]);
    });
  });

  describeWithFramework(
    "a whitespace-only line does not spend the header test, matched against the framework itself",
    () => {
      it(
        "imports only the data row on both sides",
        () => {
          const csv = [
            "object_id,title,creator",
            "   ",
            "id_objeto,titulo,creador",
            "painting-001,The Garden,Monet",
          ].join("\n");
          expect(parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE).map((r) => r.object_id)).toEqual([
            "painting-001",
          ]);
          expect(frameworkObjectsRead(csv, FRAMEWORK_SCRIPTS_DIR).ids).toEqual(["painting-001"]);
        },
        FRAMEWORK_TIMEOUT_MS,
      );

      it(
        "spends the test on a comma-separated blank-cells row on both sides, framework quirk included",
        () => {
          // `frameworkObjectsRead`'s `ids` are read straight off the column,
          // unstripped, so the blank-cells row's id compares here as `"   "`
          // against `pythonStrip`'s `""` — a storage difference, not a
          // disagreement about which rows survive. Row COUNT is the
          // invariant this fixture is proving: both sides keep the
          // blank-cells row as data and, because the header test was already
          // spent on it, both also keep the true bilingual header row below
          // it as data — three rows, not two.
          const csv = [
            "object_id,title,creator",
            "   ,   ,   ",
            "id_objeto,titulo,creador",
            "painting-001,The Garden,Monet",
          ].join("\n");
          const here = parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE).length;
          const there = (frameworkObjectsRead(csv, FRAMEWORK_SCRIPTS_DIR).ids as string[]).length;
          expect(here).toBe(there);
          expect(here).toBe(3);
        },
        FRAMEWORK_TIMEOUT_MS,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// YAML parsing
// ---------------------------------------------------------------------------

describe("parseYaml", () => {
  it("extracts telar.version from _config.yml fixture", () => {
    const yaml = readFixture("config.yml");
    const config = parseYaml(yaml);
    const telarVersion = (config?.telar as Record<string, unknown>)?.version;
    expect(telarVersion).toBe("0.9.3-beta");
  });

  it("returns null for telar.version when key is missing", () => {
    const yaml = "title: My Site\nbaseurl: /test";
    const config = parseYaml(yaml);
    const telarVersion = (config?.telar as Record<string, unknown>)?.version;
    expect(telarVersion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapConfigToProjectConfig
// ---------------------------------------------------------------------------

describe("mapConfigToProjectConfig", () => {
  it("maps _config.yml fields to project_config columns", () => {
    const yaml = readFixture("config.yml");
    const config = parseYaml(yaml);
    const mapped = mapConfigToProjectConfig(config);

    expect(mapped.title).toBe("My Telar Site");
    expect(mapped.baseurl).toBe("/my-telar-site");
    expect(mapped.url).toBe("https://example.github.io");
    expect(mapped.theme).toBe("trama");
    expect(mapped.lang).toBe("en");
    expect(mapped.description).toBe("A digital storytelling project");
    expect(mapped.author).toBe("Jane Doe");
    expect(mapped.email).toBe("jane@example.com");
    expect(mapped.telar_version).toBe("0.9.3-beta");
  });

  // The limit is a constant now, so an imported site's stated number is read
  // by nothing — its own `_config.yml` keeps the line, and the column stays
  // untouched.
  it("reads no answer word limit from a file that states one", () => {
    const yaml = "title: A site\nstory_content:\n  answer_word_limit: 150\n";
    expect(mapConfigToProjectConfig(parseYaml(yaml))).not.toHaveProperty("answer_word_limit");
  });

  it("maps story_interface fields", () => {
    const yaml = readFixture("config.yml");
    const config = parseYaml(yaml);
    const mapped = mapConfigToProjectConfig(config);

    expect(mapped.show_on_homepage).toBe(true);
    expect(mapped.show_story_steps).toBe(true);
    expect(mapped.show_object_credits).toBe(true);
  });

  it("maps collection_interface fields", () => {
    const yaml = readFixture("config.yml");
    const config = parseYaml(yaml);
    const mapped = mapConfigToProjectConfig(config);

    expect(mapped.browse_and_search).toBe(true);
    expect(mapped.show_link_on_homepage).toBe(true);
    expect(mapped.show_sample_on_homepage).toBe(false);
    expect(mapped.featured_count).toBe(4);
  });

  it("maps story_key and google_sheets fields", () => {
    const yaml = readFixture("config.yml");
    const config = parseYaml(yaml);
    const mapped = mapConfigToProjectConfig(config);

    expect(mapped.story_key).toBe("");
    expect(mapped.google_sheets_enabled).toBe(false);
    expect(mapped.google_sheets_published_url).toBe("");
  });

  // story_key is the top-level scalar, the only place the framework has read it
  // from since v0.8.0-beta. A `protected:` block is somebody else's data: a key
  // sitting inside one is not this project's story key and must not be read as
  // though it were.
  describe("story_key location (top-level only)", () => {
    it("reads story_key from the top-level scalar", () => {
      const config = parseYaml("story_key: s3cret-top\n");
      const mapped = mapConfigToProjectConfig(config);
      expect(mapped.story_key).toBe("s3cret-top");
    });

    it("parses a quoted top-level value exactly (no quotes retained)", () => {
      const config = parseYaml('story_key: "abc 123"\n');
      const mapped = mapConfigToProjectConfig(config);
      expect(mapped.story_key).toBe("abc 123");
    });

    it("does not read a key nested under protected:", () => {
      const config = parseYaml("protected:\n  key: s3cret-nested\n");
      const mapped = mapConfigToProjectConfig(config);
      expect(mapped.story_key).toBeUndefined();
    });

    it("takes the top-level scalar even when a protected block also carries a key", () => {
      const config = parseYaml("story_key: s3cret-top\nprotected:\n  key: s3cret-nested\n");
      const mapped = mapConfigToProjectConfig(config);
      expect(mapped.story_key).toBe("s3cret-top");
    });

    it("is undefined when no top-level key is present", () => {
      const config = parseYaml("title: No Key Site\n");
      const mapped = mapConfigToProjectConfig(config);
      expect(mapped.story_key).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// mapObjectsCsv
// ---------------------------------------------------------------------------

describe("mapObjectsCsv", () => {
  it("maps objects.csv rows to objects table columns", () => {
    const csv = readFixture("objects.csv");
    const rows = parseTelarCsv(csv);
    const mapped = mapObjectsCsv(rows);

    expect(mapped).toHaveLength(2);
    expect(mapped[0].object_id).toBe("painting-001");
    expect(mapped[0].title).toBe("The Garden");
    expect(mapped[0].featured).toBe(true);
    expect(mapped[0].creator).toBe("Claude Monet");
    expect(mapped[1].object_id).toBe("sculpture-002");
    expect(mapped[1].featured).toBe(false);
  });

  it('converts "true"/"yes"/"1" to true for featured', () => {
    const rows = [
      { object_id: "a", title: "A", featured: "true", creator: "" },
      { object_id: "b", title: "B", featured: "yes", creator: "" },
      { object_id: "c", title: "C", featured: "1", creator: "" },
      { object_id: "d", title: "D", featured: "false", creator: "" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped[0].featured).toBe(true);
    expect(mapped[1].featured).toBe(true);
    expect(mapped[2].featured).toBe(true);
    expect(mapped[3].featured).toBe(false);
  });

  it("filters out rows where object_id is empty string", () => {
    const rows = [
      { object_id: "", title: "No ID", featured: "false", creator: "" },
      { object_id: "valid-001", title: "Valid", featured: "false", creator: "" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].object_id).toBe("valid-001");
  });

  it("filters out rows where object_id is whitespace-only", () => {
    const rows = [
      { object_id: "   ", title: "Whitespace ID", featured: "false", creator: "" },
      { object_id: "\t", title: "Tab ID", featured: "false", creator: "" },
      { object_id: "real-id", title: "Real", featured: "false", creator: "" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].object_id).toBe("real-id");
  });

  it("filters out rows where object_id key is missing", () => {
    const rows = [
      { title: "No object_id key", featured: "false", creator: "" } as Record<string, string>,
      { object_id: "present-001", title: "Present", featured: "false", creator: "" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].object_id).toBe("present-001");
  });

  it("returns empty array when all rows have empty object_id", () => {
    const rows = [
      { object_id: "", title: "A", featured: "false", creator: "" },
      { object_id: "  ", title: "B", featured: "false", creator: "" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped).toHaveLength(0);
  });

  it("maps the first-class dimensions column", () => {
    const rows = [
      { object_id: "a", title: "A", featured: "false", dimensions: "24 x 30 cm" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped[0].dimensions).toBe("24 x 30 cm");
  });

  it("captures custom columns into extra_columns as a JSON blob", () => {
    const rows = [
      {
        object_id: "a",
        title: "A",
        featured: "false",
        creator: "Claude Monet",
        procedencia: "Bogotá",
        inventory_no: "X-12",
      },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(typeof mapped[0].extra_columns).toBe("string");
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({
      procedencia: "Bogotá",
      inventory_no: "X-12",
    });
  });

  it("leaves extra_columns undefined when there are no custom columns", () => {
    const rows = [
      { object_id: "a", title: "A", featured: "false", creator: "Claude Monet" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  it("skips empty custom columns in extra_columns", () => {
    const rows = [
      {
        object_id: "a",
        title: "A",
        featured: "false",
        procedencia: "",
        notes: "x",
      },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({ notes: "x" });
  });

  it("does not capture known first-class fields into extra_columns", () => {
    const rows = [
      {
        object_id: "a",
        title: "A",
        featured: "false",
        creator: "Claude Monet",
        procedencia: "Bogotá",
      },
    ];
    const mapped = mapObjectsCsv(rows);
    const extras = JSON.parse(mapped[0].extra_columns as string);
    expect(extras.creator).toBeUndefined();
    expect(mapped[0].creator).toBe("Claude Monet");
  });

  // ---------------------------------------------------------------------------
  // Reserved-column import warning
  //
  // `_metadata` is not in KNOWN_OBJECT_KEYS, so it is captured into
  // extra_columns like any other custom column — this warning is notice
  // only, not enforcement. The framework's own build refuses a sheet
  // carrying it (scripts/telar/csv_utils.py's _refuse_reserved_columns),
  // and serializeObjectsCsv would write it straight back out as a real
  // objects.csv column at publish, so the author should learn about it here
  // too, not only when the publish blocker (object_reserved_column in
  // runPrePublishValidation) later refuses.
  // ---------------------------------------------------------------------------
  describe("reserved-column import warning", () => {
    it("still captures the reserved column into extra_columns unchanged — warn only, never drop or alter", () => {
      const rows = [{ object_id: "a", title: "A", featured: "false", _metadata: "do-not-touch" }];
      const onWarning = vi.fn();
      const mapped = mapObjectsCsv(rows, undefined, onWarning);
      expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({ _metadata: "do-not-touch" });
    });

    it("fires the warning exactly once for a sheet carrying the reserved column", () => {
      const rows = [
        { object_id: "a", title: "A", featured: "false", _metadata: "x" },
        { object_id: "b", title: "B", featured: "false", _metadata: "y" },
      ];
      const onWarning = vi.fn();
      mapObjectsCsv(rows, undefined, onWarning);
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onWarning.mock.calls[0][0]).toEqual({ code: "reserved_column", columns: ["_metadata"] });
    });

    it.each(["_Metadata", "_METADATA", "_metadata ", " _metadata"])(
      "fires the warning for the reserved name %j regardless of case or whitespace",
      (columnName) => {
        const rows = [{ object_id: "a", title: "A", featured: "false", [columnName]: "x" }];
        const onWarning = vi.fn();
        mapObjectsCsv(rows, undefined, onWarning);
        expect(onWarning).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["my_metadata", "metadata"])(
      "does not fire for a column that merely contains the word (%j)",
      (columnName) => {
        const rows = [{ object_id: "a", title: "A", featured: "false", [columnName]: "x" }];
        const onWarning = vi.fn();
        mapObjectsCsv(rows, undefined, onWarning);
        expect(onWarning).not.toHaveBeenCalled();
      },
    );

    it("does not fire at all for a sheet without the reserved column", () => {
      const rows = [{ object_id: "a", title: "A", featured: "false", procedencia: "Bogotá" }];
      const onWarning = vi.fn();
      mapObjectsCsv(rows, undefined, onWarning);
      expect(onWarning).not.toHaveBeenCalled();
    });

    it("works with no onWarning passed at all", () => {
      const rows = [{ object_id: "a", title: "A", featured: "false", _metadata: "x" }];
      expect(() => mapObjectsCsv(rows)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // The chain the warning is earlier notice for: an objects.csv carrying
  // _metadata, once imported, produces the actual publish blocker.
  // ---------------------------------------------------------------------------
  describe("an objects.csv with a reserved column, end to end", () => {
    it("produces a publish blocker naming the object and the column", () => {
      const rows = parseTelarCsv("object_id,title,_metadata\nsculpture-1,A Sculpture,forged-value");
      const mapped = mapObjectsCsv(rows);
      const validation = runPrePublishValidation({
        headSha: "a",
        currentRepoHead: "a",
        stories: [],
        steps: [],
        pages: [],
        glossary: [],
        objects: mapped.map((m) => ({
          object_id: m.object_id as string,
          title: (m.title as string) ?? null,
          extra_columns: (m.extra_columns as string) ?? null,
        })),
      });
      const blockers = validation.blockers.filter((b) => b.code === "object_reserved_column");
      expect(blockers).toHaveLength(1);
      expect(blockers[0].entityId).toBe("sculpture-1");
      expect(blockers[0].params).toEqual({ id: "sculpture-1", column: "_metadata" });
    });

    it("produces no publish blocker for an objects.csv without the reserved column", () => {
      const rows = parseTelarCsv("object_id,title,procedencia\nsculpture-1,A Sculpture,Bogotá");
      const mapped = mapObjectsCsv(rows);
      const validation = runPrePublishValidation({
        headSha: "a",
        currentRepoHead: "a",
        stories: [],
        steps: [],
        pages: [],
        glossary: [],
        objects: mapped.map((m) => ({
          object_id: m.object_id as string,
          title: (m.title as string) ?? null,
          extra_columns: (m.extra_columns as string) ?? null,
        })),
      });
      expect(validation.blockers.map((b) => b.code)).not.toContain("object_reserved_column");
    });
  });
});

// ---------------------------------------------------------------------------
// Protection aliases are project-only
// ---------------------------------------------------------------------------

describe("protected/protegido do not rename a same-named column outside project.csv", () => {
  it("keeps a custom objects.csv 'protected' column under its own name", () => {
    const rows = parseTelarCsv("object_id,title,protected\no1,A,yes");
    expect(rows[0]).toHaveProperty("protected", "yes");
    expect(rows[0]).not.toHaveProperty("private");
    const mapped = mapObjectsCsv(rows);
    const extras = JSON.parse(mapped[0].extra_columns as string);
    expect(extras.protected).toBe("yes");
  });

  it("keeps a custom objects.csv 'protegido' column under its own name", () => {
    const rows = parseTelarCsv("object_id,title,protegido\no1,A,sí");
    expect(rows[0]).toHaveProperty("protegido", "sí");
    const mapped = mapObjectsCsv(rows);
    const extras = JSON.parse(mapped[0].extra_columns as string);
    expect(extras.protegido).toBe("sí");
  });

  it("round-trips a custom objects.csv 'protected' column under its own name", () => {
    const rows = parseTelarCsv("object_id,title,protected\no1,A,yes");
    const mapped = mapObjectsCsv(rows);
    const published = serializeObjectsCsv([
      {
        object_id: mapped[0].object_id as string,
        title: (mapped[0].title as string) ?? null,
        featured: (mapped[0].featured as boolean) ?? null,
        creator: (mapped[0].creator as string) ?? null,
        description: (mapped[0].description as string) ?? null,
        source_url: (mapped[0].source_url as string) ?? null,
        period: (mapped[0].period as string) ?? null,
        year: (mapped[0].year as string) ?? null,
        medium_genre: (mapped[0].object_type as string) ?? null,
        subjects: (mapped[0].subjects as string) ?? null,
        source: (mapped[0].source as string) ?? null,
        credit: (mapped[0].credit as string) ?? null,
        thumbnail: (mapped[0].thumbnail as string) ?? null,
        alt_text: (mapped[0].alt_text as string) ?? null,
        dimensions: (mapped[0].dimensions as string) ?? null,
        extra_columns: (mapped[0].extra_columns as string) ?? null,
      },
    ]);
    const lines = published.trim().split("\n");
    const header = lines[0].split(",");
    const protectedIdx = header.indexOf("protected");
    expect(protectedIdx).toBeGreaterThanOrEqual(0);
    const dataLine = lines.find((l) => l.startsWith("o1,"));
    expect((dataLine as string).split(",")[protectedIdx]).toBe("yes");
  });
});

// ---------------------------------------------------------------------------
// PROJECT_ONLY_ALIASES is derived from COLUMN_NAME_MAPPING, not hand-listed
// ---------------------------------------------------------------------------

describe("every non-canonical private spelling is project-only, not just protected/protegido", () => {
  const spellings = ["privada", "privado", "protegida", "protegido"];

  for (const spelling of spellings) {
    it(`keeps a custom objects.csv '${spelling}' column under its own name`, () => {
      const rows = parseTelarCsv(`object_id,title,${spelling}\no1,A,yes`);
      expect(rows[0]).toHaveProperty(spelling, "yes");
      expect(rows[0]).not.toHaveProperty("private");
    });

    it(`round-trips a custom objects.csv '${spelling}' column under its own name`, () => {
      const rows = parseTelarCsv(`object_id,title,${spelling}\no1,A,yes`);
      const mapped = mapObjectsCsv(rows);
      const published = serializeObjectsCsv([
        {
          object_id: mapped[0].object_id as string,
          title: (mapped[0].title as string) ?? null,
          featured: (mapped[0].featured as boolean) ?? null,
          creator: (mapped[0].creator as string) ?? null,
          description: (mapped[0].description as string) ?? null,
          source_url: (mapped[0].source_url as string) ?? null,
          period: (mapped[0].period as string) ?? null,
          year: (mapped[0].year as string) ?? null,
          medium_genre: (mapped[0].object_type as string) ?? null,
          subjects: (mapped[0].subjects as string) ?? null,
          source: (mapped[0].source as string) ?? null,
          credit: (mapped[0].credit as string) ?? null,
          thumbnail: (mapped[0].thumbnail as string) ?? null,
          alt_text: (mapped[0].alt_text as string) ?? null,
          dimensions: (mapped[0].dimensions as string) ?? null,
          extra_columns: (mapped[0].extra_columns as string) ?? null,
        },
      ]);
      const lines = published.trim().split("\n");
      const header = lines[0].split(",");
      const idx = header.indexOf(spelling);
      expect(idx).toBeGreaterThanOrEqual(0);
      const dataLine = lines.find((l) => l.startsWith("o1,"));
      expect((dataLine as string).split(",")[idx]).toBe("yes");
    });

    it(`still resolves '${spelling}' as private when parsing project.csv`, () => {
      const rows = parseTelarCsv(`story_id,${spelling}\ns1,yes`, undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// mapProjectCsv
// ---------------------------------------------------------------------------

describe("mapProjectCsv", () => {
  it("maps project.csv rows to stories table columns", () => {
    const csv = readFixture("project.csv");
    const rows = parseTelarCsv(csv);
    const mapped = mapProjectCsv(rows);

    expect(mapped).toHaveLength(1);
    expect(mapped[0].story_id).toBe("my-story");
    expect(mapped[0].title).toBe("My Story");
    expect(mapped[0].order).toBe(1);
    expect(mapped[0].private).toBe(false);
  });

  // --- show_sections / mostrar_secciones ---
  // Mirrors the framework's csv_utils.py alias-on-read (mostrar_secciones ->
  // show_sections) and project.py truthy whitelist (yes/true/sí/si).
  describe("show_sections", () => {
    it("reads show_sections='true' as true", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", show_sections: "true" }]);
      expect(mapped[0].show_sections).toBe(true);
    });

    it("reads mostrar_secciones='yes' as true (alias-on-read)", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", mostrar_secciones: "yes" }]);
      expect(mapped[0].show_sections).toBe(true);
    });

    it("reads mostrar_secciones='sí' as true (Spanish truthy with accent)", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", mostrar_secciones: "sí" }]);
      expect(mapped[0].show_sections).toBe(true);
    });

    it("reads mostrar_secciones='si' as true (Spanish truthy without accent)", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", mostrar_secciones: "si" }]);
      expect(mapped[0].show_sections).toBe(true);
    });

    it("reads show_sections='false' as false", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", show_sections: "false" }]);
      expect(mapped[0].show_sections).toBe(false);
    });

    it("defaults to false when neither show_sections nor mostrar_secciones is present", () => {
      const mapped = mapProjectCsv([{ story_id: "s1" }]);
      expect(mapped[0].show_sections).toBe(false);
    });

    it("English show_sections wins over Spanish mostrar_secciones when both present", () => {
      const mapped = mapProjectCsv([
        { story_id: "s1", show_sections: "false", mostrar_secciones: "true" },
      ]);
      expect(mapped[0].show_sections).toBe(false);
    });

    it("reads show_sections='1' as false (framework does not accept '1')", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", show_sections: "1" }]);
      expect(mapped[0].show_sections).toBe(false);
    });

    it("reads show_sections='sí' as true (Spanish truthy with accent)", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", show_sections: "sí" }]);
      expect(mapped[0].show_sections).toBe(true);
    });
  });

  // --- private ---
  // Truthy whitelist must match the framework's processors/project.py:
  // yes/true/sí/si (case-insensitive, trimmed). "1" is intentionally NOT
  // accepted — the framework would publish such a story in cleartext, so
  // accepting "1" here would make the Compositor UI claim protection the
  // published site does not provide.
  describe("private", () => {
    it("reads private='1' as false (framework does not accept '1')", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", private: "1" }]);
      expect(mapped[0].private).toBe(false);
    });

    it("reads private='sí' as true (Spanish truthy with accent)", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", private: "sí" }]);
      expect(mapped[0].private).toBe(true);
    });

    it("reads private='yes' as true", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", private: "yes" }]);
      expect(mapped[0].private).toBe(true);
    });

    it("reads private='true' as true", () => {
      const mapped = mapProjectCsv([{ story_id: "s1", private: "true" }]);
      expect(mapped[0].private).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// v0.8.x protected/protegido column
// ---------------------------------------------------------------------------

describe("v0.8.x protected/protegido column", () => {
  // A v0.8.x-shaped project.csv: English header row carrying the framework's
  // pre-v0.9.0 `protected` column, and the Spanish bilingual second row
  // carrying `protegido`.
  const v08ProjectCsv = [
    "order,story_id,title,subtitle,byline,protected",
    "orden,id_historia,titulo,subtitulo,firma,protegido",
    "1,my-story,My Story,Subtitle,Author,yes",
  ].join("\n");

  it("imports the story marked protected as private", () => {
    const rows = parseTelarCsv(v08ProjectCsv, undefined, true);
    expect(rows).toHaveLength(1);
    const mapped = mapProjectCsv(rows);
    expect(mapped[0].private).toBe(true);
  });

  it("skips the Spanish bilingual row rather than importing it as a story", () => {
    const rows = parseTelarCsv(v08ProjectCsv, undefined, true);
    const mapped = mapProjectCsv(rows);
    expect(mapped).toHaveLength(1);
    expect(mapped.some((s) => s.story_id === "id_historia")).toBe(false);
    expect(mapped[0].story_id).toBe("my-story");
  });

  it("round-trips: the imported story publishes back as private", () => {
    const rows = parseTelarCsv(v08ProjectCsv, undefined, true);
    const mapped = mapProjectCsv(rows);
    const published = serializeProjectCsv(
      mapped.map((s) => ({
        story_id: s.story_id as string,
        title: (s.title as string) ?? null,
        subtitle: (s.subtitle as string) ?? null,
        byline: (s.byline as string) ?? null,
        order: s.order as number,
        private: s.private as boolean,
        draft: false,
        show_sections: s.show_sections as boolean,
      })),
    );
    const lines = published.trim().split("\n");
    const header = lines[0].split(",");
    const privateIdx = header.indexOf("private");
    const dataLine = lines.find((l) => l.startsWith("1,my-story"));
    expect(dataLine).toBeDefined();
    expect((dataLine as string).split(",")[privateIdx]).toBe("yes");
  });

  it("imports a Spanish-first sheet whose header row uses protegido as private", () => {
    const csv = [
      "orden,id_historia,titulo,subtitulo,firma,protegido",
      "1,mi-historia,Mi historia,Subtitulo,Autor,sí",
    ].join("\n");
    const rows = parseTelarCsv(csv, undefined, true);
    expect(rows).toHaveLength(1);
    const mapped = mapProjectCsv(rows);
    expect(mapped[0].private).toBe(true);
  });

  // The framework would publish a story marked "1" in cleartext, so the new
  // aliases must not open a path around that whitelist.
  describe("truthy whitelist unchanged through the new aliases", () => {
    it("rejects protected='1'", () => {
      const rows = parseTelarCsv("story_id,protected\ns1,1", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(false);
    });

    it("rejects protegido='1'", () => {
      const rows = parseTelarCsv("story_id,protegido\ns1,1", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(false);
    });

    it("accepts protected='yes'/'true'/'sí'/'si', case-insensitive and trimmed", () => {
      for (const value of ["yes", "true", "sí", "si", "YES", " yes "]) {
        const rows = parseTelarCsv(`story_id,protected\ns1,${value}`, undefined, true);
        const mapped = mapProjectCsv(rows);
        expect(mapped[0].private).toBe(true);
      }
    });
  });

  // A sheet naming protection under more than one spelling: parseTelarCsv
  // decides which columns are protection columns from the header row alone,
  // before any row is built, and ORs their truthy cells into one verdict —
  // these tests pin that the result is correct whichever spelling carries
  // the truthy value and whatever position it sits at.
  describe("a sheet with more than one protection column: protection wins whatever the order", () => {
    it("story_id,private,protected / s1,,yes imports as private", () => {
      const rows = parseTelarCsv("story_id,private,protected\ns1,,yes", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });

    it("story_id,protected,private / s1,yes, imports as private", () => {
      const rows = parseTelarCsv("story_id,protected,private\ns1,yes,", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });

    it("story_id,private,protegido / s1,,sí imports as private", () => {
      const rows = parseTelarCsv("story_id,private,protegido\ns1,,sí", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });

    it("three protection columns: a truthy cell in any one makes the story private", () => {
      const rows = parseTelarCsv(
        "story_id,private,protected,protegido\ns1,,,yes",
        undefined,
        true,
      );
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });

    it("all-empty protection columns import as not private", () => {
      const rows = parseTelarCsv("story_id,private,protected\ns1,,", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(false);
    });

    it("'1' under a protection column still does not count as truthy", () => {
      const rows = parseTelarCsv("story_id,private,protected\ns1,,1", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(false);
    });
  });

  // Protection is decided from the header row by column position: a column
  // is a protection column, or it is not, by what its own header cell says,
  // never by any name a row's own keys carry.
  describe("protection resolved by header position, not by row-key guessing", () => {
    it("an untrimmed ' private_1' fourth header does not overwrite a truthy protected cell", () => {
      // The fourth header's leading space is trimmed away like any other
      // header cell; whatever name the resulting column gets, it plays no
      // part in protection, which is decided purely by position for the
      // `private` and `protected` columns two and three places to its left.
      const rows = parseTelarCsv(
        "story_id,private,protected, private_1\ns1,no,yes,no",
        undefined,
        true,
      );
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });

    it("an author's genuine 'private_1' column is not read as protection", () => {
      const rows = parseTelarCsv("story_id,private,private_1\ns1,no,yes", undefined, true);
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(false);
    });

    it("three spellings in one order all resolve to private", () => {
      const rows = parseTelarCsv(
        "story_id,private,protected,protegido,privada\ns1,,,,yes",
        undefined,
        true,
      );
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });

    it("the same three-or-more spellings in a different order still resolve to private", () => {
      const rows = parseTelarCsv(
        "story_id,privada,protegido,private,protected\ns1,,,,yes",
        undefined,
        true,
      );
      const mapped = mapProjectCsv(rows);
      expect(mapped[0].private).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// protegido does not leak into the bilingual-row detector outside project.csv
// ---------------------------------------------------------------------------

describe("protegido does not mark an ordinary objects.csv row as a header row", () => {
  it("an object titled 'Protegido' survives import", () => {
    const rows = parseTelarCsv("object_id,title\nsource,Protegido");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: "source", title: "Protegido" });
  });

  // A two-cell row scores 100% against the bilingual-word set
  // whenever both its cells happen to be known tokens — object_id="source",
  // title="Protected" is exactly such a row, with no bilingual second row in
  // sight. isHeaderRow's three-cell floor keeps a row this short out of the
  // ratio check entirely, so it imports as the object it is.
  it("an object titled 'Protected' survives import", () => {
    const rows = parseTelarCsv("object_id,title\nsource,Protected");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: "source", title: "Protected" });
  });

  // The accepted trade: the same floor that saves the row above
  // also means a genuine bilingual second row on a two-column sheet no
  // longer scores as a header — it has only two populated cells, never
  // three — so it is imported as an object rather than skipped. The
  // framework's is_header_row takes the identical trade at the identical
  // floor, so a two-column sheet reads the same way on both sides.
  it("a genuine two-column bilingual row is no longer detected and imports as data — accepted trade", () => {
    const rows = parseTelarCsv("object_id,title\nid_objeto,titulo");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ object_id: "id_objeto", title: "titulo" });
  });
});

// ---------------------------------------------------------------------------
// No reserved name can forge protection
// ---------------------------------------------------------------------------

// A header cell can carry any byte sequence a decoder passes through, so a
// reserved MARKER STRING is a name a file can forge. Protection is decided
// by column POSITION, from the header row itself, never from a name a
// row's own keys carry — so these cases (a forged header colliding with
// what a marker string would have been, a forged marker-shaped name with no
// real column behind it, the same forgeries quoted, and the same behind a
// file-leading BOM) must resolve exactly as an ordinary, unforged sheet
// would.
describe("no reserved name can forge protection", () => {
  const NUL = String.fromCharCode(0);
  const BOM = String.fromCharCode(0xfeff);

  it("a forged NUL-bearing header does not overwrite the real protected cell", () => {
    // Two forged columns, chosen to coincide with names a marker-string
    // scheme might generate for the real `protected` column. Neither has
    // any effect: protection is never decided from a row's key names,
    // forged or not.
    const csv = `story_id,${NUL}tel178-private-col-2,protected, ${NUL}tel178-private-col-2_1\ns1,no,yes,no`;
    const rows = parseTelarCsv(csv, undefined, true);
    const mapped = mapProjectCsv(rows);
    expect(mapped[0].private).toBe(true);
  });

  it("a forged marker-shaped name with a non-numeric suffix is not read as protection", () => {
    const csv = `story_id,protected,${NUL}tel178-private-col-abc\ns1,,yes`;
    const rows = parseTelarCsv(csv, undefined, true);
    const mapped = mapProjectCsv(rows);
    // The real `protected` column is empty; the forged column's "yes" must
    // not make the story private on its own account.
    expect(mapped[0].private).toBe(false);
  });

  it("the same forged NUL headers, quoted, still do not overwrite the real cell", () => {
    const csv = `story_id,"${NUL}tel178-private-col-2",protected," ${NUL}tel178-private-col-2_1"\ns1,no,yes,no`;
    const rows = parseTelarCsv(csv, undefined, true);
    const mapped = mapProjectCsv(rows);
    expect(mapped[0].private).toBe(true);
  });

  it("the same forged NUL headers, behind a file-leading BOM, still do not overwrite the real cell", () => {
    const csv = `${BOM}story_id,"${NUL}tel178-private-col-2",protected," ${NUL}tel178-private-col-2_1"\ns1,no,yes,no`;
    const rows = parseTelarCsv(csv, undefined, true);
    const mapped = mapProjectCsv(rows);
    expect(mapped[0].private).toBe(true);
  });

  it("a NUL embedded in a non-project header does not survive into the row's own key", () => {
    const rows = parseTelarCsv(`object_id,title,${NUL}notes\no1,A,secret`);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain(`${NUL}notes`);
    expect(rows[0]).toHaveProperty("notes", "secret");
  });
});

// ---------------------------------------------------------------------------
// A header can be a name JavaScript already means something by
// ---------------------------------------------------------------------------

// A plain object literal's lookup returns an inherited property for a key
// like `__proto__` or `constructor` rather than `undefined`, and plain
// `obj[key] = value` does not create an own property for those same keys —
// it reaches the inherited accessor instead and the value is discarded. A
// header cell is file-supplied text, so it can be either kind of key. Both
// must behave as an ordinary column name: readable under its own key,
// never silently dropped, and never merged with another column merely
// because both coerce to the same string.
describe("a header can be a name JavaScript already means something by", () => {
  it("keeps both values when __proto__ and [object Object] would coerce to the same key", () => {
    const rows = parseTelarCsv("object_id,__proto__,[object Object]\no1,first,second");
    expect(rows[0].object_id).toBe("o1");
    const keys = Object.keys(rows[0]).filter((k) => k !== "object_id");
    expect(keys).toHaveLength(2); // two distinct columns, not merged into one
    const values = keys.map((k) => rows[0][k]).sort();
    expect(values).toEqual(["first", "second"]);
  });

  it("keeps both values with the same two headers in the opposite order", () => {
    const rows = parseTelarCsv("object_id,[object Object],__proto__\no1,first,second");
    const keys = Object.keys(rows[0]).filter((k) => k !== "object_id");
    expect(keys).toHaveLength(2);
    const values = keys.map((k) => rows[0][k]).sort();
    expect(values).toEqual(["first", "second"]);
  });

  it("a lone __proto__ column, with no other column to collide with, is present and readable", () => {
    const rows = parseTelarCsv("object_id,__proto__\no1,secret-value");
    expect(Object.prototype.hasOwnProperty.call(rows[0], "__proto__")).toBe(true);
    expect(rows[0]["__proto__"]).toBe("secret-value");
  });

  it("a __proto__ column beside a real protection column leaves protection unaffected", () => {
    const rows = parseTelarCsv("story_id,__proto__,protected\ns1,secret-value,yes", undefined, true);
    const mapped = mapProjectCsv(rows);
    expect(mapped[0].private).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(rows[0], "__proto__")).toBe(true);
    expect(rows[0]["__proto__"]).toBe("secret-value");
  });

  it("round-trips a custom __proto__ objects.csv column through a publish", () => {
    const rows = parseTelarCsv("object_id,title,__proto__\no1,A,secret-value");
    const mapped = mapObjectsCsv(rows);
    const extras = JSON.parse(mapped[0].extra_columns as string);
    expect(Object.prototype.hasOwnProperty.call(extras, "__proto__")).toBe(true);
    expect(extras["__proto__"]).toBe("secret-value");
    const published = serializeObjectsCsv([
      {
        object_id: mapped[0].object_id as string,
        title: (mapped[0].title as string) ?? null,
        featured: (mapped[0].featured as boolean) ?? null,
        creator: (mapped[0].creator as string) ?? null,
        description: (mapped[0].description as string) ?? null,
        source_url: (mapped[0].source_url as string) ?? null,
        period: (mapped[0].period as string) ?? null,
        year: (mapped[0].year as string) ?? null,
        medium_genre: (mapped[0].object_type as string) ?? null,
        subjects: (mapped[0].subjects as string) ?? null,
        source: (mapped[0].source as string) ?? null,
        credit: (mapped[0].credit as string) ?? null,
        thumbnail: (mapped[0].thumbnail as string) ?? null,
        alt_text: (mapped[0].alt_text as string) ?? null,
        dimensions: (mapped[0].dimensions as string) ?? null,
        extra_columns: (mapped[0].extra_columns as string) ?? null,
      },
    ]);
    const lines = published.trim().split("\n");
    const header = lines[0].split(",");
    const idx = header.indexOf("__proto__");
    expect(idx).toBeGreaterThanOrEqual(0);
    const dataLine = lines.find((l) => l.startsWith("o1,"));
    expect((dataLine as string).split(",")[idx]).toBe("secret-value");
  });
});

// ---------------------------------------------------------------------------
// mapStoryCsv
// ---------------------------------------------------------------------------

describe("mapStoryCsv", () => {
  it("maps story CSV rows to steps + layers", () => {
    const csv = readFixture("story.csv");
    const rows = parseTelarCsv(csv);
    const result = mapStoryCsv(rows, 42);

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].step_number).toBe(1);
    expect(result.steps[0].story_id).toBe(42);
    expect(result.steps[0].object_id).toBe("painting-001");
    expect(result.steps[0].x).toBeCloseTo(0.5);
    expect(result.steps[0].y).toBeCloseTo(0.5);
    expect(result.steps[0].zoom).toBeCloseTo(1.5);
  });

  it("extracts layer1 when layer1_button or layer1_content exist", () => {
    const csv = readFixture("story.csv");
    const rows = parseTelarCsv(csv);
    const result = mapStoryCsv(rows, 42);

    // Step 1 has layer1 content
    const step1Layers = result.layers.filter((l) => l.layer_number === 1);
    expect(step1Layers.length).toBeGreaterThan(0);
  });

  it("filters out completely blank rows", () => {
    const rows = [
      { step: "1", object: "img-001", x: "", y: "", zoom: "", page: "", question: "Q?", answer: "", layer1_button: "", layer1_content: "", layer2_button: "", layer2_content: "" },
      { step: "2", object: "", x: "", y: "", zoom: "", page: "", question: "", answer: "", layer1_button: "", layer1_content: "", layer2_button: "", layer2_content: "" },
      { step: "3", object: "", x: "", y: "", zoom: "", page: "", question: "", answer: "", layer1_button: "", layer1_content: "", layer2_button: "", layer2_content: "" },
      { step: "4", object: "", x: "", y: "", zoom: "", page: "", question: "", answer: "A!", layer1_button: "", layer1_content: "", layer2_button: "", layer2_content: "" },
    ];
    const result = mapStoryCsv(rows, 1);

    // Only rows 1 and 4 have meaningful content
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].object_id).toBe("img-001");
    expect(result.steps[1].answer).toBe("A!");
  });

  // --- clip fields ---
  it("reads clip_start, clip_end, loop from CSV row and includes them in step insert", () => {
    const rows = [
      { step: "1", object: "img-001", x: "0.5", y: "0.5", zoom: "1.0", page: "", question: "Q?", answer: "", layer1_button: "", layer1_content: "", layer2_button: "", layer2_content: "", clip_start: "12.5", clip_end: "45.0", loop: "true" },
    ];
    const result = mapStoryCsv(rows, 1);
    expect(result.steps[0].clip_start).toBe("12.5");
    expect(result.steps[0].clip_end).toBe("45.0");
    expect(result.steps[0].loop).toBe("true");
  });

  it("produces undefined clip fields when clip columns are absent from CSV row", () => {
    const rows = [
      { step: "1", object: "img-001", x: "0.5", y: "0.5", zoom: "1.0", page: "", question: "Q?", answer: "", layer1_button: "", layer1_content: "", layer2_button: "", layer2_content: "" },
    ];
    const result = mapStoryCsv(rows, 1);
    expect(result.steps[0].clip_start).toBeUndefined();
    expect(result.steps[0].clip_end).toBeUndefined();
    expect(result.steps[0].loop).toBeUndefined();
  });

  // --- kind derivation ---
  // Empty `object` column on a meaningful row signals a section card (Telar
  // 1.1.0 framework contract). Non-empty `object` => media step.
  describe("kind derivation", () => {
    it("derives kind='media' when object is non-empty", () => {
      const rows = [{ step: "1", object: "obj-A", question: "What is this?" }];
      const result = mapStoryCsv(rows, 1);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].kind).toBe("media");
    });

    it("derives kind='section' when object is empty and question has content", () => {
      const rows = [{ step: "1", object: "", question: "Chapter One" }];
      const result = mapStoryCsv(rows, 1);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].kind).toBe("section");
      expect(result.steps[0].object_id).toBeUndefined();
    });

    it("treats whitespace-only object column as empty (kind='section')", () => {
      const rows = [{ step: "1", object: "   ", question: "Chapter One" }];
      const result = mapStoryCsv(rows, 1);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].kind).toBe("section");
    });

    it("kind='media' when object is present and question is empty (object presence wins)", () => {
      const rows = [{ step: "1", object: "obj-A", question: "" }];
      const result = mapStoryCsv(rows, 1);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].kind).toBe("media");
    });

    it("filters out rows with both object and question empty (regression on meaningfulFields)", () => {
      const rows = [{ step: "1", object: "", question: "" }];
      const result = mapStoryCsv(rows, 1);
      expect(result.steps).toHaveLength(0);
    });
  });

  // Regression: mapStoryCsv used to drop alt_text on every import/
  // resync while publish writes it, so the field round-tripped to null. Both
  // sites named in the finding are covered: the field must survive the row
  // mapping, and a row that is meaningful ONLY because of alt_text must not
  // be filtered out as blank.
  it("preserves step alt_text through the CSV row mapping (round-trip regression)", () => {
    const rows = [
      { step: "1", object: "img-001", x: "0.5", y: "0.5", zoom: "1.0", page: "", question: "Q?", answer: "", layer1_button: "", layer1_content: "", layer2_button: "", layer2_content: "", alt_text: "A wide shot of the loom." },
    ];
    const result = mapStoryCsv(rows, 1);
    expect(result.steps[0].alt_text).toBe("A wide shot of the loom.");
  });

  it("treats alt_text as a meaningful field — a row with only alt_text is not filtered out as blank", () => {
    const rows = [{ step: "1", object: "", question: "", alt_text: "A wide shot of the loom." }];
    const result = mapStoryCsv(rows, 1);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].alt_text).toBe("A wide shot of the loom.");
  });

  // The framework's `_validate_page_column`
  // (stories.py) reads a page cell with Python's `float()`, which
  // disagrees with JavaScript's `Number()` in both directions — `float()`
  // accepts Unicode/underscore digits `Number()` rejects, and refuses
  // radix prefixes `Number()` accepts. No JS rewrite of the cell can
  // claim parity with that grammar, so the value is never rewritten.
  // Only the two ASCII-anchored shapes where a plain reading is
  // unambiguous get a warning; everything else is stored as written and
  // left silent, on purpose.
  describe("page validation", () => {
    const rowWithPage = (page: string) => ({
      step: "1",
      object: "img-001",
      question: "Q?",
      page,
    });

    it("keeps an already-clean integer unchanged and does not warn", () => {
      const onWarning = vi.fn();
      const result = mapStoryCsv([rowWithPage("3")], 1, onWarning);
      expect(result.steps[0].page).toBe("3");
      expect(onWarning).not.toHaveBeenCalled();
    });

    it("stores '3.5' unchanged but warns naming the truncated integer", () => {
      const onWarning = vi.fn();
      const result = mapStoryCsv([rowWithPage("3.5")], 1, onWarning);
      expect(result.steps[0].page).toBe("3.5");
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onWarning.mock.calls[0][0]).toEqual({ code: "page_truncated", step: 1, value: "3.5", readAs: 3 });
    });

    it.each(["0", "-1"])(
      "stores %j unchanged but warns that the framework will clear it",
      (raw) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithPage(raw)], 1, onWarning);
        expect(result.steps[0].page).toBe(raw);
        expect(onWarning).toHaveBeenCalledTimes(1);
        expect(onWarning.mock.calls[0][0]).toEqual({ code: "page_below_one", step: 1, value: raw });
      },
    );

    // These are exactly the cases where Python's float() and JavaScript's
    // Number()/an ASCII-anchored regex disagree or cannot agree. Each is
    // stored as written — never rewritten — and left silent because we
    // cannot predict Python's grammar from JavaScript's.
    it.each([
      ["٣", "Arabic-indic digit (Python float() reads it as 3)"],
      ["３", "fullwidth digit (Python float() reads it as 3)"],
      ["1_0", "underscore-grouped digits (Python float() reads it as 10)"],
      ["0x10", "hex prefix (Python float() refuses it; JS Number() reads 16)"],
      ["0b11", "binary prefix (Python float() refuses it)"],
      ["0o10", "octal prefix (Python float() refuses it)"],
      ["﻿3﻿", "BOM-wrapped digit (Python float() refuses it)"],
      ["3abc", "trailing garbage (Python float() refuses it and says so itself)"],
    ])("stores %j unchanged and silent — %s", (raw) => {
      const onWarning = vi.fn();
      const result = mapStoryCsv([rowWithPage(raw)], 1, onWarning);
      expect(result.steps[0].page).toBe(raw);
      expect(onWarning).not.toHaveBeenCalled();
    });

    // An empty/whitespace-only cell is the ordinary "this step does not
    // name a page" case (most objects are not multi-page) —
    // indistinguishable from an absent column, and must be silent. A
    // warning that fires on the default state trains an author to
    // ignore warnings.
    it.each(["", "  "])("clears %j silently — no warning", (raw) => {
      const onWarning = vi.fn();
      const result = mapStoryCsv([rowWithPage(raw)], 1, onWarning);
      expect(result.steps[0].page).toBeUndefined();
      expect(onWarning).not.toHaveBeenCalled();
    });

    it("trims surrounding whitespace to '3'", () => {
      const onWarning = vi.fn();
      const result = mapStoryCsv([rowWithPage(" 3 ")], 1, onWarning);
      expect(result.steps[0].page).toBe("3");
    });

    it("stores no value and warns nothing when the page column is absent from the CSV entirely", () => {
      const onWarning = vi.fn();
      const rows = [{ step: "1", object: "img-001", question: "Q?" }];
      const result = mapStoryCsv(rows, 1, onWarning);
      expect(result.steps[0].page).toBeUndefined();
      expect(onWarning).not.toHaveBeenCalled();
    });

    it("works with no onWarning passed at all (the two non-import callers' shape)", () => {
      expect(() => mapStoryCsv([rowWithPage("3.5")], 0)).not.toThrow();
      const result = mapStoryCsv([rowWithPage("3.5")], 0);
      expect(result.steps[0].page).toBe("3.5");
    });
  });

  // x/y/zoom go through the same coercion shape as page, but the rule
  // differs — the framework has no build-time validation for
  // coordinates (only `_apply_coordinate_defaults`, which fills
  // empty/'nan' cells with 0.5/0.5/1 at BUILD time and checks nothing
  // else), so there is no parity target: a non-numeric cell must not
  // bind NaN/Infinity into D1, and any finite value is stored unchanged
  // with no clamping or range check.
  describe("coordinate validation (x, y, zoom)", () => {
    const rowWithCoord = (col: "x" | "y" | "zoom", value: string) => ({
      step: "1",
      object: "img-001",
      question: "Q?",
      [col]: value,
    });

    it.each(["x", "y", "zoom"] as const)(
      "keeps a normal %s value unchanged and does not warn",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, "0.5")], 1, onWarning);
        expect(result.steps[0][col]).toBeCloseTo(0.5);
        expect(onWarning).not.toHaveBeenCalled();
      },
    );

    it.each(["x", "y", "zoom"] as const)(
      "drops an unparseable %s ('abc') and warns",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, "abc")], 1, onWarning);
        expect(result.steps[0][col]).toBeUndefined();
        expect(onWarning).toHaveBeenCalledTimes(1);
        expect(onWarning.mock.calls[0][0]).toEqual({ code: "coordinate_invalid", step: 1, column: col, value: "abc" });
      },
    );

    it.each(["x", "y", "zoom"] as const)(
      "drops an unparseable %s ('.') and warns",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, ".")], 1, onWarning);
        expect(result.steps[0][col]).toBeUndefined();
        expect(onWarning).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["x", "y", "zoom"] as const)(
      "drops %s = 'Infinity' and warns",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, "Infinity")], 1, onWarning);
        expect(result.steps[0][col]).toBeUndefined();
        expect(onWarning).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["x", "y", "zoom"] as const)(
      "keeps an out-of-range %s (-3) unchanged and does NOT warn — deliberate, no clamping",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, "-3")], 1, onWarning);
        expect(result.steps[0][col]).toBe(-3);
        expect(onWarning).not.toHaveBeenCalled();
      },
    );

    it.each(["x", "y", "zoom"] as const)(
      "keeps an out-of-range %s (5) unchanged and does NOT warn — deliberate, no clamping",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, "5")], 1, onWarning);
        expect(result.steps[0][col]).toBe(5);
        expect(onWarning).not.toHaveBeenCalled();
      },
    );

    it.each(["x", "y", "zoom"] as const)(
      "treats an empty %s cell as silently absent — no default materialized",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, "")], 1, onWarning);
        expect(result.steps[0][col]).toBeUndefined();
        expect(onWarning).not.toHaveBeenCalled();
      },
    );

    it("treats an absent x/y/zoom column as silently absent", () => {
      const onWarning = vi.fn();
      const rows = [{ step: "1", object: "img-001", question: "Q?" }];
      const result = mapStoryCsv(rows, 1, onWarning);
      expect(result.steps[0].x).toBeUndefined();
      expect(result.steps[0].y).toBeUndefined();
      expect(result.steps[0].zoom).toBeUndefined();
      expect(onWarning).not.toHaveBeenCalled();
    });

    // Guard: parseFloat and Number disagree on "0x10" (0 vs 16), and the
    // framework's browser consumer reads coordinates with parseFloat. If
    // this ever gets swapped back to Number — the mistake `33208cf5`
    // made — this is the test that must fail, since nothing else in this
    // file distinguishes the two functions.
    it.each(["x", "y", "zoom"] as const)(
      "reads %s = '0x10' as 0 (parseFloat), not 16 (Number) — rendering parity guard",
      (col) => {
        const onWarning = vi.fn();
        const result = mapStoryCsv([rowWithCoord(col, "0x10")], 1, onWarning);
        expect(result.steps[0][col]).toBe(0);
        expect(onWarning).not.toHaveBeenCalled();
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Layer-content file references — isLayerFileReference + resolveLayerFileReferences
// ---------------------------------------------------------------------------
// Publish stores only the FILENAME in a `layerN_content` cell and writes the
// real panel markdown to telar-content/texts/stories/*.md. Import must resolve
// those filename cells to file content before mapping, or it stores the literal
// filename string as the panel body. Inline cells must be left untouched.

describe("isLayerFileReference", () => {
  it("flags a bare .md filename as a file reference", () => {
    expect(isLayerFileReference("weavers-step1-layer1.md")).toBe(true);
  });

  it("trims surrounding whitespace before checking the suffix", () => {
    expect(isLayerFileReference("  panel.md  ")).toBe(true);
  });

  it("treats inline prose as inline (not a file reference)", () => {
    expect(isLayerFileReference("A paragraph of author prose.")).toBe(false);
    expect(isLayerFileReference("See the **bold** loom.")).toBe(false);
  });

  it("treats an empty or undefined cell as not a reference", () => {
    expect(isLayerFileReference("")).toBe(false);
    expect(isLayerFileReference(undefined)).toBe(false);
  });

  it("rejects path-traversal filenames (mirrors the framework guard)", () => {
    expect(isLayerFileReference("../secrets.md")).toBe(false);
    expect(isLayerFileReference("/etc/passwd.md")).toBe(false);
    expect(isLayerFileReference("sub\\panel.md")).toBe(false);
  });

  it("is case-sensitive on the .md suffix (matches the framework)", () => {
    expect(isLayerFileReference("panel.MD")).toBe(false);
  });
});

describe("resolveLayerFileReferences", () => {
  it("substitutes the referenced file's contents for a filename cell", async () => {
    const rows = [
      { step: "1", object: "img-1", layer1_content: "weavers-panel.md", layer2_content: "" },
    ];
    const fetcher = vi.fn(async (filename: string) =>
      filename === "weavers-panel.md" ? "---\ntitle: The Loom\n---\n\nReal panel body." : null,
    );
    const resolved = await resolveLayerFileReferences(rows, fetcher);
    expect(fetcher).toHaveBeenCalledWith("weavers-panel.md");
    expect(resolved[0].layer1_content).toBe("---\ntitle: The Loom\n---\n\nReal panel body.");
    // Untouched empty cell.
    expect(resolved[0].layer2_content).toBe("");
  });

  it("leaves inline cells byte-for-byte and never fetches", async () => {
    const rows = [
      { step: "1", object: "img-1", layer1_content: "Inline **markdown** body.", layer2_content: "" },
    ];
    const fetcher = vi.fn(async () => "should not be used");
    const resolved = await resolveLayerFileReferences(rows, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolved[0].layer1_content).toBe("Inline **markdown** body.");
  });

  it("degrades to leaving the cell untouched when the referenced file is missing", async () => {
    const rows = [
      { step: "1", object: "img-1", layer1_content: "gone.md", layer2_content: "" },
    ];
    const fetcher = vi.fn(async () => null);
    const resolved = await resolveLayerFileReferences(rows, fetcher);
    expect(fetcher).toHaveBeenCalledWith("gone.md");
    // Cell left as-is — mapStoryCsv then treats it as inline, exactly the
    // framework's missing-file degradation.
    expect(resolved[0].layer1_content).toBe("gone.md");
  });
});

describe("mapStoryCsv after layer-file resolution", () => {
  it("stores the file body as layer content and the frontmatter title (not the filename)", async () => {
    const rows = [
      { step: "1", object: "img-1", question: "Q?", answer: "", layer1_button: "More", layer1_content: "weavers-panel.md", layer2_button: "", layer2_content: "" },
    ];
    const resolved = await resolveLayerFileReferences(rows, async (f) =>
      f === "weavers-panel.md" ? "---\ntitle: The Loom\n---\n\nReal panel body." : null,
    );
    const { layers: mapped } = mapStoryCsv(resolved, 1);
    const layer1 = mapped.find((l) => l.layer_number === 1)!;
    expect(layer1.content).toBe("Real panel body.");
    expect(layer1.title).toBe("The Loom");
    // The literal filename must NOT survive as content — that was the bug.
    expect(layer1.content).not.toBe("weavers-panel.md");
  });

  it("keeps inline content unchanged through the map (no regression)", async () => {
    const rows = [
      { step: "1", object: "img-1", question: "Q?", answer: "", layer1_button: "More", layer1_content: "Just inline prose.", layer2_button: "", layer2_content: "" },
    ];
    const resolved = await resolveLayerFileReferences(rows, async () => "unused");
    const { layers: mapped } = mapStoryCsv(resolved, 1);
    const layer1 = mapped.find((l) => l.layer_number === 1)!;
    expect(layer1.content).toBe("Just inline prose.");
    expect(layer1.title).toBeUndefined();
  });

  it("restore-orphans composition: the DO layer payload carries the fetched body for a .md cell and leaves an inline cell untouched", async () => {
    // Mirrors the /dashboard restore-orphan-drafts path exactly: resolve layer
    // file references against the repo, map the CSV, then project layer rows to
    // the DO payload shape. Pins that a restored draft's layer content is the
    // real file body (not the literal filename) while inline content is kept.
    const rows = [
      { step: "1", object: "img-a", question: "Q1", answer: "", layer1_button: "More", layer1_content: "weavers-panel.md", layer2_button: "", layer2_content: "" },
      { step: "2", object: "img-b", question: "Q2", answer: "", layer1_button: "Read", layer1_content: "Inline prose kept verbatim.", layer2_button: "", layer2_content: "" },
    ];
    const fileMap = new Map([["weavers-panel.md", "---\ntitle: The Loom\n---\n\nFetched file body."]]);
    const resolved = await resolveLayerFileReferences(rows, async (f) => fileMap.get(f) ?? null);
    const { layers: layerRows } = mapStoryCsv(resolved, 0);
    // The route reads the layer's own stepIndex and passes
    // title/button_label/content straight through.
    const doLayers = layerRows.map((l) => ({
      step_index: l.stepIndex,
      layer_number: l.layer_number,
      title: (l.title ?? "") as string,
      button_label: (l.button_label ?? "") as string,
      content: (l.content ?? "") as string,
    }));

    const fromFile = doLayers.find((l) => l.step_index === 0 && l.layer_number === 1)!;
    expect(fromFile.content).toBe("Fetched file body.");
    expect(fromFile.title).toBe("The Loom");
    expect(fromFile.content).not.toBe("weavers-panel.md");

    const inline = doLayers.find((l) => l.step_index === 1 && l.layer_number === 1)!;
    expect(inline.content).toBe("Inline prose kept verbatim.");
  });

  it("round-trips publish → import: filename cell resolves back to the original body + title", async () => {
    // Simulate a compositor-published story: serializeStory writes a filename
    // into the CSV cell and emits the layer .md file separately. On re-import,
    // resolving that filename to the file's on-disk content must reproduce the
    // original layer body and title.
    const step: StepWithLayers = {
      step_number: 1,
      kind: "media",
      object_id: "img-1",
      x: 0.5, y: 0.5, zoom: 1,
      page: null,
      question: "What is this?",
      answer: null,
      alt_text: null,
      clip_start: null, clip_end: null, loop: null,
      layers: [
        { layer_number: 1, title: "The Loom", button_label: "More", content: "The original **body** prose." },
      ],
    };
    const { csv, layerFiles } = serializeStory([step], "weavers");
    // Build the repo file map exactly as publish would write it to disk.
    const fileMap = new Map(
      await Promise.all(
        layerFiles.map(
          async (lf) => [lf.filename, await layerFileContent(lf.title, lf.content)] as const,
        ),
      ),
    );
    const rows = parseTelarCsv(csv);
    const resolved = await resolveLayerFileReferences(rows, async (f) => fileMap.get(f) ?? null);
    const { layers: mapped } = mapStoryCsv(resolved, 1);
    const layer1 = mapped.find((l) => l.layer_number === 1)!;
    expect(layer1.content).toBe("The original **body** prose.");
    expect(layer1.title).toBe("The Loom");
  });

  /** Builds a single-layer step + publishes it + resolves the file reference back, exactly as production does. */
  async function publishAndImportOneLayer(content: string, title: string | null = null) {
    const step: StepWithLayers = {
      step_number: 1,
      kind: "media",
      object_id: "img-1",
      x: 0.5, y: 0.5, zoom: 1,
      page: null,
      question: "What is this?",
      answer: null,
      alt_text: null,
      clip_start: null, clip_end: null, loop: null,
      layers: [
        { layer_number: 1, title, button_label: "More", content },
      ],
    };
    const { csv, layerFiles } = serializeStory([step], "weavers");
    const fileMap = new Map(
      await Promise.all(
        layerFiles.map(
          async (lf) => [lf.filename, await layerFileContent(lf.title, lf.content)] as const,
        ),
      ),
    );
    const rows = parseTelarCsv(csv);
    const resolved = await resolveLayerFileReferences(rows, async (f) => fileMap.get(f) ?? null);
    const { layers: mapped } = mapStoryCsv(resolved, 1);
    return mapped.find((l) => l.layer_number === 1)!;
  }

  it("round-trips an untitled panel whose body opens with a rule", async () => {
    // An untitled layer now always writes a frontmatter block (title: ""),
    // and the leading rule is itself immediately followed by more rule-like
    // text with no blank line, so both the frontmatter fix and the rule
    // guard are live on this one fixture. The guard inserts a blank line
    // before the second rule, so the round trip is not byte-identical to
    // `original` — nothing the author wrote is lost, but a blank line is
    // now visibly present, which is the accepted trade for never having to
    // recognise (and risk mis-recognising) an inserted marker on the way
    // back in.
    const original = "---\nfoo\n---\nbar";
    const layer1 = await publishAndImportOneLayer(original, null);
    expect(layer1.content).toBe(guardAmbiguousRuleLines(original));
    // An untitled panel must come back with no title. The title pattern
    // requires the quoted capture to allow zero characters (`.*?`, not
    // `.+?`) so `title: ""` resolves to no title rather than to the closing
    // quote character itself.
    expect(layer1.title).toBeUndefined();
  });

  it("round-trips a pasted-frontmatter-block panel body, rule preserved as a rule", async () => {
    // An author who pastes a full frontmatter block into a panel keeps
    // every rule and every line of text on re-import. "title: X" directly
    // precedes the closing rule with no blank line, so the guard separates
    // them with one — the published page then renders this as a rule and a
    // plain paragraph rather than <hr> + <h2>, which is Part 2's actual
    // requirement. Byte-identity to the stored value is not required here:
    // no marker is carried through the file, so there is nothing to strip
    // back out and nothing an author's own text could be mistaken for.
    const original = '---\ntitle: X\n---\nSome text';
    const layer1 = await publishAndImportOneLayer(original, "Notes");
    expect(layer1.content).toBe(guardAmbiguousRuleLines(original));
    expect(layer1.title).toBe("Notes");
  });

  it("leaves a body containing an author's own rule-guard-shaped line untouched (no reserved marker)", async () => {
    // No line is reserved: a line that happens to match what an earlier
    // design used as a sentinel is ordinary text, and no step in the
    // pipeline gives it any special treatment.
    const original = "Real text.\n<!--telar:rule-guard-->\nMore text.";
    const layer1 = await publishAndImportOneLayer(original, null);
    expect(layer1.content).toBe(original);
  });

  it("converges after one publish -> import cycle: a second cycle changes nothing further", async () => {
    const original = "Real text.\n---\nMore text.";
    const afterFirstCycle = await publishAndImportOneLayer(original, null);
    expect(afterFirstCycle.content).toBe("Real text.\n\n---\nMore text.");

    // Republish using what the first cycle produced as the new stored body
    // — the shape an author would see and could republish unedited.
    const afterSecondCycle = await publishAndImportOneLayer(afterFirstCycle.content!, null);
    expect(afterSecondCycle.content).toBe(afterFirstCycle.content);
  });
});

// ---------------------------------------------------------------------------
// mapGlossaryCsv — read related_terms column
// ---------------------------------------------------------------------------

describe("mapGlossaryCsv", () => {
  it("maps a glossary row to the D1 insert shape", () => {
    const rows: Record<string, string>[] = [
      { term_id: "loom", title: "Loom", definition: "A device for weaving." },
    ];
    const mapped = mapGlossaryCsv(rows);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      project_id: 0,
      term_id: "loom",
      title: "Loom",
      definition: "A device for weaving.",
    });
  });

  it("preserves related_terms verbatim, including the pipe separator", () => {
    const rows: Record<string, string>[] = [
      {
        term_id: "weaving",
        title: "Weaving",
        definition: "Interlacing threads.",
        related_terms: "loom|weaving",
      },
    ];
    const mapped = mapGlossaryCsv(rows);
    expect(mapped[0].related_terms).toBe("loom|weaving");
  });

  it("leaves related_terms undefined when the column is absent", () => {
    const rows: Record<string, string>[] = [
      { term_id: "loom", title: "Loom", definition: "A device for weaving." },
    ];
    const mapped = mapGlossaryCsv(rows);
    expect(mapped[0].related_terms).toBeUndefined();
  });

  it("leaves related_terms undefined when the cell is empty", () => {
    const rows: Record<string, string>[] = [
      { term_id: "loom", title: "Loom", definition: "A device for weaving.", related_terms: "" },
    ];
    const mapped = mapGlossaryCsv(rows);
    expect(mapped[0].related_terms).toBeUndefined();
  });

  it("reads related_terms from a Spanish-headered CSV via parseTelarCsv", () => {
    const csv =
      "id_término,título,definición,términos_relacionados\nweave,Weave,A woven structure,loom|warp";
    const mapped = mapGlossaryCsv(parseTelarCsv(csv));
    expect(mapped[0].related_terms).toBe("loom|warp");
  });
});

// ---------------------------------------------------------------------------
// The framework-rename prediction map vs the framework itself
//
// The collision blocker refuses a file because of what the FRAMEWORK will do to
// it, so the prediction has to be the framework's, not ours. This reads the
// framework's own table and diffs it, which is the only way the two can be
// known not to have drifted.
// ---------------------------------------------------------------------------

describeWithFramework("FRAMEWORK_COLUMN_RENAMES vs the framework's COLUMN_NAME_MAPPING", () => {
  it("equals it entry for entry", () => {
    const framework = readFrameworkColumnMapping();
    // Sorted pairs on both sides, so a diff names the entry that moved.
    const pairs = (m: Record<string, string>) =>
      Object.entries(m)
        .map(([k, v]) => `${k} -> ${v}`)
        .sort();
    expect(pairs(FRAMEWORK_COLUMN_RENAMES)).toEqual(pairs(framework));
  }, FRAMEWORK_TIMEOUT_MS);

  it("predicts the framework's target for every divergent spelling", () => {
    const framework = readFrameworkColumnMapping();
    // The two tables' deliberate disagreements, named: these are exactly the
    // spellings where our own canonical name is not the framework's.
    for (const header of [
      "medio", "medio_genero", "tipo_objeto", "medium_genre", "object_type",
      "privada", "privado", "protegida", "protegido", "private",
    ]) {
      expect(FRAMEWORK_COLUMN_RENAMES[header], `${header} is not predicted`).toBe(framework[header]);
    }
  }, FRAMEWORK_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The name each framework release gives a header
//
// A publish keeps a fixed column's header text only where both releases read
// it as that column, so the published tag's table is pinned against the tag's
// own module, and the grouping the collision check uses is not the same
// question and does not move with it.
// ---------------------------------------------------------------------------

describe("frameworkColumnName", () => {
  it("25: leaves collidingHeaderGroups folding unrenamed headers, so Note beside note still collides", () => {
    expect(collidingHeaderGroups(["Note", "note"], FRAMEWORK_OBJECTS_READER)).toEqual([["Note", "note"]]);
  });

  it("26: reads crédito as itself at the published tag and as credit at the head", () => {
    expect(frameworkColumnName("crédito", PUBLISHED_TAG_COLUMN_RENAMES, PUBLISHED_TAG_READER)).toBe("crédito");
    expect(frameworkColumnName("crédito", FRAMEWORK_COLUMN_RENAMES, FRAMEWORK_OBJECTS_READER)).toBe("credit");
  });

  it("26: reads Step as Step and PAGE as page under both story readers", () => {
    for (const { renames, reader } of FRAMEWORK_STORIES_RELEASES) {
      expect(frameworkColumnName("Step", renames, reader)).toBe("Step");
      expect(frameworkColumnName("PAGE", renames, reader)).toBe("page");
    }
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "27: PUBLISHED_TAG_COLUMN_RENAMES vs the published tag's COLUMN_NAME_MAPPING",
  () => {
    it("equals it entry for entry", () => {
      const tag = readFrameworkColumnMapping(frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG));
      const pairs = (m: Readonly<Record<string, string>>) =>
        Object.entries(m)
          .map(([k, v]) => `${k} -> ${v}`)
          .sort();
      expect(pairs(PUBLISHED_TAG_COLUMN_RENAMES)).toEqual(pairs(tag));
    }, FRAMEWORK_TIMEOUT_MS);
  },
);

// ---------------------------------------------------------------------------
// The emitted bilingual row, judged by both releases' own detectors
//
// A published glossary.csv has to build on the release the sites are on and on
// the test instance, and `is_header_row` answers differently at the two: at the
// tag it counts every non-NA cell, on the test instance it skips a blank one.
// Which cells are non-NA is the reader's doing, so each release is measured
// with the reader its own glossary pipeline opens the file with — no reader at
// the tag passes `keep_default_na`, so an empty cell there is NaN and is
// excluded; the test instance's glossary readers pass `keep_default_na=False`,
// so an empty cell there is "". telar/core.py, which reads objects.csv, uses
// the default at both.
//
// No detector counts a custom column's empty cell, so the ratio stays at 5/5
// however many custom columns the sheet has and the row goes out on every
// glossary.csv, as it does on every objects.csv.
// ---------------------------------------------------------------------------

const customCounts = [0, 1, 2, 4];

/** A published glossary.csv carrying `n` custom columns beyond the fixed ones. */
function glossaryCsvWithCustomColumns(n: number): string {
  const extras: Record<string, string> = {};
  for (let i = 0; i < n; i++) extras[`note_${i}`] = "x";
  return serializeGlossaryCsv([
    {
      term_id: "enc", title: "E", definition: "d", related_terms: null,
      extra_columns: n > 0 ? JSON.stringify(extras) : null,
    },
  ]);
}

// The Compositor's own side of the same constraint, which holds with or
// without a framework checkout: what it publishes, it reads back as a header.
describe("the emitted bilingual row on re-import", () => {
  it.each(customCounts)("glossary with %i custom columns: skipped, not ingested", (n) => {
    const rows = parseTelarCsv(glossaryCsvWithCustomColumns(n));
    expect(rows).toHaveLength(1);
    expect(rows[0].term_id).toBe("enc");
  });
});

// The same constraint for a file published EARLIER, when the glossary still
// carried the acknowledgement column. Nothing reads `citado_en_historias` now
// — neither this codebase nor the framework renames it to anything — but every
// glossary.csv published while the column existed still carries it in the
// bilingual row, and so does the template sheet a site is created from. The row
// is skipped because that spelling was once written into these files, not
// because some mapping still has a use for it.
describe("a bilingual row from a glossary published with the acknowledgement", () => {
  const csv = [
    "term_id,title,definition,quoted_in_stories",
    "id_término,titulo,definición,citado_en_historias",
    "loom,Loom,A device.,locked-story",
  ].join("\n");

  it("is read as a header, not imported as a term", () => {
    const mapped = mapGlossaryCsv(parseTelarCsv(csv));
    expect(mapped).toHaveLength(1);
    expect(mapped[0].term_id).toBe("loom");
  });

  it("leaves the retired column to the author, under its own name", () => {
    const mapped = mapGlossaryCsv(parseTelarCsv(csv));
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({
      quoted_in_stories: "locked-story",
    });
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the emitted bilingual row vs is_header_row at both releases",
  () => {

    /**
     * Both releases, each with the NA handling its GLOSSARY reader gives an
     * empty cell. objects.csv is read the same way at both and passes NaN.
     */
    const releases = () => [
      {
        release: PUBLISHED_FRAMEWORK_TAG,
        scriptsDir: frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG),
        glossaryEmptyAsNaN: true,
      },
      { release: "test instance", scriptsDir: FRAMEWORK_SCRIPTS_DIR, glossaryEmptyAsNaN: false },
    ];

    it.each(customCounts)(
      "glossary with %i custom columns: emitted, and a header at both releases",
      (n) => {
        const csv = glossaryCsvWithCustomColumns(n);
        const second = csv.split("\n")[1];
        // It goes out on every file; read as anything but a header it becomes a
        // term whose term_id is "id_término".
        expect(second.startsWith("id_término"), `emission at n=${n}`).toBe(true);
        for (const { release, scriptsDir, glossaryEmptyAsNaN } of releases()) {
          expect(
            frameworkIsHeaderRow(second.split(","), glossaryEmptyAsNaN, scriptsDir),
            `${release}, n=${n}`,
          ).toBe(true);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    it(
      "glossary with a custom header carrying a newline: still a header at both releases",
      () => {
        const csv = serializeGlossaryCsv([
          {
            term_id: "enc", title: "E", definition: "d", related_terms: null,
            extra_columns: JSON.stringify({ "editor\nnote": "x" }),
          },
        ]);
        // The header spans two physical lines, so the row is taken as the second
        // RECORD rather than the second line.
        const cells = Papa.parse<string[]>(csv.trimEnd()).data[1];
        expect(cells[0]).toBe("id_término");
        for (const { release, scriptsDir, glossaryEmptyAsNaN } of releases()) {
          expect(frameworkIsHeaderRow(cells, glossaryEmptyAsNaN, scriptsDir), release).toBe(true);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    it.each(customCounts)(
      "objects with %i custom columns: the row it emits is a header at both releases",
      (n) => {
        const extras: Record<string, string> = {};
        for (let i = 0; i < n; i++) extras[`note_${i}`] = "x";
        const csv = serializeObjectsCsv([
          {
            object_id: "o1", title: "T", featured: false, creator: null, description: null,
            source_url: null, period: null, year: null, medium_genre: null, subjects: null,
            source: null, credit: null, thumbnail: null, alt_text: null, dimensions: null,
            extra_columns: n > 0 ? JSON.stringify(extras) : null,
          },
        ]);
        const second = csv.split("\n")[1];
        expect(second.startsWith("id_objeto"), "objects always emit the row").toBe(true);
        // NaN empties at both releases: telar/core.py reads objects.csv with
        // default NA handling, so the padding never enters the count.
        for (const { release, scriptsDir } of releases()) {
          expect(
            frameworkIsHeaderRow(second.split(","), true, scriptsDir),
            `${release}, n=${n}`,
          ).toBe(true);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// What a collision costs, measured at both releases
//
// A publish is refused for what the framework will do with the file, and the
// two releases do different things. At the tag the generator folds every header
// before the bilingual rename, so two spellings of one name reach pandas as two
// columns under one label and neither cell can be addressed: the file BUILDS
// and loses a value silently. On the test instance the rename refuses first and
// the build stops. "It built" is therefore not the question the blocker
// answers, and the Compositor refuses both cases for the tag's sake.
// ---------------------------------------------------------------------------

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the framework's glossary pipeline on colliding headers",
  () => {
    const atTag = () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG);

    it(
      "Note beside note: folded into one column at the tag, refused on the test instance",
      () => {
        const csv = "term_id,title,definition,Note,note\nloom,Loom,A device.,KEEP-ME,OTHER\n";
        const tag = frameworkGlossaryColumns(csv, true, atTag());
        expect(tag.error, "the tag does not refuse this one — it builds").toBeUndefined();
        // Two columns of one name: `row.get("note")` is a Series, not a value.
        expect(tag.duplicates).toEqual(["note"]);
        expect(tag.columns?.filter((c) => c === "note")).toHaveLength(2);

        expect(frameworkGlossaryColumns(csv, false).error).toBe("ColumnCollisionError");
        // Refused here either way, because the tag is where the value is lost.
        expect(collidingHeaderGroups(["term_id", "title", "definition", "Note", "note"]))
          .toHaveLength(1);
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    it(
      "Title beside título: a duplicate title at the tag, refused on the test instance",
      () => {
        for (const spelling of ["Title", "TITLE", " title "]) {
          const csv = `term_id,${spelling},definition,título\nloom,a,A device.,b\n`;
          const tag = frameworkGlossaryColumns(csv, true, atTag());
          expect(tag.error, `${spelling} was refused at the tag`).toBeUndefined();
          expect(tag.duplicates, `${spelling} did not duplicate title at the tag`)
            .toEqual(["title"]);

          expect(frameworkGlossaryColumns(csv, false).error, `${spelling} was not refused`)
            .toBe("ColumnCollisionError");
          // …and we refuse it too, before it can be published.
          expect(collidingHeaderGroups(["term_id", spelling, "definition", "título"]))
            .toHaveLength(1);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    it(
      "a parser-minted title_1 builds cleanly at both releases, and is not refused",
      () => {
        const csv = "term_id,title,definition,title_1\nloom,Loom,A device.,x\n";
        for (const [release, result] of [
          [PUBLISHED_FRAMEWORK_TAG, frameworkGlossaryColumns(csv, true, atTag())],
          ["test instance", frameworkGlossaryColumns(csv, false)],
        ] as const) {
          expect(result.error, `${release} refused it`).toBeUndefined();
          expect(result.duplicates, `${release} saw a duplicate`).toEqual([]);
        }
        expect(collidingHeaderGroups(["term_id", "title", "definition", "title_1"])).toHaveLength(0);
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// The fold the collision prediction is made with
//
// `collidingHeaderGroups` predicts what Python will do to a pair of headers, so
// the fold in front of it has to be Python's. The two languages' whitespace
// sets differ in both directions: CPython's `str.strip()` removes every code
// point whose `str.isspace()` is true, which includes U+001C-U+001F and U+0085
// and excludes U+FEFF; JavaScript's `trim()` is the other way round on exactly
// those six. A header parting from its twin by one of them is a collision the
// framework makes and we would not have named.
// ---------------------------------------------------------------------------

describeWithPython("pythonStrip vs CPython's str.strip", () => {
  /** Where the two languages disagree — the whole reason this helper exists. */
  const divergent = ["\u001c", "\u001d", "\u001e", "\u001f", "\u0085", "\ufeff"];
  /** Every code point CPython strips, so agreement is checked on all of them. */
  const pythonWhitespace = [
    "\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u001c", "\u001d", "\u001e",
    "\u001f", "\u0020", "\u0085", "\u00a0", "\u1680", "\u2000", "\u2001", "\u2002",
    "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a",
    "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
  ];

  const hex = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

  it.each([...new Set([...pythonWhitespace, ...divergent])])(
    "agrees with str.strip on %j either side of a header",
    (cp) => {
      const subject = `${cp}title${cp}`;
      const fromPython = runPython(
        "s = json.loads(sys.stdin.read())\nprint(json.dumps(s.strip()))",
        JSON.stringify(subject),
      );
      expect(pythonStrip(subject), hex(cp)).toBe(fromPython);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it("differs from trim() on exactly the six code points that make it necessary", () => {
    for (const cp of divergent) {
      const subject = `${cp}title${cp}`;
      expect(pythonStrip(subject), hex(cp)).not.toBe(subject.trim());
    }
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "a header parted from its twin by U+0085",
  () => {
    // NEL is whitespace to CPython and not to JavaScript, so the two headers
    // are one column to the framework.
    //
    // These are the headers as a stored extras blob can carry them, which is
    // the shape the publish check passes: a blob written before the fold
    // covered the spelling holds both. A SHEET headed this way never gets
    // here \u2014 both columns declare `related_terms` in text that differs as
    // the file has it, so the parse applies the collision rule and republishes
    // one `related_terms` column. See the U+0085 block below.
    const headers = ["term_id", "title", "definition", "related_terms", "related_terms\u0085"];

    it(
      "is one group here, folded into one column at the tag and refused on the test instance",
      () => {
        expect(collidingHeaderGroups(headers)).toHaveLength(1);
        const csv = `${headers.join(",")}\nloom,Loom,A device.,a,b\n`;
        expect(
          frameworkGlossaryColumns(csv, true, frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG))
            .duplicates,
        ).toEqual(["related_terms"]);
        expect(frameworkGlossaryColumns(csv, false).error).toBe("ColumnCollisionError");
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// One header identity
//
// `foldHeader` is the form every place in the Compositor that decides what a
// column IS compares under, and it is CPython's because the pipeline reading
// the published file is. U+0085 is the case with teeth: whitespace to CPython,
// an ordinary character to JavaScript, so a header carrying one is a field on
// one side of the wire and a custom column on the other.
// ---------------------------------------------------------------------------

/** Whitespace to CPython's `str.strip()`, a character to JavaScript's trim. */
const NEL = "";

describe("a header parted from the field it names by U+0085", () => {
  it("is that field on a glossary sheet, with nothing left over", () => {
    const rows = parseTelarCsv(
      `term_id,${NEL}title,definition\nloom,Loom,A device.`,
      undefined,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(Object.keys(rows[0])).toEqual(["term_id", "title", "definition"]);
    const mapped = mapGlossaryCsv(rows);
    expect(mapped[0].title).toBe("Loom");
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  it("is that field on an objects sheet, with nothing left over", () => {
    const rows = parseTelarCsv(
      `object_id,${NEL}title,description\nloom,Loom,A device.`,
      undefined,
      false,
      OBJECTS_CANONICAL_SCOPE,
    );
    expect(Object.keys(rows[0])).toEqual(["object_id", "title", "description"]);
    const mapped = mapObjectsCsv(rows);
    expect(mapped[0].title).toBe("Loom");
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  it("carries the value into a republished objects.csv under a plain header", () => {
    const rows = parseTelarCsv(
      `object_id,${NEL}title,description\nloom,Loom,A device.`,
      undefined,
      false,
      OBJECTS_CANONICAL_SCOPE,
    );
    const mapped = mapObjectsCsv(rows);
    const csv = serializeObjectsCsv([
      {
        object_id: mapped[0].object_id as string,
        title: (mapped[0].title as string) ?? null,
        featured: false,
        creator: null,
        description: (mapped[0].description as string) ?? null,
        source_url: null,
        period: null,
        year: null,
        medium_genre: null,
        subjects: null,
        source: null,
        credit: null,
        thumbnail: null,
        alt_text: (mapped[0].alt_text as string) ?? null,
        extra_columns: (mapped[0].extra_columns as string) ?? null,
      },
    ]);
    const table = Papa.parse<string[]>(csv, { header: false, skipEmptyLines: true }).data;
    expect(table[0]).toEqual([...OBJECTS_CSV_COLUMNS]);
    expect(table[table.length - 1][table[0].indexOf("title")]).toBe("Loom");
  });

  it("is a bilingual row when every cell carries one", () => {
    const bilingual = [`${NEL}id_término`, `${NEL}titulo`, `${NEL}definición`];
    expect(isHeaderRow({ 0: bilingual[0], 1: bilingual[1], 2: bilingual[2] })).toBe(true);
    const rows = parseTelarCsv(
      `term_id,title,definition\n${bilingual.join(",")}\nloom,Loom,A device.`,
      undefined,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].term_id).toBe("loom");
  });

  it("is the reserved column it names, at import and at publish", () => {
    const onWarning = vi.fn();
    const mapped = mapGlossaryCsv(
      parseTelarCsv(
        `term_id,title,${NEL}_metadata\nbackstrap-loom,Loom,forged-value`,
        undefined,
        false,
        GLOSSARY_CANONICAL_SCOPE,
      ),
      onWarning,
    );
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).toEqual({ code: "reserved_column", columns: ["_metadata"] });

    const validation = runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "a",
      stories: [],
      steps: [],
      pages: [],
      objects: [],
      glossary: mapped.map((m) => ({
        term_id: m.term_id as string,
        extra_columns: (m.extra_columns as string) ?? null,
      })),
    });
    const blockers = validation.blockers.filter((b) => b.code === "glossary_reserved_column");
    expect(blockers).toHaveLength(1);
    expect(blockers[0].entityId).toBe("backstrap-loom");
  });

  // Two headers that declare one canonical name in text that differs as the
  // file has it are a collision, whatever the difference: pandas keeps them as
  // two columns and CPython's strip folds both onto `related_terms`, so the
  // framework refuses the sheet. With both holding values, the last keeps the
  // name and the other is dropped with a warning.
  it("beside its twin, collides with it, and the last holding values keeps the name", () => {
    const headers = ["term_id", "title", "definition", "related_terms", `related_terms${NEL}`];
    expect(collidingHeaderGroups(headers)).toHaveLength(1);

    const onWarning = vi.fn();
    const rows = parseTelarCsv(
      `${headers.join(",")}\nloom,Loom,A device.,a,b`,
      onWarning,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(Object.keys(rows[0])).toEqual(["term_id", "title", "definition", "related_terms"]);
    expect(rows[0].related_terms).toBe("b");
    expect(onWarning.mock.calls.map((c) => c[0])).toEqual([
      {
        code: "column_collision_last",
        name: "related_terms",
        headers: ["related_terms", "related_terms"],
        column: 5,
      },
    ]);
  });

  it("drops all but the last when the two spellings fold apart", () => {
    const onWarning = vi.fn();
    const rows = parseTelarCsv(
      "term_id,title,definition,título\nloom,First,A device.,Second",
      onWarning,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(rows[0].title).toBe("Second");
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).toMatchObject({ code: "column_collision_last", name: "title" });
  });
});

// A BOM is file encoding, not part of the first header. Papa Parse removes a
// leading one before it reports any field, so `parseTelarCsv` never sees it and
// the fold never has to answer for a code point CPython does not strip.
describe("a glossary.csv that opens with a byte-order mark", () => {
  it("is stripped of it by the parser before any header is read", () => {
    const parsed = Papa.parse<string[]>("﻿term_id,title\nloom,Loom", {
      header: false,
      skipEmptyLines: true,
    });
    expect(parsed.data[0][0]).toBe("term_id");
  });

  it("imports with term_id recognised", () => {
    const rows = parseTelarCsv(
      "﻿term_id,title,definition\nloom,Loom,A device.",
      undefined,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(Object.keys(rows[0])).toEqual(["term_id", "title", "definition"]);
    expect(mapGlossaryCsv(rows)[0].term_id).toBe("loom");
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "a U+0085 header, read by each framework release",
  () => {
    const atTag = () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG);

    /** The framework's own rename table applied to a set of headers. */
    const frameworkRenames = (headers: string[], scriptsDir: string): string[] =>
      runPython(
        `sys.path.insert(0, ${JSON.stringify(scriptsDir)})\n` +
          "import pandas as pd\n" +
          "from telar.csv_utils import normalize_column_names\n" +
          "headers = json.loads(sys.stdin.read())\n" +
          "out = normalize_column_names(pd.DataFrame(columns=headers))\n" +
          "print(json.dumps([str(c) for c in out.columns]))",
        JSON.stringify(headers),
      ) as string[];

    it(
      "is folded onto the field it names by the glossary pipeline at both releases",
      () => {
        const csv = `term_id,${NEL}title,definition\nloom,Loom,A device.\n`;
        for (const [release, result] of [
          [PUBLISHED_FRAMEWORK_TAG, frameworkGlossaryColumns(csv, true, atTag())],
          ["test instance", frameworkGlossaryColumns(csv, false)],
        ] as const) {
          expect(result.error, `${release} refused it`).toBeUndefined();
          expect(result.columns, `${release} read it as another column`)
            .toEqual(["term_id", "title", "definition"]);
          expect(result.duplicates, `${release} saw a duplicate`).toEqual([]);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    // The objects pipeline never folds a header: `normalize_column_names` looks
    // the folded name up in a table that has no `title` entry to find, and
    // `csv_to_json` renames without folding. So the framework reads this sheet's
    // title column as a custom column and the object has no title at all — which
    // is why the Compositor folds at import and republishes the value under a
    // header the framework does read.
    it(
      "is left as it stands by the objects rename at both releases",
      () => {
        for (const [release, scriptsDir] of [
          [PUBLISHED_FRAMEWORK_TAG, atTag()],
          ["test instance", FRAMEWORK_SCRIPTS_DIR],
        ] as const) {
          expect(
            frameworkRenames(["object_id", `${NEL}title`, "description"], scriptsDir),
            `${release} renamed it`,
          ).toEqual(["object_id", `${NEL}title`, "description"]);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    it(
      "makes a bilingual row of three cells at both releases",
      () => {
        const cells = [`${NEL}id_término`, `${NEL}titulo`, `${NEL}definición`];
        expect(frameworkIsHeaderRow(cells, true, atTag()), PUBLISHED_FRAMEWORK_TAG).toBe(true);
        expect(frameworkIsHeaderRow(cells, false), "test instance").toBe(true);
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// mapGlossaryCsv — custom-column passthrough
//
// glossary.csv gains the passthrough objects already had. Without it a column
// an author adds by hand reaches no D1 column, and serializeGlossaryCsv — which
// writes the file from a fixed column list — deletes it on the next publish.
// ---------------------------------------------------------------------------

describe("mapGlossaryCsv — custom-column passthrough", () => {
  it("captures a custom column into extra_columns", () => {
    const mapped = mapGlossaryCsv(
      parseTelarCsv("term_id,title,definition,source_note\nloom,Loom,A device.,Museo del Oro"),
    );
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({
      source_note: "Museo del Oro",
    });
  });

  it("leaves extra_columns undefined when the row has no custom column", () => {
    const mapped = mapGlossaryCsv(
      parseTelarCsv("term_id,title,definition\nloom,Loom,A device."),
    );
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  it("drops an empty custom cell rather than storing an empty string", () => {
    const mapped = mapGlossaryCsv(
      parseTelarCsv("term_id,title,source_note,curator\nloom,Loom,,Ana"),
    );
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({ curator: "Ana" });
  });

  it("keeps none of the first-class columns in extra_columns", () => {
    const mapped = mapGlossaryCsv(
      parseTelarCsv("term_id,title,definition,related_terms\nloom,Loom,A device.,warp"),
    );
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  it("fires one warning for the whole sheet, naming every reserved spelling found", () => {
    const onWarning = vi.fn();
    mapGlossaryCsv(
      parseTelarCsv("term_id,title,_metadata,_Metadata \nloom,Loom,forged,also-forged"),
      onWarning,
    );
    // Two reserved spellings also lowercase to one name, so the collision
    // warning fires alongside this one; assert the reserved warning itself.
    const reserved = onWarning.mock.calls
      .map((c) => c[0] as SheetIssue)
      .filter((issue) => issue.code === "reserved_column");
    expect(reserved).toEqual([{ code: "reserved_column", columns: ["_Metadata", "_metadata"] }]);
  });

  it("still captures the reserved column unchanged — the warning is notice, not a drop", () => {
    const onWarning = vi.fn();
    const mapped = mapGlossaryCsv(
      parseTelarCsv("term_id,title,_metadata\nloom,Loom,do-not-touch"),
      onWarning,
    );
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({ _metadata: "do-not-touch" });
  });

  it("does not warn for an ordinary custom column", () => {
    const onWarning = vi.fn();
    mapGlossaryCsv(parseTelarCsv("term_id,title,source_note\nloom,Loom,Museo"), onWarning);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("works with no onWarning passed at all", () => {
    expect(() =>
      mapGlossaryCsv(parseTelarCsv("term_id,title,_metadata\nloom,Loom,x")),
    ).not.toThrow();
  });

  // Two headers the framework's bilingual rename collapses into one field.
  // Notice at import, exactly as the reserved column is; the publish blocker
  // (`glossary_colliding_columns`) is what actually refuses.
  it("warns once for a sheet whose headers Telar reads as the same field", () => {
    // `credit` is no glossary field, so under the glossary scope this parse
    // renames neither header and both reach the publish side under the
    // author's own spellings — where the framework, whose table is not scoped
    // to a sheet, folds them onto one column. A pair this parse itself renames
    // onto one in-scope name never gets here: it is resolved at import, by
    // keeping one position (`title` beside `Title`, or beside `título`), or
    // into `title` and `title_1` where the header text is identical.
    const onWarning = vi.fn();
    mapGlossaryCsv(
      parseTelarCsv("term_id,title,credit,crédito\nloom,Loom,a,b", undefined, false, GLOSSARY_CANONICAL_SCOPE),
      onWarning,
    );
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).toEqual({ code: "folded_columns", groups: [["credit", "crédito"]] });
  });

  it("does not warn about collisions for an ordinary custom column", () => {
    const onWarning = vi.fn();
    mapGlossaryCsv(parseTelarCsv("term_id,title,source_note\nloom,Loom,Museo"), onWarning);
    expect(onWarning).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Two glossary headers for one framework column, end to end
//
// Which of the two mechanisms answers a sheet is decided by whether the parse
// renames its headers. A pair it renames onto one name the glossary scope
// models is resolved at import and republished as one column per name, so
// nothing is blocked. A pair it leaves alone reaches the publish check under
// the author's own spellings, and the blocker is what stops the file.
// ---------------------------------------------------------------------------

describe("two glossary headers the framework reads as one", () => {
  const importSheet = (csv: string) => {
    const onWarning = vi.fn();
    const rows = parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE);
    const mapped = mapGlossaryCsv(rows, onWarning);
    const validation = runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "a",
      stories: [],
      steps: [],
      pages: [],
      objects: [],
      glossary: mapped.map((m) => ({
        term_id: m.term_id as string,
        extra_columns: (m.extra_columns as string) ?? null,
      })),
    });
    return {
      keys: Object.keys(rows[0]),
      extras: JSON.parse((mapped[0].extra_columns as string) ?? "{}") as Record<string, string>,
      warnings: onWarning.mock.calls.map((c) => c[0] as SheetIssue),
      blockers: validation.blockers.filter((b) => b.code === "glossary_colliding_columns"),
    };
  };

  // The glossary scope does not model `credit`, so neither header is renamed
  // and both reach the publish check as the author spelled them.
  it("blocks a sheet headed credit and crédito, naming both spellings", () => {
    const sheet = importSheet("term_id,title,credit,crédito\nloom,Loom,a,b");
    expect(sheet.keys).toEqual(["term_id", "title", "credit", "crédito"]);
    expect(sheet.extras).toEqual({ credit: "a", "crédito": "b" });
    expect(sheet.warnings).toEqual([{ code: "folded_columns", groups: [["credit", "crédito"]] }]);
    expect(sheet.blockers).toHaveLength(1);
    expect(sheet.blockers[0].params?.columns).toBe('"credit", "crédito"');
  });

  // No table carries either spelling, so the parse renames neither and the two
  // keys differ — which is what lets them reach the publish check at all.
  it("blocks a sheet headed Note and note, naming both spellings", () => {
    const sheet = importSheet("term_id,title,Note,note\nloom,Loom,KEEP-ME,OTHER");
    expect(sheet.keys).toEqual(["term_id", "title", "Note", "note"]);
    expect(sheet.extras).toEqual({ Note: "KEEP-ME", note: "OTHER" });
    expect(sheet.warnings).toEqual([{ code: "folded_columns", groups: [["Note", "note"]] }]);
    expect(sheet.blockers).toHaveLength(1);
    expect(sheet.blockers[0].params?.columns).toBe('"Note", "note"');
  });

  // Both declare the canonical `title` in different text, which the framework
  // groups as one column, so the parse keeps one of them and the file it
  // republishes has one column per name. Here the one with values.
  it("keeps the one of title and Title that holds values, and blocks nothing", () => {
    const sheet = importSheet("term_id,title,definition,Title\nloom,,A device.,Loom");
    expect(sheet.keys).toEqual(["term_id", "definition", "title"]);
    expect(sheet.extras).toEqual({});
    expect(sheet.blockers).toEqual([]);
  });

  // Byte-identical headers the parse renames nothing for take the same path.
  it("suffixes a sheet headed note twice, and blocks nothing", () => {
    const sheet = importSheet("term_id,title,note,note\nloom,Loom,KEEP-ME,OTHER");
    expect(sheet.keys).toEqual(["term_id", "title", "note", "note_1"]);
    expect(sheet.warnings).toEqual([]);
    expect(sheet.blockers).toEqual([]);
  });

  it("keeps one column of a sheet whose two headers part by U+0085, and blocks nothing", () => {
    const sheet = importSheet(
      `term_id,title,definition,related_terms,related_terms${NEL}\nloom,Loom,A device.,a,b`,
    );
    expect(sheet.keys).toEqual(["term_id", "title", "definition", "related_terms"]);
    expect(sheet.warnings).toEqual([]);
    expect(sheet.blockers).toEqual([]);
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "what a suffixed glossary sheet republishes as",
  () => {
    it(
      "builds at both releases when two headers parted by U+0085 are resolved to one",
      () => {
        const rows = parseTelarCsv(
          `term_id,title,definition,related_terms,related_terms${NEL}\nloom,Loom,A device.,a,b`,
          undefined,
          false,
          GLOSSARY_CANONICAL_SCOPE,
        );
        const csv = serializeGlossaryCsv(
          mapGlossaryCsv(rows).map((m) => ({
            term_id: m.term_id as string,
            title: (m.title as string) ?? null,
            definition: (m.definition as string) ?? null,
            related_terms: (m.related_terms as string) ?? null,
            extra_columns: (m.extra_columns as string) ?? null,
          })),
        );
        for (const [release, result] of [
          [
            PUBLISHED_FRAMEWORK_TAG,
            frameworkGlossaryColumns(csv, true, frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG)),
          ],
          ["test instance", frameworkGlossaryColumns(csv, false)],
        ] as const) {
          expect(result.error, `${release} refused it`).toBeUndefined();
          expect(result.duplicates, `${release} saw a duplicate`).toEqual([]);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// The chain the glossary warning is earlier notice for: a glossary.csv carrying
// _metadata, once imported, produces the actual publish blocker.
// ---------------------------------------------------------------------------

describe("a glossary.csv with a reserved column, end to end", () => {
  const validationFor = (csv: string) =>
    runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "a",
      stories: [],
      steps: [],
      pages: [],
      objects: [],
      glossary: mapGlossaryCsv(
        parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE),
      ).map((m) => ({
        term_id: m.term_id as string,
        extra_columns: (m.extra_columns as string) ?? null,
      })),
    });

  it("produces a publish blocker naming the term and the column", () => {
    const validation = validationFor("term_id,title,_metadata\nbackstrap-loom,Loom,forged-value");
    const blockers = validation.blockers.filter((b) => b.code === "glossary_reserved_column");
    expect(blockers).toHaveLength(1);
    expect(blockers[0].entityId).toBe("backstrap-loom");
    expect(blockers[0].params).toEqual({ id: "backstrap-loom", column: "_metadata" });
  });

  it("produces no publish blocker for a glossary.csv without the reserved column", () => {
    const validation = validationFor("term_id,title,source_note\nbackstrap-loom,Loom,Museo del Oro");
    expect(validation.blockers.map((b) => b.code)).not.toContain("glossary_reserved_column");
  });

  // The whole route for the collision, from the author's file to the refusal:
  // this exact CSV was measured against the framework on 14 September and
  // raises ColumnCollisionError out of _generate_glossary_from_csv.
  it("blocks publishing a glossary.csv the framework's build would refuse", () => {
    const validation = validationFor("term_id,title,credit,crédito\nbackstrap-loom,Loom,a,b");
    const blockers = validation.blockers.filter((b) => b.code === "glossary_colliding_columns");
    expect(blockers).toHaveLength(1);
    expect(blockers[0].params?.columns).toBe('"credit", "crédito"');
  });
});

// ---------------------------------------------------------------------------
// mapObjectsCsv - medium_genre backwards compatibility
// ---------------------------------------------------------------------------

describe("mapObjectsCsv - medium_genre backwards compatibility", () => {
  it("reads medium_genre column and maps to object_type in D1 insert", () => {
    const rows: Record<string, string>[] = [
      { object_id: "obj-001", title: "A Photo", featured: "false", medium_genre: "Photograph" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped[0].object_type).toBe("Photograph");
  });

  // Every legacy spelling is renamed at the header, before the mapper sees a
  // row, so the mapper itself reads one name. These drive the whole parse
  // rather than handing the mapper a synthetic row, because the rename is the
  // thing under test.
  it.each([
    ["object_type", "legacy English"],
    ["medium", "the framework's documented name"],
    ["tipo_objeto", "legacy Spanish"],
    ["medio", "Spanish"],
    ["medio_genero", "Spanish v1.0.0"],
  ])("maps the %s header onto object_type in the D1 insert (%s)", (header) => {
    const mapped = mapObjectsCsv(
      parseTelarCsv(
        `object_id,title,featured,${header}\nobj-001,A Photo,false,Photograph`,
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped[0].object_type).toBe("Photograph");
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  // A sheet with `medium` filled in some rows beside an empty `object_type`:
  // both rename onto one field, and the values are in `medium`.
  it("keeps the spelling that holds values when a sheet carries two of them", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv(
        "object_id,title,medium,object_type\n" +
          "obj-001,First,Watercolor,\n" +
          "obj-002,Second,,\n" +
          "obj-003,Third,Woodcut,\n",
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped.map((m) => m.object_type)).toEqual(["Watercolor", undefined, "Woodcut"]);
    expect(mapped.every((m) => m.extra_columns === undefined)).toBe(true);
  });

  it("keeps the last spelling by default when both hold values", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv(
        "object_id,medium_genre,object_type\nobj-001,Watercolor,Painting",
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped[0].object_type).toBe("Painting");
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  // A modelled spelling left in the passthrough is republished as a column of
  // its own beside the Compositor's medium_genre, and the framework renames
  // both onto one canonical name — a file it refuses to build.
  it("never leaves a modelled spelling in the extra_columns passthrough", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv(
        "object_id,medium,notes\nobj-001,Oil on canvas,a custom column",
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped[0].object_type).toBe("Oil on canvas");
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({ notes: "a custom column" });
  });
});

// ---------------------------------------------------------------------------
// mapObjectsCsv - iiif_manifest legacy source_url fallback
// ---------------------------------------------------------------------------

describe("mapObjectsCsv - iiif_manifest", () => {
  // The framework prefers whichever of the pair is non-empty rather than
  // letting one column win the name (`get_source_url`), so this is read as a
  // fallback and never as a header rename.
  it("reads iiif_manifest into source_url when there is no source_url column", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv("object_id,iiif_manifest\nobj-001,https://example.org/manifest.json",
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped[0].source_url).toBe("https://example.org/manifest.json");
    expect(mapped[0].extra_columns).toBeUndefined();
  });

  it("reads iiif_manifest when the source_url column is present but empty", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv("object_id,source_url,iiif_manifest\nobj-001,,https://example.org/manifest.json",
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped[0].source_url).toBe("https://example.org/manifest.json");
  });

  it("prefers a populated source_url over iiif_manifest", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv(
        "object_id,source_url,iiif_manifest\nobj-001,https://example.org/page,https://example.org/manifest.json",
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped[0].source_url).toBe("https://example.org/page");
  });

  it("normalises a capitalised IIIF_Manifest header", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv("object_id,IIIF_Manifest\nobj-001,https://example.org/manifest.json",
        undefined, false, OBJECTS_CANONICAL_SCOPE,
      ),
    );
    expect(mapped[0].source_url).toBe("https://example.org/manifest.json");
    expect(mapped[0].extra_columns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pages import
// ---------------------------------------------------------------------------

describe("pages import — parsePageMarkdown", () => {
  it("extracts title from YAML frontmatter and body text", () => {
    const content = `---\ntitle: About\n---\nWelcome to the site.`;
    const result = parsePageMarkdown(content, "about");
    expect(result.title).toBe("About");
    expect(result.body).toBe("Welcome to the site.");
  });

  it("strips surrounding quotes from title in frontmatter", () => {
    const content = `---\ntitle: "My Page"\n---\nBody here.`;
    const result = parsePageMarkdown(content, "my-page");
    expect(result.title).toBe("My Page");
  });

  it("uses filename as title when no frontmatter", () => {
    const content = "Just a plain body without frontmatter.";
    const result = parsePageMarkdown(content, "contact");
    expect(result.title).toBe("contact");
    expect(result.body).toBe("Just a plain body without frontmatter.");
  });

  it("returns empty body string when content has only frontmatter", () => {
    const content = `---\ntitle: About\n---\n`;
    const result = parsePageMarkdown(content, "about");
    expect(result.title).toBe("About");
    expect(result.body).toBe("");
  });

  it("uses filename as title when frontmatter has no title key", () => {
    const content = `---\nlayout: page\n---\nSome body.`;
    const result = parsePageMarkdown(content, "slug-here");
    expect(result.title).toBe("slug-here");
    expect(result.body).toBe("Some body.");
  });
});

// ---------------------------------------------------------------------------
// decodeGitHubContent
// ---------------------------------------------------------------------------

describe("decodeGitHubContent (via import.server)", () => {
  it("correctly decodes Base64 with embedded newlines and UTF-8 characters", async () => {
    // This tests the same logic in github.server.ts via actual behavior
    const text = "café — naïve résumé\nSecond line";
    const bytes = new TextEncoder().encode(text);
    const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
    const base64WithNewlines = btoa(binary).replace(/(.{20})/g, "$1\n");

    // Simulate the decoding logic
    const cleaned = base64WithNewlines.replace(/\n/g, "");
    const decoded = atob(cleaned);
    const result = new TextDecoder("utf-8").decode(
      Uint8Array.from(decoded, (c) => c.charCodeAt(0))
    );
    expect(result).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// importRepo - sheetsAccessError blocking path
// ---------------------------------------------------------------------------

describe("importRepo - sheetsAccessError blocking path", () => {
  it("returns { valid: false, sheetsAccessError: true } when fetchSheetCsv throws", async () => {
    // We test this by mocking the sheets module
    const { importRepo } = await import("~/lib/import.server");
    const sheetsModule = await import("~/lib/sheets.server");

    // Mock the GitHub API calls
    const yaml = readFixture("config.yml");
    const bytes = new TextEncoder().encode(yaml);
    const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
    const base64 = btoa(binary);

    // Config with google_sheets.enabled = true
    const configWithSheets = yaml.replace(
      "enabled: false\n  published_url: \"\"",
      "enabled: true\n  published_url: \"https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pubhtml\""
    );
    const configBytes = new TextEncoder().encode(configWithSheets);
    const configBinary = Array.from(configBytes).map((b) => String.fromCharCode(b)).join("");
    const configBase64 = btoa(configBinary);

    // index.md response (404 = no index.md in this repo)
    const indexNotFound = { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "head-sha" } } } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ content: configBase64, encoding: "base64", size: configBytes.length }),
      })
      .mockResolvedValueOnce(indexNotFound)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ tree: [], truncated: false }),
      });

    // Mock discoverSheetTabs to return tabs, fetchSheetCsv to throw (HTML response)
    vi.spyOn(sheetsModule, "discoverSheetTabs").mockResolvedValue([
      { name: "objects", gid: "12345" },
    ]);
    vi.spyOn(sheetsModule, "fetchSheetCsv").mockRejectedValue(
      new Error("HTML response — sheet not accessible")
    );

    const mockEnv = {
      DB: {} as D1Database,
      ENCRYPTION_KEY: "a".repeat(64),
    } as unknown as Env;

    const result = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: mockEnv,
    });

    expect(result.valid).toBe(false);
    expect(result.sheetsAccessError).toBe(true);

    // Ensure repo CSV import was NOT attempted
    // (fetch was only called for the head, _config.yml and tree, not for CSVs)
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const csvFetchCalls = fetchCalls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0].includes("objects.csv") || call[0].includes("project.csv"))
    );
    expect(csvFetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// importRepo - pages come from the repository, not from the content source
// ---------------------------------------------------------------------------

describe("importRepo - pages under Google Sheets", () => {
  const PAGE_PATH = "telar-content/texts/pages/about.md";
  const originalFetch = globalThis.fetch;

  function base64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    return btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(""));
  }

  function ok(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  beforeEach(() => {
    importDb = makeDbMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("imports a repo page when the content source is a published Sheet", async () => {
    const { importRepo } = await import("~/lib/import.server");
    const sheetsModule = await import("~/lib/sheets.server");

    const yaml = readFixture("config.yml").replace(
      'enabled: false\n  published_url: ""',
      'enabled: true\n  published_url: "https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pubhtml"',
    );

    const page = "# About this site\n\nHeld in the repository, not in the Sheet.\n";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/graphql")) return ok({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "head-sha" } } } } });
      if (url.includes("/contents/_config.yml")) {
        return ok({ content: base64(yaml), encoding: "base64", size: Buffer.byteLength(yaml, "utf8") });
      }
      if (url.includes(`/contents/${PAGE_PATH}`)) {
        return ok({ content: base64(page), encoding: "base64", size: Buffer.byteLength(page, "utf8") });
      }
      if (url.includes("/git/trees")) {
        return ok({ tree: [{ path: PAGE_PATH, type: "blob" }], truncated: false });
      }
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    vi.spyOn(sheetsModule, "discoverSheetTabs").mockResolvedValue([
      { name: "objects", gid: "10" },
    ]);
    vi.spyOn(sheetsModule, "fetchSheetCsv").mockResolvedValue(
      "object_id,title\nobj-001,An object\n",
    );

    const result = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });

    expect(result.valid).toBe(true);
    expect(result.sheetsEnabled).toBe(false);
    expect(result.pages.imported).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rollbackProjectImport — cascade-delete coverage
// ---------------------------------------------------------------------------

describe("rollbackProjectImport — cascade-delete order", () => {
  it("deletes project_members and project_invites after per-entity cascades and before projects", async () => {
    const visited: unknown[] = [];

    // Mock db.delete to record the table reference passed in. The real drizzle
    // chain is `.delete(table).where(condition)` — we return a stub whose
    // `where` resolves to undefined so the await chain completes.
    const db = {
      insert: vi.fn(() => ({ select: vi.fn(() => ({})) })),
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return {
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => []) })),
        };
      }),
      // rollbackProjectImport now resolves dependent ids before the batch.
      // Returning [] skips the layers/steps branch — covered by the next test.
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      // The cascade is issued as a single atomic batch.
      batch: vi.fn().mockResolvedValue([[]]),
    };

    await rollbackProjectImport(db, 42);

    // Presence. The first project_members delete is the course's staff copies
    // on its sites, ahead of everything; the project's own members come later.
    expect(visited[0]).toBe(project_members);
    expect(visited).toContain(project_members);
    expect(visited).toContain(project_invites);

    // Per-entity cascades still run before the new deletes
    expect(visited.lastIndexOf(project_members)).toBeGreaterThan(visited.indexOf(project_landing));
    expect(visited.lastIndexOf(project_members)).toBeGreaterThan(visited.indexOf(project_config));
    expect(visited.indexOf(project_invites)).toBeGreaterThan(visited.indexOf(project_landing));

    // project_members deleted before project_invites (insertion order in helper)
    expect(visited.lastIndexOf(project_members)).toBeLessThan(visited.indexOf(project_invites));

    // Both run BEFORE the project row delete
    expect(visited.lastIndexOf(project_members)).toBeLessThan(visited.indexOf(projects));
    expect(visited.indexOf(project_invites)).toBeLessThan(visited.indexOf(projects));

    // The project row is deleted last
    expect(visited[visited.length - 1]).toBe(projects);
  });

  it("retains the existing per-entity cascade order", async () => {
    const visited: unknown[] = [];
    const db = {
      insert: vi.fn(() => ({ select: vi.fn(() => ({})) })),
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return { where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => []) })) };
      }),
      // Return one id so the layers/steps branch runs and we can assert the
      // full cascade (including layers + steps).
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 1 }]) })),
      })),
      batch: vi.fn().mockResolvedValue([[]]),
    };

    await rollbackProjectImport(db, 99);

    // Sanity: the rollback hits each entity table at least once
    for (const t of [
      layers,
      steps,
      stories,
      objects,
      glossary_terms,
      project_config,
      project_themes,
      project_landing,
      project_members,
      project_invites,
      projects,
    ]) {
      expect(visited).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// scanRepoPages — discover repo-side pages for the import flow
// ---------------------------------------------------------------------------

describe("scanRepoPages", () => {
  // Use vi.spyOn rather than vi.mock so the rest of the suite — which calls
  // through to the real github.server helpers via globalThis.fetch mocking
  // (see importRepo tests above) — is unaffected. We restore after each test.
  let getRepoTreeSpy: ReturnType<typeof vi.spyOn> & {
    mockResolvedValue: (v: { tree: githubServer.TreeEntry[]; truncated: boolean }) => unknown;
  };
  let getFileContentSpy: ReturnType<typeof vi.spyOn> & {
    mockResolvedValue: (v: string | null) => unknown;
    mockImplementation: (
      fn: (token: string, owner: string, repo: string, path: string) => Promise<string | null>,
    ) => unknown;
  };

  let pinnedSpies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    // The `as never` cast skirts vitest's overly-narrow MockInstance type
    // when assigning a typed spy to a loosely-typed lexical binding; the
    // spy itself is fully typed at the call sites.
    getRepoTreeSpy = vi.spyOn(githubServer, "getRepoTree") as never;
    getFileContentSpy = vi.spyOn(githubServer, "getFileContent") as never;
    // The scan reads each page strictly at the head it resolves; the cases
    // state the pages through getFileContent.
    pinnedSpies = [
      vi.spyOn(githubServer, "getRepoHead").mockResolvedValue("head-sha"),
      vi.spyOn(githubServer, "getFileAtRef").mockImplementation(
        strictReadsFromFileContent(githubServer.getFileContent, async () => ({ status: "absent" })) as never,
      ),
    ];
  });

  afterEach(() => {
    (getRepoTreeSpy as { mockRestore: () => void }).mockRestore();
    (getFileContentSpy as { mockRestore: () => void }).mockRestore();
    for (const spy of pinnedSpies) spy.mockRestore();
  });

  it("returns [] when the tree contains no telar-content/texts/pages/*.md entries", async () => {
    getRepoTreeSpy.mockResolvedValue({
      tree: [
        { path: "README.md", mode: "100644", type: "blob", sha: "a" },
        { path: "telar-content/texts/about.md", mode: "100644", type: "blob", sha: "b" },
        { path: "telar-content/texts/pages", mode: "040000", type: "tree", sha: "c" },
        { path: "telar-content/spreadsheets/objects.csv", mode: "100644", type: "blob", sha: "d" },
      ],
      truncated: false,
    });

    const result = await scanRepoPages("token", "owner", "repo");

    expect(result).toEqual([]);
    expect(getFileContentSpy).not.toHaveBeenCalled();
  });

  it("returns parsed page records with index-based order for matching md entries", async () => {
    getRepoTreeSpy.mockResolvedValue({
      tree: [
        { path: "README.md", mode: "100644", type: "blob", sha: "a" },
        { path: "telar-content/texts/pages/about.md", mode: "100644", type: "blob", sha: "b" },
        { path: "telar-content/texts/pages/team.md", mode: "100644", type: "blob", sha: "c" },
      ],
      truncated: false,
    });
    getFileContentSpy.mockImplementation(async (_t: string, _o: string, _r: string, path: string) => {
      if (path === "telar-content/texts/pages/about.md") {
        return "---\ntitle: About this project\n---\nWelcome to the project.";
      }
      if (path === "telar-content/texts/pages/team.md") {
        return "---\ntitle: Our team\n---\nMeet the team.";
      }
      return null;
    });

    const result = await scanRepoPages("token", "owner", "repo");

    expect(result).toEqual([
      { slug: "about", title: "About this project", body: "Welcome to the project.", frontmatter: "\ntitle: About this project\n", order: 0 },
      { slug: "team", title: "Our team", body: "Meet the team.", frontmatter: "\ntitle: Our team\n", order: 1 },
    ]);
  });

  it("skips entries absent at the head while preserving order for the rest", async () => {
    getRepoTreeSpy.mockResolvedValue({
      tree: [
        { path: "telar-content/texts/pages/about.md", mode: "100644", type: "blob", sha: "a" },
        { path: "telar-content/texts/pages/missing.md", mode: "100644", type: "blob", sha: "b" },
        { path: "telar-content/texts/pages/team.md", mode: "100644", type: "blob", sha: "c" },
      ],
      truncated: false,
    });
    getFileContentSpy.mockImplementation(async (_t: string, _o: string, _r: string, path: string) => {
      if (path === "telar-content/texts/pages/missing.md") return null;
      if (path === "telar-content/texts/pages/about.md") {
        return "---\ntitle: About\n---\nAbout body.";
      }
      if (path === "telar-content/texts/pages/team.md") {
        return "---\ntitle: Team\n---\nTeam body.";
      }
      return null;
    });

    const result = await scanRepoPages("token", "owner", "repo");

    // Two entries returned; the missing one is dropped. The remaining entries
    // keep their original index from the filtered tree (0 and 2).
    expect(result).toEqual([
      { slug: "about", title: "About", body: "About body.", frontmatter: "\ntitle: About\n", order: 0 },
      { slug: "team", title: "Team", body: "Team body.", frontmatter: "\ntitle: Team\n", order: 2 },
    ]);
  });

  it("takes only the files directly in the pages folder, as the framework builds them", async () => {
    getRepoTreeSpy.mockResolvedValue({
      tree: [
        { path: "telar-content/texts/pages/sub", mode: "040000", type: "tree", sha: "t" },
        { path: "telar-content/texts/pages/sub/x.md", mode: "100644", type: "blob", sha: "a" },
        { path: "telar-content/texts/pages/about.md", mode: "100644", type: "blob", sha: "b" },
        { path: "telar-content/texts/pages/sub/deeper/y.md", mode: "100644", type: "blob", sha: "c" },
      ],
      truncated: false,
    });
    getFileContentSpy.mockResolvedValue("---\ntitle: A page\n---\nBody.");

    const result = await scanRepoPages("token", "owner", "repo");

    expect(result.map((p) => [p.slug, p.order])).toEqual([["about", 0]]);
    expect(getFileContentSpy.mock.calls.map((call: unknown[]) => call[3])).toEqual([
      "telar-content/texts/pages/about.md",
    ]);
  });

  it("falls back to slug as title when frontmatter is missing", async () => {
    getRepoTreeSpy.mockResolvedValue({
      tree: [
        { path: "telar-content/texts/pages/notes.md", mode: "100644", type: "blob", sha: "a" },
      ],
      truncated: false,
    });
    getFileContentSpy.mockResolvedValue("Just a body without frontmatter.");

    const result = await scanRepoPages("token", "owner", "repo");

    expect(result).toEqual([
      {
        slug: "notes",
        title: "notes",
        body: "Just a body without frontmatter.",
        frontmatter: "",
        order: 0,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests for the `deleteProjectCascade` extraction (from
// `rollbackProjectImport`) and the `reimportRepo` extraction. The cascade
// covers 9+ entity tables — including project_pages — and underpins the
// journaled snapshot-and-restore re-import path.
// ---------------------------------------------------------------------------

describe("deleteProjectCascade — extracted from rollbackProjectImport", () => {
  it("is exported from app/lib/import.server.ts and is callable as deleteProjectCascade(db, projectId)", async () => {
    const mod = await import("~/lib/import.server");
    expect(typeof (mod as any).deleteProjectCascade).toBe("function");
  });

  it("includes project_pages in the cascade (supersedes legacy 9-table list)", async () => {
    const visited: unknown[] = [];
    const db: any = {
      insert: vi.fn(() => ({ select: vi.fn(() => ({})) })),
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return { where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => []) })) };
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 1 }]),
        })),
      })),
      batch: vi.fn().mockResolvedValue([[]]),
    };

    const { deleteProjectCascade } = await import("~/lib/import.server");
    const { project_pages } = await import("~/db/schema");
    await deleteProjectCascade(db, 7);

    expect(visited).toContain(project_pages);
  });

  it("issues the cascade as a single db.batch([...]) call", async () => {
    const db: any = {
      insert: vi.fn(() => ({ select: vi.fn(() => ({})) })),
      delete: vi.fn(() => ({ where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => []) })) })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
      batch: vi.fn().mockResolvedValue([[]]),
    };

    const { deleteProjectCascade } = await import("~/lib/import.server");
    await deleteProjectCascade(db, 7);

    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("rollbackProjectImport delegates to deleteProjectCascade (no behavioural drift)", async () => {
    // Both functions, called against the same mock db, must record the
    // same delete-table sequence and the same number of batch calls.
    const makeRecorder = () => {
      const visited: unknown[] = [];
      const db: any = {
        insert: vi.fn(() => ({ select: vi.fn(() => ({})) })),
        delete: vi.fn((table: unknown) => {
          visited.push(table);
          return { where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => []) })) };
        }),
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 1 }]) })),
        })),
        batch: vi.fn().mockResolvedValue([[]]),
      };
      return { db, visited };
    };

    const a = makeRecorder();
    const b = makeRecorder();

    const { rollbackProjectImport, deleteProjectCascade } = await import(
      "~/lib/import.server"
    );
    await rollbackProjectImport(a.db, 42);
    await deleteProjectCascade(b.db, 42);

    expect(a.visited).toEqual(b.visited);
    expect(a.db.batch).toHaveBeenCalledTimes(1);
    expect(b.db.batch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Orphan detection + .compositor-ignored
// ---------------------------------------------------------------------------

describe("orphan detection + .compositor-ignored", () => {
  describe("parseCompositorIgnored", () => {
    it("returns [] when contents are null (missing file = empty list)", () => {
      expect(parseCompositorIgnored(null)).toEqual([]);
    });

    it("returns [] for an empty string", () => {
      expect(parseCompositorIgnored("")).toEqual([]);
    });

    it("parses newline-delimited story IDs, trimming whitespace, dropping blanks and # comments", () => {
      const contents = [
        "# header comment",
        "  story-a  ",
        "",
        "story-b",
        "# another comment",
        "   ",
        "story-c",
      ].join("\n");
      expect(parseCompositorIgnored(contents)).toEqual([
        "story-a",
        "story-b",
        "story-c",
      ]);
    });

    it("dedupes repeated IDs", () => {
      const contents = "story-a\nstory-a\nstory-b\n";
      expect(parseCompositorIgnored(contents)).toEqual(["story-a", "story-b"]);
    });

    it("handles \\r\\n line endings (Windows-edited file)", () => {
      const contents = "# header\r\nstory-a\r\nstory-b\r\n";
      expect(parseCompositorIgnored(contents)).toEqual(["story-a", "story-b"]);
    });
  });

  describe("detectOrphanStoryIds", () => {
    it("emits a story ID present on GitHub but absent from project.csv (happy path)", () => {
      const result = detectOrphanStoryIds({
        projectCsvStoryIds: new Set(["story-a", "story-b"]),
        spreadsheetDirListing: [
          "project.csv",
          "story-a.csv",
          "story-b.csv",
          "story-c.csv",
        ],
        ignoredIds: new Set<string>(),
      });
      expect(result).toEqual(["story-c"]);
    });

    it("suppresses orphans listed in .compositor-ignored", () => {
      const result = detectOrphanStoryIds({
        projectCsvStoryIds: new Set(["story-a", "story-b"]),
        spreadsheetDirListing: [
          "project.csv",
          "story-a.csv",
          "story-b.csv",
          "story-c.csv",
        ],
        ignoredIds: new Set(["story-c"]),
      });
      expect(result).toEqual([]);
    });

    it("returns [] when spreadsheets/ contains only project.csv (no false positives)", () => {
      const result = detectOrphanStoryIds({
        projectCsvStoryIds: new Set<string>(),
        spreadsheetDirListing: ["project.csv"],
        ignoredIds: new Set<string>(),
      });
      expect(result).toEqual([]);
    });

    it("ignores non-csv entries and the project.csv registry itself", () => {
      const result = detectOrphanStoryIds({
        projectCsvStoryIds: new Set<string>(),
        spreadsheetDirListing: [
          "project.csv",
          "objects.csv", // registry — not a story file, but ends in .csv; should NOT be flagged
          "glossary.csv", // registry — same
          "README.md",
          "story-orphan.csv",
        ],
        ignoredIds: new Set<string>(),
      });
      expect(result).toEqual(["story-orphan"]);
    });

    it("treats a glosario.csv beside a glossary.csv as a story, and the glossary the site reads as none", () => {
      const orphans = (spreadsheetDirListing: string[]) =>
        detectOrphanStoryIds({ projectCsvStoryIds: new Set<string>(), spreadsheetDirListing, ignoredIds: new Set<string>() });
      expect(orphans(["glossary.csv", "glosario.csv"])).toEqual(["glosario"]);
      expect(orphans(["glosario.csv"])).toEqual([]);
      expect(orphans(["glossary.csv"])).toEqual([]);
    });

    it("skips both names of the project and objects sheets, as the build does", () => {
      const result = detectOrphanStoryIds({
        projectCsvStoryIds: new Set<string>(),
        spreadsheetDirListing: ["project.csv", "proyecto.csv", "objects.csv", "objetos.csv", "story-x.csv"],
        ignoredIds: new Set<string>(),
      });
      expect(result).toEqual(["story-x"]);
    });

    it("dedupes the listing if GitHub returned the same path twice", () => {
      const result = detectOrphanStoryIds({
        projectCsvStoryIds: new Set<string>(),
        spreadsheetDirListing: ["story-x.csv", "story-x.csv"],
        ignoredIds: new Set<string>(),
      });
      expect(result).toEqual(["story-x"]);
    });
  });

  describe("scanRepoOrphanStoryIds — integration", () => {
    let getRepoTreeSpy: ReturnType<typeof vi.spyOn> & {
      mockResolvedValue: (v: { tree: githubServer.TreeEntry[]; truncated: boolean }) => unknown;
    };
    let getFileContentSpy: ReturnType<typeof vi.spyOn> & {
      mockImplementation: (
        fn: (token: string, owner: string, repo: string, path: string) => Promise<string | null>,
      ) => unknown;
    };

    let pinnedSpies: Array<{ mockRestore: () => void }> = [];

    beforeEach(() => {
      getRepoTreeSpy = vi.spyOn(githubServer, "getRepoTree") as never;
      getFileContentSpy = vi.spyOn(githubServer, "getFileContent") as never;
      // Without a head the scan resolves one and lists the spreadsheets
      // subtree at it; the cases state the repository as a whole tree, so the
      // listing is that tree's spreadsheets entries, relative to the directory.
      const dir = "telar-content/spreadsheets/";
      pinnedSpies = [
        vi.spyOn(githubServer, "getRepoHead").mockResolvedValue("head-sha"),
        vi.spyOn(githubServer, "getSubtreeOids").mockResolvedValue({
          ok: true,
          at: () => ({ kind: "tree", oid: "sheets-oid" }),
        }),
        vi.spyOn(githubServer, "listSubtreeEntries").mockImplementation(async () => {
          const { tree } = await githubServer.getRepoTree("token", "owner", "repo", "head-sha");
          const under = tree.filter((e) => e.type === "blob" && e.path.startsWith(dir));
          return {
            files: new Map(under.map((e) => [e.path.slice(dir.length), e.sha])),
            dirs: new Set<string>(),
          };
        }),
        vi.spyOn(githubServer, "getFileAtRef").mockImplementation(
          strictReadsFromFileContent(githubServer.getFileContent, async () => ({ status: "absent" })) as never,
        ),
      ];
    });

    afterEach(() => {
      (getRepoTreeSpy as { mockRestore: () => void }).mockRestore();
      (getFileContentSpy as { mockRestore: () => void }).mockRestore();
      for (const spy of pinnedSpies) spy.mockRestore();
    });

    it("happy path: listing has 3 stories, project.csv references 2, .compositor-ignored is empty → 1 orphan", async () => {
      getRepoTreeSpy.mockResolvedValue({
        tree: [
          { path: "telar-content/spreadsheets/project.csv", mode: "100644", type: "blob", sha: "p" },
          { path: "telar-content/spreadsheets/story-a.csv", mode: "100644", type: "blob", sha: "a" },
          { path: "telar-content/spreadsheets/story-b.csv", mode: "100644", type: "blob", sha: "b" },
          { path: "telar-content/spreadsheets/story-c.csv", mode: "100644", type: "blob", sha: "c" },
        ],
        truncated: false,
      });
      getFileContentSpy.mockImplementation(async (_t: string, _o: string, _r: string, path: string) => {
        if (path === ".compositor-ignored") return ""; // present but empty
        return null;
      });

      const result = await scanRepoOrphanStoryIds("token", "owner", "repo", new Set(["story-a", "story-b"]));

      expect(result).toEqual(["story-c"]);
    });

    it("suppresses orphans listed in .compositor-ignored", async () => {
      getRepoTreeSpy.mockResolvedValue({
        tree: [
          { path: "telar-content/spreadsheets/project.csv", mode: "100644", type: "blob", sha: "p" },
          { path: "telar-content/spreadsheets/story-a.csv", mode: "100644", type: "blob", sha: "a" },
          { path: "telar-content/spreadsheets/story-b.csv", mode: "100644", type: "blob", sha: "b" },
          { path: "telar-content/spreadsheets/story-c.csv", mode: "100644", type: "blob", sha: "c" },
        ],
        truncated: false,
      });
      getFileContentSpy.mockImplementation(async (_t: string, _o: string, _r: string, path: string) => {
        if (path === ".compositor-ignored") return "story-c\n";
        return null;
      });

      const result = await scanRepoOrphanStoryIds("token", "owner", "repo", new Set(["story-a", "story-b"]));

      expect(result).toEqual([]);
    });

    it("handles missing .compositor-ignored as empty list (no throw)", async () => {
      getRepoTreeSpy.mockResolvedValue({
        tree: [
          { path: "telar-content/spreadsheets/project.csv", mode: "100644", type: "blob", sha: "p" },
          { path: "telar-content/spreadsheets/story-a.csv", mode: "100644", type: "blob", sha: "a" },
          { path: "telar-content/spreadsheets/story-orphan.csv", mode: "100644", type: "blob", sha: "o" },
        ],
        truncated: false,
      });
      // .compositor-ignored returns null (404 from getFileContent)
      getFileContentSpy.mockResolvedValue(null);

      const result = await scanRepoOrphanStoryIds("token", "owner", "repo", new Set(["story-a"]));

      expect(result).toEqual(["story-orphan"]);
    });

    it("returns [] when telar-content/spreadsheets/ contains only registry files", async () => {
      getRepoTreeSpy.mockResolvedValue({
        tree: [
          { path: "telar-content/spreadsheets/project.csv", mode: "100644", type: "blob", sha: "p" },
          { path: "telar-content/spreadsheets/objects.csv", mode: "100644", type: "blob", sha: "o" },
          { path: "telar-content/spreadsheets/glossary.csv", mode: "100644", type: "blob", sha: "g" },
        ],
        truncated: false,
      });
      getFileContentSpy.mockResolvedValue(null);

      const result = await scanRepoOrphanStoryIds("token", "owner", "repo", new Set<string>());

      expect(result).toEqual([]);
    });

    it("ignores nested paths under telar-content/spreadsheets/ — only direct children of the directory count", async () => {
      getRepoTreeSpy.mockResolvedValue({
        tree: [
          { path: "telar-content/spreadsheets/project.csv", mode: "100644", type: "blob", sha: "p" },
          { path: "telar-content/spreadsheets/story-real.csv", mode: "100644", type: "blob", sha: "a" },
          // Nested file — must NOT be treated as an orphan story id
          { path: "telar-content/spreadsheets/archive/story-old.csv", mode: "100644", type: "blob", sha: "x" },
        ],
        truncated: false,
      });
      getFileContentSpy.mockResolvedValue(null);

      const result = await scanRepoOrphanStoryIds("token", "owner", "repo", new Set<string>());

      // story-real is the only direct-child orphan; story-old is in a sub-path and excluded
      expect(result).toEqual(["story-real"]);
    });
  });

  // The orphan restore scans at the head it resolves and reads the ignore
  // list strictly there: read as an empty list, a failed read would
  // restore a story the author chose to ignore.
  describe("scanRepoOrphanStoryIds — pinned to a head", () => {
    // The spreadsheets directory alone, listed as the story check lists a
    // subtree, so an image-heavy tree cannot truncate it; relative paths.
    const SHEETS_LISTING = {
      files: new Map([["project.csv", "p"], ["story-a.csv", "a"], ["story-b.csv", "b"], ["archive/old.csv", "x"]]),
      dirs: new Set(["archive"]),
    };
    const SHEETS_AT = { ok: true as const, at: () => ({ kind: "tree" as const, oid: "sheets-oid" }) };
    let getRepoTreeSpy: ReturnType<typeof vi.spyOn>;
    let getSubtreeOidsSpy: ReturnType<typeof vi.spyOn>;
    let listSubtreeEntriesSpy: ReturnType<typeof vi.spyOn>;
    let getFileAtRefSpy: ReturnType<typeof vi.spyOn>;
    let getFileContentSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // The whole tree is not a source here; answering it keeps the case off
      // the network if it is ever read.
      getRepoTreeSpy = vi.spyOn(githubServer, "getRepoTree").mockRejectedValue(new Error("the whole tree was read"));
      getSubtreeOidsSpy = vi.spyOn(githubServer, "getSubtreeOids").mockResolvedValue(SHEETS_AT);
      listSubtreeEntriesSpy = vi.spyOn(githubServer, "listSubtreeEntries").mockResolvedValue(SHEETS_LISTING);
      getFileAtRefSpy = vi.spyOn(githubServer, "getFileAtRef");
      getFileContentSpy = vi.spyOn(githubServer, "getFileContent").mockResolvedValue(null);
    });

    afterEach(() => {
      for (const spy of [getRepoTreeSpy, getSubtreeOidsSpy, listSubtreeEntriesSpy, getFileAtRefSpy, getFileContentSpy]) {
        spy.mockRestore();
      }
    });

    it("lists the spreadsheets subtree and reads the ignore list at that head, the list strictly", async () => {
      getFileAtRefSpy.mockResolvedValue({ status: "ok", content: "story-b\n" });

      expect(await scanRepoOrphanStoryIds("token", "owner", "repo", new Set(), "head-sha")).toEqual(["story-a"]);
      expect(getSubtreeOidsSpy).toHaveBeenCalledWith("token", "owner", "repo", ["head-sha"], ["telar-content/spreadsheets"]);
      expect(listSubtreeEntriesSpy).toHaveBeenCalledWith("token", "owner", "repo", "sheets-oid");
      expect(getRepoTreeSpy).not.toHaveBeenCalled();
      expect(getFileAtRefSpy).toHaveBeenCalledWith("token", "owner", "repo", ".compositor-ignored", "head-sha", {
        strict: true,
      });
      expect(getFileContentSpy).not.toHaveBeenCalled();
    });

    it("reads a missing ignore list as an empty list", async () => {
      getFileAtRefSpy.mockResolvedValue({ status: "absent" });

      expect(await scanRepoOrphanStoryIds("token", "owner", "repo", new Set(), "head-sha")).toEqual([
        "story-a",
        "story-b",
      ]);
    });

    it("finds no orphans where the head has no spreadsheets directory", async () => {
      getSubtreeOidsSpy.mockResolvedValue({ ok: true, at: () => ({ kind: "absent" }) });
      getFileAtRefSpy.mockResolvedValue({ status: "absent" });

      expect(await scanRepoOrphanStoryIds("token", "owner", "repo", new Set(), "head-sha")).toEqual([]);
    });

    it.each([
      ["the listing cannot be trusted", () => listSubtreeEntriesSpy.mockResolvedValue(null)],
      ["the head does not resolve", () => getSubtreeOidsSpy.mockResolvedValue({ ok: false, reason: "unresolved" })],
      ["the path is not a directory", () => getSubtreeOidsSpy.mockResolvedValue({ ok: true, at: () => ({ kind: "other", type: "Blob" }) })],
    ])("throws a plain error when %s, never a partial list", async (_label, arrange) => {
      arrange();
      getFileAtRefSpy.mockResolvedValue({ status: "absent" });

      const scan = scanRepoOrphanStoryIds("token", "owner", "repo", new Set(), "head-sha");
      await expect(scan).rejects.toThrow(/spreadsheets/);
      await expect(scan).rejects.not.toMatchObject({ name: "SheetUnreadableError" });
    });

    it("refuses a failed read of the ignore list, naming it", async () => {
      getFileAtRefSpy.mockResolvedValue({ status: "error" });

      await expect(scanRepoOrphanStoryIds("token", "owner", "repo", new Set(), "head-sha")).rejects.toMatchObject({
        name: "SheetUnreadableError",
        path: ".compositor-ignored",
      });
    });
  });

  describe("isSafeSiteBase (SSRF guard for live-site probe)", () => {
    it("rejects the cloud metadata link-local address", () => {
      expect(isSafeSiteBase("http://169.254.169.254")).toBe(false);
    });

    it("rejects non-https schemes", () => {
      expect(isSafeSiteBase("http://example.com")).toBe(false);
    });

    it("rejects RFC1918 10.x addresses", () => {
      expect(isSafeSiteBase("https://10.0.0.1")).toBe(false);
    });

    it("rejects localhost", () => {
      expect(isSafeSiteBase("https://localhost")).toBe(false);
    });

    it("rejects IPv4 loopback", () => {
      expect(isSafeSiteBase("https://127.0.0.1")).toBe(false);
    });

    it("rejects 172.16.x (inside the private range)", () => {
      expect(isSafeSiteBase("https://172.16.0.1")).toBe(false);
    });

    it("allows 172.32.x (just outside the private 172.16-31 range)", () => {
      expect(isSafeSiteBase("https://172.32.0.1")).toBe(true);
    });

    it("allows a github.io site", () => {
      expect(isSafeSiteBase("https://owner.github.io")).toBe(true);
    });

    it("allows a custom domain", () => {
      expect(isSafeSiteBase("https://my.custom-domain.org")).toBe(true);
    });

    it("rejects a garbage string", () => {
      expect(isSafeSiteBase("not a url")).toBe(false);
    });
  });

  describe("isSafeObjectId (path-traversal / injection guard)", () => {
    it("accepts a simple object id", () => {
      expect(isSafeObjectId("obj-001")).toBe(true);
    });

    it("accepts dots, underscores, and hyphens", () => {
      expect(isSafeObjectId("a.b_c-1")).toBe(true);
    });

    it("rejects path traversal", () => {
      expect(isSafeObjectId("../etc")).toBe(false);
    });

    it("rejects a slash", () => {
      expect(isSafeObjectId("a/b")).toBe(false);
    });

    it("rejects a space", () => {
      expect(isSafeObjectId("a b")).toBe(false);
    });

    it("rejects a percent-encoded sequence", () => {
      expect(isSafeObjectId("a%2e")).toBe(false);
    });

    it("rejects an empty string", () => {
      expect(isSafeObjectId("")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// A column with no heading
//
// pandas gives a blank header a name of its own making, from the column's
// POSITION in the file it is reading: `Unnamed: <index>`. The published file
// puts custom columns after the five fixed ones, so a blank heading a sheet
// carries at index 3 is read back as `unnamed: 5`, and a column whose identity
// is decided by where it lands is one no import can predict. It is dropped.
// ---------------------------------------------------------------------------

describe("a glossary column with no heading", () => {
  const BLANK_BESIDE_UNNAMED = "term_id,title,definition,,unnamed: 5\nloom,Loom,A device.,lost,kept\n";

  const termsOf = (csv: string) =>
    mapGlossaryCsv(parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE)).map((t) => ({
      term_id: t.term_id as string,
      title: (t.title as string) ?? null,
      definition: (t.definition as string) ?? null,
      related_terms: (t.related_terms as string) ?? null,
      extra_columns: (t.extra_columns as string) ?? null,
    }));

  it("carries no key of its own into the row", () => {
    const rows = parseTelarCsv(BLANK_BESIDE_UNNAMED, undefined, false, GLOSSARY_CANONICAL_SCOPE);
    expect(Object.keys(rows[0])).toEqual(["term_id", "title", "definition", "unnamed: 5"]);
  });

  it("says so once, naming the column, when a row had a value under it", () => {
    const onWarning = vi.fn();
    parseTelarCsv(BLANK_BESIDE_UNNAMED, onWarning, false, GLOSSARY_CANONICAL_SCOPE);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).toEqual({ code: "blank_header", column: 4 });
  });

  it("says nothing about a trailing comma no row has a value under", () => {
    const onWarning = vi.fn();
    parseTelarCsv(
      "term_id,title,definition,\nloom,Loom,A device.,",
      onWarning,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("leaves the author's own unnamed: 5 an ordinary custom column", () => {
    expect(JSON.parse(termsOf(BLANK_BESIDE_UNNAMED)[0].extra_columns as string)).toEqual({
      "unnamed: 5": "kept",
    });
  });

  it("publishes one column per name, and is not blocked", () => {
    const terms = termsOf(BLANK_BESIDE_UNNAMED);
    expect(serializeGlossaryCsv(terms).split("\n")[0]).toBe(
      "term_id,title,definition,related_terms,unnamed: 5",
    );
    const validation = runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "a",
      stories: [],
      steps: [],
      pages: [],
      objects: [],
      glossary: terms,
    });
    expect(validation.blockers.filter((b) => b.code === "glossary_colliding_columns")).toEqual([]);
  });

  // The reverse case: two headings that fold to nothing are two columns to both
  // framework releases, which name them apart. Dropping both is what stops the
  // Compositor refusing a sheet neither release has trouble with.
  it("does not block a sheet whose two blank-folding headings the framework reads apart", () => {
    const terms = termsOf(`term_id,title,definition,,${NEL}\nloom,Loom,A device.,a,b\n`);
    const validation = runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "a",
      stories: [],
      steps: [],
      pages: [],
      objects: [],
      glossary: terms,
    });
    expect(validation.blockers.filter((b) => b.code === "glossary_colliding_columns")).toEqual([]);
    expect(serializeGlossaryCsv(terms).split("\n")[0]).toBe(
      "term_id,title,definition,related_terms",
    );
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the published glossary of a sheet that had a column with no heading",
  () => {
    const atTag = () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG);

    it(
      "is read as one column per name at both releases",
      () => {
        const terms = mapGlossaryCsv(
          parseTelarCsv(
            "term_id,title,definition,,unnamed: 5\nloom,Loom,A device.,lost,kept\n",
            undefined,
            false,
            GLOSSARY_CANONICAL_SCOPE,
          ),
        ).map((t) => ({
          term_id: t.term_id as string,
          title: (t.title as string) ?? null,
          definition: (t.definition as string) ?? null,
          related_terms: (t.related_terms as string) ?? null,
          extra_columns: (t.extra_columns as string) ?? null,
        }));
        const published = serializeGlossaryCsv(terms);
        for (const [release, result] of [
          [PUBLISHED_FRAMEWORK_TAG, frameworkGlossaryColumns(published, true, atTag())],
          ["test instance", frameworkGlossaryColumns(published, false)],
        ] as const) {
          expect(result.error, `${release} refused it`).toBeUndefined();
          expect(result.duplicates, `${release} saw a duplicate`).toEqual([]);
          expect(result.columns, `${release} read another column set`).toEqual([
            "term_id", "title", "definition", "related_terms", "unnamed: 5",
          ]);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// isHeaderRow's two strips
//
// The detector counts populated cells one way and matches them another. A cell
// holding nothing but a code point CPython calls whitespace and JavaScript does
// not is populated to the first and empty to the second, so a bilingual row of
// three names padded with one such cell scores 3/4 and is imported as a term.
// The test instance's `is_header_row` excludes that cell and recognises the
// row; the published tag counts it and reads the row as data. One strip, the
// one every other decision about a header in this module already uses.
// ---------------------------------------------------------------------------

describe("a bilingual row padded with a cell that folds to nothing", () => {
  const padded = (pad: string): Record<string, string> => ({
    "0": "id_término", "1": "titulo", "2": "definición", "3": pad,
  });
  /** The five CPython strips and JavaScript's trim does not, then U+FEFF. */
  const divergent = ["", "", "", "", "", "﻿"];

  it.each(divergent.slice(0, 5))("is a header row when padded with %j", (pad) => {
    expect(isHeaderRow(padded(pad))).toBe(true);
  });

  // The sixth runs the other way: JavaScript's trim removes U+FEFF and
  // CPython's strip keeps it, so a cell holding one is populated and matches no
  // known name — a fourth cell the ratio counts, here and in the framework's
  // own `is_header_row` alike.
  it("is not a header row when padded with U+FEFF", () => {
    expect(isHeaderRow(padded(divergent[5]))).toBe(false);
  });

  it("is skipped rather than imported as a term", () => {
    const rows = parseTelarCsv(
      `term_id,title,definition,note\nid_término,titulo,definición,${NEL}\nloom,Loom,A device.,x`,
      undefined,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].term_id).toBe("loom");
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the framework's is_header_row on a bilingual row padded that way",
  () => {
    const atTag = () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG);
    const cells = ["id_término", "titulo", "definición", NEL];

    it(
      "recognises it on the test instance, whose strip this one follows",
      () => {
        expect(frameworkIsHeaderRow(cells, false)).toBe(true);
        expect(frameworkIsHeaderRow(cells, true)).toBe(true);
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    // The published tag has no such skip: every non-NA cell counts toward the
    // total, so the padded cell drags the ratio to 3/4 and the row is read as a
    // term there. Recorded, not followed — a sheet is imported once and
    // published to whichever release the site is on, and a bilingual row
    // ingested as a term corrupts the data on both.
    it(
      "reads it as data at the published tag, which counts the cell it cannot name",
      () => {
        expect(frameworkIsHeaderRow(cells, false, atTag())).toBe(false);
        expect(frameworkIsHeaderRow(cells, true, atTag())).toBe(false);
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// The text a custom column is kept under
//
// The kept text and the identity are two answers about one header, and they
// have to agree. Stripped with JavaScript's `trim()`, a header ending in
// U+FEFF is kept as the text its neighbour already has while folding to a
// name of its own — so two columns the framework keeps apart are stored as
// one name and a suffix, and the suffix is published as a column neither the
// sheet nor the framework ever had.
// ---------------------------------------------------------------------------

describe("a custom column whose header ends in U+FEFF", () => {
  const BOM = "﻿";
  const csv = `term_id,title,definition,b${BOM},b\nloom,Loom,A device.,first,second`;

  it("is kept under its own text, beside its unadorned twin", () => {
    const rows = parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE);
    expect(Object.keys(rows[0])).toEqual(["term_id", "title", "definition", `b${BOM}`, "b"]);
    expect(rows[0][`b${BOM}`]).toBe("first");
    expect(rows[0].b).toBe("second");
  });

  it("publishes both columns and re-imports under the same keys", () => {
    const stored = mapGlossaryCsv(
      parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE),
    ).map((m) => ({
      term_id: m.term_id as string,
      title: (m.title as string) ?? null,
      definition: (m.definition as string) ?? null,
      related_terms: (m.related_terms as string) ?? null,
      extra_columns: (m.extra_columns as string) ?? null,
    }));
    expect(JSON.parse(stored[0].extra_columns as string)).toEqual({
      [`b${BOM}`]: "first",
      b: "second",
    });
    const published = serializeGlossaryCsv(stored);
    const reread = mapGlossaryCsv(
      parseTelarCsv(published, undefined, false, GLOSSARY_CANONICAL_SCOPE),
    );
    expect(JSON.parse(reread[0].extra_columns as string)).toEqual(
      JSON.parse(stored[0].extra_columns as string),
    );
  });

  // The other five divergent code points run the opposite way: CPython strips
  // them and JavaScript's trim does not, so a stored blob key carrying one at
  // its edge re-imports under the stripped spelling once and matches from then
  // on.
  it("re-imports a key edged with U+0085 under the stripped spelling, once", () => {
    const first = parseTelarCsv(
      `term_id,title,${NEL}note\nloom,Loom,v`,
      undefined,
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    expect(Object.keys(first[0])).toEqual(["term_id", "title", "note"]);
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the published glossary of a sheet headed b+U+FEFF beside b",
  () => {
    const atTag = () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG);
    const BOM = "﻿";

    it(
      "is two columns at both releases, as the sheet was",
      () => {
        const csv = `term_id,title,definition,b${BOM},b\nloom,Loom,A device.,first,second\n`;
        for (const [release, result] of [
          [PUBLISHED_FRAMEWORK_TAG, frameworkGlossaryColumns(csv, true, atTag())],
          ["test instance", frameworkGlossaryColumns(csv, false)],
        ] as const) {
          expect(result.error, `${release} refused it`).toBeUndefined();
          expect(result.duplicates, `${release} saw a duplicate`).toEqual([]);
          expect(result.columns, `${release} read another column set`).toEqual([
            "term_id", "title", "definition", `b${BOM}`, "b",
          ]);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// Two objects columns the framework reads as one
//
// The same failure the glossary check names, on the sheet that carries most of
// a site's content. `Nota` beside `nota` is two custom columns to this parse —
// no table renames either — and one column to the framework, which folds a
// header before it decides what claims a name.
// ---------------------------------------------------------------------------

describe("an objects sheet headed Nota beside nota", () => {
  const CSV = "object_id,title,Nota,nota\nobj-1,Un objeto,primera,segunda";

  const mappedWith = (csv: string, onWarning?: (issue: SheetIssue) => void) =>
    mapObjectsCsv(
      parseTelarCsv(csv, onWarning, false, OBJECTS_CANONICAL_SCOPE),
      1,
      onWarning,
    );

  it("keeps both columns and says so at import", () => {
    const onWarning = vi.fn();
    const mapped = mappedWith(CSV, onWarning);
    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({
      Nota: "primera",
      nota: "segunda",
    });
    const named = onWarning.mock.calls
      .map((c) => c[0] as SheetIssue)
      .filter((issue) => issue.code === "folded_columns");
    expect(named).toEqual([{ code: "folded_columns", groups: [["Nota", "nota"]] }]);
  });

  it("is blocked at publish, once for the file", () => {
    const mapped = mappedWith(CSV);
    const blockers = runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "a",
      stories: [],
      steps: [],
      pages: [],
      glossary: [],
      objects: mapped.map((m) => ({
        object_id: m.object_id as string,
        title: (m.title as string) ?? null,
        extra_columns: (m.extra_columns as string) ?? null,
      })),
    }).blockers.filter((b) => b.code === "objects_colliding_columns");
    expect(blockers).toHaveLength(1);
    expect(blockers[0].params?.columns).toBe('"Nota", "nota"');
  });
});

describe("an objects sheet headed medium beside medium_genre", () => {
  it("is collapsed by the parse, so nothing reaches the publish check", () => {
    const onWarning = vi.fn();
    const mapped = mapObjectsCsv(
      parseTelarCsv(
        "object_id,title,medium,medium_genre\nobj-1,Un objeto,first,second",
        onWarning,
        false,
        OBJECTS_CANONICAL_SCOPE,
      ),
      1,
      onWarning,
    );
    expect(onWarning.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ code: "column_collision_last", name: "medium_genre" }),
    );
    expect(mapped[0].object_type).toBe("second");
    expect(mapped[0].extra_columns).toBeUndefined();

    const blockers = runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "a",
      stories: [],
      steps: [],
      pages: [],
      glossary: [],
      objects: mapped.map((m) => ({
        object_id: m.object_id as string,
        title: (m.title as string) ?? null,
        extra_columns: (m.extra_columns as string) ?? null,
      })),
    }).blockers.filter((b) => b.code === "objects_colliding_columns");
    expect(blockers).toEqual([]);
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the objects.csv a Nota-beside-nota sheet would publish",
  () => {
    const published = () =>
      serializeObjectsCsv(
        mapObjectsCsv(
          parseTelarCsv(
            "object_id,title,Nota,nota\nobj-1,Un objeto,primera,segunda",
            undefined,
            false,
            OBJECTS_CANONICAL_SCOPE,
          ),
          1,
        ).map((m) => ({
          object_id: m.object_id as string,
          title: (m.title as string) ?? null,
          featured: null,
          creator: null,
          description: null,
          source_url: null,
          period: null,
          year: null,
          medium_genre: null,
          subjects: null,
          source: null,
          credit: null,
          thumbnail: null,
          alt_text: (m.alt_text as string) ?? null,
          dimensions: null,
          extra_columns: (m.extra_columns as string) ?? null,
        })),
      );

    it(
      "is refused by the test instance, which is why the publish is blocked",
      () => {
        // Through every step `telar.core.csv_to_json` takes before the
        // rename, not `normalize_column_names` alone: the reader drops comment
        // rows and instruction columns first, so a pair it deletes never
        // reaches the refusal and a test on the primitive would not see that.
        expect(frameworkObjectsRead(published(), FRAMEWORK_SCRIPTS_DIR).error)
          .toBe("ColumnCollisionError");
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    // The published tag renames a header only when its folded spelling is in
    // the table, and keeps the author's own spelling otherwise — so it reads
    // these as two columns and builds. The blocker is for the release the sites
    // are moving to, not the one they are on.
    it(
      "is read as two columns at the published tag",
      () => {
        const read = frameworkObjectsRead(published(), frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG));
        expect(read.error).toBeUndefined();
        expect(read.columns?.slice(-2)).toEqual(["Nota", "nota"]);
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// ---------------------------------------------------------------------------
// The per-sheet scope the objects prediction is made under
// ---------------------------------------------------------------------------

describeWithFramework("FRAMEWORK_OBJECT_FIELDS vs the framework's OBJECT_FIELDS", () => {
  it(
    "holds the same names, read out of the framework's own module",
    () => {
      expect([...FRAMEWORK_OBJECT_FIELDS].sort()).toEqual(readFrameworkObjectFields());
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

/** One objects row through the parse, the mapper and the publish check. */
function objectsSheet(csv: string) {
  const onWarning = vi.fn();
  const mapped = mapObjectsCsv(
    parseTelarCsv(csv, onWarning, false, OBJECTS_CANONICAL_SCOPE),
    1,
    onWarning,
  );
  const blockers = runPrePublishValidation({
    headSha: "a",
    currentRepoHead: "a",
    stories: [],
    steps: [],
    pages: [],
    glossary: [],
    objects: mapped.map((m) => ({
      object_id: m.object_id as string,
      title: (m.title as string) ?? null,
      extra_columns: (m.extra_columns as string) ?? null,
    })),
  }).blockers.filter((b) => b.code === "objects_colliding_columns");
  return { mapped, blockers, warnings: onWarning.mock.calls.map((c) => c[0] as SheetIssue) };
}

describe("an objects sheet headed step beside paso", () => {
  it("keeps both columns, warns about neither and blocks nothing", () => {
    const sheet = objectsSheet("object_id,title,step,paso\nobj-1,Un objeto,a,b\n");
    expect(JSON.parse(sheet.mapped[0].extra_columns as string)).toEqual({ step: "a", paso: "b" });
    expect(sheet.warnings.map((w) => w.code)).not.toContain("folded_columns");
    expect(sheet.blockers).toEqual([]);
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the objects.csv a step-beside-paso sheet publishes",
  () => {
    const published = () =>
      serializeObjectsCsv(
        objectsSheet("object_id,title,step,paso\nobj-1,Un objeto,a,b\n").mapped.map((m) => ({
          object_id: m.object_id as string,
          title: (m.title as string) ?? null,
          featured: null,
          creator: null,
          description: null,
          source_url: null,
          period: null,
          year: null,
          medium_genre: null,
          subjects: null,
          source: null,
          credit: null,
          thumbnail: null,
          alt_text: (m.alt_text as string) ?? null,
          dimensions: null,
          extra_columns: (m.extra_columns as string) ?? null,
        })),
      );

    // `paso` renames onto `step`, which OBJECT_FIELDS does not carry, so the
    // scoped call leaves both headers alone and the sheet builds.
    it(
      "builds on the test instance with both columns",
      () => {
        const read = frameworkObjectsRead(published(), FRAMEWORK_SCRIPTS_DIR);
        expect(read.error).toBeUndefined();
        expect(read.columns?.slice(-2)).toEqual(["paso", "step"]);
      },
      FRAMEWORK_TIMEOUT_MS,
    );

    // The published tag scopes nothing: it renames `paso` to `step` on any
    // sheet and holds two columns of one name.
    it(
      "is read as two columns of one name at the published tag",
      () => {
        const read = frameworkObjectsRead(published(), frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG));
        expect(read.error).toBeUndefined();
        expect(read.columns?.filter((c) => c === "step")).toHaveLength(2);
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

// `credit` IS in OBJECT_FIELDS, so the scope does not spare this pair: the
// framework's objects reader renames the Spanish spelling onto `credit` and
// `_refuse_colliding_renames` fires. Both spellings declare the Compositor's
// own `credit` too, so the parse resolves them before the prediction sees them
// — which is why the published file carries one column and no blocker.
describe("an objects sheet headed credit beside its Spanish spelling", () => {
  it("is collapsed by the parse, so nothing reaches the publish check", () => {
    const sheet = objectsSheet("object_id,title,credit,crédito\nobj-1,Un objeto,a,b\n");
    expect(sheet.warnings).toContainEqual(
      expect.objectContaining({ code: "column_collision_last", name: "credit" }),
    );
    expect(sheet.mapped[0].credit).toBe("b");
    expect(sheet.mapped[0].extra_columns).toBeUndefined();
    expect(sheet.blockers).toEqual([]);
  });
});

describeWithFramework("an objects sheet headed credit beside its Spanish spelling", () => {
  it(
    "is refused by the test instance if it reaches it uncollapsed",
    () => {
      const csv = "object_id,title,credit,crédito\nobj-1,Un objeto,a,b\n";
      expect(frameworkObjectsRead(csv, FRAMEWORK_SCRIPTS_DIR).error).toBe("ColumnCollisionError");
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Instruction columns, which the objects reader removes before it renames
// ---------------------------------------------------------------------------

describe("an objects sheet headed #Note beside #note", () => {
  it("is not warned about at import and not blocked at publish", () => {
    const sheet = objectsSheet("object_id,title,#Note,#note\nobj-1,Un objeto,a,b\n");
    expect(JSON.parse(sheet.mapped[0].extra_columns as string)).toEqual({
      "#Note": "a",
      "#note": "b",
    });
    expect(sheet.warnings.map((w) => w.code)).not.toContain("folded_columns");
    expect(sheet.blockers).toEqual([]);
  });
});

describeWithFramework("the objects.csv a #Note-beside-#note sheet publishes", () => {
  it(
    "builds on the test instance, which removes both columns",
    () => {
      const read = frameworkObjectsRead(
        serializeObjectsCsv(
          objectsSheet("object_id,title,#Note,#note\nobj-1,Un objeto,a,b\n").mapped.map((m) => ({
            object_id: m.object_id as string,
            title: (m.title as string) ?? null,
            featured: null,
            creator: null,
            description: null,
            source_url: null,
            period: null,
            year: null,
            medium_genre: null,
            subjects: null,
            source: null,
            credit: null,
            thumbnail: null,
            alt_text: (m.alt_text as string) ?? null,
            dimensions: null,
            extra_columns: (m.extra_columns as string) ?? null,
          })),
        ),
        FRAMEWORK_SCRIPTS_DIR,
      );
      expect(read.error).toBeUndefined();
      expect(read.columns?.filter((c) => c.startsWith("#"))).toEqual([]);
      expect(read.ids).toEqual(["obj-1"]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

// The rule is `col.startswith('#')` on the header as pandas holds it — no
// strip, no fold — so a leading space takes a column out of the removal and
// leaves it in the prediction.
describe("an objects header opening with a space before its #", () => {
  it("is still predicted on, and its unspaced twin is not", () => {
    expect(
      collidingHeaderGroups(["object_id", " #Note", " #note"], FRAMEWORK_OBJECTS_READER),
    ).toEqual([[" #Note", " #note"]]);
    expect(
      collidingHeaderGroups(["object_id", " #Note", "#Note"], FRAMEWORK_OBJECTS_READER),
    ).toEqual([]);
  });
});

describe("a glossary sheet headed #Note beside #note", () => {
  it("is not predicted on, because the head removes instruction columns before it renames", () => {
    expect(collidingHeaderGroups(["term_id", "title", "definition", "#Note", "#note"], FRAMEWORK_GLOSSARY_READER))
      .toEqual([]);
  });

  it("raises no folded_columns warning at import", () => {
    const warnings: SheetIssue[] = [];
    mapGlossaryCsv([{ term_id: "loom", title: "Loom", definition: "A device.", "#Note": "a", "#note": "b" }], (w) => warnings.push(w));
    expect(warnings.map((w) => w.code)).not.toContain("folded_columns");
  });

  it("is predicted on for a pair that is not instruction columns", () => {
    expect(collidingHeaderGroups(["term_id", "title", "Note", "note"], FRAMEWORK_GLOSSARY_READER))
      .toEqual([["Note", "note"]]);
  });
});

describe("27: importedHeader read as project.csv's", () => {
  const table = [
    ["order", "story_id", "title", "privada", "protected"],
    ["1", "s1", "T1", "", "yes"],
  ];

  it("names every protection position and the one that decides `private`", () => {
    const header = importedHeader(table, PROJECT_CANONICAL_SCOPE, true);
    expect([...header.privateColumnIndexes]).toEqual([3, 4]);
    expect(header.protectionColumnIndex).toBe(4);
    expect(header.finalNames[3]).toBeUndefined();
    expect(header.finalNames[4]).toBeUndefined();
  });

  it("reads the same table as custom columns when it is not read as project.csv's", () => {
    const header = importedHeader(table, PROJECT_CANONICAL_SCOPE);
    expect(header.privateColumnIndexes.size).toBe(0);
    expect(header.protectionColumnIndex).toBeUndefined();
    expect(header.finalNames.slice(3)).toEqual(["privada", "protected"]);
  });
});

describe("28: a glossary sheet headed kind beside tipo", () => {
  const headers = ["term_id", "kind", "tipo"];

  it("is one group under the glossary's own aliases and none under the shared table", () => {
    expect(collidingHeaderGroups(headers, FRAMEWORK_GLOSSARY_READER, FRAMEWORK_GLOSSARY_COLUMN_RENAMES)).toEqual([
      ["kind", "tipo"],
    ]);
    expect(collidingHeaderGroups(headers, FRAMEWORK_GLOSSARY_READER, FRAMEWORK_COLUMN_RENAMES)).toEqual([]);
  });
});

describeWithFramework("the glossary.csv a #Note-beside-#note sheet publishes", () => {
  it(
    "is read by the test instance, which removes instruction columns before it renames",
    () => {
      const csv = "term_id,title,definition,#Note,#note\nloom,Loom,A device.,a,b\n";
      expect(frameworkGlossaryColumns(csv, false).error).toBeUndefined();
      expect(frameworkGlossaryColumns(csv, false).columns).toEqual(["term_id", "title", "definition"]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The cells a row is CLASSIFIED on
//
// Classification runs on CPython's strip, the strip the framework classifies
// with: it does not remove U+FEFF and JavaScript's `trim()` does, so a cell
// holding nothing but the mark is a populated cell to the framework's
// `is_header_row` and an empty one to a trimmed count. A bilingual row of
// three names padded with one scores 3/4 under the framework's strip and 3/3
// under `trim()` — read as data on one side and deleted on the other.
// ---------------------------------------------------------------------------

describe("a bilingual row padded with a cell holding only U+FEFF", () => {
  const BOM = "﻿";
  const cells = ["id_término", "título", "definición", BOM];
  const csv = `term_id,title,definition,note\n${cells.join(",")}\n`;

  it("is imported as a term rather than discarded as a header row", () => {
    const rows = parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].term_id).toBe("id_término");
    // Storage strips what classification strips, so the mark the framework
    // reads in that cell is the mark the row is stored with.
    expect(rows[0].note).toBe(BOM);
  });

  it("is classified the same way by the direct call", () => {
    const row: Record<string, string> = {};
    cells.forEach((cell, i) => { row[String(i)] = cell; });
    expect(isHeaderRow(row)).toBe(false);
  });

  describeWithFrameworkTag(PUBLISHED_FRAMEWORK_TAG, "against the framework", () => {
    it(
      "is data to is_header_row at both releases",
      () => {
        const tag = frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG);
        for (const emptyAsNaN of [true, false]) {
          expect(frameworkIsHeaderRow(cells, emptyAsNaN), "test instance").toBe(false);
          expect(frameworkIsHeaderRow(cells, emptyAsNaN, tag), "published tag").toBe(false);
        }
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// Instruction columns — kept, and the author told the framework will drop them
// ---------------------------------------------------------------------------

describe("a populated column headed with #", () => {
  /** Every warning naming an instruction column, from one call. */
  function instructionWarnings(map: (onWarning: (issue: SheetIssue) => void) => void): SheetIssue[] {
    const onWarning = vi.fn();
    map(onWarning);
    return onWarning.mock.calls
      .map((c) => c[0] as SheetIssue)
      .filter((issue) => issue.code === "instruction_column");
  }

  it("warns once on an objects sheet, naming the column", () => {
    const warnings = instructionWarnings((w) =>
      mapObjectsCsv(
        parseTelarCsv("object_id,title,#Note\nobj-1,A,keep me\nobj-2,B,and me", w, false, OBJECTS_CANONICAL_SCOPE),
        1,
        w,
      ),
    );

    expect(warnings).toEqual([{ code: "instruction_column", columns: ["#Note"] }]);
  });

  it("warns once on a glossary sheet, naming the column", () => {
    const warnings = instructionWarnings((w) =>
      mapGlossaryCsv(parseTelarCsv("term_id,title,#Nota\nloom,Loom,anotar", undefined, false, GLOSSARY_CANONICAL_SCOPE), w),
    );

    expect(warnings).toEqual([{ code: "instruction_column", columns: ["#Nota"] }]);
  });

  it("says nothing about a column no row fills", () => {
    const warnings = instructionWarnings((w) =>
      mapObjectsCsv(
        parseTelarCsv("object_id,title,#Note\nobj-1,A,", w, false, OBJECTS_CANONICAL_SCOPE),
        1,
        w,
      ),
    );

    expect(warnings).toEqual([]);
  });

  it("says nothing about an ordinary custom column", () => {
    const warnings = instructionWarnings((w) =>
      mapObjectsCsv(
        parseTelarCsv("object_id,title,Note\nobj-1,A,keep me", w, false, OBJECTS_CANONICAL_SCOPE),
        1,
        w,
      ),
    );

    expect(warnings).toEqual([]);
  });

  it("keeps the column — the warning is notice, not a drop", () => {
    const mapped = mapObjectsCsv(
      parseTelarCsv("object_id,title,#Note\nobj-1,A,keep me", undefined, false, OBJECTS_CANONICAL_SCOPE),
      1,
    );

    expect(JSON.parse(mapped[0].extra_columns as string)).toEqual({ "#Note": "keep me" });
  });
});

// ---------------------------------------------------------------------------
// A comment row is one the framework's row rule drops
//
// `telar.core.csv_to_json` skips a ROW whose FIRST cell, Python-stripped, opens
// `#` (scripts/telar/core.py:94 on the test instance, :90 at the published tag,
// the same line at both). CPython's strip and JavaScript's `trim()` disagree
// over exactly two kinds of code point, and each disagreement is a row one side
// turns into an object and the other does not: a marker behind U+FEFF is data
// to the framework and a comment here, so the site carries a phantom object
// whose id is the mark; a marker behind U+0085 is a comment there and data
// here, so the Compositor holds an object the site never builds.
// ---------------------------------------------------------------------------

/** The two code points CPython's strip and JavaScript's `trim()` disagree over. */
/**
 * The byte-order mark, which CPython's strip leaves and JavaScript's `trim()`
 * removes. `NEL` above is the same disagreement the other way round.
 *
 * An escape, not the character: it is invisible in a source file, and a tool
 * that tidied a stray one away would leave these fixtures testing a plain `#`
 * row and passing on a rule neither release holds.
 */
const MARK = "\uFEFF";

/** One objects.csv whose single comment candidate opens with `marker`. */
const objectsWithMarker = (marker: string) => `object_id,title\n${marker}#note,X\na,A\n`;

/** The same sheet with the `#` in the SECOND cell instead of the first. */
const OBJECTS_WITH_LATE_MARKER = "object_id,title\nx,#note\na,A\n";

/** The same candidate on a glossary sheet, above one term. */
const glossaryWithMarker = (marker: string) => `term_id,title\n${marker}#note,A note\nloom,Loom\n`;

describe("isCommentCell mirrors the framework's row rule", () => {
  it("keeps a row whose marker is behind U+FEFF, which CPython's strip leaves", () => {
    const rows = parseTelarCsv(objectsWithMarker(MARK), undefined, false, OBJECTS_CANONICAL_SCOPE);

    // Two rows: the candidate is data here as it is data there, and the id is
    // the cell the framework reads, mark and all. Stored with the mark taken
    // off, the row publishes as `#note,X`, which both framework releases drop
    // as a comment — the object gone from the site and from the next import.
    expect(rows.map((r) => r.object_id)).toEqual([`${MARK}#note`, "a"]);
  });

  it("stores a cell edged with U+0085, which CPython's strip removes, stripped", () => {
    const rows = parseTelarCsv(
      `object_id,title\na,X${NEL}\n`,
      undefined,
      false,
      OBJECTS_CANONICAL_SCOPE,
    );

    expect(rows.map((r) => r.title)).toEqual(["X"]);
  });

  it("drops a row whose marker is behind U+0085, which CPython's strip removes", () => {
    const rows = parseTelarCsv(objectsWithMarker(NEL), undefined, false, OBJECTS_CANONICAL_SCOPE);

    expect(rows.map((r) => r.object_id)).toEqual(["a"]);
  });

  it("keeps a row whose `#` sits in a cell other than the first", () => {
    // `core.py` tests the FIRST column alone, so `x,#note` is the object `x`
    // to both framework releases. Dropped here as a comment, the object the
    // Compositor never shows is republished verbatim above the data on every
    // publish, and the site builds it every time.
    const rows = parseTelarCsv(
      OBJECTS_WITH_LATE_MARKER,
      undefined,
      false,
      OBJECTS_CANONICAL_SCOPE,
    );

    expect(rows.map((r) => r.object_id)).toEqual(["x", "a"]);
    expect(rows.map((r) => r.title)).toEqual(["#note", "A"]);
  });

  it("drops a row whose marker is behind spaces, as both strips always have", () => {
    const rows = parseTelarCsv(objectsWithMarker("  "), undefined, false, OBJECTS_CANONICAL_SCOPE);

    expect(rows.map((r) => r.object_id)).toEqual(["a"]);
  });

  it("leaves the label-row detector alone, which folds on its own strip", () => {
    const labelRow = (pad: string) =>
      `object_id,title,description,credit\nid_objeto,titulo,descripcion,${pad}\nobj-1,A,,\n`;
    const ids = (pad: string) =>
      parseTelarCsv(labelRow(pad), undefined, false, OBJECTS_CANONICAL_SCOPE).map(
        (r) => r.object_id,
      );

    expect(isHeaderRow({ 0: "id_objeto", 1: "titulo", 2: "descripcion", 3: MARK })).toBe(false);
    expect(isHeaderRow({ 0: "id_objeto", 1: "titulo", 2: "descripcion", 3: NEL })).toBe(true);
    expect(ids(MARK)).toEqual(["id_objeto", "obj-1"]);
    expect(ids(NEL)).toEqual(["obj-1"]);
  });
});

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the rows each framework release turns into objects and glossary pages",
  () => {
    for (const [release, scripts, foldFirst] of [
      ["the test instance", () => FRAMEWORK_SCRIPTS_DIR, false],
      ["the published tag", () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG), true],
    ] as const) {
      it(
        `keeps a U+FEFF marker as an object and drops a U+0085 one on ${release}`,
        () => {
          expect(frameworkObjectsRead(objectsWithMarker(MARK), scripts()).ids).toEqual([
            `${MARK}#note`,
            "a",
          ]);
          expect(frameworkObjectsRead(objectsWithMarker(NEL), scripts()).ids).toEqual(["a"]);
          expect(frameworkObjectsRead(objectsWithMarker("  "), scripts()).ids).toEqual(["a"]);
        },
        FRAMEWORK_TIMEOUT_MS,
      );

      // `core.py` filters on `df[first_col]` alone — :94 on the test instance,
      // :90 at the published tag — so a `#` in any later cell is ordinary
      // content and the row is an object.
      it(
        `builds an object out of a row whose \`#\` is not in the first cell on ${release}`,
        () => {
          expect(frameworkObjectsRead(OBJECTS_WITH_LATE_MARKER, scripts()).ids).toEqual(["x", "a"]);
          expect(frameworkObjectsRead(objectsWithMarker(""), scripts()).ids).toEqual(["a"]);
        },
        FRAMEWORK_TIMEOUT_MS,
      );

      // The page generator strips the term before it tests the marker
      // (`term_id = str(row.get('term_id','')).strip()` at
      // generate_collections.py:338 on the test instance, :291 at the tag; the
      // test at :348 and :300), so U+0085 and a space take the row out of the
      // site and U+FEFF leaves a page behind. The link map tests nothing
      // (telar/glossary.py:83-87 at both) and holds every row with both cells.
      it(
        `writes a page for a U+FEFF marker and none for a U+0085 one on ${release}`,
        () => {
          const mark = frameworkGlossaryTerms(glossaryWithMarker(MARK), foldFirst, scripts());
          expect(mark.pages).toEqual([`${MARK}#note`, "loom"]);
          expect(mark.linkMap).toEqual([`${MARK}#note`, "loom"]);

          const nel = frameworkGlossaryTerms(glossaryWithMarker(NEL), foldFirst, scripts());
          expect(nel.pages).toEqual(["loom"]);
          expect(nel.linkMap).toEqual(["#note", "loom"]);

          const plain = frameworkGlossaryTerms(glossaryWithMarker(""), foldFirst, scripts());
          expect(plain.pages).toEqual(["loom"]);
          expect(plain.linkMap).toEqual(["#note", "loom"]);
        },
        FRAMEWORK_TIMEOUT_MS,
      );

      it(
        `imports as many objects as ${release} builds`,
        () => {
          for (const marker of [MARK, NEL, "  ", ""]) {
            const csv = objectsWithMarker(marker);
            const here = parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE).length;
            const there = (frameworkObjectsRead(csv, scripts()).ids as string[]).length;
            expect([JSON.stringify(marker), here]).toEqual([JSON.stringify(marker), there]);
          }
        },
        FRAMEWORK_TIMEOUT_MS,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Two spellings of one column, through each sheet's own reader
//
// Every sheet resolves its header in `parseTelarCsv` under its own scope, so
// the collision rule reaches each mapper the same way: the spelling that
// holds values keeps the field.
// ---------------------------------------------------------------------------

describe("two spellings of one modelled column, through each sheet's reader", () => {
  it("a story sheet keeps the question column that holds values", () => {
    const warnings: SheetIssue[] = [];
    const rows = parseTelarCsv(
      "step,object,x,y,zoom,question,pregunta,answer\n" +
        "1,obj-001,0.5,0.5,1,,What is shown here?,An answer\n" +
        "2,obj-001,0.4,0.4,2,,Where was it made?,Another answer\n",
      (issue) => warnings.push(issue),
      false,
      STORY_CANONICAL_SCOPE,
    );
    const { steps } = mapStoryCsv(rows, 7);
    expect(steps.map((s) => s.question)).toEqual(["What is shown here?", "Where was it made?"]);
    expect(steps.every((s) => s.extra_columns === "{}")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "column_collision_only_filled",
      headers: ["question", "pregunta"],
      kept: "pregunta",
      column: 7,
    });
  });

  it("the glossary keeps the definition column that holds values", () => {
    const warnings: SheetIssue[] = [];
    const rows = parseTelarCsv(
      "term_id,title,definición,definition\nloom,Loom,A frame for weaving.,\nwarp,Warp,,\n",
      (issue) => warnings.push(issue),
      false,
      GLOSSARY_CANONICAL_SCOPE,
    );
    const mapped = mapGlossaryCsv(rows);
    expect(mapped.map((m) => m.definition)).toEqual(["A frame for weaving.", undefined]);
    expect(mapped.every((m) => m.extra_columns === undefined)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", kept: "definición", column: 3 });
  });

  it("the project sheet keeps the subtitle column that holds values", () => {
    const warnings: SheetIssue[] = [];
    const rows = parseTelarCsv(
      "order,story_id,title,subtitle,subtítulo\n1,story-one,First,,A subtitle\n2,story-two,Second,,\n",
      (issue) => warnings.push(issue),
      true,
      PROJECT_CANONICAL_SCOPE,
    );
    const mapped = mapProjectCsv(rows);
    expect(mapped.map((m) => m.subtitle)).toEqual(["A subtitle", undefined]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "column_collision_only_filled", kept: "subtítulo", column: 5 });
  });

  it("the project sheet keeps the canonical spelling, silently, when neither holds values", () => {
    const warnings: SheetIssue[] = [];
    const rows = parseTelarCsv(
      "order,story_id,subtítulo,title,subtitle\n1,story-one,,First,\n",
      (issue) => warnings.push(issue),
      true,
      PROJECT_CANONICAL_SCOPE,
    );
    expect(Object.keys(rows[0])).toEqual(["order", "story_id", "title", "subtitle"]);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The first import refuses a sheet whose colliding columns both hold values
//
// Nothing has been written at that point and the author is on onboarding, so
// the import stops and names the sheet, the field and the headers. A sync
// refuses the same sheets (see sync-colliding-columns.test.ts).
// ---------------------------------------------------------------------------

describe("importRepo — two colliding columns that both hold values", () => {
  const originalFetch = globalThis.fetch;

  function base64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    return btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(""));
  }

  function ok(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  /** Serves `_config.yml` plus `files` (repo path → text); every other path 404s. */
  function serveRepo(files: Record<string, string>, config = readFixture("config.yml"), truncated = false) {
    const all: Record<string, string> = { "_config.yml": config, ...files };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/git/trees")) return ok({ tree: [], truncated });
      // The orphan scan's listing: the head resolves and has no spreadsheets directory.
      if (url.endsWith("/graphql") && String(init?.body ?? "").includes("SubtreeOids")) {
        return ok({ data: { repository: { c0: { __typename: "Commit" }, c0p0: null } } });
      }
      // The default branch, main, and the head every read is pinned to.
      if (url.endsWith("/graphql")) return ok({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "head-sha" } } } } });
      for (const [path, text] of Object.entries(all)) {
        if (url.includes(`/contents/${path}`)) return ok({ content: base64(text), encoding: "base64", size: Buffer.byteLength(text, "utf8") });
      }
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  async function refusal(): Promise<CollidingColumnsRefusal> {
    const { importRepo } = await import("~/lib/import.server");
    const outcome = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(CollidingColumnsRefusal);
    // Refused before the project row exists: nothing was written.
    expect(importDb.inserts).toEqual([]);
    return outcome as CollidingColumnsRefusal;
  }

  const SHEETS = "telar-content/spreadsheets";

  beforeEach(() => {
    importDb = makeDbMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("refuses the objects sheet, naming medium and object_type", async () => {
    serveRepo({
      [`${SHEETS}/objects.csv`]: "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n",
    });
    const err = await refusal();
    expect(err.sheet).toBe("objects.csv");
    expect(err.canonicalName).toBe("medium_genre");
    expect(err.headers).toEqual(["medium", "object_type"]);
  });

  it("refuses the objects sheet with title beside a spaced title, both filled", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: "object_id,title, title \nobj-001,First,Second\n" });
    const err = await refusal();
    expect(err.sheet).toBe("objects.csv");
    expect(err.headers).toEqual(["title", "title"]);
  });

  it("refuses the project sheet, naming subtitle and subtítulo", async () => {
    serveRepo({
      [`${SHEETS}/project.csv`]: "order,story_id,title,subtitle,subtítulo\n1,story-one,First,One,Uno\n",
    });
    const err = await refusal();
    expect(err.sheet).toBe("project.csv");
    expect(err.canonicalName).toBe("subtitle");
    expect(err.headers).toEqual(["subtitle", "subtítulo"]);
  });

  it("refuses a story sheet, naming question and pregunta", async () => {
    serveRepo({
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]:
        "step,object,x,y,zoom,question,pregunta,answer\n1,obj-001,0.5,0.5,1,What?,¿Qué?,An answer\n",
    });
    const err = await refusal();
    expect(err.sheet).toBe("story-one.csv");
    expect(err.canonicalName).toBe("question");
    expect(err.headers).toEqual(["question", "pregunta"]);
  });

  it("refuses the glossary, naming definition and definición", async () => {
    serveRepo({
      [`${SHEETS}/glossary.csv`]: "term_id,title,definition,definición\nloom,Loom,A frame.,Un marco.\n",
    });
    const err = await refusal();
    expect(err.sheet).toBe("glossary.csv");
    expect(err.canonicalName).toBe("definition");
    expect(err.headers).toEqual(["definition", "definición"]);
  });

  // The Sheets branch reads every failure inside its loop as a Sheet it could
  // not reach; a refusal has to get past that and name the tab.
  it("refuses a Google Sheets tab, naming the tab rather than reporting the Sheet unreachable", async () => {
    const sheetsModule = await import("~/lib/sheets.server");
    serveRepo(
      {},
      readFixture("config.yml").replace(
        'enabled: false\n  published_url: ""',
        'enabled: true\n  published_url: "https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pubhtml"',
      ),
    );
    vi.spyOn(sheetsModule, "discoverSheetTabs").mockResolvedValue([{ name: "objects", gid: "10" }]);
    vi.spyOn(sheetsModule, "fetchSheetCsv").mockResolvedValue(
      "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n",
    );
    const err = await refusal();
    expect(err.sheet).toBe("objects");
    expect(err.headers).toEqual(["medium", "object_type"]);
  });

  it("still imports a sheet whose colliding columns have values in only one", async () => {
    const { importRepo } = await import("~/lib/import.server");
    serveRepo({
      [`${SHEETS}/objects.csv`]: "object_id,title,medium,object_type\nobj-001,First,Oil,\n",
    });
    const result = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });
    expect(result.valid).toBe(true);
    expect(result.objects.warnings).toContainEqual(
      expect.objectContaining({
        code: "column_collision_only_filled",
        sheet: "objects.csv",
        kept: "medium",
        column: 3,
      }),
    );
  });

  it("names the story sheet on each warning its steps raise", async () => {
    const { importRepo } = await import("~/lib/import.server");
    serveRepo({
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]: "step,object,x,question\n1,obj-001,abc,Q\n2,obj-001,0.5,Q,surplus\n",
    });
    const result = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });
    expect(result.objects.warnings).toEqual([
      { code: "ragged_row", row: { label: "2" }, sheet: "story-one.csv" },
      { code: "coordinate_invalid", step: 1, column: "x", value: "abc", sheet: "story-one.csv" },
    ]);
  });

  it("reports a truncated tree as the one warning that names no sheet", async () => {
    const { importRepo } = await import("~/lib/import.server");
    serveRepo({}, readFixture("config.yml"), true);
    const result = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });
    expect(result.objects.warnings).toEqual([{ code: "tree_truncated" }]);
  });

  // What the review step lists: a site the Compositor published has a Spanish
  // header row in every sheet, and none of them is a warning.
  it("reports nothing for a published site's bilingual rows", async () => {
    const { importRepo } = await import("~/lib/import.server");
    serveRepo({
      [`${SHEETS}/objects.csv`]: serializeObjectsCsv([
        {
          object_id: "obj-001", title: "First", featured: null, creator: null, description: null,
          source_url: null, period: null, year: null, medium_genre: null, subjects: null, source: null,
          credit: null, thumbnail: null, alt_text: null, dimensions: null, extra_columns: null,
        },
      ]),
      [`${SHEETS}/project.csv`]: serializeProjectCsv([
        { story_id: "story-one", title: "First", subtitle: null, byline: null, order: 1, private: false, draft: false, show_sections: false },
      ]),
      [`${SHEETS}/glossary.csv`]: serializeGlossaryCsv([
        { term_id: "loom", title: "Loom", definition: "A frame.", related_terms: null, extra_columns: null },
      ]),
    });
    const result = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });
    expect(result.valid).toBe(true);
    expect(result.objects.warnings).toEqual([]);
  });

  it("refuses from parseTelarCsv only when asked to, and keeps the last by default", () => {
    const csv = "object_id,medium,object_type\no1,Oil,Painting\n";
    expect(() =>
      parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE, {
        severalHoldValues: "refuse",
        sheetName: "objects.csv",
      }),
    ).toThrow(CollidingColumnsRefusal);
    const warnings: SheetIssue[] = [];
    const rows = parseTelarCsv(csv, (issue) => warnings.push(issue), false, OBJECTS_CANONICAL_SCOPE);
    expect(rows[0].medium_genre).toBe("Painting");
    expect(warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The bilingual row a publish writes is not a warning
//
// Every sheet the Compositor publishes carries a second, Spanish header row,
// and the parse skips it. Only a skipped row holding a cell that is not a
// header token may hold content, so only that one is reported.
// ---------------------------------------------------------------------------

describe("the bilingual row of a published sheet", () => {
  const collect = (csv: string, isProjectCsv = false, scope?: ReadonlySet<string>) => {
    const warnings: SheetIssue[] = [];
    const rows = parseTelarCsv(csv, (issue) => warnings.push(issue), isProjectCsv, scope);
    return { rows, warnings };
  };

  it("raises nothing on objects.csv, custom columns included", () => {
    const csv = serializeObjectsCsv([
      {
        object_id: "obj-1", title: "Un objeto", featured: null, creator: "Anon", description: null,
        source_url: null, period: null, year: "1700", medium_genre: null, subjects: null, source: null,
        credit: null, thumbnail: null, alt_text: null, dimensions: null,
        extra_columns: JSON.stringify({ archivo: "AGN", signatura: "SC 1" }),
      },
    ]);
    const { rows, warnings } = collect(csv, false, OBJECTS_CANONICAL_SCOPE);
    expect(rows.map((r) => r.object_id)).toEqual(["obj-1"]);
    expect(warnings).toEqual([]);
  });

  it("raises nothing on project.csv", () => {
    const csv = serializeProjectCsv([
      { story_id: "weavers", title: "The Weavers", subtitle: "A story", byline: "Jane Doe", order: 1, private: false, draft: false, show_sections: false },
    ]);
    const { rows, warnings } = collect(csv, true, PROJECT_CANONICAL_SCOPE);
    expect(rows.map((r) => r.story_id)).toEqual(["weavers"]);
    expect(warnings).toEqual([]);
  });

  it("raises nothing on glossary.csv", () => {
    const csv = serializeGlossaryCsv([
      { term_id: "loom", title: "Loom", definition: "A frame.", related_terms: null, extra_columns: JSON.stringify({ fuente: "RAE" }) },
    ]);
    const { rows, warnings } = collect(csv, false, GLOSSARY_CANONICAL_SCOPE);
    expect(rows.map((r) => r.term_id)).toEqual(["loom"]);
    expect(warnings).toEqual([]);
  });
});

describe("importRepo — an object's media read from telar-content/objects", () => {
  const originalFetch = globalThis.fetch;
  const SITE = "https://example.github.io/my-telar-site";
  const OBJECTS_OID = "objects-tree-oid";

  type Listing = "ok" | "unresolved" | "truncated" | "throws";
  let requests: string[] = [];

  function base64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    return btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(""));
  }

  function answer(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }

  /**
   * A repository whose objects.csv lists `ids` (all self-hosted), with
   * `objectFiles` (paths relative to telar-content/objects) in that folder, or
   * no folder at all when it is undefined. `site` answers every HEAD sent to the
   * published site: a status, or "unreachable" for a fetch that throws.
   */
  function serve(opts: {
    ids: string[];
    objectFiles?: string[];
    listing?: Listing;
    site: number | "unreachable";
    sources?: Record<string, string>;
    /** The framework version the repository's _config.yml names, in place of the fixture's. */
    version?: string;
  }) {
    const csv = `object_id,title,source_url\n${opts.ids.map((id) => `${id},${id},${opts.sources?.[id] ?? ""}`).join("\n")}\n`;
    const files: Record<string, string> = {
      "_config.yml": opts.version
        ? readFixture("config.yml").replace(/version: "0\.9\.3-beta"/, `version: "${opts.version}"`)
        : readFixture("config.yml"),
      "telar-content/spreadsheets/objects.csv": csv,
    };
    const listing = opts.listing ?? "ok";
    requests = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push(`${method} ${url}`);
      if (url.startsWith(`${SITE}/`)) {
        if (opts.site === "unreachable") throw new TypeError("fetch failed");
        return answer(opts.site, {});
      }
      if (url.endsWith("/graphql")) {
        const body = String(init?.body ?? "");
        if (!body.includes("SubtreeOids")) {
          return answer(200, { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "head-sha" } } } } });
        }
        const path = String(JSON.parse(body).variables.c0p0);
        if (!path.endsWith(":telar-content/objects")) {
          return answer(200, { data: { repository: { c0: { __typename: "Commit" }, c0p0: null } } });
        }
        if (listing === "throws") throw new TypeError("fetch failed");
        if (listing === "unresolved") return answer(200, { data: { repository: { c0: null, c0p0: null } } });
        const at = opts.objectFiles === undefined ? null : { __typename: "Tree", oid: OBJECTS_OID };
        return answer(200, { data: { repository: { c0: { __typename: "Commit" }, c0p0: at } } });
      }
      if (url.includes(`/git/trees/${OBJECTS_OID}`)) {
        const paths = opts.objectFiles ?? [];
        const dirs = [...new Set(paths.filter((p) => p.includes("/")).map((p) => p.slice(0, p.lastIndexOf("/"))))];
        const tree = [
          ...dirs.map((path) => ({ path, mode: "040000", type: "tree" })),
          ...paths.map((path) => ({ path, mode: "100644", type: "blob", sha: `sha-${path}` })),
        ];
        return answer(200, { tree, truncated: listing === "truncated" });
      }
      if (url.includes("/git/trees")) return answer(200, { tree: [], truncated: false });
      for (const [path, text] of Object.entries(files)) {
        if (url.includes(`/contents/${path}`)) {
          return answer(200, { content: base64(text), encoding: "base64", size: Buffer.byteLength(text, "utf8") });
        }
      }
      return answer(404, { message: "Not Found" });
    }) as unknown as typeof fetch;
  }

  async function run() {
    const { importRepo } = await import("~/lib/import.server");
    const result = await importRepo({
      token: "test-token",
      installationId: 1,
      repoFullName: "user/repo",
      userId: 1,
      env: { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
    });
    const rows = importDb.inserts
      .filter((i) => i.table === objects)
      .flatMap((i) => i.values as Array<Record<string, unknown>>);
    const byId = Object.fromEntries(rows.map((r) => [r.object_id as string, r]));
    return { result, byId };
  }

  /** The live-site HEADs sent for one object, tile and audio alike. */
  function probesFor(id: string): string[] {
    return requests.filter(
      (r) => r.startsWith(`HEAD ${SITE}/iiif/objects/${id}/`) || r.startsWith(`HEAD ${SITE}/telar-content/objects/${id}.`),
    );
  }

  beforeEach(() => {
    importDb = makeDbMock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("settles an image and an audio object from their files, with the site unreachable and no probe sent", async () => {
    serve({ ids: ["a", "b"], objectFiles: ["a.jpg", "b.mp3"], site: "unreachable" });
    const { result, byId } = await run();
    expect(result.valid).toBe(true);
    expect(byId.a.image_available).toBe(true);
    expect(byId.b.image_available).toBe(true);
    expect(byId.b.source_url).toBe("b.mp3");
    expect(result.iiifObjectIds).toEqual(["a"]);
    expect(result.audioObjectIds).toEqual(["b"]);
    expect(requests.filter((r) => r.startsWith("HEAD "))).toEqual([]);
  });

  it("leaves an object whose source begins with http to the probe, as the tiler builds nothing for it", async () => {
    serve({ ids: ["h"], objectFiles: ["h.jpg"], site: 404, sources: { h: "http:foo" } });
    const { byId } = await run();
    expect(byId.h.image_available).toBe(false);
    expect(probesFor("h").length).toBeGreaterThan(0);
  });

  it("takes an extension spelled all uppercase, and records the filename as the repository spells it", async () => {
    serve({ ids: ["f", "g"], objectFiles: ["f.JPG", "g.MP3"], site: "unreachable" });
    const { byId } = await run();
    expect(byId.f.image_available).toBe(true);
    expect(byId.g.image_available).toBe(true);
    expect(byId.g.source_url).toBe("g.MP3");
    expect(requests.filter((r) => r.startsWith("HEAD "))).toEqual([]);
  });

  it.each([
    ["answers 404", 404 as const],
    ["cannot be reached", "unreachable" as const],
  ])("probes an object with no file in the folder, and writes it not available when the site %s", async (_label, site) => {
    serve({ ids: ["a", "c"], objectFiles: ["a.jpg"], site });
    const { byId } = await run();
    expect(probesFor("c").length).toBeGreaterThan(0);
    expect(probesFor("a")).toEqual([]);
    expect(byId.c.image_available).toBe(false);
    expect(byId.c.source_url ?? null).toBeNull();
  });

  it("probes every object when the folder is absent", async () => {
    serve({ ids: ["a"], site: 404 });
    const { byId } = await run();
    expect(probesFor("a").length).toBeGreaterThan(0);
    expect(byId.a.image_available).toBe(false);
  });

  it("settles an object with both an image and an audio file as audio", async () => {
    serve({ ids: ["d"], objectFiles: ["d.jpg", "d.mp3"], site: "unreachable" });
    const { result, byId } = await run();
    expect(byId.d.image_available).toBe(true);
    expect(byId.d.source_url).toBe("d.mp3");
    expect(result.iiifObjectIds).toEqual([]);
    expect(result.audioObjectIds).toEqual(["d"]);
  });

  it.each([
    ["a file in a subfolder", "e", "sub/e.jpg"],
    ["an extension in mixed case", "map", "map.JpG"],
    ["an object_id the tiler rejects", "map.v1", "map.v1.jpg"],
  ])("does not match %s, and probes the object", async (_label, id, file) => {
    serve({ ids: [id], objectFiles: [file], site: 404 });
    const { result, byId } = await run();
    expect(probesFor(id).length).toBeGreaterThan(0);
    expect(byId[id].image_available).toBe(false);
    expect(result.iiifObjectIds).toEqual([]);
  });

  // The tiler's search list is the site's release's: `.gif` from 1.8.0.
  it("settles map.gif as tiled on 1.8.0, and leaves it to the probe on 1.7.0", async () => {
    serve({ ids: ["map"], objectFiles: ["map.gif"], site: 404, version: "1.8.0" });
    const on18 = await run();
    expect(on18.byId.map.image_available).toBe(true);
    expect(probesFor("map")).toEqual([]);

    importDb = makeDbMock();
    serve({ ids: ["map"], objectFiles: ["map.gif"], site: 404, version: "1.7.0" });
    const on17 = await run();
    expect(on17.byId.map.image_available).toBe(false);
    expect(probesFor("map").length).toBeGreaterThan(0);
  });

  it.each([
    ["the head does not resolve", "unresolved" as const],
    ["the listing comes back truncated", "truncated" as const],
    ["the listing request throws", "throws" as const],
  ])("probes every object when %s, and the import still succeeds", async (_label, listing) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serve({ ids: ["a", "b"], objectFiles: ["a.jpg", "b.mp3"], listing, site: 200 });
    const { result, byId } = await run();
    expect(result.valid).toBe(true);
    expect(probesFor("a").length).toBeGreaterThan(0);
    expect(probesFor("b").length).toBeGreaterThan(0);
    // The site answers every probe, so the tile probe settles both.
    expect(byId.a.image_available).toBe(true);
    expect(byId.b.image_available).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("telar-content/objects"))).toBe(true);
  });
});
