/**
 * Seeding a project and driving a real client socket, for the workers project.
 *
 * Storage is shared across this project's files, so every fixture mints ids of
 * its own and nothing here reads a row another test wrote.
 *
 * The frames the server sends on acceptance are queued as they arrive rather
 * than awaited one at a time: all four are sent before `accept()` returns, so a
 * test that read them one request at a time would find the later ones already
 * past.
 *
 * @version v1.5.0-beta
 */

import { expect } from "vitest";
import { env } from "cloudflare:workers";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type * as Y from "yjs";

import worker from "../entry";

/** The wire constants the Durable Object writes, restated so drift goes red. */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_SESSION_CONTROL = 2;
export const SUB_STATE_RESET = 0x03;
export const SUB_DOC_GENERATION = 0x04;
export const SUB_FREEZE = 0x05;

/** The value the pool binds; tokens have to be signed with the same secret. */
const TEST_SESSION_SECRET = "test-session-secret";

/** Encode bytes as base64url (no padding), matching the cookie token shape. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a `<base64url(JSON)>.<base64url(HMAC-SHA256)>` session token of the shape
 * `getUserIdFromToken` verifies: a numeric `userId` and a `createdAt` inside the
 * seven-day window, signed over the payload segment.
 */
export async function mintToken(userId: number): Promise<string> {
  const enc = new TextEncoder();
  const payload = JSON.stringify({ userId, createdAt: new Date().toISOString() });
  const payloadB64 = base64urlEncode(enc.encode(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(TEST_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return `${payloadB64}.${base64urlEncode(new Uint8Array(sig))}`;
}

export interface Fixture {
  userId: number;
  projectId: number;
  token: string;
  /** The one story's title, seeded so a document rebuilt from D1 carries
   *  content a reader can tell apart from an empty, unloaded one. */
  storyTitle: string;
}

// A per-module counter, folded into `nextGithubId`'s random component below.
let githubIdCounter = 0;

/**
 * `github_id` carries a unique index, so it has to be collision-free across
 * every seeded user in this project's shared storage. The value is a 48-bit
 * `crypto.getRandomValues` draw — 2^48 possibilities — with a monotonic
 * counter added on top, so even the negligible chance of two draws landing on
 * the same random value still leaves them distinguished by the counter.
 */
function nextGithubId(): number {
  githubIdCounter += 1;
  const randomBytes = new Uint8Array(6);
  crypto.getRandomValues(randomBytes);
  let random = 0;
  for (const byte of randomBytes) {
    random = random * 256 + byte;
  }
  return random + githubIdCounter;
}

/**
 * One user, one project, one `convenor` membership and one story, all with
 * ids of their own. The story's title is derived from the same unique label
 * as the rest of the fixture, so a document rebuilt from these rows carries
 * content traceable to this call rather than to any other test's.
 */
export async function seedProject(label: string): Promise<Fixture> {
  const unique = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const now = new Date().toISOString();

  const user = await env.DB.prepare(
    `INSERT INTO users (
       github_id, github_login, encrypted_access_token, encrypted_refresh_token,
       access_token_expires_at, refresh_token_expires_at, created_at, updated_at
     ) VALUES (?, ?, 'x', 'x', ?, ?, ?, ?) RETURNING id`,
  )
    .bind(nextGithubId(), unique, now, now, now, now)
    .first<{ id: number }>();

  const project = await env.DB.prepare(
    `INSERT INTO projects (
       user_id, github_repo_full_name, installation_id, created_at, updated_at
     ) VALUES (?, ?, 1, ?, ?) RETURNING id`,
  )
    .bind(user!.id, `harness/${unique}`, now, now)
    .first<{ id: number }>();

  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, 'convenor', ?)`,
  )
    .bind(project!.id, user!.id, now)
    .run();

  const storyTitle = `Story ${unique}`;
  await env.DB.prepare(
    `INSERT INTO stories (project_id, story_id, title) VALUES (?, 's1', ?)`,
  )
    .bind(project!.id, storyTitle)
    .run();

  return {
    userId: user!.id,
    projectId: project!.id,
    token: await mintToken(user!.id),
    storyTitle,
  };
}

export function stubFor(projectId: number): DurableObjectStub {
  return env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
}

/** A client end of an admitted socket, with everything the server sent queued. */
export interface Socket {
  ws: WebSocket;
  closes: Array<{ code: number; reason: string }>;
  next(): Promise<Uint8Array>;
}

/**
 * The upgrade request a browser sends, with the generation it claims and,
 * when given, the awareness client id it declares.
 */
export function upgradeRequest(fixture: Fixture, generation: string, awarenessClientId?: number): Request {
  const declared = awarenessClientId === undefined ? "" : `&aw=${awarenessClientId}`;
  return new Request(
    `https://harness/ws/${fixture.projectId}?token=${encodeURIComponent(fixture.token)}&gen=${generation}${declared}`,
    { headers: { Upgrade: "websocket" } },
  );
}

/** Drive one upgrade and hand back whatever the worker answered. */
export function attemptUpgrade(fixture: Fixture, generation: string, awarenessClientId?: number): Promise<Response> {
  return worker.fetch(upgradeRequest(fixture, generation, awarenessClientId), env);
}

export async function openSocket(fixture: Fixture, generation: string, awarenessClientId?: number): Promise<Socket> {
  const response = await attemptUpgrade(fixture, generation, awarenessClientId);

  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).not.toBeNull();

  const queued: Uint8Array[] = [];
  const waiting: ((frame: Uint8Array) => void)[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  ws!.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as ArrayBuffer | string;
    const frame =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else queued.push(frame);
  });
  ws!.addEventListener("close", (event: CloseEvent) => {
    closes.push({ code: event.code, reason: event.reason });
  });
  ws!.accept();

  return {
    ws: ws!,
    closes,
    next() {
      const queuedFrame = queued.shift();
      if (queuedFrame) return Promise.resolve(queuedFrame);
      return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("no frame arrived")), 5000);
        waiting.push((frame) => {
          clearTimeout(timer);
          resolvePromise(frame);
        });
      });
    },
  };
}

