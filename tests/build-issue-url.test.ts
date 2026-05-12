/**
 * This file pins the `buildIssueUrl` and `deriveIssueTitle` helpers — the
 * bug-report stage that assembles the final GitHub `issues/new` URL,
 * including label query params, body truncation, and the byte-length
 * guard that keeps the URL under the GitHub limit.
 *
 * @version v1.2.0-beta
 */
import { describe, it, expect } from "vitest";
import {
  buildIssueUrl,
  deriveIssueTitle,
} from "../app/components/features/bug-report/build-issue-url";

describe("buildIssueUrl", () => {
  it("starts with https://github.com/UCSB-AMPLab/telar-compositor/issues/new", () => {
    const url = buildIssueUrl("hello");
    expect(
      url.startsWith(
        "https://github.com/UCSB-AMPLab/telar-compositor/issues/new?",
      ),
    ).toBe(true);
  });

  it("includes labels=bug query param", () => {
    const url = buildIssueUrl("hello");
    const params = new URL(url).searchParams;
    expect(params.get("labels")).toBe("bug");
  });

  it("URL-encodes the body parameter so '?' and '&' in body do not break parsing", () => {
    const input = "q=1&r=2 ?# yes";
    const url = buildIssueUrl(input);
    expect(new URL(url).searchParams.get("body")).toBe(input);
  });

  it("round-trips a small body: parsing the URL's body param yields the input", () => {
    const input = "Hello, world!\n\n- item one\n- item two";
    const url = buildIssueUrl(input);
    expect(new URL(url).searchParams.get("body")).toBe(input);
  });

  it("does NOT truncate when body is well under 7800 bytes", () => {
    const url = buildIssueUrl("a".repeat(100));
    expect(new URL(url).searchParams.get("body")).not.toContain(
      "<!-- body truncated -->",
    );
  });

  it("appends literal '<!-- body truncated -->' marker when body exceeds ~7800 bytes", () => {
    const longBody = "x".repeat(20000);
    const url = buildIssueUrl(longBody);
    const decoded = new URL(url).searchParams.get("body")!;
    expect(decoded.endsWith("<!-- body truncated -->")).toBe(true);
  });

  it("produces a final URL ≤ 8000 bytes when truncated", () => {
    const longBody = "x".repeat(20000);
    const url = buildIssueUrl(longBody);
    expect(new TextEncoder().encode(url).length).toBeLessThanOrEqual(8000);
  });

  it("body byte length ≤ 7800 when truncated", () => {
    const longBody = "x".repeat(20000);
    const url = buildIssueUrl(longBody);
    const decoded = new URL(url).searchParams.get("body")!;
    expect(new TextEncoder().encode(decoded).length).toBeLessThanOrEqual(7800);
  });

  it("does NOT throw on a 100KB input", () => {
    expect(() => buildIssueUrl("y".repeat(100_000))).not.toThrow();
  });

  it("is byte-accurate via TextEncoder for multi-byte unicode (no off-by-N)", () => {
    const url = buildIssueUrl("🐛".repeat(4000));
    const decoded = new URL(url).searchParams.get("body")!;
    expect(decoded.endsWith("<!-- body truncated -->")).toBe(true);
    expect(new TextEncoder().encode(url).length).toBeLessThanOrEqual(8000);
  });

  // Title param — added 2026-05-10 as a 36.1 hotfix so the GitHub compose page
  // lands with a pre-filled summary line (the user's first bug-report input)
  // instead of a blank Title field.

  it("omits the title query param when no title is provided (back-compat)", () => {
    const url = buildIssueUrl("hello");
    expect(new URL(url).searchParams.has("title")).toBe(false);
  });

  it("omits the title query param when title is an empty string", () => {
    const url = buildIssueUrl("hello", "");
    expect(new URL(url).searchParams.has("title")).toBe(false);
  });

  it("includes the title query param when a non-empty title is provided", () => {
    const url = buildIssueUrl("body text", "publishing failed silently");
    expect(new URL(url).searchParams.get("title")).toBe(
      "publishing failed silently",
    );
  });

  it("URL-encodes the title parameter so '?' and '&' in the title don't break parsing", () => {
    const title = "what does ?foo=bar do & why is it broken";
    const url = buildIssueUrl("body", title);
    expect(new URL(url).searchParams.get("title")).toBe(title);
  });

  it("preserves the title even when the body is truncated under MAX_URL_BYTES", () => {
    const title = "a real-world title for a long body";
    const url = buildIssueUrl("x".repeat(20000), title);
    expect(new URL(url).searchParams.get("title")).toBe(title);
    expect(new TextEncoder().encode(url).length).toBeLessThanOrEqual(8000);
  });
});

describe("deriveIssueTitle", () => {
  it("returns the input unchanged when it is short and single-line", () => {
    expect(deriveIssueTitle("publishing failed silently")).toBe(
      "publishing failed silently",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(deriveIssueTitle("   tap on bug button does nothing   ")).toBe(
      "tap on bug button does nothing",
    );
  });

  it("uses only the first line when the input is multi-line", () => {
    expect(
      deriveIssueTitle("Publish hangs forever\n\nReproduces every time."),
    ).toBe("Publish hangs forever");
  });

  it("normalises CRLF line endings", () => {
    expect(deriveIssueTitle("first line\r\nsecond line")).toBe("first line");
  });

  it("slices to 80 chars by default", () => {
    const longLine =
      "I clicked publish on the story and it just sat there spinning forever and I had to refresh the entire page to recover from it";
    const title = deriveIssueTitle(longLine);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(longLine.startsWith(title)).toBe(true);
  });

  it("returns an empty string when input is empty or whitespace-only", () => {
    expect(deriveIssueTitle("")).toBe("");
    expect(deriveIssueTitle("   \n   ")).toBe("");
  });

  it("respects an explicit maxLen override", () => {
    expect(
      deriveIssueTitle("publishing failed silently", 10),
    ).toBe("publishing");
  });
});
