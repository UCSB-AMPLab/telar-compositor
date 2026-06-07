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

import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import {
  isSafeImageUrl,
  livePreviewPlugin,
} from "~/components/ui/markdown-editor/livePreviewPlugin";

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

// ---------------------------------------------------------------------------
// Image-preview widget insertion for off-cursor images
// ---------------------------------------------------------------------------
//
// An ![alt](url) markdown image NOT on the cursor line must produce an inline
// image-preview widget (ImageWidget → span.cm-md-image-preview > img), not a
// bare cm-md-image-alt reference. This pins the behaviour so the live-preview
// path can't silently regress to text-only rendering.

describe("livePreviewPlugin — image preview widget", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  // Collect every widget decoration's rendered DOM from the plugin's set.
  function widgetDoms(set: DecorationSet): HTMLElement[] {
    const doms: HTMLElement[] = [];
    const cursor = set.iter();
    while (cursor.value) {
      const widget = cursor.value.spec.widget as
        | { toDOM?: () => HTMLElement }
        | undefined;
      if (widget?.toDOM) doms.push(widget.toDOM());
      cursor.next();
    }
    return doms;
  }

  it("renders an image-preview widget for an image off the cursor line", () => {
    // Two lines: image on line 1, cursor parked on line 2 so onCursorLine() is
    // false for the image range and the widget path is taken.
    const doc = "![A weaving](https://cdn.example/weaving.png)\nsecond line";
    view = new EditorView({
      state: EditorState.create({
        doc,
        // anchor on the second line, well past the image syntax
        selection: { anchor: doc.length },
        // The markdown language parser must be present for syntaxTree() to
        // expose the Image node the plugin decorates (matches MarkdownEditor.tsx).
        extensions: [markdown(), livePreviewPlugin],
      }),
      parent: document.body,
    });

    const pluginValue = view.plugin(livePreviewPlugin);
    expect(pluginValue).not.toBeNull();
    const doms = widgetDoms(pluginValue!.decorations);

    const preview = doms.find((el) =>
      el.querySelector?.("img") &&
      (el.classList.contains("cm-md-image-preview") ||
        el.querySelector(".cm-md-image-preview")),
    );
    expect(preview).toBeDefined();

    const img = preview!.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("alt")).toBe("A weaving");
    expect(img.getAttribute("src")).toBe("https://cdn.example/weaving.png");
  });
});
