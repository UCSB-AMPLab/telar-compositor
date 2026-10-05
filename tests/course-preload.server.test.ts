/**
 * Course preloading — what leaves the parent, what reaches the child, and what
 * the join response can honestly say about a retry.
 *
 * Four things this pins, each of which fails quietly if wrong:
 *
 *   - THE FILTER. Only an absolute http(s) source_url can be inherited. A
 *     self-hosted upload's files live in the PARENT's repository, and the
 *     import path stores repository-local audio filenames in the same column,
 *     so a non-null value is not enough: a repo-relative one preloads as
 *     exactly the dead reference the exclusion exists to prevent.
 *   - THE PAYLOAD. `objects.insert` and nothing else. The same endpoint accepts
 *     `config`, `stories` and `objects.remove` under the same signed marker, so
 *     a stray block would overwrite the group's settings or delete their work.
 *   - THE MAPPING. source_url / image_available / thumbnail verbatim, created_by
 *     carried, origin "compositor", featuring off, marker set to the course.
 *   - THE DISCRIMINATION. A skipped insert is either one we preloaded before
 *     (harmless) or the site's own object holding the id first (a real
 *     collision). The response must not conflate them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { preloadCourseObjects, isUrlBackedSource } from "~/lib/course-preload.server";
import type { CoursePreloadEnv } from "~/lib/course-preload.server";
import { probeSequentialMockDb } from "./sync-probe-fixtures";

const COURSE_ID = 900;
const CHILD_ID = 42;

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  stubName: string;
}

/**
 * A fake DO binding that captures the request and answers with a chosen ingest
 * result. `applied.objectInsert` / `skipped.objectInsert` mirror the real
 * endpoint's response shape.
 */
function fakeEnv(
  response: { applied?: Record<string, number>; skipped?: Record<string, string[]> } = {},
  status = 200,
): { env: CoursePreloadEnv; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let lastName = "";
  const env: CoursePreloadEnv = {
    SESSION_SECRET: "test-secret",
    COLLABORATION: {
      idFromName: (name: string) => {
        lastName = name;
        return name;
      },
      get: () => ({
        fetch: async (req: Request) => {
          calls.push({
            url: req.url,
            headers: Object.fromEntries(req.headers.entries()),
            body: JSON.parse(await req.text()) as Record<string, unknown>,
            stubName: lastName,
          });
          return new Response(
            JSON.stringify({ applied: response.applied ?? {}, skipped: response.skipped ?? {} }),
            { status },
          );
        },
      }),
    },
  };
  return { env, calls };
}

function parentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    project_id: COURSE_ID,
    object_id: "obj-1",
    title: "Mapa de la Nueva Granada",
    creator: "Anónimo",
    description: "A description",
    alt_text: "Alt text",
    source_url: "https://iiif.example.org/manifest.json",
    period: "Colonial",
    year: "1600",
    object_type: "map",
    subjects: "cartography",
    source: "An archive",
    credit: "A credit",
    thumbnail: "https://iiif.example.org/thumb.jpg",
    dimensions: "10 x 10 cm",
    extra_columns: '{"accession_number":"ACC-1"}',
    featured: true,
    image_available: true,
    missing_from_repo: false,
    origin: "iiif",
    created_by: 7,
    course_project_id: null,
    updated_at: null,
    ...overrides,
  };
}

