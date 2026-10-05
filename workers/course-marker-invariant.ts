/**
 * A site's document holds a course marker only for the course the site is
 * attached to.
 *
 * `course_project_id` on an object makes it the course's: a site cannot
 * delete it. A preload in flight when the site leaves its course, or when the
 * course is deleted, can write markers after the leave has cleared them, and
 * a load can restore them from a blob or from D1. Ordering those operations
 * against each other cannot be done from outside the object, so the object
 * holds the rule itself, wherever markers enter the document and wherever the
 * document meets D1: an insert carrying another course's marker is refused,
 * and a marker naming any course but the site's parent is dropped at load and
 * before each snapshot.
 *
 * The parent is read from D1 by the caller, inside the object's serialised
 * section. It is null for a site in no course, and for one whose course was
 * deleted, since the parent link clears with the course row.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

/** The course a marker value names, or null when it names none. */
export function markerCourse(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Whether an object may carry a marker for `course` on a site whose parent is `parent`. */
export function markerAllowed(course: number | null, parent: number | null): boolean {
  return course === null || course === parent;
}

/**
 * Drop every marker in `objects` that does not name `parent`, including one
 * that is not a well-formed course id at all. Returns whether any was dropped.
 * The caller runs this inside a transaction, so the change reaches the log and
 * the peers as one.
 */
export function dropStrandedMarkers(
  objects: Y.Array<Y.Map<unknown>>,
  parent: number | null,
): boolean {
  let dropped = false;
  objects.forEach((entry) => {
    if (!(entry instanceof Y.Map) || !entry.has("course_project_id")) return;
    const course = markerCourse(entry.get("course_project_id"));
    if (course !== null && course === parent) return;
    entry.delete("course_project_id");
    dropped = true;
  });
  return dropped;
}
