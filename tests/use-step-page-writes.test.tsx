// @vitest-environment jsdom

/**
 * The route's step writes, exercised through the hook the route calls.
 *
 * Everything here happens across a gap: a dialog is opened from one render and
 * answered in another, and in between a peer can replace an object, reorder the
 * list by rewriting order keys, or delete the step. So each case mounts the hook
 * over a real Y.Doc, mutates that doc the way a peer would — deliberately
 * WITHOUT rerendering, which is the state the bug lives in — and then calls the
 * handler the editor would call.
 *
 * Display order is `order_key` order throughout: the seed scan, the new step's
 * index, the cancellation of an unconsumed request and every target resolution
 * read the ordered maps, so a reorder that moves nothing in the array still
 * moves what these answer.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";

const ydocRef: { current: Y.Doc | null } = { current: null };

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: ydocRef.current }),
}));

import { useStructuralOps } from "~/hooks/use-structural-ops";
import type { StructuralOps } from "~/hooks/use-structural-ops";
import { useStepPageWrites } from "~/hooks/use-step-page-writes";
import type { StepWriteRow } from "~/hooks/use-step-page-writes";
import { isSidebarStep, sidebarShapeOf } from "~/lib/step-writes";
import type { WriteBinding } from "~/lib/step-writes";
import { selectStepIn } from "~/lib/step-selection";
import { nextOrderKeyAfterLast, orderedMaps } from "~/lib/field-order";
import type { PageChooserSession } from "~/components/features/editor/PageChooserDialog";

// ---------------------------------------------------------------------------
// A document, and the rows a render would derive from it
// ---------------------------------------------------------------------------

interface StepFields {
  _id?: number | null;
  _temp_id?: string | null;
  step_number?: number;
  kind?: string;
  object_id?: string;
  order_key?: string;
  page?: string | null;
  x?: number | null;
  y?: number | null;
  zoom?: number | null;
}

function stepMapOf(fields: StepFields, index: number): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("_id", fields._id ?? null);
  map.set("_temp_id", fields._temp_id ?? null);
  map.set("step_number", fields.step_number ?? index + 1);
  map.set("kind", fields.kind ?? "media");
  map.set("object_id", fields.object_id ?? "");
  map.set("order_key", fields.order_key ?? `a${index}`);
  map.set("page", fields.page ?? null);
  map.set("x", fields.x ?? null);
  map.set("y", fields.y ?? null);
  map.set("zoom", fields.zoom ?? null);
  map.set("layers", new Y.Array<Y.Map<unknown>>());
  return map;
}

function docWithSteps(steps: StepFields[]) {
  const doc = new Y.Doc();
  ydocRef.current = doc;
  const storyYMap = new Y.Map<unknown>();
  const stepsArray = new Y.Array<Y.Map<unknown>>();
  doc.transact(() => {
    storyYMap.set("steps", stepsArray);
    doc.getArray<Y.Map<unknown>>("stories").push([storyYMap]);
    stepsArray.push(steps.map(stepMapOf));
  });
  return { doc, storyYMap, stepsArray };
}

/** What a render derives from the live array: the sidebar's steps, in order. */
function rowsOf(stepsArray: Y.Array<Y.Map<unknown>> | null): StepWriteRow[] {
  return orderedMaps(stepsArray)
    .filter((m) => isSidebarStep(sidebarShapeOf(m)))
    .map((m) => ({
      id: (m.get("_id") as number | null) ?? 0,
      step_number: (m.get("step_number") as number) ?? 0,
      object_id: (m.get("object_id") as string | null) ?? null,
      _tempId: (m.get("_temp_id") as string | null) ?? null,
      _yMap: m,
    }));
}

interface HarnessProps {
  activeStepIndex: number;
  isStepZero: boolean;
  selectionKey: string;
  /** Overrides the rows derived from the doc; the branch without a Y.Doc uses it. */
  rows?: StepWriteRow[];
  useYjs?: boolean;
  /** The URL the editor was opened at, which a selection mirrors into. */
  searchParams?: string;
}

/** One object per source, so a change of object is a change of source key. */
const sourceKeyOfObject = (objectId: string | null) => `src:${objectId ?? "none"}`;

