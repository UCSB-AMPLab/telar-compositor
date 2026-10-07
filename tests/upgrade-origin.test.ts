/**
 * Reading `?from=` on /upgrade.
 *
 * The value is user-controlled and was passed straight to `redirect()`, which
 * forwards to any origin it names. The parser answers with one of three
 * origins or nothing, and the page only ever navigates to the fixed path an
 * origin maps to — so what matters here is that nothing outside the three
 * reads as one of them. The value arrives already decoded once by
 * URLSearchParams; the encoded cases are what a second decoding would have
 * turned into a match, and must not.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readUpgradeOrigin, upgradeOriginPath } from "~/lib/upgrade-origin";

describe("readUpgradeOrigin", () => {
  it.each([
    ["/publish", "publish"],
    ["/objects", "objects"],
    ["/objects/mission-bell", "objects"],
    ["/start", "start"],
    ["/config", null],
  ] as const)("reads %s as %s", (from, origin) => {
    expect(readUpgradeOrigin(from)).toBe(origin);
  });

  it.each([
    [null],
    [""],
    ["/publishing"],
    ["/objectsx"],
    ["publish"],
    ["https://evil.example/"],
    ["//evil.example/"],
    ["https://compositor.telar.org/publish"],
    ["%2Fpublish"],
    ["/%70ublish"],
    ["/stories"],
  ])("reads %s as nothing", (from) => {
    expect(readUpgradeOrigin(from)).toBeNull();
  });
});

describe("upgradeOriginPath", () => {
  it("returns a fixed path for each origin, never a caller's value", () => {
    expect(upgradeOriginPath("publish")).toBe("/publish");
    expect(upgradeOriginPath("objects")).toBe("/objects");
    expect(upgradeOriginPath("start")).toBe("/start");
  });
});
