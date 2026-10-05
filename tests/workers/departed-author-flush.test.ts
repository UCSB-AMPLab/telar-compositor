/**
 * An edit a warm object holds still saves after its author's account is
 * deleted.
 *
 * The object keeps a person's edit in memory until the next snapshot, and the
 * snapshot writes their id into `last_edited_by`. A deleted account leaves its
 * `users` row behind as a tombstone, so that id still resolves and the write
 * lands: the edit is kept, under the person's name. Run against the real class,
 * real D1 and the real migration chain, so the foreign keys and migration
 * 0057's triggers are the ones production has.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import * as schema from "../../app/db/schema";
import { project_members } from "../../app/db/schema";
import { tombstoneAccount } from "../../app/lib/account-tombstone.server";
import { signInternalMarker } from "../../workers/auth";
import {
  MESSAGE_SYNC,
  drainAcceptanceFrames,
  mintToken,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

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

async function collaboratorMember(fixture: Fixture): Promise<Fixture> {
  const now = new Date().toISOString();
  const githubId = Math.floor(Math.random() * 2 ** 48) + Date.now();
  const user = await env.DB.prepare(
    `INSERT INTO users (
       github_id, github_login, encrypted_access_token, encrypted_refresh_token,
       access_token_expires_at, refresh_token_expires_at, created_at, updated_at
     ) VALUES (?, ?, 'x', 'x', ?, ?, ?, ?) RETURNING id`,
  )
    .bind(githubId, `departing-${githubId}`, now, now, now, now)
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, 'collaborator', ?)`,
  )
    .bind(fixture.projectId, user!.id, now)
    .run();
  return { ...fixture, userId: user!.id, token: await mintToken(user!.id) };
}

function sendUpdate(socket: Socket, state: Uint8Array, mutate: (doc: Y.Doc) => void): void {
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const before = Y.encodeStateVector(client);
  client.transact(() => mutate(client));
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client, before));
  socket.ws.send(encoding.toUint8Array(encoder));
}

async function servedTitle(stub: DurableObjectStub): Promise<string> {
  const bytes = await runInDurableObject(stub, (instance) =>
    Y.encodeStateAsUpdate((instance as unknown as { ydoc: Y.Doc }).ydoc),
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return String(doc.getArray<Y.Map<unknown>>("stories").get(0).get("title"));
}

/** Force a snapshot, and read its body so the object is free to go on. */
async function forceSnapshot(fixture: Fixture): Promise<number> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, "snapshot");
  const response = await stubFor(fixture.projectId).fetch(
    new Request("https://internal/snapshot", {
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

/** What the account deletion writes, through the same function it calls. */
async function deleteAccountRows(fixture: Fixture): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db.batch([
    db.delete(project_members).where(and(eq(project_members.user_id, fixture.userId), eq(project_members.project_id, fixture.projectId))),
    tombstoneAccount(db as never, fixture.userId, new Date().toISOString()),
  ] as never);
}

describe("a departed author's unsaved edit", () => {
  it("is written at the next snapshot, under their id", async () => {
    const fixture = await seedProject("departed-flush");
    const stub = stubFor(fixture.projectId);
    touched.add(stub);
    const departing = await collaboratorMember(fixture);
    const socket = await openSocket(departing, "new");
    const state = await drainAcceptanceFrames(socket);

    sendUpdate(socket, state, (doc) => {
      (doc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text).insert(0, "kept ");
    });
    await vi.waitFor(async () => {
      expect((await servedTitle(stub)).startsWith("kept ")).toBe(true);
    }, { timeout: 5000 });

    await deleteAccountRows(departing);
    const tombstone = await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?")
      .bind(departing.userId)
      .first<{ deleted_at: string | null }>();
    expect(tombstone!.deleted_at).not.toBeNull();

    expect(await forceSnapshot(fixture)).toBe(200);
    const story = await env.DB.prepare("SELECT title, last_edited_by FROM stories WHERE project_id = ?")
      .bind(fixture.projectId)
      .first<{ title: string; last_edited_by: number | null }>();
    expect(story).toEqual({ title: `kept ${fixture.storyTitle}`, last_edited_by: departing.userId });

    try { socket.ws.close(); } catch { /* already closed */ }
  }, 20_000);
});
