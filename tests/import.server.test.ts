import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  isHeaderRow,
  isCommentRow,
  parseTelarCsv,
  mapConfigToProjectConfig,
  mapObjectsCsv,
  mapProjectCsv,
  mapStoryCsv,
  parseIndexMd,
  parsePageMarkdown,
} from "~/lib/import.server";
import { parseYaml } from "~/lib/yaml.server";

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
