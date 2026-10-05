/**
 * A socket whose membership was removed without its eviction reaching the
 * object stops acting for its user, against the real object and
 * real sockets.
 *
 * Membership is read at admission and kept in the attachment. The removal
 * reaches an open socket only as `/notify-deleted`, which a caller can fail to
 * send, so a message on a socket last checked a minute ago or more rereads the
 * row first. These cases delete the row in D1 and never call `/notify-deleted`,
 * then write.
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

import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_SESSION_CONTROL,
  MESSAGE_SYNC,
  addMember,
  clientSyncStep1,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

const SUB_REMOVED_FROM_PROJECT = 0x02;
const EVICTION_TIMEOUT = 60_000;

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

/** An editor's client document, kept in step with what it sends. */
class Editor {
  readonly doc = new Y.Doc();
  constructor(readonly socket: Socket, state: Uint8Array) {
    Y.applyUpdate(this.doc, state);
  }
  /** Change the document locally and send the update, as the client does. */
  send(change: (config: Y.Map<unknown>) => void): void {
    let update: Uint8Array | null = null;
    const capture = (u: Uint8Array) => { update = u; };
    this.doc.on("update", capture);
    change(this.doc.getMap("config"));
    this.doc.off("update", capture);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update!);
    this.socket.ws.send(encoding.toUint8Array(encoder));
  }
  appendTitle(text: string): void {
    this.send((config) => {
      const title = config.get("title") as Y.Text;
      title.insert(title.length, text);
    });
  }
}

/** A project with a config row, an owner watching, and a second member. */
async function twoEditors(label: string, memberRole: "collaborator" | "convenor" = "collaborator") {
  const fixture = await seedProject(label);
  touched.add(stubFor(fixture.projectId));
  await env.DB.prepare(
    "INSERT INTO project_config (project_id, title, story_key) VALUES (?, 'Site', 'k')",
  )
    .bind(fixture.projectId)
    .run();
  const member = await addMember(fixture, `${label}-member`, memberRole);
  const watcherSocket = await openSocket(fixture, "0");
  const watcher = new Editor(watcherSocket, await drainAcceptanceFrames(watcherSocket));
  const memberSocket = await openSocket(member, "0");
  const editor = new Editor(memberSocket, await drainAcceptanceFrames(memberSocket));
  return { fixture, member, watcher, editor };
}

function deleteMembership(member: Fixture): Promise<unknown> {
  return env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(member.projectId, member.userId)
    .run();
}

/** Rewrite the member's socket attachment through `edit`. */
function editAttachment(member: Fixture, edit: (attachment: Record<string, unknown>) => void): Promise<void> {
  return runInDurableObject(stubFor(member.projectId), (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Record<string, unknown>;
      if (attachment.userId !== member.userId) continue;
      edit(attachment);
      ws.serializeAttachment(attachment);
    }
  });
}

/** As though the member's membership was last read `ms` ago. */
const ageCheck = (member: Fixture, ms: number) =>
  editAttachment(member, (a) => { a.membershipCheckedAt = Date.now() - ms; });

function memberAttachment(member: Fixture): Promise<Record<string, unknown>> {
  return runInDurableObject(stubFor(member.projectId), (_instance, state) =>
    state.getWebSockets()
      .map((ws) => ws.deserializeAttachment() as Record<string, unknown>)
      .find((a) => a.userId === member.userId)!,
  );
}

function documentTitle(fixture: Fixture): Promise<string> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) =>
    String((instance as unknown as { ydoc: Y.Doc }).ydoc.getMap("config").get("title")),
  );
}

function documentStoryKey(fixture: Fixture): Promise<unknown> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) =>
    (instance as unknown as { ydoc: Y.Doc }).ydoc.getMap("config").get("story_key"),
  );
}

/**
 * Whether the watcher was relayed an update before the answer to a probe it
 * sends now. The object answers in order, so a relay that was coming arrives
 * first.
 */
async function relayedBeforeProbe(watcher: Editor): Promise<boolean> {
  watcher.socket.ws.send(clientSyncStep1(new Y.Doc()));
  for (;;) {
    const decoder = decoding.createDecoder(await watcher.socket.next());
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    const type = decoding.readVarUint(decoder);
    if (type === syncProtocol.messageYjsUpdate) return true;
    return false;
  }
}

/** The session-control subtype the socket was sent, and its close. */
async function removal(socket: Socket): Promise<{ subtype: number; close: { code: number; reason: string } }> {
  const decoder = decoding.createDecoder(await socket.next());
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SESSION_CONTROL);
  const subtype = decoding.readUint8(decoder);
  await vi.waitFor(() => expect(socket.closes.length).toBeGreaterThan(0));
  return { subtype, close: socket.closes[0] };
}