function mountWrites(steps: StepFields[], initial: Partial<HarnessProps> = {}) {
  const { doc, storyYMap, stepsArray } = docWithSteps(steps);

  // What the route would hold in state. Read at every render, so a selection the
  // route performs during a handler is visible to the effects that handler
  // schedules — which is how `handleAddStep` and its request behave in the
  // editor, where the index moves in the same batch as the request.
  const current: HarnessProps = {
    activeStepIndex: 1,
    isStepZero: false,
    selectionKey: "tmp:a",
    ...initial,
  };

  // The route's own selection sinks. The sequence itself is not restated here:
  // the harness drives the real `selectStepIn`, so a panel reset or a mirror
  // dropped from it is dropped from what these tests run.
  let params = new URLSearchParams(initial.searchParams ?? "");
  const setters = {
    setActiveStepIndex: vi.fn<(index: number) => void>((index) => {
      current.activeStepIndex = index;
      current.isStepZero = index === 0;
    }),
    closePanels: vi.fn<() => void>(),
    setSearchParams: vi.fn<
      (
        update: (prev: URLSearchParams) => URLSearchParams,
        options: { replace: boolean }
      ) => void
    >((update) => { params = update(params); }),
  };

  const spies = {
    onSelectStep: vi.fn<(index: number) => void>((index) => selectStepIn(setters, index)),
    submitCapture: vi.fn<(fields: Record<string, string>) => void>(),
    submitChangeObject: vi.fn<(fields: Record<string, string>) => void>(),
    submitSetPage: vi.fn<(fields: Record<string, string>) => void>(),
  };

  let ops: StructuralOps | null = null;

  const { result, rerender } = renderHook(() => {
    ops = useStructuralOps(1, "convenor");
    const useYjs = current.useYjs ?? true;
    const sidebarSteps = current.rows ?? rowsOf(useYjs ? stepsArray : null);
    const activeStep = current.isStepZero
      ? sidebarSteps[0] ?? null
      : sidebarSteps[current.activeStepIndex - 1] ?? null;
    return useStepPageWrites({
      useYjs,
      ydoc: useYjs ? doc : null,
      ops: useYjs ? ops : null,
      storyYMap: useYjs ? storyYMap : null,
      stepsArray: useYjs ? stepsArray : null,
      sidebarSteps,
      activeStep,
      activeStepIndex: current.activeStepIndex,
      isStepZero: current.isStepZero,
      selectionKey: current.selectionKey,
      sourceKeyForObject: sourceKeyOfObject,
      onSelectStep: spies.onSelectStep,
      submitCapture: spies.submitCapture,
      submitChangeObject: spies.submitChangeObject,
      submitSetPage: spies.submitSetPage,
    });
  });

  return {
    doc,
    storyYMap,
    stepsArray,
    ...spies,
    setters,
    /** The URL the mirror has left behind. */
    searchParams: () => params.toString(),
    api: () => result.current,
    ops: () => ops!,
    /** Move the route's own state and rerender, as a step switch would. */
    update: (next: Partial<HarnessProps>) => {
      Object.assign(current, next);
      act(() => rerender());
    },
    /** Rerender unchanged, the way the Y.Array observer makes the route. */
    reflect: () => act(() => rerender()),
  };
}

function session(over: Partial<PageChooserSession> = {}): PageChooserSession {
  return {
    selectionKey: "tmp:a",
    targetKey: "tmp:a",
    objectId: "codex",
    sourceKey: "src:codex",
    ...over,
  };
}

/** What a capture carries: the same four facts a chooser session names. */
function binding(over: Partial<WriteBinding> = {}): WriteBinding {
  return { ...session(), ...over };
}

const CODEX_STEP: StepFields = { _temp_id: "a", object_id: "codex", order_key: "a0" };

beforeEach(() => {
  ydocRef.current = null;
});

// ---------------------------------------------------------------------------

