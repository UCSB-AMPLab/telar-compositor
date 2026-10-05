/**
 * @vitest-environment jsdom
 *
 * in-place-editing.test.tsx — InPlaceText and InPlaceMarkdown: the rendered
 * block and the field that replaces it, with the wrapper owning the draft.
 *
 * The cases the build plan names: a field closed at once, by blur or by
 * Escape, with no Y.Text, keeps what was typed; reopening before the loader
 * has revalidated shows the draft, not the loader's older value; a failed
 * save keeps the field open with the draft and the error; a plain click on a
 * link edits and a Cmd or Ctrl click follows it; the keyboard opens the
 * field with Enter and Escape closes it, focus going back to the block.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
}));

import { InPlaceText } from "~/components/ui/InPlaceText";
import { InPlaceMarkdown } from "~/components/ui/InPlaceMarkdown";
import { resetTargetSaves, trackedTargetCount } from "~/components/ui/target-saves";

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
  cleanup();
  resetTargetSaves();
});

/** Lets pending promises and the focus scope's next-task judgement run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

const block = () => document.querySelector<HTMLElement>("[data-in-place]");
/** The value a block shows, without the marker of a recovered draft waiting. */
function valueOf(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-in-place-marker]").forEach((marker) => marker.remove());
  return copy.textContent ?? "";
}
const input = () => screen.getByRole("textbox") as HTMLInputElement;

function editorView(): EditorView {
  const content = document.querySelector(".cm-content") as HTMLElement | null;
  expect(content).toBeTruthy();
  return EditorView.findFromDOM(content!)!;
}

function openByKey() {
  const b = block()!;
  act(() => b.focus());
  fireEvent.keyDown(b, { key: "Enter" });
}

describe("InPlaceText", () => {
  it("shows the value, and the placeholder muted when it is empty", () => {
    const { rerender } = render(<InPlaceText yText={null} initialValue="Río Magdalena" placeholder="Add a title" />);
    expect(valueOf(block()!)).toBe("Río Magdalena");
    rerender(<InPlaceText key="empty" yText={null} initialValue="" placeholder="Add a title" />);
    const muted = screen.getByText("Add a title");
    expect(muted.className).toContain("text-gray-400");
  });

  it("opens on Enter with the field focused, and Escape gives focus back to the block", () => {
    render(<InPlaceText yText={null} initialValue="alpha" />);
    openByKey();
    expect(block()).toBeNull();
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(block()).not.toBeNull();
    expect(document.activeElement).toBe(block());
  });

  it("opens on a click", () => {
    render(<InPlaceText yText={null} initialValue="alpha" />);
    fireEvent.click(block()!);
    expect(input().value).toBe("alpha");
  });

  it.each(["blur", "escape"] as const)(
    "keeps an edit closed at once by %s with no Y.Text, and saves it",
    async (how) => {
      const onSave = vi.fn();
      render(<InPlaceText yText={null} initialValue="alpha" onSave={onSave} />);
      openByKey();
      fireEvent.change(input(), { target: { value: "alpha beta" } });
      if (how === "blur") fireEvent.blur(input());
      else fireEvent.keyDown(input(), { key: "Escape" });
      await settle();
      expect(valueOf(block()!)).toBe("alpha beta");
      expect(onSave).toHaveBeenCalledWith("alpha beta");
    },
  );

  it("keeps the edit with neither a Y.Text nor a save", async () => {
    render(<InPlaceText yText={null} initialValue="alpha" />);
    openByKey();
    fireEvent.change(input(), { target: { value: "gamma" } });
    fireEvent.blur(input());
    await settle();
    expect(valueOf(block()!)).toBe("gamma");
  });

  it("shows the draft when reopened before the loader has revalidated", async () => {
    const onSave = vi.fn();
    const { rerender } = render(<InPlaceText yText={null} initialValue="alpha" onSave={onSave} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "alpha beta" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    // The loader has not revalidated: the route still passes the old value.
    rerender(<InPlaceText yText={null} initialValue="alpha" onSave={onSave} />);
    openByKey();
    expect(input().value).toBe("alpha beta");
  });

  it("takes the loader's new value when nothing is waiting to be saved", () => {
    const { rerender } = render(<InPlaceText yText={null} initialValue="alpha" />);
    rerender(<InPlaceText yText={null} initialValue="omega" />);
    expect(valueOf(block()!)).toBe("omega");
  });

  it("keeps an unsaved draft when the loader brings a different value", async () => {
    const { rerender } = render(<InPlaceText yText={null} initialValue="alpha" />);
    openByKey();
    fireEvent.change(input(), { target: { value: "gamma" } });
    fireEvent.blur(input());
    await settle();
    rerender(<InPlaceText yText={null} initialValue="omega" />);
    expect(valueOf(block()!)).toBe("gamma");
  });

  it("keeps the field open with the draft and the error when the save fails", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("We couldn't save that.")).mockResolvedValue(undefined);
    render(<InPlaceText yText={null} initialValue="alpha" onSave={onSave} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "alpha beta" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(block()).toBeNull();
    expect(input().value).toBe("alpha beta");
    expect(screen.getByRole("alert").textContent).toBe("We couldn't save that.");
    // A second try that succeeds closes it.
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(valueOf(block()!)).toBe("alpha beta");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends the save of a changed draft when it unmounts while open", () => {
    const onSave = vi.fn();
    const { unmount } = render(<InPlaceText yText={null} initialValue="alpha" onSave={onSave} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "alpha beta" } });
    unmount();
    return settle().then(() => expect(onSave).toHaveBeenCalledWith("alpha beta"));
  });

  it("writes through the Y.Text as the author types", () => {
    const doc = new Y.Doc();
    const yText = doc.getText("q");
    yText.insert(0, "alpha");
    render(<InPlaceText yText={yText} initialValue="alpha" />);
    openByKey();
    fireEvent.change(input(), { target: { value: "alpha beta" } });
    expect(yText.toString()).toBe("alpha beta");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(valueOf(block()!)).toBe("alpha beta");
  });

  it("grows the field with its text", () => {
    render(<InPlaceText yText={null} initialValue="four" />);
    openByKey();
    expect(input().size).toBe(4);
    fireEvent.change(input(), { target: { value: "twelve chars" } });
    expect(input().size).toBe(12);
  });

  it("shows the answer's line counter in a multiline field that asks for it", () => {
    render(<InPlaceText multiline yText={null} initialValue="one two" fieldProps={{ answerLength: true }} />);
    openByKey();
    expect(screen.getByTestId("answer-line-count").textContent).toBe('answer_budget_count:{"lines":1,"budget":18}');
  });
});