/** Every sync frame `socket` receives in the next `ms`, by sync message type. */
async function syncFramesFor(socket: Socket, ms: number): Promise<number[]> {
  const types: number[] = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const frame = await Promise.race([
      socket.next().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(until - Date.now(), 1))),
    ]);
    if (frame === null) break;
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) === MESSAGE_SYNC) types.push(decoding.readVarUint(decoder));
  }
  return types;
}

/**
 * A read held until the returned `release` is called, answering `row` or, for
 * `"fails"`, throwing from the read itself; `reads` counts calls.
 */
function heldRead(row: { role: string } | null | "fails") {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const state = { reads: 0 };
  const read = async () => {
    state.reads += 1;
    await gate;
    if (row === "fails") throw new Error("D1 unavailable");
    return row;
  };
  return { read, release: () => release(), state };
}

/** Send `/notify-deleted` for one user, as the application does. */
async function notifyDeleted(fixture: Fixture, userId: number): Promise<number> {
  const { signInternalMarker } = await import("../../workers/auth");
  const { sigHex, timestamp } = await signInternalMarker(
    fixture.projectId, env.SESSION_SECRET, "notify-deleted", String(userId),
  );
  const res = await stubFor(fixture.projectId).fetch(
    new Request(`https://internal/notify-deleted?userId=${userId}`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(fixture.projectId),
      },
    }),
  );
  await res.text();
  return res.status;
}

/** Replace the object's membership read, returning the calls it receives. */
function replaceMembershipRead(
  fixture: Fixture,
  read: () => Promise<{ role: string } | null>,
): Promise<void> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    (instance as unknown as { readMembershipRow: () => Promise<{ role: string } | null> }).readMembershipRow = read;
  });
}

describe("a socket whose membership was removed without an eviction", () => {
  it("writes nothing once its check is due: removed, closed, and nothing relayed", async () => {
    const { fixture, member, watcher, editor } = await twoEditors("recheck-revoked");
    await deleteMembership(member);
    await ageCheck(member, 61_000);

    editor.appendTitle(" edited");

    expect(await removal(editor.socket)).toEqual({
      subtype: SUB_REMOVED_FROM_PROJECT,
      close: { code: 1000, reason: "removed_from_project" },
    });
    expect(await documentTitle(fixture)).toBe("Site");
    expect(await relayedBeforeProbe(watcher)).toBe(false);
  });

  it("keeps writing until its check is due", async () => {
    const { fixture, member, watcher, editor } = await twoEditors("recheck-not-due");
    await deleteMembership(member);

    editor.appendTitle(" edited");

    await vi.waitFor(async () => expect(await documentTitle(fixture)).toBe("Site edited"));
    expect(await relayedBeforeProbe(watcher)).toBe(true);
    expect(editor.socket.closes).toEqual([]);
  });

  it("is checked at once when its attachment has no check time", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-no-time");
    await deleteMembership(member);
    await editAttachment(member, (a) => { delete a.membershipCheckedAt; });

    editor.appendTitle(" edited");

    expect((await removal(editor.socket)).close.reason).toBe("removed_from_project");
    expect(await documentTitle(fixture)).toBe("Site");
  });

  it("is still checked after a hibernation", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-hibernated");
    await deleteMembership(member);
    await ageCheck(member, 61_000);
    await hibernate(stubFor(fixture.projectId));

    editor.appendTitle(" edited");

    expect((await removal(editor.socket)).close.reason).toBe("removed_from_project");
    expect(await documentTitle(fixture)).toBe("Site");
  }, EVICTION_TIMEOUT);
});

describe("a socket whose membership is still there", () => {
  it("takes the role D1 holds now: a demoted convenor's convenor-only write is not kept", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-demoted", "convenor");
    await env.DB.prepare("UPDATE project_members SET role = 'collaborator' WHERE project_id = ? AND user_id = ?")
      .bind(member.projectId, member.userId)
      .run();
    await ageCheck(member, 61_000);

    editor.send((config) => config.set("story_key", "changed"));
    editor.appendTitle(" edited");

    await vi.waitFor(async () => expect(await documentTitle(fixture)).toBe("Site edited"));
    expect(await documentStoryKey(fixture)).toBe("k");
    const attachment = await memberAttachment(member);
    expect(attachment.role).toBe("collaborator");
    expect(Date.now() - (attachment.membershipCheckedAt as number)).toBeLessThan(10_000);
  });
});