describe("useStepPageWrites — the four session checks on a page choice", () => {
  it("writes the page and clears the framing when all four agree", () => {
    const h = mountWrites([{ ...CODEX_STEP, page: "1", x: 0.2, y: 0.3, zoom: 2 }]);
    act(() => h.api().handleChoosePage(4, session()));

    const step = h.stepsArray.get(0);
    expect(step.get("page")).toBe("4");
    expect(step.get("x")).toBeNull();
    expect(step.get("y")).toBeNull();
    expect(step.get("zoom")).toBeNull();
  });

  it("writes nothing when the selection has moved on", () => {
    const h = mountWrites([CODEX_STEP], { selectionKey: "id:9" });
    act(() => h.api().handleChoosePage(4, session()));
    expect(h.stepsArray.get(0).get("page")).toBeNull();
  });

  it("writes nothing when a peer replaced the object before the rerender", () => {
    const h = mountWrites([CODEX_STEP]);
    // A second document replaces the object; the route has not rerendered.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.doc));
    peer.transact(() => {
      const steps = (peer.getArray<Y.Map<unknown>>("stories").get(0).get("steps")) as Y.Array<Y.Map<unknown>>;
      steps.get(0).set("object_id", "atlas");
    });
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(peer));

    act(() => h.api().handleChoosePage(4, session()));
    expect(h.stepsArray.get(0).get("page")).toBeNull();
  });

  it("writes nothing when the object's source has changed under it", () => {
    const h = mountWrites([CODEX_STEP]);
    act(() => h.api().handleChoosePage(4, session({ sourceKey: "src:elsewhere" })));
    expect(h.stepsArray.get(0).get("page")).toBeNull();
  });

  it("writes nothing when the target step has been deleted", () => {
    const h = mountWrites([CODEX_STEP]);
    h.doc.transact(() => h.stepsArray.delete(0, 1));
    act(() => h.api().handleChoosePage(4, session()));
    expect(h.stepsArray.length).toBe(0);
  });
});

describe("useStepPageWrites — a reorder made only of order keys", () => {
  const two: StepFields[] = [
    { _temp_id: "a", object_id: "codex", order_key: "a0" },
    { _temp_id: "b", object_id: "codex", order_key: "a1" },
  ];

  it("refuses a choice whose step a peer's reorder moved out of the slot", () => {
    const h = mountWrites(two, { activeStepIndex: 1, selectionKey: "tmp:a" });
    // The peer drags b in front of a. Nothing leaves the array; only keys move.
    h.doc.transact(() => h.stepsArray.get(1).set("order_key", "Zz"));

    act(() => h.api().handleChoosePage(4, session({ targetKey: "tmp:a" })));
    expect(h.stepsArray.get(0).get("page")).toBeNull();
  });

  it("writes for the step the reorder put in the slot", () => {
    const h = mountWrites(two, { activeStepIndex: 1, selectionKey: "tmp:b" });
    h.doc.transact(() => h.stepsArray.get(1).set("order_key", "Zz"));

    act(() =>
      h.api().handleChoosePage(4, session({ selectionKey: "tmp:b", targetKey: "tmp:b" }))
    );
    expect(h.stepsArray.get(1).get("page")).toBe("4");
    expect(h.stepsArray.get(0).get("page")).toBeNull();
  });
});

describe("useStepPageWrites — step 0 and step 1", () => {
  const two: StepFields[] = [
    { _temp_id: "a", object_id: "codex", order_key: "a0" },
    { _temp_id: "b", object_id: "codex", order_key: "a1" },
  ];

  it("resolves step 0 to the first step", () => {
    const h = mountWrites(two, { isStepZero: true, activeStepIndex: 0, selectionKey: "step0" });
    act(() => h.api().handleChoosePage(4, session({ selectionKey: "step0" })));
    expect(h.stepsArray.get(0).get("page")).toBe("4");
  });

  it("refuses a session opened under step 0 once step 1 is selected", () => {
    const h = mountWrites(two, { activeStepIndex: 1, selectionKey: "tmp:a" });
    // Both resolve to the same Y.Map; the selection key is what separates them.
    act(() => h.api().handleChoosePage(4, session({ selectionKey: "step0" })));
    expect(h.stepsArray.get(0).get("page")).toBeNull();
  });

  it("refuses a step-0 session after a peer put another step first", () => {
    const h = mountWrites(two, { isStepZero: true, activeStepIndex: 0, selectionKey: "step0" });
    h.doc.transact(() => h.stepsArray.get(1).set("order_key", "Zz"));
    act(() => h.api().handleChoosePage(4, session({ selectionKey: "step0", targetKey: "tmp:a" })));
    expect(h.stepsArray.get(0).get("page")).toBeNull();
  });
});

