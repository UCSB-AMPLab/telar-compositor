/**
 * A config repair goes through the collaboration document, not around it
 *, against the real object and real sockets.
 *
 * A value written to D1 alone is written back by a warm document, and a
 * document rebuilt from D1 loses every editor's changes since the last
 * snapshot. Through `/ingest-sync`, the value is applied to the document,
 * snapshotted and sent to the editors, and nothing is rebuilt. These cases
 * send the request the helper sends.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

import { repairConfigThroughDocument } from "~/lib/config-repair.server";
import {
  MESSAGE_SYNC,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
} from "./helpers/collaboration-client";

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

/** A project whose config row holds the values a repair corrects. */
async function seedWithConfig(label: string, sheets: boolean): Promise<Fixture> {
  const fixture = await seedProject(label);
  touched.add(stubFor(fixture.projectId));
  await env.DB.prepare(
    `INSERT INTO project_config (project_id, title, url, baseurl, google_sheets_enabled)
     VALUES (?, 'Site', 'https://old.example.org', '/old', ?)`,
  )
    .bind(fixture.projectId, sheets ? 1 : 0)
    .run();
  return fixture;
}

function configRow(projectId: number) {
  return env.DB.prepare(
    "SELECT title, url, baseurl, google_sheets_enabled FROM project_config WHERE project_id = ?",
  )
    .bind(projectId)
    .first<{ title: string; url: string; baseurl: string; google_sheets_enabled: number }>();
}

/** The document's config values and generation, read inside the object. */
function documentConfig(fixture: Fixture) {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const inner = instance as unknown as { ydoc: Y.Doc; docGeneration: number | null };
    const config = inner.ydoc.getMap<unknown>("config");
    return {
      title: String(config.get("title") ?? ""),
      url: config.get("url"),
      baseurl: config.get("baseurl"),
      sheets: config.get("google_sheets_enabled"),
      generation: inner.docGeneration,
    };
  });
}

/** An editor's update to the title, sent the way the client sends it. */
function editTitle(state: Uint8Array, prefix: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  let update: Uint8Array | null = null;
  doc.on("update", (u: Uint8Array) => { update = u; });
  (doc.getMap("config").get("title") as Y.Text).insert(0, prefix);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update!);
  return encoding.toUint8Array(encoder);
}

describe("a config repair through the document", () => {
  it("lands in the document, the editors and D1, and keeps an editor's unsaved change", async () => {
    const fixture = await seedWithConfig("repair-warm", true);
    const socket = await openSocket(fixture, "0");
    const state = await drainAcceptanceFrames(socket);

    // An edit nobody has snapshotted yet: in the document, not in D1.
    socket.ws.send(editTitle(state, "Edited "));
    await vi.waitFor(async () => expect((await documentConfig(fixture)).title).toBe("Edited Site"));
    expect((await configRow(fixture.projectId))?.title).toBe("Site");
    const before = await documentConfig(fixture);

    const outcome = await repairConfigThroughDocument(env as never, fixture.projectId, {
      url: "https://owner.github.io",
      baseurl: "/repo",
      google_sheets_enabled: false,
    });

    expect(outcome).toBe("applied");
    const after = await documentConfig(fixture);
    expect(after).toMatchObject({ url: "https://owner.github.io", baseurl: "/repo", sheets: false });
    // Nothing was rebuilt: the same generation, and the unsaved title is kept,
    // which a rebuild from D1 would have lost.
    expect(after.generation).toBe(before.generation);
    expect(after.title).toBe("Edited Site");
    expect(await configRow(fixture.projectId)).toEqual({
      title: "Edited Site",
      url: "https://owner.github.io",
      baseurl: "/repo",
      google_sheets_enabled: 0,
    });
    // The editor stays connected, and what it is sent carries the repair.
    const frame = decoding.createDecoder(await socket.next());
    expect(decoding.readVarUint(frame)).toBe(MESSAGE_SYNC);
    const editor = new Y.Doc();
    Y.applyUpdate(editor, state);
    syncProtocol.readSyncMessage(frame, encoding.createEncoder(), editor, "server");
    const seen = editor.getMap<unknown>("config");
    expect([seen.get("url"), seen.get("baseurl"), seen.get("google_sheets_enabled")])
      .toEqual(["https://owner.github.io", "/repo", false]);
    expect(socket.closes).toEqual([]);
  });

  it("refuses to turn Google Sheets on, or a flag sent as a string, and changes nothing", async () => {
    const fixture = await seedWithConfig("repair-refused", true);
    await drainAcceptanceFrames(await openSocket(fixture, "0"));
    const sheetsOff = await seedWithConfig("repair-refused-off", false);
    await drainAcceptanceFrames(await openSocket(sheetsOff, "0"));

    expect(
      await repairConfigThroughDocument(env as never, sheetsOff.projectId, { google_sheets_enabled: true as never }),
    ).toBe("refused");
    expect(
      await repairConfigThroughDocument(env as never, fixture.projectId, { google_sheets_enabled: "false" as never }),
    ).toBe("refused");

    expect((await documentConfig(sheetsOff)).sheets).toBe(false);
    expect((await configRow(sheetsOff.projectId))?.google_sheets_enabled).toBe(0);
    expect((await documentConfig(fixture)).sheets).toBe(true);
    expect((await configRow(fixture.projectId))?.google_sheets_enabled).toBe(1);
  });

  it("applies to a cold object whose project has no config row, and creates the row", async () => {
    const fixture = await seedProject("repair-cold");
    touched.add(stubFor(fixture.projectId));

    const outcome = await repairConfigThroughDocument(env as never, fixture.projectId, {
      url: "https://owner.github.io",
      baseurl: "/repo",
    });

    expect(outcome).toBe("applied");
    expect(await configRow(fixture.projectId)).toMatchObject({
      url: "https://owner.github.io",
      baseurl: "/repo",
    });
  });
});
