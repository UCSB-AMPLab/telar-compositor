/**
 * The rule a site's document keeps for course markers, as pure
 * functions: a marker stands only for the course the site is attached to.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import { dropStrandedMarkers, markerAllowed, markerCourse } from "../workers/course-marker-invariant";

function objects(markers: unknown[]): Y.Array<Y.Map<unknown>> {
  const doc = new Y.Doc();
  const array = doc.getArray<Y.Map<unknown>>("objects");
  doc.transact(() => {
    for (const marker of markers) {
      const m = new Y.Map<unknown>();
      if (marker !== undefined) m.set("course_project_id", marker);
      array.push([m]);
    }
  });
  return array;
}

describe("the course marker rule", () => {
  it("reads only a positive integer as a course", () => {
    expect([900, 0, -1, 1.5, "900", null, undefined].map(markerCourse)).toEqual([900, null, null, null, null, null, null]);
  });

  it("allows an unmarked object anywhere, and a marked one only on the course's site", () => {
    expect(markerAllowed(null, null)).toBe(true);
    expect(markerAllowed(900, 900)).toBe(true);
    expect(markerAllowed(900, 901)).toBe(false);
    expect(markerAllowed(900, null)).toBe(false);
  });

  it("drops every marker but the parent's, malformed ones included, and says whether it did", () => {
    const array = objects([900, 901, undefined, "900", 900]);
    expect(dropStrandedMarkers(array, 900)).toBe(true);
    expect(array.toArray().map((m) => (m.has("course_project_id") ? m.get("course_project_id") : "none"))).toEqual([
      900, "none", "none", "none", 900,
    ]);
    expect(dropStrandedMarkers(array, 900)).toBe(false);
  });

  it("drops every marker on a site in no course", () => {
    const array = objects([900, 901]);
    expect(dropStrandedMarkers(array, null)).toBe(true);
    expect(array.toArray().some((m) => m.has("course_project_id"))).toBe(false);
  });
});
