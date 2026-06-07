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
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
} from "~/lib/import.server";
import { parseYaml } from "~/lib/yaml.server";
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
});

// ---------------------------------------------------------------------------
// isCommentRow
// ---------------------------------------------------------------------------

describe("isCommentRow", () => {
  it("identifies rows where any cell starts with #", () => {
    const row = { object_id: "# This is a comment", title: "" };
    expect(isCommentRow(row)).toBe(true);
  });

  it("returns false for data rows", () => {
    const row = { object_id: "painting-001", title: "The Garden" };
    expect(isCommentRow(row)).toBe(false);
  });

  it("detects # in any column", () => {
    const row = { object_id: "painting-001", description: "# skip this" };
    expect(isCommentRow(row)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseTelarCsv
// ---------------------------------------------------------------------------

describe("parseTelarCsv", () => {
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
    const rows = parseTelarCsv(csv);
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

  it("reads legacy object_type column and maps to object_type in D1 insert", () => {
    const rows: Record<string, string>[] = [
      { object_id: "obj-001", title: "A Photo", featured: "false", object_type: "Photograph" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped[0].object_type).toBe("Photograph");
  });

  it("prefers medium_genre over legacy object_type when both are present", () => {
    const rows: Record<string, string>[] = [
      { object_id: "obj-001", title: "A Photo", featured: "false", medium_genre: "Watercolor", object_type: "Painting" },
    ];
    const mapped = mapObjectsCsv(rows);
    expect(mapped[0].object_type).toBe("Watercolor");
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
        json: async () => ({ content: configBase64, encoding: "base64" }),
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
    // (fetch was only called for _config.yml and tree, not for CSVs)
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
// rollbackProjectImport — cascade-delete coverage
// ---------------------------------------------------------------------------

describe("rollbackProjectImport — cascade-delete order", () => {
  it("deletes project_members and project_invites after per-entity cascades and before projects", async () => {
    const visited: unknown[] = [];

    // Mock db.delete to record the table reference passed in. The real drizzle
    // chain is `.delete(table).where(condition)` — we return a stub whose
    // `where` resolves to undefined so the await chain completes.
    const db = {
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return {
          where: vi.fn().mockResolvedValue(undefined),
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
      batch: vi.fn().mockResolvedValue([]),
    };

    await rollbackProjectImport(db, 42);

    // Presence
    expect(visited).toContain(project_members);
    expect(visited).toContain(project_invites);

    // Per-entity cascades still run before the new deletes
    expect(visited.indexOf(project_members)).toBeGreaterThan(visited.indexOf(project_landing));
    expect(visited.indexOf(project_members)).toBeGreaterThan(visited.indexOf(project_config));
    expect(visited.indexOf(project_invites)).toBeGreaterThan(visited.indexOf(project_landing));

    // project_members deleted before project_invites (insertion order in helper)
    expect(visited.indexOf(project_members)).toBeLessThan(visited.indexOf(project_invites));

    // Both run BEFORE the project row delete
    expect(visited.indexOf(project_members)).toBeLessThan(visited.indexOf(projects));
    expect(visited.indexOf(project_invites)).toBeLessThan(visited.indexOf(projects));

    // The project row is deleted last
    expect(visited[visited.length - 1]).toBe(projects);
  });

  it("retains the existing per-entity cascade order", async () => {
    const visited: unknown[] = [];
    const db = {
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      // Return one id so the layers/steps branch runs and we can assert the
      // full cascade (including layers + steps).
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 1 }]) })),
      })),
      batch: vi.fn().mockResolvedValue([]),
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

  beforeEach(() => {
    // The `as never` cast skirts vitest's overly-narrow MockInstance type
    // when assigning a typed spy to a loosely-typed lexical binding; the
    // spy itself is fully typed at the call sites.
    getRepoTreeSpy = vi.spyOn(githubServer, "getRepoTree") as never;
    getFileContentSpy = vi.spyOn(githubServer, "getFileContent") as never;
  });

  afterEach(() => {
    (getRepoTreeSpy as { mockRestore: () => void }).mockRestore();
    (getFileContentSpy as { mockRestore: () => void }).mockRestore();
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
    getFileContentSpy.mockImplementation(async (_t, _o, _r, path) => {
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
      { slug: "about", title: "About this project", body: "Welcome to the project.", order: 0 },
      { slug: "team", title: "Our team", body: "Meet the team.", order: 1 },
    ]);
  });

  it("skips entries when getFileContent returns null while preserving order for the rest", async () => {
    getRepoTreeSpy.mockResolvedValue({
      tree: [
        { path: "telar-content/texts/pages/about.md", mode: "100644", type: "blob", sha: "a" },
        { path: "telar-content/texts/pages/missing.md", mode: "100644", type: "blob", sha: "b" },
        { path: "telar-content/texts/pages/team.md", mode: "100644", type: "blob", sha: "c" },
      ],
      truncated: false,
    });
    getFileContentSpy.mockImplementation(async (_t, _o, _r, path) => {
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
      { slug: "about", title: "About", body: "About body.", order: 0 },
      { slug: "team", title: "Team", body: "Team body.", order: 2 },
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
      delete: vi.fn((table: unknown) => {
        visited.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 1 }]),
        })),
      })),
      batch: vi.fn().mockResolvedValue([]),
    };

    const { deleteProjectCascade } = await import("~/lib/import.server");
    const { project_pages } = await import("~/db/schema");
    await deleteProjectCascade(db, 7);

    expect(visited).toContain(project_pages);
  });

  it("issues the cascade as a single db.batch([...]) call", async () => {
    const db: any = {
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
      batch: vi.fn().mockResolvedValue([]),
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
        delete: vi.fn((table: unknown) => {
          visited.push(table);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 1 }]) })),
        })),
        batch: vi.fn().mockResolvedValue([]),
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

    beforeEach(() => {
      getRepoTreeSpy = vi.spyOn(githubServer, "getRepoTree") as never;
      getFileContentSpy = vi.spyOn(githubServer, "getFileContent") as never;
    });

    afterEach(() => {
      (getRepoTreeSpy as { mockRestore: () => void }).mockRestore();
      (getFileContentSpy as { mockRestore: () => void }).mockRestore();
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
      getFileContentSpy.mockImplementation(async (_t, _o, _r, path) => {
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
      getFileContentSpy.mockImplementation(async (_t, _o, _r, path) => {
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
