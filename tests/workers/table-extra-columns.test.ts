/**
 * Removing a refused custom column from every object or glossary term,
 * against the real class, real D1 and the real migration chain.
 *
 * Objects hold the column in the document, so the route removes it there and
 * D1 agrees before it answers. Glossary terms never carry it in the document;
 * the route writes D1, and a snapshot afterwards leaves the removal standing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { signInternalMarker } from "../../workers/auth";
import { tableColumnDetail } from "~/lib/story-columns";
import { hibernate } from "./helpers/hibernate";
import { drainAcceptanceFrames, openSocket, seedProject, stubFor, type Fixture } from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";
const opened: DurableObjectStub[] = [];

afterEach(async () => {
  for (const stub of opened.splice(0)) {
    try { await hibernate(stub); } catch { /* already gone */ }
  }
});

const j = (o: Record<string, string>) => JSON.stringify(o);

async function call(fixture: Fixture, op: string, path: string, detail?: string): Promise<number> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, op, undefined, detail);
  const response = await stubFor(fixture.projectId).fetch(
    new Request(`https://internal${path}`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(fixture.projectId),
      },
    }),
  );
  await response.text();
  return response.status;
}

const removeColumn = (fixture: Fixture, table: string, column: string, signedFor = table) =>
  call(
    fixture,
    "remove-table-column",
    `/remove-table-column?${new URLSearchParams({ table, column })}`,
    tableColumnDetail(signedFor, column),
  );

async function seedGlossary(fixture: Fixture, blobs: Array<string | null>): Promise<void> {
  for (let i = 0; i < blobs.length; i++) {
    await env.DB.prepare(
      "INSERT INTO glossary_terms (project_id, term_id, title, order_key, extra_columns) VALUES (?, ?, ?, ?, ?)",
    ).bind(fixture.projectId, `t${i}`, `Term ${i}`, `a${i}`, blobs[i]).run();
  }
}

async function glossaryExtras(fixture: Fixture): Promise<Array<string | null>> {
  const rows = await env.DB.prepare("SELECT extra_columns FROM glossary_terms WHERE project_id = ? ORDER BY term_id")
    .bind(fixture.projectId).all<{ extra_columns: string | null }>();
  return rows.results.map((r) => r.extra_columns);
}

async function objectExtras(fixture: Fixture): Promise<Array<string | null>> {
  const rows = await env.DB.prepare("SELECT extra_columns FROM objects WHERE project_id = ? ORDER BY object_id")
    .bind(fixture.projectId).all<{ extra_columns: string | null }>();
  return rows.results.map((r) => r.extra_columns);
}

describe("removing a refused column from every row of a table", () => {
  it("clears glossary terms in D1 and keeps the removal through a snapshot", async () => {
    const fixture = await seedProject("glossary-remove");
    await seedGlossary(fixture, [j({ _metadata: "a", nota: "una" }), j({ _metadata: "" }), null]);
    opened.push(stubFor(fixture.projectId));
    await drainAcceptanceFrames(await openSocket(fixture, "0"));

    expect(await removeColumn(fixture, "glossary", "_metadata")).toBe(200);
    expect(await glossaryExtras(fixture)).toEqual([j({ nota: "una" }), "{}", null]);

    expect(await call(fixture, "snapshot", "/snapshot")).toBe(200);
    expect(await glossaryExtras(fixture)).toEqual([j({ nota: "una" }), "{}", null]);
  });

  it("clears objects in the document and has D1 agree before it answers", async () => {
    const fixture = await seedProject("objects-remove");
    for (const [id, blob] of [["o1", j({ _metadata: "a", nota: "una" })], ["o2", j({ _metadata: "" })], ["o3", null]] as const) {
      await env.DB.prepare(
        "INSERT INTO objects (project_id, object_id, title, order_key, extra_columns, image_available) VALUES (?, ?, ?, ?, ?, 0)",
      ).bind(fixture.projectId, id, `Title ${id}`, `a${id}`, blob).run();
    }
    opened.push(stubFor(fixture.projectId));
    await drainAcceptanceFrames(await openSocket(fixture, "0"));

    expect(await removeColumn(fixture, "objects", "_metadata")).toBe(200);
    // An object that held none is written "" by the snapshot, as for any save.
    expect(await objectExtras(fixture)).toEqual([j({ nota: "una" }), "{}", ""]);
  });

  it("refuses a request signed for another table or column", async () => {
    const fixture = await seedProject("table-remove-signed");
    opened.push(stubFor(fixture.projectId));
    expect(await removeColumn(fixture, "glossary", "_metadata", "objects")).not.toBe(200);
    expect(await call(fixture, "remove-table-column", "/remove-table-column?table=steps&column=x", tableColumnDetail("steps", "x"))).toBe(400);
  });
});