describe("while a membership read is in flight", () => {
  it("a burst waits for one read and applies in the order it was sent", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-burst");
    await ageCheck(member, 61_000);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await replaceMembershipRead(fixture, async () => {
      reads += 1;
      await gate;
      return { role: "collaborator" };
    });
    // Every title the document holds, in the order its updates applied.
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const inner = instance as unknown as { ydoc: Y.Doc; titles?: string[] };
      inner.titles = [];
      inner.ydoc.on("update", () => inner.titles!.push(String(inner.ydoc.getMap("config").get("title"))));
    });

    editor.appendTitle("1");
    editor.appendTitle("2");
    editor.appendTitle("3");
    await vi.waitFor(() => expect(reads).toBe(1));
    // Long enough for all three to have arrived and queued behind the read.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await documentTitle(fixture)).toBe("Site");
    release();

    await vi.waitFor(async () => expect(await documentTitle(fixture)).toBe("Site123"));
    expect(reads).toBe(1);
    const titles = await runInDurableObject(stubFor(fixture.projectId), (instance) =>
      (instance as unknown as { titles: string[] }).titles,
    );
    expect(titles).toEqual(["Site1", "Site12", "Site123"]);
  });

  it("an eviction that lands first drops the waiting messages, whatever the read then finds", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-evicted-during");
    await ageCheck(member, 61_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    await replaceMembershipRead(fixture, async () => {
      reads += 1;
      await gate;
      return { role: "collaborator" };
    });

    editor.appendTitle(" edited");
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(await notifyDeleted(fixture, member.userId)).toBe(200);
    release();

    expect((await removal(editor.socket)).close.reason).toBe("removed_from_project");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await documentTitle(fixture)).toBe("Site");
  });
  it("an eviction that lands first drops the waiting messages when the read then fails", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-evicted-then-fails");
    await ageCheck(member, 61_000);
    const held = heldRead("fails");
    await replaceMembershipRead(fixture, held.read);

    editor.appendTitle(" edited");
    await vi.waitFor(() => expect(held.state.reads).toBe(1));
    expect(await notifyDeleted(fixture, member.userId)).toBe(200);
    held.release();

    expect((await removal(editor.socket)).close.reason).toBe("removed_from_project");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await documentTitle(fixture)).toBe("Site");
  });

  it("a socket closed during the read processes nothing", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-closed-during");
    await ageCheck(member, 61_000);
    const held = heldRead({ role: "collaborator" });
    await replaceMembershipRead(fixture, held.read);

    editor.appendTitle(" edited");
    await vi.waitFor(() => expect(held.state.reads).toBe(1));
    editor.socket.ws.close(1000, "tab closed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    held.release();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await documentTitle(fixture)).toBe("Site");
  });

  it("messages resumed together keep their own relay: a reverted write does not silence the next", async () => {
    const { fixture, member, watcher, editor } = await twoEditors("recheck-revert-relay");
    await ageCheck(member, 61_000);
    const held = heldRead({ role: "collaborator" });
    await replaceMembershipRead(fixture, held.read);

    // A collaborator's convenor-only write, which the object reverts, then an
    // ordinary edit, both waiting on the same read.
    editor.send((config) => config.set("story_key", "changed"));
    editor.appendTitle(" edited");
    await vi.waitFor(() => expect(held.state.reads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    held.release();

    await vi.waitFor(async () => expect(await documentTitle(fixture)).toBe("Site edited"));
    expect(await documentStoryKey(fixture)).toBe("k");
    expect(await syncFramesFor(watcher.socket, 300)).toContain(syncProtocol.messageYjsUpdate);
  });
});

describe("when the membership cannot be read", () => {
  it("lets the message through, and reads again on the next one", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-read-fails");
    await ageCheck(member, 61_000);
    let reads = 0;
    await replaceMembershipRead(fixture, async () => {
      reads += 1;
      throw new Error("D1 unavailable");
    });

    editor.appendTitle("1");
    await vi.waitFor(async () => expect(await documentTitle(fixture)).toBe("Site1"));
    editor.appendTitle("2");
    await vi.waitFor(async () => expect(await documentTitle(fixture)).toBe("Site12"));
    expect(reads).toBe(2);
    expect(editor.socket.closes).toEqual([]);
  });

  it("closes the socket, and drops its message, ten minutes after the last read that succeeded", async () => {
    const { fixture, member, editor } = await twoEditors("recheck-grace-over");
    await ageCheck(member, 10 * 60_000 + 1000);
    await replaceMembershipRead(fixture, async () => {
      throw new Error("D1 unavailable");
    });

    editor.appendTitle(" edited");

    await vi.waitFor(() => expect(editor.socket.closes.length).toBeGreaterThan(0));
    expect(editor.socket.closes[0].code).toBe(1013);
    expect(await documentTitle(fixture)).toBe("Site");
  });
});
