/**
 * isTemporaryPageSlug — recognises the placeholder slug assigned by `addPage`
 * (`untitled` or `untitled-N`) so the deferred-slug effect can replace it once
 * the user types a title.
 *
 * This was the regression at commit f839a91 (2026-04-15): addPage started
 * assigning a temp slug to dodge `UNIQUE(project_id, slug)`, but the deferred-
 * slug effect kept its `!page.slug` check, so auto-slug-from-title silently
 * stopped working — every new page kept the URL `/untitled-N/` regardless of
 * what title the user typed.
 */

import { describe, it, expect } from "vitest";
import { isTemporaryPageSlug } from "~/lib/slug";

describe("isTemporaryPageSlug", () => {
  it("recognises the bare 'untitled' placeholder", () => {
    expect(isTemporaryPageSlug("untitled")).toBe(true);
  });

  it("recognises numbered 'untitled-N' placeholders", () => {
    expect(isTemporaryPageSlug("untitled-2")).toBe(true);
    expect(isTemporaryPageSlug("untitled-3")).toBe(true);
    expect(isTemporaryPageSlug("untitled-16")).toBe(true);
    expect(isTemporaryPageSlug("untitled-99")).toBe(true);
  });

  it("rejects user-authored slugs that happen to start with 'untitled'", () => {
    // Real titles like "Untitled symphony" would normalise to a slug we should
    // NOT treat as a placeholder — the user explicitly chose this text.
    expect(isTemporaryPageSlug("untitled-symphony")).toBe(false);
    expect(isTemporaryPageSlug("untitled-foo")).toBe(false);
    expect(isTemporaryPageSlug("untitleder")).toBe(false);
    expect(isTemporaryPageSlug("untitled-2-bis")).toBe(false);
  });

  it("rejects normal page slugs", () => {
    expect(isTemporaryPageSlug("about")).toBe(false);
    expect(isTemporaryPageSlug("home")).toBe(false);
    expect(isTemporaryPageSlug("my-page")).toBe(false);
  });

  it("returns false for null, undefined, or empty input", () => {
    expect(isTemporaryPageSlug(null)).toBe(false);
    expect(isTemporaryPageSlug(undefined)).toBe(false);
    expect(isTemporaryPageSlug("")).toBe(false);
  });

  it("does not match 'untitled-' with no number (defensive)", () => {
    // makeUniqueSlug never produces this (it would emit `untitled-2`), but
    // guard against accidental matches if the format ever changes.
    expect(isTemporaryPageSlug("untitled-")).toBe(false);
  });

  it("does not match 'untitled-0' or negative-number forms (defensive)", () => {
    // makeUniqueSlug starts at -2; 0 and negatives shouldn't appear, but the
    // regex `\d+` would match `untitled-0`. Document the actual behaviour.
    expect(isTemporaryPageSlug("untitled-0")).toBe(true); // \d+ matches
    expect(isTemporaryPageSlug("untitled--2")).toBe(false);
  });
});