/** The insert rows the preload sent, for a run that made exactly one DO call. */
function sentInserts(calls: CapturedCall[]): Array<Record<string, unknown>> {
  const objectsBlock = calls[0].body.objects as { insert: Array<Record<string, unknown>> };
  return objectsBlock.insert;
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

describe("isUrlBackedSource", () => {
  it("accepts absolute http(s) URLs — IIIF manifests and external media alike", () => {
    expect(isUrlBackedSource("https://iiif.example.org/manifest.json")).toBe(true);
    expect(isUrlBackedSource("http://example.org/audio.mp3")).toBe(true);
    expect(isUrlBackedSource("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isUrlBackedSource("  https://example.org/m.json  ")).toBe(true);
  });

  it("rejects everything repository-bound", () => {
    expect(isUrlBackedSource(null), "self-hosted upload").toBe(false);
    expect(isUrlBackedSource(""), "empty cell").toBe(false);
    expect(isUrlBackedSource("   "), "whitespace cell").toBe(false);
    expect(isUrlBackedSource("telar-content/objects/map.jpg"), "repo path").toBe(false);
    expect(isUrlBackedSource("/telar-content/objects/map.jpg"), "root-relative path").toBe(false);
    expect(isUrlBackedSource("interview.mp3"), "repo-local audio filename").toBe(false);
    expect(isUrlBackedSource("file:///etc/passwd"), "non-http scheme").toBe(false);
  });
});

describe("preloadCourseObjects — the filter in use", () => {
  it("preloads only URL-backed rows and names the rest as repo-bound", async () => {
    const db = probeSequentialMockDb([
      [
        parentRow({ id: 1, object_id: "iiif-obj" }),
        parentRow({ id: 2, object_id: "upload-obj", source_url: null }),
        parentRow({ id: 3, object_id: "audio-obj", source_url: "interview.mp3" }),
        parentRow({ id: 4, object_id: "video-obj", source_url: "https://vimeo.com/1" }),
      ],
    ]);
    const { env, calls } = fakeEnv({ applied: { objectInsert: 2 } });

    const result = await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(sentInserts(calls).map((r) => r.object_id)).toEqual(["iiif-obj", "video-obj"]);
    expect(result.inserted).toBe(2);
    expect(result.skippedRepoBound).toEqual(["upload-obj", "audio-obj"]);
  });

  it("makes no DO call at all when the course has nothing URL-backed", async () => {
    const db = probeSequentialMockDb([
      [parentRow({ object_id: "upload-obj", source_url: null })],
    ]);
    const { env, calls } = fakeEnv();

    const result = await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(calls).toHaveLength(0);
    expect(result).toEqual({
      inserted: 0,
      skippedAlreadyOurs: [],
      skippedConflict: [],
      skippedRepoBound: ["upload-obj"],
    });
  });
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

describe("preloadCourseObjects — the payload", () => {
  it("sends objects.insert and NOTHING else", async () => {
    const db = probeSequentialMockDb([[parentRow()]]);
    const { env, calls } = fakeEnv({ applied: { objectInsert: 1 } });

    await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(Object.keys(calls[0].body)).toEqual(["objects"]);
    expect(Object.keys(calls[0].body.objects as object)).toEqual(["insert"]);
  });

  it("addresses the CHILD's document and signs the marker for the child", async () => {
    const db = probeSequentialMockDb([[parentRow()]]);
    const { env, calls } = fakeEnv({ applied: { objectInsert: 1 } });

    await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(calls[0].stubName).toBe(String(CHILD_ID));
    expect(calls[0].headers["x-internal-project"]).toBe(String(CHILD_ID));
    expect(calls[0].headers["x-internal-auth"]).toBeTruthy();
    expect(calls[0].url).toContain("/ingest-sync");
  });

  it("throws on a refused ingest, leaving the preload safe to retry", async () => {
    const db = probeSequentialMockDb([[parentRow()]]);
    const { env } = fakeEnv({}, 409);

    await expect(
      preloadCourseObjects(db, env, { courseProjectId: COURSE_ID, childProjectId: CHILD_ID }),
    ).rejects.toThrow(/409/);
  });
});

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

describe("preloadCourseObjects — the mapping", () => {
  it("carries the image fields verbatim, the attribution, and the marker", async () => {
    const db = probeSequentialMockDb([[parentRow()]]);
    const { env, calls } = fakeEnv({ applied: { objectInsert: 1 } });

    await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    const row = sentInserts(calls)[0];
    // The image is the course's: same URL, same thumbnail, same availability —
    // carried as-is, never re-probed.
    expect(row.source_url).toBe("https://iiif.example.org/manifest.json");
    expect(row.thumbnail).toBe("https://iiif.example.org/thumb.jpg");
    expect(row.image_available).toBe(true);
    // The record is the group's: metadata copied as a starting point.
    expect(row.title).toBe("Mapa de la Nueva Granada");
    expect(row.creator).toBe("Anónimo");
    expect(row.credit).toBe("A credit");
    expect(row.extra_columns).toBe('{"accession_number":"ACC-1"}');
    // Provenance, attribution, marker.
    expect(row.origin).toBe("compositor");
    expect(row.created_by).toBe(7);
    expect(row.course_project_id).toBe(COURSE_ID);
  });

  it("forces featuring off — the homepage is the group's decision", async () => {
    const db = probeSequentialMockDb([[parentRow({ featured: true })]]);
    const { env, calls } = fakeEnv({ applied: { objectInsert: 1 } });

    await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(sentInserts(calls)[0].featured).toBe(false);
  });

  it("carries a broken parent value unchanged rather than healing it", async () => {
    // The filter establishes shape, not reachability: an unreachable URL
    // preloads exactly as broken as the parent already had it.
    const db = probeSequentialMockDb([
      [parentRow({ source_url: "https://gone.example.org/404.json", image_available: false, thumbnail: null })],
    ]);
    const { env, calls } = fakeEnv({ applied: { objectInsert: 1 } });

    await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    const row = sentInserts(calls)[0];
    expect(row.source_url).toBe("https://gone.example.org/404.json");
    expect(row.image_available).toBe(false);
    expect(row.thumbnail).toBeNull();
  });

  it("carries a null created_by rather than inventing an author", async () => {
    const db = probeSequentialMockDb([[parentRow({ created_by: null })]]);
    const { env, calls } = fakeEnv({ applied: { objectInsert: 1 } });

    await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(sentInserts(calls)[0].created_by).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry discrimination
// ---------------------------------------------------------------------------

describe("preloadCourseObjects — retry discrimination", () => {
  it("separates 'we preloaded this before' from a genuine collision", async () => {
    const db = probeSequentialMockDb([
      // Parent rows.
      [
        parentRow({ id: 1, object_id: "ours-again" }),
        parentRow({ id: 2, object_id: "their-own" }),
        parentRow({ id: 3, object_id: "fresh" }),
      ],
      // Child rows read back after the ingest snapshot.
      [
        { object_id: "ours-again", course_project_id: COURSE_ID },
        { object_id: "their-own", course_project_id: null },
        { object_id: "fresh", course_project_id: COURSE_ID },
      ],
    ]);
    const { env } = fakeEnv({
      applied: { objectInsert: 1 },
      skipped: { objectInsert: ["ours-again", "their-own"] },
    });

    const result = await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(result.inserted).toBe(1);
    expect(result.skippedAlreadyOurs).toEqual(["ours-again"]);
    expect(result.skippedConflict).toEqual(["their-own"]);
  });

  it("treats an object marked for a DIFFERENT course as a collision, not ours", async () => {
    const db = probeSequentialMockDb([
      [parentRow({ object_id: "contested" })],
      [{ object_id: "contested", course_project_id: 901 }],
    ]);
    const { env } = fakeEnv({
      applied: { objectInsert: 0 },
      skipped: { objectInsert: ["contested"] },
    });

    const result = await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(result.skippedAlreadyOurs).toEqual([]);
    expect(result.skippedConflict).toEqual(["contested"]);
  });

  it("does not read the child back when the ingest skipped nothing", async () => {
    const selectSpy = vi.fn();
    const db = probeSequentialMockDb([[parentRow()]]);
    const original = db.select;
    // Count the selects: exactly one (the parent read) when nothing was skipped.
    (db as unknown as { select: unknown }).select = (...args: unknown[]) => {
      selectSpy();
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    const { env } = fakeEnv({ applied: { objectInsert: 1 } });

    await preloadCourseObjects(db, env, {
      courseProjectId: COURSE_ID,
      childProjectId: CHILD_ID,
    });

    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});
