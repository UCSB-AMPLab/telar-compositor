// @vitest-environment jsdom
/**
 * The stage's owner of a layer's content without a Y.Text
 * (use-layer-content-drafts.ts): the draft, the debounce, the numbered sends
 * and their answers taken by number, departure, Discard, takeover, deletion,
 * the scope ending, and what survives a reload through target-saves.
 *
 * Sends are deferred promises the test settles in whatever order it needs;
 * the owner never sees the route.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import * as Y from "yjs";
import { LayerContentDrafts, contentRecoveryKey, forgetRetiredLayers, retireLayerContent, useLayerContentDrafts } from "~/hooks/use-layer-content-drafts";
import { WithdrawnSave, type FieldSaveOptions } from "~/hooks/use-route-field-save";
import { recoveredFor, recordSequencedFailure, resetTargetSaves, nextSequence, sequenceSucceeded } from "~/components/ui/target-saves";

interface Sent {
  fields: Record<string, string>;
  options: FieldSaveOptions;
  resolve: (stamp: number | undefined) => void;
  reject: (error: unknown) => void;
}

let sent: Sent[];

function owner(projectId = 3) {
  return new LayerContentDrafts(
    { projectId, storyKey: "s1", actionUrl: "/stories/s1" },
    (_layerId, fields, options) =>
      new Promise<number | undefined>((resolve, reject) => {
        sent.push({ fields, options, resolve, reject });
      }),
    { debounceMs: 1500, errorMessage: () => "stage.save_failed" },
  );
}

const KEY = contentRecoveryKey(3, 51);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sent = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  resetTargetSaves();
  forgetRetiredLayers();
  sessionStorage.clear();
});

async function flushPromises() {
  vi.useRealTimers();
  await settle();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

describe("sending", () => {
  it("sends the draft 1500 ms after the last edit, as autosave-layer content, to the scope's action", () => {
    const drafts = owner();
    drafts.edit(51, "A");
    vi.advanceTimersByTime(1000);
    drafts.edit(51, "AB");
    vi.advanceTimersByTime(1499);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].fields).toEqual({ intent: "autosave-layer", layerId: "51", field: "content", value: "AB" });
    expect(sent[0].options.action).toBe("/stories/s1");
  });

  it("shows the draft while its save is out, then the acknowledged text", async () => {
    const drafts = owner();
    drafts.edit(51, "Typed");
    vi.advanceTimersByTime(1500);
    expect(drafts.view(51, "Loaded", 1)).toEqual({ value: "Typed", failed: false, sending: true });
    sent[0].resolve(10);
    await flushPromises();
    expect(drafts.view(51, "Loaded", 5)).toEqual({ value: "Typed", failed: false, sending: false });
  });

  it("leaving sends a held draft once, and never again when the timer would have fired", () => {
    const drafts = owner();
    drafts.edit(51, "Leaving");
    drafts.flush(51);
    drafts.flush(51);
    vi.advanceTimersByTime(5000);
    expect(sent.map((s) => s.fields.value)).toEqual(["Leaving"]);
  });

  it("leaving sends nothing when nothing is held back", () => {
    const drafts = owner();
    drafts.flush(51);
    drafts.edit(51, "Sent");
    vi.advanceTimersByTime(1500);
    drafts.flush(51);
    expect(sent).toHaveLength(1);
  });
});

describe("answers taken by number", () => {
  async function twoSends(drafts: LayerContentDrafts) {
    drafts.edit(51, "A");
    vi.advanceTimersByTime(1500);
    drafts.edit(51, "B");
    vi.advanceTimersByTime(1500);
    expect(sent.map((s) => s.fields.value)).toEqual(["A", "B"]);
    return { a: sent[0], b: sent[1] };
  }

  it("A succeeding after B succeeded leaves B acknowledged", async () => {
    const drafts = owner();
    const { a, b } = await twoSends(drafts);
    b.resolve(20);
    await flushPromises();
    a.resolve(21);
    await flushPromises();
    // An older loader read, from before B's answer, does not replace B.
    expect(drafts.view(51, "old", 19).value).toBe("B");
    expect(drafts.view(51, "newer", 20).value).toBe("newer");
  });

  it("A failing after B succeeded is ignored, shown nowhere and kept nowhere", async () => {
    const drafts = owner();
    const { a, b } = await twoSends(drafts);
    b.resolve(20);
    await flushPromises();
    a.reject(new Error("offline"));
    await flushPromises();
    expect(drafts.view(51, "old", 1)).toEqual({ value: "B", failed: false, sending: false });
    expect(recoveredFor(KEY, KEY)).toBeNull();
  });

  it("B failing after A succeeded keeps A acknowledged and B's failure, shown with B's text", async () => {
    const drafts = owner();
    const { a, b } = await twoSends(drafts);
    a.resolve(20);
    await flushPromises();
    b.reject(new Error("offline"));
    await flushPromises();
    expect(drafts.view(51, "loaded", 1)).toEqual({ value: "B", failed: true, sending: false });
    expect(recoveredFor(KEY, KEY)).toMatchObject({ draft: "B", sequence: 2 });
    // Discard falls back to A, the acknowledged text.
    expect(drafts.discard(51)).toBe(true);
    expect(drafts.view(51, "loaded", 1).value).toBe("A");
    expect(recoveredFor(KEY, KEY)).toBeNull();
  });

  it("A failing before B succeeds: the failure goes with B's success", async () => {
    const drafts = owner();
    const { a, b } = await twoSends(drafts);
    a.reject(new Error("offline"));
    await flushPromises();
    // B is still out: the failure is not the latest.
    expect(drafts.view(51, "loaded", 1).failed).toBe(false);
    expect(recoveredFor(KEY, KEY)).toMatchObject({ draft: "A", sequence: 1 });
    b.resolve(20);
    await flushPromises();
    expect(drafts.view(51, "loaded", 1)).toEqual({ value: "B", failed: false, sending: false });
    expect(recoveredFor(KEY, KEY)).toBeNull();
  });

  it("A succeeding while B is out updates the acknowledged text without touching B", async () => {
    const drafts = owner();
    const { a } = await twoSends(drafts);
    a.resolve(20);
    await flushPromises();
    expect(drafts.view(51, "loaded", 1)).toEqual({ value: "B", failed: false, sending: true });
  });

  it("a failure shows until a Retry succeeds", async () => {
    const drafts = owner();
    drafts.edit(51, "Kept");
    vi.advanceTimersByTime(1500);
    sent[0].reject(new Error("refused"));
    await flushPromises();
    expect(drafts.view(51, "loaded", 1).failed).toBe(true);
    drafts.retry(51);
    expect(sent[1].fields.value).toBe("Kept");
    expect(drafts.view(51, "loaded", 1).failed).toBe(false);
    sent[1].resolve(9);
    await flushPromises();
    expect(drafts.view(51, "loaded", 1)).toEqual({ value: "Kept", failed: false, sending: false });
  });
});

describe("Discard", () => {
  it("with a timer pending, cancels it and goes back to the loaded value", () => {
    const drafts = owner();
    drafts.edit(51, "Thrown away");
    expect(drafts.discard(51)).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(0);
    expect(drafts.view(51, "Loaded", 1).value).toBe("Loaded");
  });

  it("with a send out, does nothing", async () => {
    const drafts = owner();
    drafts.edit(51, "Out");
    vi.advanceTimersByTime(1500);
    expect(drafts.discard(51)).toBe(false);
    expect(drafts.view(51, "Loaded", 1).value).toBe("Out");
  });
});

describe("across a reload", () => {
  it("a recorded failure seeds the next owner's draft and failure", async () => {
    const before = owner();
    before.edit(51, "Survives");
    vi.advanceTimersByTime(1500);
    sent[0].reject(new Error("refused"));
    await flushPromises();
    // A reload: memory goes, sessionStorage stays.
    resetTargetSaves();
    const after = owner();
    expect(after.view(51, "Loaded", 1)).toEqual({ value: "Survives", failed: true, sending: false });
  });

  it("numbers sends above every number given before the reload", async () => {
    const before = owner();
    before.edit(51, "one");
    vi.advanceTimersByTime(1500);
    before.edit(51, "two");
    vi.advanceTimersByTime(1500);
    resetTargetSaves();
    expect(nextSequence(KEY)).toBe(3);
  });

  it("an older failure never replaces a newer record", () => {
    expect(recordSequencedFailure(KEY, KEY, "newer", "offline", 5)).not.toBeNull();
    expect(recordSequencedFailure(KEY, KEY, "older", "offline", 4)).toBeNull();
    expect(recoveredFor(KEY, KEY)!.draft).toBe("newer");
  });

  it("a late failure below a success is ignored, after a reload too", () => {
    sequenceSucceeded(KEY, KEY, 5);
    resetTargetSaves();
    expect(recordSequencedFailure(KEY, KEY, "late", "offline", 4)).toBeNull();
    expect(recoveredFor(KEY, KEY)).toBeNull();
  });
});

describe("the layer's Y.Text arriving", () => {
  it("cancels the timer and withdraws the sends not yet submitted, keeping the draft", () => {
    const drafts = owner();
    drafts.edit(51, "Before the shared text");
    vi.advanceTimersByTime(1500);
    drafts.edit(51, "Held by the timer");
    drafts.takeOver(51);
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(1);
    expect(sent[0].options.withdrawn!()).toBe(true);
    expect(drafts.view(51, "Loaded", 1).value).toBe("Held by the timer");
  });

  it("a withdrawn send's rejection records no failure", async () => {
    const drafts = owner();
    drafts.edit(51, "Withdrawn");
    vi.advanceTimersByTime(1500);
    drafts.takeOver(51);
    sent[0].reject(new WithdrawnSave());
    await flushPromises();
    expect(recoveredFor(KEY, KEY)).toBeNull();
  });
});

describe("deleting the layer", () => {
  it("cancels its timer, and a late failure for it is not kept", async () => {
    const drafts = owner();
    drafts.reopen();
    drafts.edit(51, "Out");
    vi.advanceTimersByTime(1500);
    drafts.edit(51, "Held");
    retireLayerContent(3, 51);
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(1);
    sent[0].reject(new Error("gone"));
    await flushPromises();
    expect(recoveredFor(KEY, KEY)).toBeNull();
    drafts.close();
  });

  it("changing step is not deleting: the record stays", async () => {
    const drafts = owner();
    drafts.edit(51, "Kept across steps");
    drafts.flush(51);
    sent[0].reject(new Error("offline"));
    await flushPromises();
    expect(drafts.view(51, "loaded", 1)).toMatchObject({ value: "Kept across steps", failed: true });
  });
});

describe("the scope ending", () => {
  it("cancels every timer and keeps each unsent draft in target-saves, sending nothing", () => {
    const drafts = owner();
    drafts.reopen();
    drafts.edit(51, "Unsent");
    drafts.close();
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(0);
    expect(recoveredFor(KEY, KEY)).toMatchObject({ draft: "Unsent", error: "stage.save_failed" });
  });

  it("a send out when it ends still settles target-saves: a success clears, a failure is kept", async () => {
    const drafts = owner();
    drafts.reopen();
    drafts.edit(51, "Out");
    vi.advanceTimersByTime(1500);
    drafts.close();
    expect(recoveredFor(KEY, KEY)).toBeNull();
    sent[0].reject(new Error("save not answered"));
    await flushPromises();
    expect(recoveredFor(KEY, KEY)).toMatchObject({ draft: "Out" });
  });

  it("sends nothing after it has ended", () => {
    const drafts = owner();
    drafts.reopen();
    drafts.close();
    drafts.edit(51, "Late");
    drafts.flush(51);
    expect(sent).toHaveLength(0);
  });
});

describe("a return to an older text while a newer send is out", () => {
  it.each([
    ["succeeds", (s: Sent) => s.resolve(20)],
    ["fails", (s: Sent) => s.reject(new Error("offline"))],
  ])("is kept when the scope ends before the pause, whatever the newer send's answer (it %s)", async (_what, answer) => {
    const drafts = owner();
    drafts.reopen();
    drafts.edit(51, "A");
    vi.advanceTimersByTime(1500);
    sent[0].resolve(10);
    await flushPromises();
    drafts.edit(51, "B");
    vi.advanceTimersByTime(1500);
    // Back to A, and away before the pause ends.
    drafts.edit(51, "A");
    drafts.close();
    answer(sent[1]);
    await flushPromises();
    expect(recoveredFor(KEY, KEY)).toMatchObject({ draft: "A" });
  });
});

describe("the Y.Text arriving with a send already submitted", () => {
  it("leaves the submitted send tracked, so its success is not overtaken by a record of the same text", async () => {
    const drafts = owner();
    drafts.reopen();
    drafts.edit(51, "X");
    vi.advanceTimersByTime(1500);
    sent[0].options.onSubmit?.();
    drafts.takeOver(51);
    expect(sent[0].options.withdrawn!()).toBe(false);
    drafts.close();
    sent[0].resolve(30);
    await flushPromises();
    expect(recoveredFor(KEY, KEY)).toBeNull();
  });
});

describe("deleting a layer whose send is out in an owner whose scope has ended", () => {
  it("keeps the late failure from recording a draft", async () => {
    const before = owner();
    before.reopen();
    before.edit(51, "Out");
    before.flush(51);
    // The author moves to another story, comes back, and deletes the layer.
    before.close();
    const after = owner();
    after.reopen();
    retireLayerContent(3, 51);
    sent[0].reject(new Error("gone"));
    await flushPromises();
    expect(recoveredFor(KEY, KEY)).toBeNull();
    after.close();
  });
});

describe("the Y.Text arriving for a layer whose panel is not open", () => {
  /** A shared document holding the story's layer 51 with a content Y.Text. */
  function sharedDoc() {
    const doc = new Y.Doc();
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<Y.Map<unknown>>();
    const step = new Y.Map<unknown>();
    const layers = new Y.Array<Y.Map<unknown>>();
    const layer = new Y.Map<unknown>();
    layer.set("_id", 51);
    layer.set("content", new Y.Text("Shared"));
    layers.push([layer]);
    step.set("layers", layers);
    steps.push([step]);
    story.set("story_id", "s1");
    story.set("steps", steps);
    doc.getArray("stories").push([story]);
    return doc;
  }

  it("withdraws the owner's held draft as collaboration connects", () => {
    const send = vi.fn(() => new Promise<number | undefined>(() => {}));
    const { result, rerender, unmount } = renderHook(
      ({ ydoc }: { ydoc: Y.Doc | null }) =>
        useLayerContentDrafts({ scope: { projectId: 3, storyKey: "s1" }, send, errorMessage: "stage.save_failed", ydoc }),
      { initialProps: { ydoc: null as Y.Doc | null } },
    );
    result.current.edit(51, "Typed before the connection");
    rerender({ ydoc: sharedDoc() });
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
    unmount();
    resetTargetSaves();
    sessionStorage.clear();
  });
});