/** The freeze frame in `frame`, parsed; fails the test for any other frame. */
export function readFreezeFrame(frame: Uint8Array): {
  leases: Array<{ rev: number; kind: string; userId: number; remainingMs: number }>;
  ended: Array<{ rev: number; kind: string; userId: number; outcome: string }>;
} {
  const decoder = decoding.createDecoder(frame);
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SESSION_CONTROL);
  expect(decoding.readUint8(decoder)).toBe(SUB_FREEZE);
  return JSON.parse(decoding.readVarString(decoder));
}

/**
 * Read the five frames the server sends on acceptance, asserting each, and
 * return the document state that came with sync step 2.
 *
 * The second is the freeze as it stands. The fifth is awareness: `new Awareness(doc)` gives the server its own local
 * state, so `awarenessStates` is never empty and the awareness frame is always
 * sent. A test that stopped after sync step 2 would find it waiting in the
 * queue and read it as the answer to whatever it sent next.
 */
export async function drainAcceptanceFrames(
  socket: Socket,
  generation = 0,
): Promise<Uint8Array> {
  const control = decoding.createDecoder(await socket.next());
  expect(decoding.readVarUint(control)).toBe(MESSAGE_SESSION_CONTROL);
  expect(decoding.readUint8(control)).toBe(SUB_DOC_GENERATION);
  expect(decoding.readVarUint(control)).toBe(generation);

  readFreezeFrame(await socket.next());

  const step1 = decoding.createDecoder(await socket.next());
  expect(decoding.readVarUint(step1)).toBe(MESSAGE_SYNC);
  expect(decoding.readVarUint(step1)).toBe(syncProtocol.messageYjsSyncStep1);

  const step2 = decoding.createDecoder(await socket.next());
  expect(decoding.readVarUint(step2)).toBe(MESSAGE_SYNC);
  expect(decoding.readVarUint(step2)).toBe(syncProtocol.messageYjsSyncStep2);
  const state = decoding.readVarUint8Array(step2);

  const awareness = decoding.createDecoder(await socket.next());
  expect(decoding.readVarUint(awareness)).toBe(MESSAGE_AWARENESS);

  return state;
}

/**
 * A second user with a membership of `role` on `fixture`'s project, and a
 * session of their own.
 */
export async function addMember(
  fixture: Fixture,
  label: string,
  role: "convenor" | "collaborator" | "instructor" = "collaborator",
): Promise<Fixture> {
  const unique = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const now = new Date().toISOString();
  const user = await env.DB.prepare(
    `INSERT INTO users (
       github_id, github_login, encrypted_access_token, encrypted_refresh_token,
       access_token_expires_at, refresh_token_expires_at, created_at, updated_at
     ) VALUES (?, ?, 'x', 'x', ?, ?, ?, ?) RETURNING id`,
  )
    .bind(nextGithubId(), unique, now, now, now, now)
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(fixture.projectId, user!.id, role, now)
    .run();
  return { ...fixture, userId: user!.id, token: await mintToken(user!.id) };
}

/** A client sync step 1, the message a reconnecting editor sends first. */
export function clientSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}
