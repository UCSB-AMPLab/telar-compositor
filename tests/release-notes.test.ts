import { describe, it, expect } from "vitest";
import { CURRENT_RELEASE, shouldShowReleaseNote } from "~/lib/release-notes";

describe("release-notes", () => {
  it("exposes the current release id, i18n key, and a contributors array", () => {
    expect(CURRENT_RELEASE.id).toBe("1.3.0-beta");
    expect(CURRENT_RELEASE.i18nKey).toBe("v1_3_0_beta");
    expect(Array.isArray(CURRENT_RELEASE.contributors)).toBe(true);
  });

  it("shows when the user's last-seen release differs and no welcome is pending", () => {
    expect(shouldShowReleaseNote(null, false)).toBe(true);
    expect(shouldShowReleaseNote("1.2.1-beta", false)).toBe(true);
  });

  it("does not show when the user has already seen this release", () => {
    expect(shouldShowReleaseNote("1.3.0-beta", false)).toBe(false);
  });

  it("never shows while the added-to-project welcome modal is pending", () => {
    expect(shouldShowReleaseNote(null, true)).toBe(false);
  });
});
