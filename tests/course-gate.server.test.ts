/**
 * Who may create and run courses.
 *
 * This replaces a shared password held in an environment variable and answered
 * once per session. That gated ACCESS without settling WHO, and the cost of
 * leaving it open showed up in two places: the word sat in plaintext in a
 * tracked config file, so the gate was only as closed as the repository; and
 * access being a property of the SESSION meant the door had to be advertised
 * to be findable, so every signed-in person was shown an invitation to unlock
 * a feature reserved for a group they were not in.
 *
 * Access is a property of the PERSON now. The tests below pin the two things
 * that follow from that and one that does not change:
 *
 *   - Closed is the state a row arrives in. The column defaults to 0, so a
 *     deploy that grants nothing opens nothing — the same doctrine the
 *     environment variable had to state explicitly, now enforced by the schema.
 *   - No caller means no access, for the same reason.
 *   - The refusal carries no detail, as its predecessor did not.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { mayUseCourses, requireCourseAccess } from "~/lib/course-gate.server";

type UserFlag = { course_access: boolean };

describe("mayUseCourses", () => {
  it("admits a person the flag was granted to", () => {
    expect(mayUseCourses({ course_access: true } as UserFlag)).toBe(true);
  });

  it("refuses a person it was not", () => {
    expect(mayUseCourses({ course_access: false } as UserFlag)).toBe(false);
  });

  it("refuses when there is no user at all", () => {
    expect(mayUseCourses(null)).toBe(false);
    expect(mayUseCourses(undefined)).toBe(false);
  });

  it("refuses anything that is not the boolean true", () => {
    // The column is read, never rendered or coerced: a row that somehow
    // carried 1, "1" or "true" is not a grant this function invents.
    for (const value of [1, "1", "true", {}, []] as unknown[]) {
      expect(mayUseCourses({ course_access: value } as unknown as UserFlag)).toBe(false);
    }
  });
});

describe("requireCourseAccess", () => {
  it("returns quietly for a person with access", () => {
    expect(() => requireCourseAccess({ course_access: true } as UserFlag)).not.toThrow();
  });

  it("throws a bare 403 for anyone else, saying nothing about why", async () => {
    for (const user of [{ course_access: false } as UserFlag, null, undefined]) {
      let thrown: unknown;
      try {
        requireCourseAccess(user);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Response);
      const response = thrown as Response;
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
    }
  });
});