describe("the draft's target", () => {
  it("does not save a fallback draft once collaboration takes over", async () => {
    const onSave = vi.fn();
    const { rerender, unmount } = render(<InPlaceText yText={null} initialValue="old" onSave={onSave} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "local draft" } });
    const doc = new Y.Doc();
    const yText = doc.getText("q");
    yText.insert(0, "new collaborative value");
    rerender(<InPlaceText yText={yText} initialValue="old" onSave={onSave} />);
    await settle();
    expect(onSave).not.toHaveBeenCalled();
    expect(input().value).toBe("new collaborative value");
    unmount();
    await settle();
    expect(onSave).not.toHaveBeenCalled();
    expect(yText.toString()).toBe("new collaborative value");
  });

  it("saves an open draft to its own target when the target changes, and starts the new one clean", async () => {
    const saveA = vi.fn();
    const saveB = vi.fn();
    const { rerender } = render(<InPlaceText target="a" yText={null} initialValue="A" onSave={saveA} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "draft for A" } });
    rerender(<InPlaceText target="b" yText={null} initialValue="B" onSave={saveB} />);
    await settle();
    expect(saveA).toHaveBeenCalledWith("draft for A");
    expect(saveB).not.toHaveBeenCalled();
    expect(valueOf(block()!)).toBe("B");
  });

  it("does not let a save for an old target close or overwrite the new one", async () => {
    let resolveA: () => void = () => {};
    const saveA = vi.fn(() => new Promise<void>((r) => (resolveA = r)));
    const saveB = vi.fn();
    const { rerender } = render(<InPlaceText target="a" yText={null} initialValue="A" onSave={saveA} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "draft for A" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    rerender(<InPlaceText target="b" yText={null} initialValue="B" onSave={saveB} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "draft for B" } });
    await act(async () => resolveA());
    await settle();
    expect(input().value).toBe("draft for B");
    expect(saveA).toHaveBeenCalledTimes(1);
    expect(saveB).not.toHaveBeenCalled();
  });
});

describe("edits made while a save is in flight", () => {
  function deferredSave() {
    const pending: Array<() => void> = [];
    const save = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)));
    const resolveNext = async () => {
      await act(async () => pending.shift()?.());
      await settle();
    };
    return { save, resolveNext };
  }

  it("saves the newer text before closing", async () => {
    const { save, resolveNext } = deferredSave();
    render(<InPlaceText yText={null} initialValue="" onSave={save} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "first" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    fireEvent.change(input(), { target: { value: "second" } });
    await resolveNext();
    expect(save).toHaveBeenLastCalledWith("second");
    expect(block()).toBeNull();
    await resolveNext();
    expect(valueOf(block()!)).toBe("second");
    expect(save.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["first", "second"]);
  });

  it("sends the newer text when it unmounts with the first save still in flight", async () => {
    const { save, resolveNext } = deferredSave();
    const { unmount } = render(<InPlaceText yText={null} initialValue="" onSave={save} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "first" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    fireEvent.change(input(), { target: { value: "second" } });
    unmount();
    await settle();
    // The newer save waits for the one in flight, so they land in order.
    expect(save).toHaveBeenCalledTimes(1);
    await resolveNext();
    expect(save.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["first", "second"]);
  });
});