describe("useStepPageWrites — the branch without a Y.Doc", () => {
  const rows: StepWriteRow[] = [
    { id: 11, step_number: 1, object_id: "codex", _tempId: null, _yMap: null },
    { id: 12, step_number: 2, object_id: "codex", _tempId: null, _yMap: null },
  ];

  it("submits the resolved concrete step id and the expected object", () => {
    const h = mountWrites([], { useYjs: false, rows, activeStepIndex: 2, selectionKey: "id:12" });
    act(() =>
      h.api().handleChoosePage(4, session({ selectionKey: "id:12", targetKey: "id:12" }))
    );
    expect(h.submitSetPage).toHaveBeenCalledWith({
      intent: "set-page",
      stepId: "12",
      page: "4",
      expectedObjectId: "codex",
    });
  });

  it("submits nothing when the session names a step that is not the target", () => {
    const h = mountWrites([], { useYjs: false, rows, activeStepIndex: 2, selectionKey: "id:12" });
    act(() =>
      h.api().handleChoosePage(4, session({ selectionKey: "id:12", targetKey: "id:11" }))
    );
    expect(h.submitSetPage).not.toHaveBeenCalled();
  });
});

describe("useStepPageWrites — the targeted object change fails closed", () => {
  const two: StepFields[] = [
    { _temp_id: "a", object_id: "codex", order_key: "a0" },
    { _temp_id: "b", object_id: "codex", order_key: "a1" },
  ];

  it("writes nothing when the target cannot be resolved", () => {
    const h = mountWrites(two, { activeStepIndex: 1, selectionKey: "tmp:a" });
    act(() => h.api().handleChangeObject("atlas", "tmp:b"));
    expect(h.stepsArray.get(0).get("object_id")).toBe("codex");
    expect(h.stepsArray.get(1).get("object_id")).toBe("codex");
  });

  it("writes nothing for a target key when there is no Y.Doc at all", () => {
    const rows: StepWriteRow[] = [
      { id: 11, step_number: 1, object_id: "codex", _tempId: null, _yMap: null },
    ];
    const h = mountWrites([], { useYjs: false, rows, activeStepIndex: 1, selectionKey: "id:11" });
    act(() => h.api().handleChangeObject("atlas", "id:11"));
    expect(h.submitChangeObject).not.toHaveBeenCalled();
  });

  it("writes to the named step when it is the target", () => {
    const h = mountWrites(two, { activeStepIndex: 2, selectionKey: "tmp:b" });
    act(() => h.api().handleChangeObject("atlas", "tmp:b"));
    expect(h.stepsArray.get(1).get("object_id")).toBe("atlas");
    expect(h.stepsArray.get(0).get("object_id")).toBe("codex");
  });

  it("writes to the active step when no target is named", () => {
    const h = mountWrites(two, { activeStepIndex: 2, selectionKey: "tmp:b" });
    act(() => h.api().handleChangeObject("atlas"));
    expect(h.stepsArray.get(1).get("object_id")).toBe("atlas");
  });
});

describe("useStepPageWrites — the capture baseline", () => {
  const one: StepFields[] = [{ ...CODEX_STEP, page: "2", x: 0.1, y: 0.2, zoom: 3 }];

  function captured(h: ReturnType<typeof mountWrites>) {
    act(() => h.api().handleCapturePosition({ x: 0.8, y: 0.9, zoom: 5, page: "3" }, binding()));
    h.reflect();
    return h;
  }

  it("shows the pill for the captured step and restores the prior values", () => {
    const h = captured(mountWrites(one));
    expect(h.api().captureUndoNonce).toBe(1);

    act(() => h.api().handleUndoCapture());
    const step = h.stepsArray.get(0);
    expect(step.get("page")).toBe("2");
    expect(step.get("x")).toBe(0.1);
    expect(step.get("zoom")).toBe(3);
  });

  it("is cleared by a page choice", () => {
    const h = captured(mountWrites(one));
    act(() => h.api().handleChoosePage(4, session()));
    h.reflect();
    expect(h.api().captureUndoNonce).toBeNull();
  });

  it("is cleared by a local object change", () => {
    const h = captured(mountWrites(one));
    act(() => h.api().handleChangeObject("atlas"));
    h.reflect();
    expect(h.api().captureUndoNonce).toBeNull();
  });

  it("restores nothing after a peer replaced the object, before the rerender", () => {
    const h = captured(mountWrites(one));
    const afterCapture = {
      x: h.stepsArray.get(0).get("x"),
      y: h.stepsArray.get(0).get("y"),
    };
    // The peer's replacement lands in the doc; the route has not rerendered.
    h.doc.transact(() => h.stepsArray.get(0).set("object_id", "atlas"));

    act(() => h.api().handleUndoCapture());
    expect(h.stepsArray.get(0).get("x")).toBe(afterCapture.x);
    expect(h.stepsArray.get(0).get("y")).toBe(afterCapture.y);
  });

  it("retires the pill on the render that brings the replacement in", () => {
    const h = captured(mountWrites(one));
    h.doc.transact(() => h.stepsArray.get(0).set("object_id", "atlas"));
    h.reflect();
    expect(h.api().captureUndoNonce).toBeNull();
  });
});

