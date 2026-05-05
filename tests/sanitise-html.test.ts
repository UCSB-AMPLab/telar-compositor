/**
 * Tests for app/lib/sanitise-html.ts.
 *
 * The sanitiser is the boundary between marked.parse() output and the
 * dangerouslySetInnerHTML calls in app/routes/_app.upgrade.tsx (release
 * notes loader at :213 and manual upgrade-step renderer at :1404).
 *
 * Test cases cover the strip rules (script tags, event handlers,
 * javascript: URLs) and the allow rules (heading id attributes from
 * the custom Renderer at upgrade.tsx:209-212, https and data:image
 * URLs, plain inline formatting).
 */

import { describe, it, expect } from "vitest";
import { sanitiseHtml } from "~/lib/sanitise-html";

describe("sanitiseHtml", () => {
  it("strips <script> tags", () => {
    const out = sanitiseHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
  });

  it("strips event-handler attributes", () => {
    const out = sanitiseHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });

  it("strips javascript: URLs in href", () => {
    const out = sanitiseHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("preserves heading id attributes", () => {
    const out = sanitiseHtml('<h2 id="install">Install</h2>');
    expect(out).toContain("<h2");
    expect(out).toContain('id="install"');
  });

  it("preserves https hrefs", () => {
    const out = sanitiseHtml('<a href="https://example.com">ok</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it("preserves https img src", () => {
    const out = sanitiseHtml('<img src="https://cdn.example/img.png">');
    expect(out).toContain('src="https://cdn.example/img.png"');
  });

  it("preserves data:image src for img tag", () => {
    const out = sanitiseHtml('<img src="data:image/png;base64,iVBOR">');
    expect(out).toContain("data:image/png");
  });

  it("preserves plain formatting", () => {
    const out = sanitiseHtml("<p>hello <strong>world</strong></p>");
    expect(out).toContain("<p>");
    expect(out).toContain("<strong>");
  });

  it("rejects data:image/svg+xml in img src", () => {
    const out = sanitiseHtml('<img src="data:image/svg+xml;base64,PHN2Zw==">');
    expect(out).not.toContain("data:image/svg");
  });

  // The rejection must hold under whitespace,
  // control-char, HTML-entity, and embedded-comment evasion, because
  // sanitize-html's downstream naughtyHref normalises the URL the same
  // way browsers do before the scheme allowlist runs. If the
  // transformTags hook only matches the canonical form, all the shapes
  // below leak the SVG src into the SSR HTML response.
  it.each([
    '<img src=" data:image/svg+xml;base64,PHN2Zw==">',
    '<img src="\tdata:image/svg+xml;base64,PHN2Zw==">',
    '<img src="\ndata:image/svg+xml;base64,PHN2Zw==">',
    '<img src="&#x20;data:image/svg+xml;base64,PHN2Zw==">',
    '<img src="&#x09;data:image/svg+xml;base64,PHN2Zw==">',
    '<img src="data: image/svg+xml;base64,PHN2Zw==">',
    '<img src="da<!---->ta:image/svg+xml;base64,PHN2Zw==">',
  ])("rejects data:image/svg+xml under whitespace/comment evasion: %s", (input) => {
    const out = sanitiseHtml(input);
    expect(out).not.toContain("svg+xml");
    expect(out.toLowerCase()).not.toMatch(/data:\s*image\/svg/);
  });
});
