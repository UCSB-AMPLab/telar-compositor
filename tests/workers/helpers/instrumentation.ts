/**
 * Instrumenting one `ProjectCollaborationDO` instance, for the workers project.
 *
 * Everything here belongs to ONE instance and does not survive an eviction: the
 * policy seam, the retirement budget, the D1 wrapper and the storage probe are
 * all installed on the instance that has to carry them, and a test that evicts
 * reinstalls whatever the next instance needs.
 *
 * The signed request builder lives here too: every file that mints an internal
 * marker needs the op, the binding and the method to travel together, and a
 * marker signed for one control string and sent with another is refused at
 * the far end, which is the whole point of binding it.
 *
 * @version v1.5.0-beta
 */

import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { expect, vi } from "vitest";

import { signInternalMarker } from "../../../workers/auth";
import { MAX_RECORD_BYTES } from "../../../workers/doc-log";
import { MESSAGE_SYNC, type Fixture, type Socket } from "./collaboration-client";

const TEST_SECRET = "test-session-secret";

/** The thresholds every compaction fixture runs under: twenty records, or 8 MiB. */
export const SEAM_RECORDS = 20;

/** The instance fields the tests reach for, named once. */
export interface Internals {
  docSeq: number | null;
  docGeneration: number | null;
  docLoaded: boolean;
  baseSeq: number | null;
  logBytesSinceBase: number;
  projectId: number | null;
  environment: string;
  nonce: string;
  ydoc: Y.Doc;
  env: { DB: D1Database };
  ctx: DurableObjectState;
  compactionPolicy: { records: number; bytes: number; ceiling: number; partLimit?: number };
  retirementBudget: { deletes?: number; lists?: number };
  storageProbe: unknown;
  lastAlarm: unknown;
  alarmRing: unknown[];
  isSnapshotting: boolean;
  ensureDocLoaded: () => Promise<void>;
  bindIdentity: () => Promise<boolean>;
  refusePastHalt: () => void;
  scheduleSnapshot: () => Promise<void>;
  snapshotToD1: () => Promise<void>;
  alarm: (info?: { retryCount: number; isRetry: boolean }) => Promise<void>;
}

/** Lower the thresholds, and whatever else this instance needs, in one place. */
export async function installSeams(
  stub: DurableObjectStub,
  seams: {
    records?: number;
    partLimit?: number;
    ceiling?: number;
    retirement?: { deletes?: number; lists?: number };
  } = {},
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    internals.compactionPolicy = {
      records: seams.records ?? SEAM_RECORDS,
      bytes: 8 * 1024 * 1024,
      ceiling: seams.ceiling ?? MAX_RECORD_BYTES,
      partLimit: seams.partLimit,
    };
    internals.retirementBudget = seams.retirement ?? {};
  });
}

/** One signed internal request, with the op and any bound string in the marker. */
export async function signedFor(
  fixture: Fixture,
  path: string,
  op: string,
  options: { method?: string; binding?: string } = {},
): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(
    fixture.projectId,
    TEST_SECRET,
    op,
    options.binding,
  );
  return new Request(`https://internal${path}`, {
    method: options.method ?? "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(fixture.projectId),
    },
  });
}

/** One storage operation the probe saw, with the phase the object had set. */
export interface ProbeCall {
  operation: string;
  phase: string;
  args: readonly unknown[];
  /** Keys the operation acknowledged, for a deletion that resolved. */
  acknowledged?: number;
}

/**
 * A probe's mutable control: what it saw, and an optional interceptor that owns
 * the call. An interceptor MUST invoke or deliberately refuse; the default
 * passes everything through.
 */
export interface ProbeControl {
  calls: ProbeCall[];
  intercept?: (
    operation: string,
    phase: string,
    args: readonly unknown[],
    invoke: () => unknown,
  ) => unknown;
}

/** Install a probe on this instance's storage, and answer its control. */
export async function installProbe(
  stub: DurableObjectStub,
  control: ProbeControl = { calls: [] },
): Promise<ProbeControl> {
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as Internals).storageProbe = (
      operation: string,
      phase: string,
      args: readonly unknown[],
      invoke: () => unknown,
    ) => {
      const call: ProbeCall = { operation, phase, args };
      control.calls.push(call);
      const result = control.intercept
        ? control.intercept(operation, phase, args, invoke)
        : invoke();
      if (operation !== "delete") return result;
      return Promise.resolve(result).then((acknowledged) => {
        call.acknowledged = acknowledged as number;
        return acknowledged;
      });
    };
  });
  return control;
}

/** Every probed call under one phase tag, in order. */
export function callsTagged(control: ProbeControl, phase: string, operation?: string): ProbeCall[] {
  return control.calls.filter(
    (call) => call.phase === phase && (operation === undefined || call.operation === operation),
  );
}

/**
 * Make ONE instance's blob write fail before it executes.
 *
 * The binding belongs to the instance, never to the shared environment, so
 * nothing another test in this isolate can reach is touched. Before execution
 * rather than after, so the row does not move and the snapshot half retires no
 * header — which is what leaves a log for the compaction to fold.
 */
export async function failBlobWrite(
  stub: DurableObjectStub,
  failing: { on: boolean },
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const inner = internals.env.DB;
    const isBlobWrite = /^UPDATE projects SET yjs_state/;
    const wrapper = {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop !== "bind") {
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...args: unknown[]) => {
              const bound = target.bind(...args);
              return new Proxy(bound, {
                get(boundTarget, boundProp) {
                  if (boundProp === "run") {
                    return async () => {
                      if (failing.on && isBlobWrite.test(sql)) {
                        throw new Error("D1_ERROR: the blob write was refused");
                      }
                      return await boundTarget.run();
                    };
                  }
                  const value = Reflect.get(boundTarget, boundProp);
                  return typeof value === "function" ? value.bind(boundTarget) : value;
                },
              });
            };
          },
        });
      },
      batch(statements: unknown[]) {
        return inner.batch(statements as never);
      },
    };
    internals.env = { ...internals.env, DB: wrapper as unknown as D1Database };
  });
}

/** Send one client update built from the state the server last sent. */
export function clientEdit(
  socket: Socket,
  state: Uint8Array,
  mutate: (doc: Y.Doc) => void,
): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const before = Y.encodeStateVector(client);
  client.transact(() => mutate(client));
  const update = Y.encodeStateAsUpdate(client, before);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  socket.ws.send(encoding.toUint8Array(encoder));
  return Y.encodeStateAsUpdate(client);
}

/** The document the object serves, as a copy. */
export async function docOf(stub: DurableObjectStub): Promise<Y.Doc> {
  const bytes = await runInDurableObject(stub, (instance) =>
    Y.encodeStateAsUpdate((instance as unknown as Internals).ydoc),
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

/** Wait until the object's own document satisfies `holds`. */
export async function waitUntil(
  stub: DurableObjectStub,
  holds: (doc: Y.Doc) => boolean,
  timeout = 5000,
): Promise<void> {
  await vi.waitFor(async () => {
    expect(holds(await docOf(stub))).toBe(true);
  }, { timeout });
}

export async function cancelAlarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
}
