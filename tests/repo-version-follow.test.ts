/**
 * The Compositor records the version the repository names, in both directions.
 * `repoVersionToFollow` decides when D1 should change.
 *
 * @version v1.5.3-beta
 */

import { describe, it, expect } from "vitest";
import { repoVersionToFollow } from "~/lib/repo-version-follow";

describe("repoVersionToFollow", () => {
  it("follows the repository up", () => {
    expect(repoVersionToFollow("1.8.0", "1.7.0")).toBe("1.8.0");
  });

  it("follows the repository down", () => {
    expect(repoVersionToFollow("1.7.0", "1.8.1")).toBe("1.7.0");
  });

  it("follows a downgrade to a release from a prerelease of the same version", () => {
    expect(repoVersionToFollow("1.8.1-rc.1", "1.8.1")).toBe("1.8.1-rc.1");
  });

  it("is null when D1 already holds the version, with or without the v", () => {
    expect(repoVersionToFollow("1.8.1", "1.8.1")).toBeNull();
    expect(repoVersionToFollow("v1.8.1", "1.8.1")).toBeNull();
  });

  it("takes any version the repository names when D1 has none", () => {
    expect(repoVersionToFollow("1.7.0", null)).toBe("1.7.0");
  });

  it("is null when the repository names no version", () => {
    expect(repoVersionToFollow(null, "1.8.1")).toBeNull();
    expect(repoVersionToFollow("", "1.8.1")).toBeNull();
  });

  it("does not replace a readable version with one that does not parse", () => {
    expect(repoVersionToFollow("latest", "1.8.1")).toBeNull();
  });
});