describe("saves in order", () => {
  it("keeps saves in order between two fields editing the same target", async () => {
    const store: { value?: string } = {};
    const pending: Array<() => void> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve) =>
          pending.push(() => {
            store.value = value;
            resolve();
          }),
        ),
    );
    render(
      <>
        <InPlaceText target="shared" yText={null} initialValue="v0" onSave={save} label="one" />
        <InPlaceText target="shared" yText={null} initialValue="v0" onSave={save} label="two" />
      </>,
    );
    const finish = async (label: string, value: string) => {
      const b = screen.getByRole("button", { name: label });
      act(() => b.focus());
      fireEvent.keyDown(b, { key: "Enter" });
      const field = document.activeElement as HTMLInputElement;
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: "Escape" });
      await settle();
    };
    await finish("one", "from one");
    await finish("two", "from two");
    while (pending.length) {
      await act(async () => pending.pop()!());
      await settle();
    }
    expect(store.value).toBe("from two");
  });

  it("sends the reverted text when it unmounts during a save", async () => {
    const pending: Array<() => void> = [];
    const save = vi.fn((_: string) => new Promise<void>((resolve) => pending.push(resolve)));
    const { unmount } = render(<InPlaceText yText={null} initialValue="original" onSave={save} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "first" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    fireEvent.change(input(), { target: { value: "original" } });
    unmount();
    while (pending.length) {
      await act(async () => pending.shift()!());
      await settle();
    }
    expect(save.mock.calls.map((c) => c[0])).toEqual(["first", "original"]);
  });

  it("keeps a target's saves in order across a trip to another target and back", async () => {
    // A store that keeps whichever write lands last, and saves that land
    // in whatever order they are resolved.
    const store: Record<string, string> = {};
    const pending: Array<() => void> = [];
    const saveTo = (key: string) =>
      vi.fn(
        (value: string) =>
          new Promise<void>((resolve) =>
            pending.push(() => {
              store[key] = value;
              resolve();
            }),
          ),
      );
    const saveA = saveTo("a");
    const saveB = saveTo("b");
    const field = (target: string, value: string) => (
      <InPlaceText target={target} yText={null} initialValue={value} onSave={target === "a" ? saveA : saveB} />
    );
    const { rerender } = render(field("a", "A"));
    openByKey();
    fireEvent.change(input(), { target: { value: "a1" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    rerender(field("b", "B"));
    rerender(field("a", "a1"));
    openByKey();
    fireEvent.change(input(), { target: { value: "a2" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    // Resolve the newest save first, each time, until none is left.
    while (pending.length) {
      await act(async () => pending.pop()!());
      await settle();
    }
    expect(store.a).toBe("a2");
  });
});

describe("reverting on a target another generation is saving", () => {
  function storeBackedSave() {
    const store: { value?: string } = {};
    const pending: Array<() => void> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve) =>
          pending.push(() => {
            store.value = value;
            resolve();
          }),
        ),
    );
    // A queued save starts only once the one before it has settled, so
    // each round lets the queue move before looking for the next.
    const resolveAll = async () => {
      for (;;) {
        await settle();
        if (!pending.length) return;
        await act(async () => pending.shift()!());
      }
    };
    return { store, save, resolveAll };
  }

  const field = (target: string, save: (v: string) => Promise<void>) => (
    <InPlaceText target={target} yText={null} initialValue={target === "a" ? "original" : "B"} onSave={save} />
  );

  async function leaveAndComeBack(save: (v: string) => Promise<void>, rerender: (ui: React.ReactElement) => void) {
    openByKey();
    fireEvent.change(input(), { target: { value: "first" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    rerender(field("b", save));
    // The loader has not revalidated: A comes back with its old value.
    rerender(field("a", save));
    openByKey();
  }

  it("saves the reverted text when finishing, while the earlier save is still queued", async () => {
    const { store, save, resolveAll } = storeBackedSave();
    const { rerender } = render(field("a", save));
    await leaveAndComeBack(save, rerender);
    fireEvent.change(input(), { target: { value: "edited" } });
    fireEvent.change(input(), { target: { value: "original" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await resolveAll();
    expect(store.value).toBe("original");
    expect(valueOf(block()!)).toBe("original");
  });

  it("saves the reverted text when finishing after the earlier save has landed", async () => {
    const { store, save, resolveAll } = storeBackedSave();
    const { rerender } = render(field("a", save));
    await leaveAndComeBack(save, rerender);
    await resolveAll();
    expect(store.value).toBe("first");
    // An edit that comes back to the loader's value still asks for it.
    fireEvent.change(input(), { target: { value: "edited" } });
    fireEvent.change(input(), { target: { value: "original" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await resolveAll();
    expect(store.value).toBe("original");
  });

  it("sends the reverted text on unmount, while the earlier save is still queued", async () => {
    const { store, save, resolveAll } = storeBackedSave();
    const { rerender, unmount } = render(field("a", save));
    await leaveAndComeBack(save, rerender);
    fireEvent.change(input(), { target: { value: "edited" } });
    fireEvent.change(input(), { target: { value: "original" } });
    unmount();
    await resolveAll();
    expect(store.value).toBe("original");
  });

  it("saves the reverted text behind two queued saves from earlier visits", async () => {
    const { store, save, resolveAll } = storeBackedSave();
    const { rerender } = render(field("a", save));
    await leaveAndComeBack(save, rerender);
    fireEvent.change(input(), { target: { value: "second" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    rerender(field("b", save));
    rerender(field("a", save));
    openByKey();
    fireEvent.change(input(), { target: { value: "edited" } });
    fireEvent.change(input(), { target: { value: "original" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await resolveAll();
    expect(store.value).toBe("original");
  });
});

describe("two fields on one target", () => {
  function controlledSave() {
    const store: { value?: string } = {};
    const pending: Array<{ value: string; succeed: () => void; fail: (e: Error) => void }> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve, reject) =>
          pending.push({
            value,
            succeed: () => {
              store.value = value;
              resolve();
            },
            fail: reject,
          }),
        ),
    );
    return { store, pending, save };
  }

  async function finishIn(label: string, value: string) {
    const b = screen.getByRole("button", { name: label });
    act(() => b.focus());
    fireEvent.keyDown(b, { key: "Enter" });
    const field = document.activeElement as HTMLInputElement;
    fireEvent.change(field, { target: { value } });
    fireEvent.keyDown(field, { key: "Escape" });
    await settle();
    return field;
  }

  it("keeps a field open until the matching queued save stores, and shows it when that save fails", async () => {
    const { pending, save } = controlledSave();
    render(
      <>
        <InPlaceText target="same-closing" yText={null} initialValue="v0" onSave={save} label="one" />
        <InPlaceText target="same-closing" yText={null} initialValue="v0" onSave={save} label="two" />
      </>,
    );
    await finishIn("one", "first");
    const second = await finishIn("two", "first");
    // Nothing is stored yet, so the second field must not have closed.
    expect(second.isConnected).toBe(true);
    await act(async () => pending.shift()!.fail(new Error("We couldn't save that.")));
    await settle();
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([
      "We couldn't save that.",
      "We couldn't save that.",
    ]);
  });

  it("does not resend older text on unmount over a newer submission", async () => {
    const { store, pending, save } = controlledSave();
    const one = render(<InPlaceText target="same-unmount" yText={null} initialValue="v0" onSave={save} label="one" />);
    render(<InPlaceText target="same-unmount" yText={null} initialValue="v0" onSave={save} label="two" />);
    await finishIn("one", "first");
    await finishIn("two", "second");
    one.unmount();
    for (;;) {
      await settle();
      const next = pending.shift();
      if (!next) break;
      await act(async () => next.succeed());
    }
    expect(save.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
    expect(store.value).toBe("second");
  });
});

describe("a draft left behind whose save fails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  /** A save each call of which the test succeeds or fails, writing a store on success. */
  function controlledSave(initial: string) {
    const store = { value: initial };
    const pending: Array<{ value: string; succeed: () => void; fail: (message: string) => void }> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve, reject) =>
          pending.push({
            value,
            succeed: () => {
              store.value = value;
              resolve();
            },
            fail: (message) => reject(new Error(message)),
          }),
        ),
    );
    const next = async (outcome: "succeed" | "fail", message = "offline") => {
      const call = pending.shift()!;
      await act(async () => (outcome === "succeed" ? call.succeed() : call.fail(message)));
      await settle();
    };
    return { store, pending, save, next };
  }

  const KEY = "project:1/step:7/question";
  const stored = () => window.sessionStorage.getItem(`telar:recovered-draft:${KEY}`);
  const field = (save: (v: string) => Promise<void>, value = "v0", label?: string) => (
    <InPlaceText target="left" recoveryKey={KEY} yText={null} initialValue={value} onSave={save} label={label} />
  );
  const notice = () => screen.queryByTestId("in-place-recovered");

  /** Types into a field, leaves it by unmounting, and fails the save it sent. */
  async function leaveAndFail(save: ReturnType<typeof controlledSave>) {
    const first = render(field(save.save));
    openByKey();
    fireEvent.change(input(), { target: { value: "left behind" } });
    first.unmount();
    await settle();
    expect(save.pending.map((p) => p.value)).toEqual(["left behind"]);
    await save.next("fail");
  }

  it("comes back in the field the next time it opens, with the error, and opening writes nothing", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    // Closed, the field shows what the target holds.
    expect(valueOf(block()!)).toBe("v0");
    openByKey();
    expect(input().value).toBe("left behind");
    expect(notice()).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("offline");
    expect(screen.getByText("in_place.recovered_notice")).toBeTruthy();
    // Closing it unedited writes nothing, shows the stored value, and keeps the draft.
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(saves.save).toHaveBeenCalledTimes(1);
    expect(valueOf(block()!)).toBe("v0");
    openByKey();
    expect(input().value).toBe("left behind");
  });

  it("comes back when the field finished and went before its save failed", async () => {
    const saves = controlledSave("v0");
    const first = render(field(saves.save));
    openByKey();
    fireEvent.change(input(), { target: { value: "finished then left" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    first.unmount();
    await saves.next("fail");
    render(field(saves.save));
    openByKey();
    expect(input().value).toBe("finished then left");
    expect(screen.getByRole("alert").textContent).toBe("offline");
  });

  it("is saved by Retry, which forgets it once the save succeeds", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    const second = render(field(saves.save));
    openByKey();
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    await settle();
    expect(saves.pending.map((p) => p.value)).toEqual(["left behind"]);
    await saves.next("succeed");
    expect(saves.store.value).toBe("left behind");
    expect(valueOf(block()!)).toBe("left behind");
    expect(stored()).toBeNull();
    second.unmount();
    render(field(saves.save, "left behind"));
    openByKey();
    expect(notice()).toBeNull();
  });

  it("stays, with the new error, when Retry fails", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    await settle();
    await saves.next("fail", "still offline");
    expect(input().value).toBe("left behind");
    expect(notice()).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("still offline");
    expect(JSON.parse(stored()!)).toMatchObject({ draft: "left behind", error: "still offline" });
  });

  it("is forgotten by Discard, which closes on the stored value", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    await settle();
    expect(valueOf(block()!)).toBe("v0");
    expect(saves.save).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
    openByKey();
    expect(input().value).toBe("v0");
    expect(notice()).toBeNull();
  });

  it("cannot be discarded while Retry's save is out, so that save cannot store a discarded draft", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    await settle();
    expect(saves.pending.map((p) => p.value)).toEqual(["left behind"]);
    const discard = screen.getByText("in_place.recovered_discard");
    expect(discard.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(discard);
    await settle();
    // Discard was refused: the draft is still the field's, and still kept.
    expect(block()).toBeNull();
    expect(input().value).toBe("left behind");
    expect(stored()).not.toBeNull();
    // The save lands, and what the field closes on is what is stored.
    await saves.next("succeed");
    expect(saves.store.value).toBe("left behind");
    expect(valueOf(block()!)).toBe("left behind");
    expect(stored()).toBeNull();
  });

  it("can be discarded again once a Retry has failed", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    await settle();
    await saves.next("fail", "still offline");
    const discard = screen.getByText("in_place.recovered_discard");
    expect(discard.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(discard);
    await settle();
    expect(valueOf(block()!)).toBe("v0");
    expect(saves.store.value).toBe("v0");
    expect(stored()).toBeNull();
  });

  it("is saved, and forgotten, when the author edits it and finishes", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    fireEvent.change(input(), { target: { value: "left behind, finished" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    await saves.next("succeed");
    expect(saves.store.value).toBe("left behind, finished");
    expect(valueOf(block()!)).toBe("left behind, finished");
    expect(stored()).toBeNull();
  });

  it("is forgotten when the author edits it and leaves, and that save succeeds", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    const second = render(field(saves.save));
    openByKey();
    fireEvent.change(input(), { target: { value: "left behind, edited" } });
    second.unmount();
    await settle();
    await saves.next("succeed");
    expect(saves.store.value).toBe("left behind, edited");
    expect(stored()).toBeNull();
    render(field(saves.save, "left behind, edited"));
    openByKey();
    expect(input().value).toBe("left behind, edited");
    expect(notice()).toBeNull();
  });

  it("is forgotten when the author edits it, finishes, and goes before that save succeeds", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    const second = render(field(saves.save));
    openByKey();
    fireEvent.change(input(), { target: { value: "finished, then gone" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    second.unmount();
    await saves.next("succeed");
    expect(stored()).toBeNull();
    render(field(saves.save, "finished, then gone"));
    openByKey();
    expect(notice()).toBeNull();
  });

  it("keeps the field open when focus moves to Retry, rather than finishing it", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    const retry = screen.getByText("in_place.recovered_retry");
    act(() => retry.focus());
    await settle();
    expect(block()).toBeNull();
    expect(input().value).toBe("left behind");
    // Leaving the notice for somewhere else finishes the field: unedited, it closes.
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    act(() => elsewhere.focus());
    await settle();
    expect(valueOf(block()!)).toBe("v0");
    expect(saves.save).toHaveBeenCalledTimes(1);
    elsewhere.remove();
  });

  it("survives a reload of the tab, through sessionStorage", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    expect(JSON.parse(stored()!)).toMatchObject({ draft: "left behind", error: "offline" });
    // A reload keeps sessionStorage and loses everything in memory.
    resetTargetSaves();
    render(field(saves.save));
    openByKey();
    expect(input().value).toBe("left behind");
    expect(screen.getByRole("alert").textContent).toBe("offline");
  });

  it("is kept when another field stores a newer value after the failure, and writes nothing over it", async () => {
    const saves = controlledSave("v0");
    const left = render(field(saves.save, "v0", "left"));
    openByKey();
    fireEvent.change(input(), { target: { value: "left behind" } });
    left.unmount();
    await settle();
    // A field opened while that save is out, before it fails, does not take it.
    render(field(saves.save, "v0", "writer"));
    openByKey();
    const writer = input();
    await saves.next("fail");
    fireEvent.change(writer, { target: { value: "newer" } });
    fireEvent.keyDown(writer, { key: "Escape" });
    await settle();
    await saves.next("succeed");
    expect(saves.store.value).toBe("newer");
    expect(valueOf(screen.getByRole("button", { name: "writer" }))).toBe("newer");
    // The next field to open on the target shows the draft as recovered.
    render(field(saves.save, "newer", "next"));
    const next = screen.getByRole("button", { name: "next" });
    expect(valueOf(next)).toBe("newer");
    expect(next.querySelector("[data-in-place-marker]")).not.toBeNull();
    act(() => next.focus());
    fireEvent.keyDown(next, { key: "Enter" });
    expect((document.activeElement as HTMLInputElement).value).toBe("left behind");
    expect(notice()).not.toBeNull();
    // Discard goes back to the newer value, and nothing was written over it.
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    await settle();
    expect(valueOf(screen.getByRole("button", { name: "next" }))).toBe("newer");
    expect(saves.save.mock.calls.map((c) => c[0])).toEqual(["left behind", "newer"]);
    expect(saves.store.value).toBe("newer");
  });

  it("is marked on the closed block while it waits, and the mark follows it being recorded and cleared", async () => {
    const saves = controlledSave("v0");
    // A closed field already on the target when the draft is recorded.
    render(field(saves.save, "v0", "closed"));
    const closed = () => screen.getByRole("button", { name: "closed" });
    const marker = () => closed().querySelector("[data-in-place-marker]");
    expect(marker()).toBeNull();
    const left = render(field(saves.save, "v0", "left"));
    const leftBlock = screen.getByRole("button", { name: "left" });
    act(() => leftBlock.focus());
    fireEvent.keyDown(leftBlock, { key: "Enter" });
    fireEvent.change(document.activeElement!, { target: { value: "left behind" } });
    left.unmount();
    await settle();
    await saves.next("fail");
    expect(marker()?.textContent).toBe("in_place.recovered_marker");
    expect(closed().getAttribute("aria-describedby")).toBe(marker()!.id);
    expect(valueOf(closed())).toBe("v0");
    // A block mounted afterwards is marked from the start.
    render(field(saves.save, "v0", "later"));
    expect(screen.getByRole("button", { name: "later" }).querySelector("[data-in-place-marker]")).not.toBeNull();
    // Discarded from the closed field itself, the mark goes from every block.
    act(() => closed().focus());
    fireEvent.keyDown(closed(), { key: "Enter" });
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    await settle();
    expect(marker()).toBeNull();
    expect(screen.getByRole("button", { name: "later" }).querySelector("[data-in-place-marker]")).toBeNull();
  });

  it("is not marked on a block with no save, or with a Y.Text", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    const doc = new Y.Doc();
    render(
      <>
        <InPlaceText target="left" recoveryKey={KEY} yText={null} initialValue="v0" label="no save" />
        <InPlaceText target="left" recoveryKey={KEY} yText={doc.getText("q")} initialValue="v0" onSave={saves.save} label="shared" />
      </>,
    );
    for (const name of ["no save", "shared"]) {
      expect(screen.getByRole("button", { name }).querySelector("[data-in-place-marker]")).toBeNull();
    }
  });

  it("cannot be discarded in one field while another field's Retry of it is saving", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(
      <>
        {field(saves.save, "v0", "A")}
        {field(saves.save, "v0", "B")}
      </>,
    );
    const openIn = (name: string) => {
      const b = screen.getByRole("button", { name });
      act(() => b.focus());
      fireEvent.keyDown(b, { key: "Enter" });
      return document.activeElement as HTMLInputElement;
    };
    const a = openIn("A");
    // Pressed with a pointer, the buttons leave focus where it is; B is opened by a click.
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    const [retryA] = screen.getAllByText("in_place.recovered_retry");
    fireEvent.click(retryA);
    await settle();
    expect(saves.pending.map((p) => p.value)).toEqual(["left behind"]);
    const [, discardB] = screen.getAllByText("in_place.recovered_discard");
    expect(discardB.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(discardB);
    await settle();
    // Discard in B was refused: B still holds the draft, which is still kept.
    expect(screen.getAllByTestId("in-place-recovered")).toHaveLength(2);
    expect(stored()).not.toBeNull();
    await saves.next("succeed");
    expect(saves.store.value).toBe("left behind");
    expect(a.isConnected).toBe(false);
  });

  /**
   * A shows the recovered "left behind"; another field, which showed it too,
   * is edited to "y", finished as A opens, and goes before its save fails,
   * so "y" is kept in place of the draft A shows.
   */
  async function replacedWhileShown(saves: ReturnType<typeof controlledSave>) {
    await leaveAndFail(saves);
    const other = render(field(saves.save, "v0", "other"));
    const otherBlock = screen.getByRole("button", { name: "other" });
    act(() => otherBlock.focus());
    fireEvent.keyDown(otherBlock, { key: "Enter" });
    fireEvent.change(document.activeElement!, { target: { value: "y" } });
    render(field(saves.save, "v0", "A"));
    const aBlock = screen.getByRole("button", { name: "A" });
    act(() => aBlock.focus());
    fireEvent.keyDown(aBlock, { key: "Enter" });
    const a = document.activeElement as HTMLInputElement;
    expect(a.value).toBe("left behind");
    await settle();
    expect(saves.pending.map((p) => p.value)).toEqual(["y"]);
    other.unmount();
    await saves.next("fail", "offline again");
    expect(JSON.parse(stored()!)).toMatchObject({ draft: "y" });
    return a;
  }

  it("forgets on Discard only the draft it showed, not a later failure kept in its place", async () => {
    const saves = controlledSave("v0");
    await replacedWhileShown(saves);
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    await settle();
    expect(valueOf(screen.getByRole("button", { name: "A" }))).toBe("v0");
    expect(JSON.parse(stored()!)).toMatchObject({ draft: "y" });
    // Held in memory as well as in storage.
    render(field(saves.save, "v0", "next"));
    fireEvent.click(screen.getByRole("button", { name: "next" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("y");
  });

  it("forgets on a successful Retry only the draft it showed, not a later failure kept in its place", async () => {
    const saves = controlledSave("v0");
    await replacedWhileShown(saves);
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    await settle();
    await saves.next("succeed");
    expect(saves.store.value).toBe("left behind");
    expect(JSON.parse(stored()!)).toMatchObject({ draft: "y" });
    expect(screen.getByRole("button", { name: "A" }).querySelector("[data-in-place-marker]")).not.toBeNull();
  });

  it("keeps drafts of the same target in different projects apart", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(<InPlaceText target="left" recoveryKey="project:2/step:7/question" yText={null} initialValue="v0" onSave={saves.save} />);
    expect(block()!.querySelector("[data-in-place-marker]")).toBeNull();
    openByKey();
    expect(input().value).toBe("v0");
    expect(notice()).toBeNull();
  });

  it("does not come back, marked or in the field, after Discard when storage refused both the replacement and the removal", async () => {
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    await settle();
    await saves.next("fail", "still offline");
    // The failed Retry is kept in memory only; storage still holds the first draft.
    expect(JSON.parse(stored()!)).toMatchObject({ draft: "left behind", error: "offline" });
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    await settle();
    expect(valueOf(block()!)).toBe("v0");
    expect(block()!.querySelector("[data-in-place-marker]")).toBeNull();
    openByKey();
    expect(input().value).toBe("v0");
    expect(notice()).toBeNull();
  });

  it("is kept in memory when sessionStorage throws", async () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    expect(input().value).toBe("left behind");
    expect(screen.getByRole("alert").textContent).toBe("offline");
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    await settle();
    expect(valueOf(block()!)).toBe("v0");
  });

  it("is kept in memory when sessionStorage refuses writes", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const saves = controlledSave("v0");
    await leaveAndFail(saves);
    render(field(saves.save));
    openByKey();
    expect(input().value).toBe("left behind");
  });
});

describe("typing resumed while a commit is out", () => {
  it("is not overwritten by adopting another field's value", async () => {
    const store: { value?: string } = {};
    const pending: Array<{ value: string; succeed: () => void; fail: () => void }> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve, reject) =>
          pending.push({
            value,
            succeed: () => {
              store.value = value;
              resolve();
            },
            fail: () => reject(new Error(`failed ${value}`)),
          }),
        ),
    );
    render(
      <>
        <InPlaceText target="resumed" yText={null} initialValue="v0" onSave={save} label="A" />
        <InPlaceText target="resumed" yText={null} initialValue="v0" onSave={save} label="B" />
      </>,
    );
    const openIn = (label: string) => {
      const b = screen.getByRole("button", { name: label });
      act(() => b.focus());
      fireEvent.keyDown(b, { key: "Enter" });
      return document.activeElement as HTMLInputElement;
    };
    const a = openIn("A");
    fireEvent.change(a, { target: { value: "mine" } });
    fireEvent.keyDown(a, { key: "Escape" });
    await settle();
    const b = openIn("B");
    fireEvent.change(b, { target: { value: "theirs" } });
    fireEvent.keyDown(b, { key: "Escape" });
    await settle();
    // A resumes typing and comes back to what it submitted.
    fireEvent.change(a, { target: { value: "mine!" } });
    fireEvent.change(a, { target: { value: "mine" } });
    const step = async (outcome: "succeed" | "fail") => {
      await act(async () => pending.shift()![outcome]());
      await settle();
    };
    expect(pending.map((p) => p.value)).toEqual(["mine"]);
    await step("fail");
    expect(pending.map((p) => p.value)).toEqual(["theirs"]);
    await step("succeed");
    // A does not take B's value: it finishes again with its own.
    expect(a.isConnected).toBe(true);
    expect(a.value).toBe("mine");
    while (pending.length) await step("succeed");
    expect(store.value).toBe("mine");
    expect(screen.getAllByRole("button").map((x) => x.textContent)).toContain("mine");
  });
});

describe("a field's older commit resolving after its newer one", () => {
  it("does not resend the field's text over a later field's finish", async () => {
    const store: { value?: string } = {};
    const pending: Array<{ value: string; succeed: () => void }> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve) =>
          pending.push({
            value,
            succeed: () => {
              store.value = value;
              resolve();
            },
          }),
        ),
    );
    render(
      <>
        <InPlaceText target="order" yText={null} initialValue="v0" onSave={save} label="A" />
        <InPlaceText target="order" yText={null} initialValue="v0" onSave={save} label="B" />
      </>,
    );
    const openIn = (label: string) => {
      const b = screen.getByRole("button", { name: label });
      act(() => b.focus());
      fireEvent.keyDown(b, { key: "Enter" });
      return document.activeElement as HTMLInputElement;
    };
    const a = openIn("A");
    fireEvent.change(a, { target: { value: "x" } });
    fireEvent.keyDown(a, { key: "Escape" });
    await settle();
    fireEvent.change(a, { target: { value: "y" } });
    fireEvent.keyDown(a, { key: "Escape" });
    await settle();
    const b = openIn("B");
    fireEvent.change(b, { target: { value: "z" } });
    fireEvent.keyDown(b, { key: "Escape" });
    await settle();
    while (pending.length) {
      await act(async () => pending.shift()!.succeed());
      await settle();
    }
    expect(save.mock.calls.map((c) => c[0])).toEqual(["x", "z"]);
    expect(store.value).toBe("z");
  });
});

describe("a finished field that goes before its commit settles", () => {
  it("does not bring back its superseded text over a later field's finish", async () => {
    const store: { value?: string } = {};
    const pending: Array<{ value: string; succeed: () => void; fail: () => void }> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve, reject) =>
          pending.push({
            value,
            succeed: () => {
              store.value = value;
              resolve();
            },
            fail: () => reject(new Error(`failed ${value}`)),
          }),
        ),
    );
    const first = render(<InPlaceText target="superseded" yText={null} initialValue="v0" onSave={save} label="A" />);
    render(<InPlaceText target="superseded" yText={null} initialValue="v0" onSave={save} label="B" />);
    const finishIn = async (label: string, value: string) => {
      const b = screen.getByRole("button", { name: label });
      act(() => b.focus());
      fireEvent.keyDown(b, { key: "Enter" });
      const field = document.activeElement as HTMLInputElement;
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: "Escape" });
      await settle();
    };
    await finishIn("A", "a");
    await finishIn("B", "b");
    await act(async () => pending.shift()!.fail());
    await settle();
    first.unmount();
    for (;;) {
      await settle();
      const next = pending.shift();
      if (!next) break;
      await act(async () => next.succeed());
    }
    expect(save.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    expect(store.value).toBe("b");
  });
});

