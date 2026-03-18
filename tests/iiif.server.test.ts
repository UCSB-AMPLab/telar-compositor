/**
 * Unit tests for iiif.server.ts — IIIF manifest fetch and parse utility.
 *
 * Tests cover:
 *   - extractV2Label: plain string, language object, language array
 *   - extractV3Label: "en" key, fallback to first language
 *   - fetchAndParseManifest: v2 fixture, v3 fixture, invalid JSON
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import v2Manifest from "./fixtures/iiif-v2-manifest.json";
import v3Manifest from "./fixtures/iiif-v3-manifest.json";

// We import after setting up global fetch mock
import {
  extractV2Label,
  extractV3Label,
  fetchAndParseManifest,
} from "~/lib/iiif.server";

// ---------------------------------------------------------------------------
// extractV2Label
// ---------------------------------------------------------------------------

describe("extractV2Label", () => {
  it("returns a plain string as-is", () => {
    expect(extractV2Label("plain string")).toBe("plain string");
  });

  it("extracts @value from a single language object", () => {
    expect(
      extractV2Label([{ "@value": "labeled", "@language": "en" }])
    ).toBe("labeled");
  });

  it("extracts first @value from a language array", () => {
    expect(
      extractV2Label([
        { "@value": "first", "@language": "en" },
        { "@value": "segundo", "@language": "es" },
      ])
    ).toBe("first");
  });

  it("returns empty string for empty array", () => {
    expect(extractV2Label([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractV3Label
// ---------------------------------------------------------------------------

describe("extractV3Label", () => {
  it("returns the English value when 'en' key exists", () => {
    expect(extractV3Label({ en: ["English title"] })).toBe("English title");
  });

  it("returns value from first language when 'en' is absent", () => {
    expect(extractV3Label({ es: ["Titulo"] })).toBe("Titulo");
  });

  it("tries 'none' key as fallback before first language", () => {
    expect(extractV3Label({ none: ["None label"], fr: ["French"] })).toBe(
      "None label"
    );
  });

  it("returns empty string for empty map", () => {
    expect(extractV3Label({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fetchAndParseManifest
// ---------------------------------------------------------------------------

describe("fetchAndParseManifest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a v2 manifest correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => v2Manifest,
      })
    );

    const result = await fetchAndParseManifest(
      "https://example.org/manifests/test-object"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.metadata.title).toBe("Portrait of Ana de Mendoza");
    expect(result.metadata.creator).toBe("Diego Velázquez");
    expect(result.metadata.thumbnail).toBe(
      "https://example.org/images/test-object/full/200,/0/default.jpg"
    );
    expect(result.metadata.image_available).toBe(true);
  });

  it("parses a v3 manifest correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => v3Manifest,
      })
    );

    const result = await fetchAndParseManifest(
      "https://example.org/manifests/test-object-v3"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.metadata.title).toBe("The Codex of Maps");
    expect(result.metadata.creator).toBe("Juan de la Cruz");
    expect(result.metadata.thumbnail).toBe(
      "https://example.org/images/test-object-v3/full/200,/0/default.jpg"
    );
    expect(result.metadata.image_available).toBe(true);
  });

  it("returns ok: false with error 'not_iiif' for invalid JSON shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ some: "random json" }),
      })
    );

    const result = await fetchAndParseManifest("https://example.org/not-iiif");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected not ok");
    expect(result.error).toBe("not_iiif");
  });

  it("returns ok: false with error 'fetch_failed' on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network failure"))
    );

    const result = await fetchAndParseManifest(
      "https://example.org/unreachable"
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected not ok");
    expect(result.error).toBe("fetch_failed");
  });
});
