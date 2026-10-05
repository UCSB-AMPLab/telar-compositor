/**
 * What a block guarded by `describeWithFrameworkTag` does when the checkout
 * lacks the tag: a gate run with `TELAR_PARITY_REQUIRED=1` cannot let a proof
 * pinned to a released framework skip and still report green.
 *
 * @version v1.5.0-beta
 */

import { describe, expect, it } from "vitest";

import { frameworkTagBlockMode, PARITY_REQUIRED_ENV } from "./helpers/framework-checkout";

describe("the tag-guarded block's mode", () => {
  it("runs with the tag, skips without it, and fails without it when required", () => {
    expect(frameworkTagBlockMode("v1.7.0", {}, true)).toBe("run");
    expect(frameworkTagBlockMode("v1.7.0", { [PARITY_REQUIRED_ENV]: "1" }, true)).toBe("run");
    expect(frameworkTagBlockMode("v9.9.9", {}, false)).toBe("skip");
    expect(frameworkTagBlockMode("v9.9.9", { [PARITY_REQUIRED_ENV]: "1" }, false)).toBe("fail");
  });

  it("reads an absent tag from the checkout as required when the gate says so", () => {
    expect(frameworkTagBlockMode("v0.0.0-no-such-tag", { [PARITY_REQUIRED_ENV]: "1" })).toBe("fail");
  });
});