describe("ordering by the author's last request", () => {
  function storeSave() {
    const store: { value?: string } = {};
    const pending: Array<{ value: string; succeed: () => void; fail: () => void }> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve, reject) =>
          pending.push({
            value,
            succeed: () => {
              store.value = value;
              resolve();
            },
            fail: () => reject(new Error(`failed ${value}`)),
          }),
        ),
    );
    const drain = async () => {
      for (;;) {
        await settle();
        const next = pending.shift();
        if (!next) return;
        await act(async () => next.succeed());
      }
    };
    return { store, pending, save, drain };
  }
  const openIn = (label: string) => {
    const b = screen.getByRole("button", { name: label });
    act(() => b.focus());
    fireEvent.keyDown(b, { key: "Enter" });
    return document.activeElement as HTMLInputElement;
  };

  it("does not move a field's text behind a later finish when it finishes again with nothing typed", async () => {
    const { store, save, drain } = storeSave();
    render(
      <>
        <InPlaceText target="again" yText={null} initialValue="v0" onSave={save} label="A" />
        <InPlaceText target="again" yText={null} initialValue="v0" onSave={save} label="B" />
      </>,
    );
    const a = openIn("A");
    fireEvent.change(a, { target: { value: "a" } });
    fireEvent.keyDown(a, { key: "Escape" });
    await settle();
    const b = openIn("B");
    fireEvent.change(b, { target: { value: "b" } });
    fireEvent.keyDown(b, { key: "Escape" });
    await settle();
    // A is still open, waiting on its save; Escape again asks for nothing new.
    fireEvent.keyDown(a, { key: "Escape" });
    await drain();
    expect(store.value).toBe("b");
  });

  it("saves a draft left behind that equals a save in flight when a later value is wanted behind it", async () => {
    const { store, save, drain } = storeSave();
    render(
      <>
        <InPlaceText target="inflight" yText={null} initialValue="v0" onSave={save} label="A" />
        <InPlaceText target="inflight" yText={null} initialValue="v0" onSave={save} label="B" />
      </>,
    );
    const late = render(<InPlaceText target="inflight" yText={null} initialValue="v0" onSave={save} label="C" />);
    const a = openIn("A");
    fireEvent.change(a, { target: { value: "t" } });
    fireEvent.keyDown(a, { key: "Escape" });
    await settle();
    const b = openIn("B");
    fireEvent.change(b, { target: { value: "u" } });
    fireEvent.keyDown(b, { key: "Escape" });
    await settle();
    // C, opened after both, is left with "t": the save in flight, not the
    // value that will land.
    const c = openIn("C");
    fireEvent.change(c, { target: { value: "t" } });
    late.unmount();
    await drain();
    expect(store.value).toBe("t");
  });
});