describe("useStepPageWrites — a capture is bound to what it captured", () => {
  const POS = { x: 0.8, y: 0.9, zoom: 5, page: "3" };
  const framed: StepFields = { ...CODEX_STEP, page: "2", x: 0.1, y: 0.2, zoom: 3 };

  /** The step's four viewport values, as the doc holds them. */
  function viewportOf(h: ReturnType<typeof mountWrites>, index = 0) {
    const map = orderedMaps(h.stepsArray)[index];
    return {
      page: map.get("page"),
      x: map.get("x"),
      y: map.get("y"),
      zoom: map.get("zoom"),
    };
  }

  it("writes the viewport when the step still shows what the viewer showed", () => {
    const h = mountWrites([framed]);
    act(() => h.api().handleCapturePosition(POS, binding()));
    expect(viewportOf(h)).toEqual({ page: "3", x: 0.8, y: 0.9, zoom: 5 });
  });

  it("writes nothing onto an object a peer put there between the read and the write", () => {
    const h = mountWrites([framed]);
    // A second document replaces the object. The route has not rerendered, so
    // the column's records — and the disabled state of the button — still
    // describe the object whose viewport was just read.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.doc));
    peer.transact(() => {
      const steps = (peer.getArray<Y.Map<unknown>>("stories").get(0).get("steps")) as Y.Array<Y.Map<unknown>>;
      steps.get(0).set("object_id", "atlas");
    });
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(peer));

    act(() => h.api().handleCapturePosition(POS, binding()));
    // The replacement keeps its own page and coordinates, and no Undo baseline
    // was recorded for a capture that never happened.
    expect(viewportOf(h)).toEqual({ page: "2", x: 0.1, y: 0.2, zoom: 3 });
    expect(h.api().captureUndoNonce).toBeNull();
  });

  it("leaves an earlier baseline standing when it refuses", () => {
    const h = mountWrites([framed]);
    act(() => h.api().handleCapturePosition(POS, binding()));
    h.reflect();
    expect(h.api().captureUndoNonce).toBe(1);

    h.doc.transact(() => h.stepsArray.get(0).set("object_id", "atlas"));
    act(() => h.api().handleCapturePosition({ ...POS, page: "1" }, binding()));
    // Nothing written, nothing cleared: the pill still belongs to the capture
    // that did happen, and Undo still restores what it overwrote.
    expect(viewportOf(h)).toEqual({ page: "3", x: 0.8, y: 0.9, zoom: 5 });
    expect(h.api().captureUndoNonce).toBe(1);
  });

  it("writes nothing when the source has changed under the object", () => {
    const h = mountWrites([framed]);
    act(() => h.api().handleCapturePosition(POS, binding({ sourceKey: "src:elsewhere" })));
    expect(viewportOf(h)).toEqual({ page: "2", x: 0.1, y: 0.2, zoom: 3 });
  });

  it("writes nothing when the selection has moved on", () => {
    const h = mountWrites([framed], { selectionKey: "id:9" });
    act(() => h.api().handleCapturePosition(POS, binding()));
    expect(viewportOf(h)).toEqual({ page: "2", x: 0.1, y: 0.2, zoom: 3 });
  });

  it("writes nothing when a peer's reorder moved the step out of the slot", () => {
    const h = mountWrites(
      [framed, { _temp_id: "b", object_id: "codex", order_key: "a1" }],
      { activeStepIndex: 1, selectionKey: "tmp:a" }
    );
    h.doc.transact(() => h.stepsArray.get(1).set("order_key", "Zz"));
    act(() => h.api().handleCapturePosition(POS, binding()));
    expect(viewportOf(h, 1)).toEqual({ page: "2", x: 0.1, y: 0.2, zoom: 3 });
  });

  it("submits the resolved step id and the expected object without a Y.Doc", () => {
    const rows: StepWriteRow[] = [
      { id: 11, step_number: 1, object_id: "codex", _tempId: null, _yMap: null },
      { id: 12, step_number: 2, object_id: "codex", _tempId: null, _yMap: null },
    ];
    const h = mountWrites([], { useYjs: false, rows, activeStepIndex: 2, selectionKey: "id:12" });
    act(() =>
      h.api().handleCapturePosition(
        POS,
        binding({ selectionKey: "id:12", targetKey: "id:12" })
      )
    );
    expect(h.submitCapture).toHaveBeenCalledWith({
      intent: "capture-position",
      stepId: "12",
      x: "0.8",
      y: "0.9",
      zoom: "5",
      page: "3",
      expectedObjectId: "codex",
    });
  });

  it("submits nothing without a Y.Doc when the object has changed", () => {
    const rows: StepWriteRow[] = [
      { id: 11, step_number: 1, object_id: "atlas", _tempId: null, _yMap: null },
    ];
    const h = mountWrites([], { useYjs: false, rows, activeStepIndex: 1, selectionKey: "id:11" });
    act(() =>
      h.api().handleCapturePosition(
        POS,
        binding({ selectionKey: "id:11", targetKey: "id:11" })
      )
    );
    expect(h.submitCapture).not.toHaveBeenCalled();
  });
});

