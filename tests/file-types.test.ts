/**
 * Unit coverage for the file-type declaration module.
 *
 * Offline: these test the declaration's own shape and derivations. What the
 * declaration must EQUAL in the framework is a separate, live check —
 * `tests/template-coupling.live.test.ts`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  TILEABLE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  UPLOAD_ACCEPTED_EXTENSIONS,
  BROWSER_RENDERABLE_EXTENSIONS,
  UPLOAD_ACCEPTED_MIME_TYPES,
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_ACCEPTED_FORMAT_LIST,
  mimeTypesFor,
  formatListFor,
  acceptAttributeFor,
  extensionForMimeType,
  storedExtensionFor,
  formatLabelFor,
  uploadFileExtension,
  isBrowserRenderable,
} from "~/lib/file-types";

describe("MIME derivation", () => {
  it("derives the upload MIME set from the upload extension set", () => {
    expect([...UPLOAD_ACCEPTED_MIME_TYPES].sort()).toEqual(
      [...mimeTypesFor(UPLOAD_ACCEPTED_EXTENSIONS)].sort(),
    );
    expect([...UPLOAD_ACCEPTED_MIME_TYPES].sort()).toEqual([
      "application/pdf",
      "audio/mp4",
      "audio/mpeg",
      "audio/ogg",
      "audio/x-m4a",
      "image/jpeg",
      "image/png",
      "image/tiff",
      "image/webp",
    ]);
  });

  it("collapses the two spellings of a format to one MIME type", () => {
    expect([...mimeTypesFor(["jpg", "jpeg"])]).toEqual(["image/jpeg"]);
    expect([...mimeTypesFor(["tif", "tiff"])]).toEqual(["image/tiff"]);
  });

  it("throws rather than silently skipping an extension it cannot name", () => {
    // A set widened without the format table being widened is a mistake, not a
    // narrower MIME list.
    expect(() => mimeTypesFor(["jxl"])).toThrow(/no MIME type declared/);
  });

  it("stores every accepted MIME type under an extension of its own", () => {
    // Totality is what lets the upload path call storedExtensionFor without a
    // branch: no accepted file can fall through to another format's extension.
    for (const mime of UPLOAD_ACCEPTED_MIME_TYPES) {
      expect(UPLOAD_ACCEPTED_EXTENSIONS.has(storedExtensionFor(mime))).toBe(true);
    }
    expect(storedExtensionFor("image/tiff")).toBe("tif");
    expect(() => storedExtensionFor("image/gif")).toThrow(/no extension declared/);
  });

  it("maps a MIME type back to the extension a file is stored under", () => {
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForMimeType("image/tiff")).toBe("tif");
    expect(extensionForMimeType("image/webp")).toBe("webp");
    expect(extensionForMimeType("application/pdf")).toBe("pdf");
    expect(extensionForMimeType("image/gif")).toBeNull();
  });
});

describe("the three sets are independently declared", () => {
  it("does not alias the upload set to the tileable set", () => {
    // Overlapping in value, and that must stay a coincidence: aliasing them
    // would make the upload set unwidenable without also claiming tiles.
    expect(UPLOAD_ACCEPTED_EXTENSIONS).not.toBe(TILEABLE_EXTENSIONS);
    expect(BROWSER_RENDERABLE_EXTENSIONS).not.toBe(UPLOAD_ACCEPTED_EXTENSIONS);
    expect(AUDIO_EXTENSIONS).not.toBe(UPLOAD_ACCEPTED_EXTENSIONS);
  });

  it("lets audio join the upload set without restructuring anything", () => {
    // Widening UPLOAD_ACCEPTED_EXTENSIONS to audio must be an edit
    // to one set, not a change to the derivations — so the format table already
    // names every audio extension, and every derivation already handles them.
    const widened = [...UPLOAD_ACCEPTED_EXTENSIONS, ...AUDIO_EXTENSIONS];
    const mimes = mimeTypesFor(widened);
    expect(mimes.has("audio/mpeg")).toBe(true);
    expect(mimes.has("audio/ogg")).toBe(true);
    expect(mimes.has("audio/mp4")).toBe(true);
    expect(formatListFor(widened)).toContain("MP3");
    expect(acceptAttributeFor(widened)).toContain(".mp3");
  });

  it("accepts every audio extension the framework treats as audio", () => {
    for (const ext of AUDIO_EXTENSIONS) expect(UPLOAD_ACCEPTED_EXTENSIONS.has(ext)).toBe(true);
  });

  it("never claims tiles for an audio extension", () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(TILEABLE_EXTENSIONS.some((e) => e.ext === ext)).toBe(false);
      expect(BROWSER_RENDERABLE_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe("browser-renderable formats", () => {
  it("excludes the formats an <img> cannot show", () => {
    // PDF cannot render in an <img> at all; TIFF renders in no browser but
    // Safari. Both are accepted for upload, so both would show a broken image.
    expect(BROWSER_RENDERABLE_EXTENSIONS.has("pdf")).toBe(false);
    expect(BROWSER_RENDERABLE_EXTENSIONS.has("tif")).toBe(false);
    expect(BROWSER_RENDERABLE_EXTENSIONS.has("tiff")).toBe(false);
  });

  it("renders nothing the upload set does not accept", () => {
    for (const ext of BROWSER_RENDERABLE_EXTENSIONS) {
      expect(UPLOAD_ACCEPTED_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("decides on the reported MIME type, not the filename", () => {
    // A renamed file cannot talk its way into an <img>, and a truthfully-named
    // one is not refused for its spelling.
    expect(isBrowserRenderable({ type: "application/pdf", name: "report.png" })).toBe(false);
    expect(isBrowserRenderable({ type: "image/jpeg", name: "photo.pdf" })).toBe(true);
    expect(isBrowserRenderable({ type: "image/tiff", name: "scan.tif" })).toBe(false);
    expect(isBrowserRenderable({ type: "image/webp", name: "map.webp" })).toBe(true);
  });

  it("refuses a file whose MIME type it does not declare", () => {
    expect(isBrowserRenderable({ type: "image/svg+xml", name: "logo.svg" })).toBe(false);
    expect(uploadFileExtension({ type: "image/svg+xml", name: "logo.svg" })).toBe("svg");
  });

  it("takes the extension from the MIME type when it knows it", () => {
    expect(uploadFileExtension({ type: "image/jpeg", name: "photo.JPEG" })).toBe("jpg");
    expect(uploadFileExtension({ type: "", name: "photo.PNG" })).toBe("png");
    expect(uploadFileExtension({ type: "", name: "noextension" })).toBe("");
  });
});

describe("user-facing derivations", () => {
  it("lists each accepted format once, by name", () => {
    expect(UPLOAD_ACCEPTED_FORMAT_LIST).toBe(formatListFor(UPLOAD_ACCEPTED_EXTENSIONS));
    expect(UPLOAD_ACCEPTED_FORMAT_LIST).toBe("JPG, PNG, WEBP, TIFF, PDF, MP3, OGG, M4A");
  });

  it("names both spellings of a format the same way", () => {
    expect(formatLabelFor("tif")).toBe("TIFF");
    expect(formatLabelFor("tiff")).toBe("TIFF");
    expect(formatLabelFor("jpeg")).toBe("JPG");
    // An extension with no entry still gets a label rather than an empty one.
    expect(formatLabelFor("jxl")).toBe("JXL");
  });

  it("offers the file input every accepted extension", () => {
    const offered = new Set(UPLOAD_ACCEPT_ATTRIBUTE.split(",").map((s) => s.replace(/^\./, "")));
    expect(offered).toEqual(new Set(UPLOAD_ACCEPTED_EXTENSIONS));
  });
});