describe("retrying after a failed save", () => {
  it("drops the old error while the new attempt is out", async () => {
    const outcomes: Array<{ ok: () => void; fail: () => void }> = [];
    const save = vi.fn(
      () => new Promise<void>((resolve, reject) => outcomes.push({ ok: resolve, fail: () => reject(new Error("no")) })),
    );
    render(<InPlaceText target="retry" yText={null} initialValue="v0" onSave={save} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "one" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    await act(async () => outcomes.shift()!.fail());
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("no");
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => outcomes.shift()!.ok());
    await settle();
    expect(valueOf(block()!)).toBe("one");
  });
});

describe("a field opened and never edited", () => {
  function pendingSave() {
    const store: { value?: string } = {};
    const pending: Array<{ value: string; succeed: () => void }> = [];
    const save = vi.fn(
      (value: string) =>
        new Promise<void>((resolve) =>
          pending.push({
            value,
            succeed: () => {
              store.value = value;
              resolve();
            },
          }),
        ),
    );
    const drain = async () => {
      for (;;) {
        await settle();
        const next = pending.shift();
        if (!next) return;
        await act(async () => next.succeed());
      }
    };
    return { store, save, drain };
  }

  it.each(["escape", "unmount"] as const)(
    "asks for nothing when it closes by %s, and another field's pending value is stored",
    async (how) => {
      const { store, save, drain } = pendingSave();
      const writerView = render(
        <InPlaceText target="looked" yText={null} initialValue="v0" onSave={save} label="writer" />,
      );
      const looker = render(
        <InPlaceText target="looked" yText={null} initialValue="v0" onSave={save} label="looker" />,
      );
      const writerBlock = screen.getByRole("button", { name: "writer" });
      act(() => writerBlock.focus());
      fireEvent.keyDown(writerBlock, { key: "Enter" });
      const writer = document.activeElement as HTMLInputElement;
      fireEvent.change(writer, { target: { value: "written" } });
      fireEvent.keyDown(writer, { key: "Escape" });
      await settle();
      // The other field opens, is looked at, and closes without an edit.
      const lookerBlock = screen.getByRole("button", { name: "looker" });
      act(() => lookerBlock.focus());
      fireEvent.keyDown(lookerBlock, { key: "Enter" });
      const looked = document.activeElement as HTMLInputElement;
      expect(looked.value).toBe("v0");
      if (how === "escape") fireEvent.keyDown(looked, { key: "Escape" });
      else looker.unmount();
      await drain();
      expect(save.mock.calls.map((c) => c[0])).toEqual(["written"]);
      expect(store.value).toBe("written");
      if (how === "unmount") return;
      // Closed at once on what the target held then; the loader's
      // revalidation brings the stored value.
      writerView.rerender(
        <InPlaceText target="looked" yText={null} initialValue="written" onSave={save} label="writer" />,
      );
      looker.rerender(<InPlaceText target="looked" yText={null} initialValue="written" onSave={save} label="looker" />);
      expect(valueOf(screen.getByRole("button", { name: "looker" }))).toBe("written");
    },
  );

  it("closes at once with nothing pending, and saves nothing", async () => {
    const save = vi.fn();
    render(<InPlaceText target="glance" yText={null} initialValue="v0" onSave={save} />);
    openByKey();
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(valueOf(block()!)).toBe("v0");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("the newest value, from the loader or a save", () => {
  it("is what an unedited close shows, after a loader value newer than the last save", async () => {
    const save = vi.fn(async () => {});
    const field = (value: string) => (
      <InPlaceText target="newest" yText={null} initialValue={value} onSave={save} />
    );
    const { rerender } = render(field("v0"));
    openByKey();
    fireEvent.change(input(), { target: { value: "v1" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(valueOf(block()!)).toBe("v1");
    rerender(field("v2"));
    expect(valueOf(block()!)).toBe("v2");
    openByKey();
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(valueOf(block()!)).toBe("v2");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("is what an unedited close shows when the loader value arrived while it was open", async () => {
    const save = vi.fn(async () => {});
    const field = (value: string) => (
      <InPlaceText target="newest-open" yText={null} initialValue={value} onSave={save} />
    );
    const { rerender } = render(field("v0"));
    openByKey();
    fireEvent.change(input(), { target: { value: "v1" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    openByKey();
    rerender(field("v2"));
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(valueOf(block()!)).toBe("v2");
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("a field that closes late", () => {
  it("does not take focus back from the field the author moved to", async () => {
    let finishSave: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((resolve) => (finishSave = resolve)));
    render(
      <>
        <InPlaceText target="late-a" yText={null} initialValue="a" onSave={slow} label="A" />
        <InPlaceText target="late-b" yText={null} initialValue="b" label="B" />
      </>,
    );
    const a = screen.getByRole("button", { name: "A" });
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "Enter" });
    const field = document.activeElement as HTMLInputElement;
    fireEvent.change(field, { target: { value: "a2" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await settle();
    const b = screen.getByRole("button", { name: "B" });
    act(() => b.focus());
    fireEvent.keyDown(b, { key: "Enter" });
    const other = document.activeElement as HTMLInputElement;
    expect(other.value).toBe("b");
    await act(async () => finishSave());
    await settle();
    expect(valueOf(screen.getByRole("button", { name: "A" }))).toBe("a2");
    expect(document.activeElement).toBe(other);
  });
});

describe("nothing outlives a target's record", () => {
  it("takes the loader's value as the baseline once the record is gone, not a stale stored one", async () => {
    const store: { value: string } = { value: "v0" };
    const save = vi.fn(async (value: string) => {
      store.value = value;
    });
    const first = render(<InPlaceText target="kept" yText={null} initialValue="v0" onSave={save} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(store.value).toBe("x");
    first.unmount();
    // Someone else changes the target; the loader brings their value.
    store.value = "y";
    render(<InPlaceText target="kept" yText={null} initialValue="y" onSave={save} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(store.value).toBe("x");
    expect(valueOf(block()!)).toBe("x");
  });

  it("keeps nothing for a field with no target once it is gone", async () => {
    const before = trackedTargetCount();
    const save = vi.fn(async () => {});
    const { unmount } = render(<InPlaceText yText={null} initialValue="v0" onSave={save} />);
    openByKey();
    fireEvent.change(input(), { target: { value: "x" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    unmount();
    await settle();
    expect(trackedTargetCount()).toBe(before);
  });
});

describe("InPlaceMarkdown", () => {
  const source = "See [the map](https://example.org/map) here.";

  it("renders the Markdown in the block", () => {
    render(<InPlaceMarkdown yText={null} initialValue={source} />);
    const link = screen.getByText("the map") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
  });

  it("edits on a plain click on a link, without following it", () => {
    render(<InPlaceMarkdown yText={null} initialValue={source} />);
    const followed = fireEvent.click(screen.getByText("the map"));
    expect(followed).toBe(false);
    expect(block()).toBeNull();
    expect(editorView().state.doc.toString()).toBe(source);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("follows the link on a modified click %o", (modifier) => {
    render(<InPlaceMarkdown yText={null} initialValue={source} />);
    const followed = fireEvent.click(screen.getByText("the map"), modifier);
    expect(followed).toBe(true);
    expect(block()).not.toBeNull();
  });

  it("opens on Enter with the editor focused, and Escape gives focus back to the block", () => {
    render(<InPlaceMarkdown yText={null} initialValue={source} />);
    openByKey();
    const view = editorView();
    expect(view.hasFocus).toBe(true);
    fireEvent.keyDown(view.contentDOM, { key: "Escape" });
    expect(block()).not.toBeNull();
    expect(document.activeElement).toBe(block());
  });

  it("keeps an edit closed at once by Escape with no Y.Text, and saves it", async () => {
    const onSave = vi.fn();
    render(<InPlaceMarkdown yText={null} initialValue="**bold**" onSave={onSave} />);
    openByKey();
    const view = editorView();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " and more" } }));
    fireEvent.keyDown(view.contentDOM, { key: "Escape" });
    await settle();
    expect(onSave).toHaveBeenCalledWith("**bold** and more");
    expect(block()!.querySelector("strong")?.textContent).toBe("bold");
    expect(valueOf(block()!)!.trim()).toBe("bold and more");
  });

  it("closes when focus leaves the editor, and not when it moves into the link popover", async () => {
    render(
      <div>
        <button type="button">elsewhere</button>
        <InPlaceMarkdown yText={null} initialValue={source} editorProps={{ alwaysShowToolbar: true }} />
      </div>,
    );
    openByKey();
    await settle();
    const link = screen.getByTitle("toolbar.link");
    link.focus();
    fireEvent.click(link, { detail: 0 });
    expect(document.activeElement).toBe(screen.getByPlaceholderText("link_popover.url_placeholder"));
    await settle();
    expect(block()).toBeNull();
    act(() => screen.getByText("elsewhere").focus());
    await settle();
    expect(block()).not.toBeNull();
  });

  it("leaves Escape in the link popover to the popover", async () => {
    render(<InPlaceMarkdown yText={null} initialValue={source} editorProps={{ alwaysShowToolbar: true }} />);
    openByKey();
    const link = screen.getByTitle("toolbar.link");
    link.focus();
    fireEvent.click(link, { detail: 0 });
    fireEvent.keyDown(screen.getByPlaceholderText("link_popover.url_placeholder"), { key: "Escape" });
    await settle();
    expect(block()).toBeNull();
    expect(editorView().hasFocus).toBe(true);
  });

  it("brings back a recovered draft, and keeps the editor open while focus is on Retry", async () => {
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error("offline");
    });
    const first = render(<InPlaceMarkdown target="md" yText={null} initialValue="**v0**" onSave={save} />);
    openByKey();
    const view = editorView();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " left" } }));
    first.unmount();
    await settle();
    render(<InPlaceMarkdown target="md" yText={null} initialValue="**v0**" onSave={save} />);
    openByKey();
    expect(editorView().state.doc.toString()).toBe("**v0** left");
    expect(screen.getByRole("alert").textContent).toBe("offline");
    const retry = screen.getByText("in_place.recovered_retry");
    act(() => retry.focus());
    await settle();
    expect(block()).toBeNull();
    fail = false;
    fireEvent.click(retry);
    await settle();
    expect(save).toHaveBeenLastCalledWith("**v0** left");
    expect(valueOf(block()!)!.trim()).toBe("v0 left");
    window.sessionStorage.clear();
  });

  it("renders through the render function it is given", () => {
    render(<InPlaceMarkdown yText={null} initialValue="x" render={(md) => `<em>${md}!</em>`} />);
    expect(block()!.innerHTML).toContain("<em>x!</em>");
  });
});
