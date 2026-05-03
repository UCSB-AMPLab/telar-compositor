// @vitest-environment jsdom
/**
 * livePreviewPlugin.test.ts — Coverage for the isSafeImageUrl scheme allowlist
 * used by the markdown editor live-preview ImageWidget.
 *
 * Defence-in-depth against javascript:, vbscript:, data:text/html, and
 * protocol-relative URLs reaching `<img src>` from raw markdown.
 *
 * data:image/svg+xml is dropped from the allowlist — SVG can carry inline
 * scripts via <foreignObject>, animation events, and parser quirks even when
 * loaded via <img>. The MarkdownEditor preview is a logged-in editing surface
 * where pasted markdown reaches the DOM; tightening the allowlist to raster
 * MIME types only removes that residual XSS surface.
 */

import { describe, it, expect } from "vitest";
import { isSafeImageUrl } from "~/components/ui/markdown-editor/livePreviewPlugin";

describe("isSafeImageUrl", () => {
  it.each<[string, boolean]>([
    // Allowed schemes
    ["https://cdn.example/foo.png", true],
    ["http://localhost/foo.png", true],
    ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", true],
    ["/images/foo.png", true],

    // Rejected schemes
    ["javascript:alert(1)", false],
    ["vbscript:msgbox", false],
    ["data:text/html,<script>alert(1)</script>", false],
    ["not a url", false],
    ["//evil.example/foo.png", false],
  ])("isSafeImageUrl(%j) === %s", (input, expected) => {
    expect(isSafeImageUrl(input)).toBe(expected);
  });

  describe("svg rejection", () => {
    it("rejects base64-encoded data:image/svg+xml URLs", () => {
      expect(
        isSafeImageUrl(
          "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==",
        ),
      ).toBe(false);
    });

    it("rejects uri-encoded inline data:image/svg+xml URLs", () => {
      expect(isSafeImageUrl("data:image/svg+xml,<svg></svg>")).toBe(false);
    });

    it("rejects data:image/svg+xml regardless of letter case", () => {
      expect(isSafeImageUrl("DATA:IMAGE/SVG+XML;base64,PHN2Zy8+")).toBe(false);
    });

    it("still accepts data:image/jpeg URLs (regression)", () => {
      expect(
        isSafeImageUrl("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg="),
      ).toBe(true);
    });

    it("still accepts data:image/jpg URLs (regression)", () => {
      expect(isSafeImageUrl("data:image/jpg;base64,/9j/4AAQSkZJRgABAQ==")).toBe(true);
    });

    it("still accepts data:image/gif URLs (regression)", () => {
      expect(isSafeImageUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).toBe(true);
    });

    it("still accepts data:image/webp URLs (regression)", () => {
      expect(
        isSafeImageUrl("data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"),
      ).toBe(true);
    });
  });
});