describe("coming back to a story with a send still out from the last visit", () => {
  it("shows the draft and its failure when that send fails", async () => {
    const before = owner();
    before.reopen();
    before.edit(51, "Sent before leaving");
    before.flush(51);
    before.close();
    const after = owner();
    after.reopen();
    expect(after.view(51, "Loaded", 1)).toMatchObject({ value: "Loaded", failed: false });
    sent[0].reject(new Error("offline"));
    await flushPromises();
    expect(after.view(51, "Loaded", 1)).toMatchObject({ value: "Sent before leaving", failed: true });
    after.close();
  });

  it("keeps a newer local edit over the failed text", async () => {
    const before = owner();
    before.reopen();
    before.edit(51, "Old");
    before.flush(51);
    before.close();
    const after = owner();
    after.reopen();
    after.view(51, "Loaded", 1);
    after.edit(51, "Newer");
    sent[0].reject(new Error("offline"));
    await flushPromises();
    expect(after.view(51, "Loaded", 1).value).toBe("Newer");
    after.close();
  });

  it("takes that send's success as acknowledged, in number order", async () => {
    const before = owner();
    before.reopen();
    before.edit(51, "Stored");
    before.flush(51);
    before.close();
    const after = owner();
    after.reopen();
    after.view(51, "Loaded", 1);
    sent[0].resolve(40);
    await flushPromises();
    expect(after.view(51, "Loaded", 39).value).toBe("Stored");
    after.close();
  });
});

describe("two sends from the last visit settling after coming back", () => {
  async function twoOut() {
    const before = owner();
    before.reopen();
    before.edit(51, "A");
    before.flush(51);
    before.edit(51, "B");
    before.flush(51);
    before.close();
    const after = owner();
    after.reopen();
    after.view(51, "Loaded", 1);
    return after;
  }

  it("A then B failing: the draft and Retry carry B", async () => {
    const after = await twoOut();
    sent[0].reject(new Error("offline"));
    await flushPromises();
    sent[1].reject(new Error("offline"));
    await flushPromises();
    expect(after.view(51, "Loaded", 1)).toMatchObject({ value: "B", failed: true });
    after.retry(51);
    expect(sent.at(-1)!.fields.value).toBe("B");
    after.close();
  });

  it("A failing, then B succeeding: B is the saved text and nothing is recovered", async () => {
    const after = await twoOut();
    sent[0].reject(new Error("offline"));
    await flushPromises();
    sent[1].resolve(50);
    await flushPromises();
    expect(after.view(51, "Loaded", 1)).toMatchObject({ value: "B", failed: false });
    after.close();
  });
});
