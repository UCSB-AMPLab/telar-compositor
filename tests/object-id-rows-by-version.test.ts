/**
 * Whether the two warnings about rows sharing an object id say the site uses
 * the same row everywhere, by the site's framework version.
 *
 * From Telar 1.8.0 the build keeps the last row of each id and every page
 * reads that one (`_keep_the_last_of_each_id`, `scripts/telar/processors/
 * objects/frame.py`). Before it, some parts of the site read the first row
 * and others the last. A version with no readable release reads as 1.7.0, and a
 * pre-release as the release it names, as every other version-dependent read
 * in `object-id` does.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { repeatedIdIssues, sharedSiteIdIssues } from "~/lib/object-id";

const REPEATED = [{ object_id: "map" }, { object_id: "o1" }, { object_id: "map" }];
const SHARED = [{ object_id: "map" }, { object_id: "o1" }, { object_id: "map.jpg" }];

const CASES: Array<[string, string | null, boolean]> = [
  ["1.8.0", "1.8.0", true],
  ["a later release", "v1.9.2", true],
  ["a 1.8.0 pre-release", "1.8.0-rc.1", true],
  ["1.7.0", "1.7.0", false],
  ["an older release", "0.9.0-beta", false],
  ["no version", null, false],
  ["an unreadable version", "latest", false],
];

describe("an object_id written in more than one row", () => {
  for (const [label, version, everywhere] of CASES) {
    it(`on ${label}, says the site ${everywhere ? "uses the last row everywhere" : "reads different rows in different places"}`, () => {
      expect(repeatedIdIssues(REPEATED, version)).toEqual([
        { code: "object_id_repeated", id: "map", sameRowEverywhere: everywhere },
      ]);
    });
  }
});

describe("ids the site reads as one object", () => {
  for (const [label, version, everywhere] of CASES) {
    it(`on ${label}, says the site ${everywhere ? "uses the last row everywhere" : "reads different rows in different places"}`, () => {
      expect(sharedSiteIdIssues(SHARED, version)).toEqual([
        { code: "object_site_id_shared", ids: ["map", "map.jpg"], shown: "map.jpg", sameRowEverywhere: everywhere },
      ]);
    });
  }
});