describe("useStepPageWrites — the seed a new step starts from", () => {
  it("takes the last eligible step in display order, not array order", () => {
    const h = mountWrites([
      { _temp_id: "a", object_id: "codex", page: "2", x: 0.1, y: 0.2, zoom: 3, order_key: "a0" },
      { _temp_id: "b", object_id: "atlas", page: "7", order_key: "a1" },
    ]);
    // A peer drags atlas in front of codex, so codex is the last displayed step.
    h.doc.transact(() => h.stepsArray.get(1).set("order_key", "Zz"));

    act(() => h.api().handleAddStep());
    const added = orderedMaps(h.stepsArray).at(-1)!;
    expect(added.get("object_id")).toBe("codex");
    expect(added.get("page")).toBe("2");
    expect(added.get("zoom")).toBe(3);
  });

  it("skips section cards and steps with no object", () => {
    const h = mountWrites([
      { _temp_id: "a", object_id: "codex", page: "5", order_key: "a0" },
      { _temp_id: "b", object_id: "", order_key: "a1" },
      { _temp_id: "c", kind: "section", object_id: "atlas", order_key: "a2" },
    ]);
    act(() => h.api().handleAddStep());
    const added = orderedMaps(h.stepsArray).at(-1)!;
    expect(added.get("object_id")).toBe("codex");
    expect(added.get("page")).toBe("5");
  });

  it("adds an empty step, and asks for no dialog, when nothing is eligible", () => {
    const h = mountWrites([{ _temp_id: "a", object_id: "", order_key: "a0" }]);
    act(() => h.api().handleAddStep());
    expect(orderedMaps(h.stepsArray).at(-1)!.get("object_id")).toBe("");
    expect(h.api().pendingNewStep).toBeNull();
    expect(h.onSelectStep).toHaveBeenCalledWith(2);
  });

  it("selects the new step at its display index, past a section card", () => {
    const h = mountWrites([
      { _temp_id: "a", object_id: "codex", order_key: "a0" },
      { _temp_id: "c", kind: "section", object_id: "", order_key: "a1" },
      // A malformed entry the sidebar does not show and does not count.
      { _temp_id: null, _id: 0, step_number: 0, order_key: "a2" },
    ]);
    act(() => h.api().handleAddStep());
    // Two included steps precede it: the media step and the section card.
    expect(h.onSelectStep).toHaveBeenCalledWith(3);
    expect(h.api().pendingNewStep).not.toBeNull();
  });

  it("requests the dialog from the title card as it does from a step", () => {
    const h = mountWrites([{ _temp_id: "a", object_id: "codex", order_key: "a0" }], {
      isStepZero: true,
      activeStepIndex: 0,
      selectionKey: "step0",
    });
    act(() => h.api().handleAddStep());
    const tempId = orderedMaps(h.stepsArray).at(-1)!.get("_temp_id");
    // The addition selects the new step, and the request survives to the column
    // that the shell then mounts on it.
    expect(h.onSelectStep).toHaveBeenCalledWith(2);
    expect(h.api().pendingNewStep).toEqual({ tempId });
  });
});

