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

// ---------------------------------------------------------------------------
// fetchAndParseManifest scheme guard
// ---------------------------------------------------------------------------
//
// Defence-in-depth: reject non-https schemes and unparseable URL strings
// before fetch() is invoked. Cloudflare Workers blocks RFC1918/loopback at
// the runtime layer; this is the additional scheme-allowlist check.

describe("fetchAndParseManifest scheme guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects http:// URLs without invoking fetch()", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndParseManifest(
      "http://example.org/manifest.json"
    );

    expect(result).toEqual({ ok: false, error: "fetch_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects file:// URLs without invoking fetch()", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndParseManifest("file:///etc/passwd");

    expect(result).toEqual({ ok: false, error: "fetch_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unparseable URL strings without invoking fetch()", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndParseManifest("not a url");

    expect(result).toEqual({ ok: false, error: "fetch_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows https:// URLs through to fetch()", async () => {
    const minimalV3Manifest = {
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: "https://example.org/manifest.json",
      type: "Manifest",
      label: { en: ["Test"] },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => minimalV3Manifest,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndParseManifest(
      "https://example.org/manifest.json"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.org/manifest.json"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.metadata.title).toBe("Test");
  });
});

// ---------------------------------------------------------------------------
// fetchAndParseManifest userinfo guard
// ---------------------------------------------------------------------------
//
// Defence-in-depth: reject userinfo-bearing https URLs before fetch().
// Embedded credentials (https://user:pass@host/...) would otherwise leak to
// whatever host fetch() resolves. DNS rebinding and IDN homograph attacks
// are not addressed by this guard.

describe("fetchAndParseManifest userinfo guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects https URLs with user:pass@ userinfo without invoking fetch()", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndParseManifest(
      "https://user:pass@example.org/manifest.json"
    );

    expect(result).toEqual({ ok: false, error: "fetch_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects https URLs with username-only userinfo without invoking fetch()", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndParseManifest(
      "https://user@example.org/manifest.json"
    );

    expect(result).toEqual({ ok: false, error: "fetch_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
