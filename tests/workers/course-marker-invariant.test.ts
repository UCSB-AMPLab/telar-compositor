/**
 * A course marker does not outlast the site's attachment to its course
 *, against the real class, real D1 and the real migration chain.
 *
 * The race it closes: a preload's ingest lands between a leave's marker clear
 * and its detach batch, so the markers are written while the site is still
 * attached and nothing clears them afterwards. The site's next snapshot drops
 * them, because the object reads the site's parent from D1 and keeps only
 * that course's markers. An ingest after the detach is refused outright.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { signInternalMarker } from "../../workers/auth";
import { drainAcceptanceFrames, openSocket, seedProject, stubFor, type Fixture } from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";

const touched = new Set<DurableObjectStub>();

afterEach(async () => {
  for (const stub of touched) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "test over"); } catch { /* already closed */ }
      }
    });
  }
  touched.clear();
});

async function signed(projectId: number, path: string, action: string, body: unknown): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(projectId, TEST_SECRET, action);
  return new Request(`https://internal${path}`, {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(projectId),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** A course, and the fixture's site attached to it. */
async function attachToCourse(site: Fixture): Promise<number> {
  const now = new Date().toISOString();
  const course = await env.DB.prepare(
    `INSERT INTO projects (user_id, github_repo_full_name, installation_id, kind, created_at, updated_at)
     VALUES (?, ?, 1, 'course', ?, ?) RETURNING id`,
  )
    .bind(site.userId, `harness/course-${site.projectId}-${Date.now()}`, now, now)
    .first<{ id: number }>();
  await env.DB.prepare("UPDATE projects SET parent_project_id = ? WHERE id = ?")
    .bind(course!.id, site.projectId)
    .run();
  return course!.id;
}

async function ingestCourseObject(site: Fixture, courseId: number, objectId: string) {
  const res = await stubFor(site.projectId).fetch(await signed(site.projectId, "/ingest-sync", "ingest-sync", {
    objects: {
      insert: [{
        object_id: objectId,
        title: "A course object",
        source_url: "https://example.org/manifest.json",
        featured: false,
        origin: "compositor",
        course_project_id: courseId,
      }],
    },
  }));
  const body = (await res.json()) as { courseRefused?: { objectInsert?: string[] } };
  return { status: res.status, courseRefused: body.courseRefused?.objectInsert ?? [] };
}

async function markersInDocument(site: Fixture): Promise<Array<number | null>> {
  return runInDurableObject(stubFor(site.projectId), (instance) => {
    const doc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    return doc.getArray<Y.Map<unknown>>("objects").toArray()
      .map((m) => (m.get("course_project_id") as number | undefined) ?? null);
  });
}

async function markersInD1(site: Fixture): Promise<Array<number | null>> {
  const rows = await env.DB.prepare("SELECT course_project_id FROM objects WHERE project_id = ? ORDER BY object_id")
    .bind(site.projectId)
    .all<{ course_project_id: number | null }>();
  return rows.results.map((r) => r.course_project_id);
}

async function forceSnapshot(site: Fixture): Promise<number> {
  const res = await stubFor(site.projectId).fetch(await signed(site.projectId, "/snapshot", "snapshot", {}));
  await res.text();
  return res.status;
}

describe("a course marker and the site's attachment", () => {
  it("is dropped at the next snapshot when it landed between a leave's clear and its detach", async () => {
    const site = await seedProject("marker-window");
    touched.add(stubFor(site.projectId));
    const course = await attachToCourse(site);

    // The leave's clear has run on an empty document; the preload lands now,
    // while D1 still has the site attached.
    const landed = await ingestCourseObject(site, course, "course-object");
    expect(landed).toEqual({ status: 200, courseRefused: [] });
    expect(await markersInDocument(site)).toEqual([course]);

    // The leave's batch detaches the site.
    await env.DB.prepare("UPDATE projects SET parent_project_id = NULL WHERE id = ?").bind(site.projectId).run();

    expect(await forceSnapshot(site)).toBe(200);
    expect(await markersInDocument(site)).toEqual([null]);
    expect(await markersInD1(site)).toEqual([null]);
  }, 20_000);

  it("is refused when the preload lands after the site has left", async () => {
    const site = await seedProject("marker-late");
    touched.add(stubFor(site.projectId));
    const course = await attachToCourse(site);
    await env.DB.prepare("UPDATE projects SET parent_project_id = NULL WHERE id = ?").bind(site.projectId).run();

    const late = await ingestCourseObject(site, course, "course-object");
    expect(late).toEqual({ status: 200, courseRefused: ["course-object"] });
    expect(await markersInDocument(site)).toEqual([]);
  }, 20_000);

  it("is dropped at the next snapshot when the course itself is deleted", async () => {
    const site = await seedProject("marker-course-gone");
    touched.add(stubFor(site.projectId));
    const course = await attachToCourse(site);
    await ingestCourseObject(site, course, "course-object");

    // The course row goes; the foreign keys clear the site's parent link and
    // the D1 marker, and the document still holds its copy.
    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(course).run();
    expect(await markersInDocument(site)).toEqual([course]);

    expect(await forceSnapshot(site)).toBe(200);
    expect(await markersInDocument(site)).toEqual([null]);
  }, 20_000);

  it("is not rebuilt into the document by a reset from a D1 row that still holds it", async () => {
    const site = await seedProject("marker-reset");
    touched.add(stubFor(site.projectId));
    const course = await attachToCourse(site);
    await env.DB.prepare("UPDATE projects SET parent_project_id = NULL WHERE id = ?").bind(site.projectId).run();
    // A clear whose flush failed leaves D1 marked for a course the site has
    // since left.
    await env.DB.prepare(
      `INSERT INTO objects (project_id, object_id, title, course_project_id, origin)
       VALUES (?, 'stranded', 'Stranded', ?, 'compositor')`,
    ).bind(site.projectId, course).run();

    const res = await stubFor(site.projectId).fetch(await signed(site.projectId, "/reset", "reset", {}));
    await res.text();
    expect(res.status).toBe(200);
    expect(await markersInDocument(site)).toEqual([null]);
  }, 20_000);

  it("is not loaded into the document from a D1 row that still holds it", async () => {
    const site = await seedProject("marker-load");
    touched.add(stubFor(site.projectId));
    const course = await attachToCourse(site);
    await env.DB.prepare("UPDATE projects SET parent_project_id = NULL WHERE id = ?").bind(site.projectId).run();
    await env.DB.prepare(
      `INSERT INTO objects (project_id, object_id, title, course_project_id, origin)
       VALUES (?, 'stranded', 'Stranded', ?, 'compositor')`,
    ).bind(site.projectId, course).run();

    // The first socket's admission loads the document; no snapshot has run.
    const socket = await openSocket(site, "new");
    await drainAcceptanceFrames(socket);
    expect(await markersInDocument(site)).toEqual([null]);
    socket.ws.close();
  }, 20_000);
});