describe("useStepPageWrites — the selection an addition performs", () => {
  it("moves the index, closes both layer panels and mirrors the step into the URL", () => {
    const h = mountWrites([{ _temp_id: "a", object_id: "codex", order_key: "a0" }], {
      searchParams: "step=1&layer=2",
    });
    act(() => h.api().handleAddStep());

    expect(h.setters.setActiveStepIndex).toHaveBeenCalledWith(2);
    expect(h.setters.closePanels).toHaveBeenCalled();
    // The new step is in the URL and the layer that was open is not, so a
    // reload lands on the step the author is now editing.
    expect(h.searchParams()).toBe("step=2");
    expect(h.setters.setSearchParams.mock.calls[0][1]).toEqual({ replace: true });
  });

  it("drops both parameters when the selection is the title card", () => {
    const h = mountWrites([{ _temp_id: "a", object_id: "codex", order_key: "a0" }], {
      searchParams: "step=3&layer=1",
    });
    act(() => h.api().handleAddStep());
    h.onSelectStep.mockClear();
    act(() => h.onSelectStep(0));
    expect(h.searchParams()).toBe("");
  });
});

describe("useStepPageWrites — adding from a section card", () => {
  const withSection: StepFields[] = [
    { _temp_id: "a", object_id: "codex", page: "2", order_key: "a0" },
    { _temp_id: "c", kind: "section", object_id: "", order_key: "a1" },
  ];

  /** The section card is the active selection when Add step is pressed. */
  function addedFromSection() {
    const h = mountWrites(withSection, { activeStepIndex: 2, selectionKey: "tmp:c" });
    act(() => h.api().handleAddStep());
    const tempId = orderedMaps(h.stepsArray).at(-1)!.get("_temp_id") as string;
    h.update({ selectionKey: `tmp:${tempId}` });
    return { h, tempId };
  }

  it("selects the new step and hands the request to the column", () => {
    const { h, tempId } = addedFromSection();
    // Two included entries precede it: the media step and the section card.
    expect(h.setters.setActiveStepIndex).toHaveBeenCalledWith(3);
    expect(orderedMaps(h.stepsArray).at(-1)!.get("object_id")).toBe("codex");
    expect(h.api().pendingNewStep).toEqual({ tempId });
  });

  it("cancels the request when a peer's reorder puts the section card in the slot", () => {
    const { h } = addedFromSection();
    // Nothing leaves the array and nothing is deleted: the peer drags the
    // section card past the new step, so the active slot now holds the card.
    const afterTheNewStep = nextOrderKeyAfterLast(h.stepsArray);
    h.doc.transact(() => h.stepsArray.get(1).set("order_key", afterTheNewStep));
    h.reflect();
    expect(h.api().pendingNewStep).toBeNull();
  });
});

describe("useStepPageWrites — the unconsumed new-step request", () => {
  function added() {
    const h = mountWrites([{ _temp_id: "a", object_id: "codex", order_key: "a0" }]);
    act(() => h.api().handleAddStep());
    const tempId = orderedMaps(h.stepsArray).at(-1)!.get("_temp_id") as string;
    h.update({ selectionKey: `tmp:${tempId}` });
    return { h, tempId };
  }

  it("stands while the new step is the live active target", () => {
    const { h, tempId } = added();
    expect(h.api().pendingNewStep).toEqual({ tempId });
  });

  it("is cancelled when the live active target moves to another step", () => {
    const { h } = added();
    h.update({ activeStepIndex: 1, selectionKey: "tmp:a" });
    expect(h.api().pendingNewStep).toBeNull();
  });

  it("is cancelled when the step leaves the array", () => {
    const { h } = added();
    h.doc.transact(() => h.stepsArray.delete(1, 1));
    h.reflect();
    expect(h.api().pendingNewStep).toBeNull();
  });

  it("is cancelled when the title card becomes the target", () => {
    const { h } = added();
    h.update({ isStepZero: true, activeStepIndex: 0, selectionKey: "step0" });
    expect(h.api().pendingNewStep).toBeNull();
  });

  it("is not cleared by an acknowledgement of an older request", () => {
    const { h, tempId } = added();
    act(() => h.api().handleNewStepConsumed("an-earlier-step"));
    expect(h.api().pendingNewStep).toEqual({ tempId });

    act(() => h.api().handleNewStepConsumed(tempId));
    expect(h.api().pendingNewStep).toBeNull();
  });
});
