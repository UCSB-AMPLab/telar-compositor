// @vitest-environment jsdom
import { describe, expect, test, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { MemoryRouter } from "react-router";

const showToast = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast, dismissToast: vi.fn() }),
}));

// i18n stub: echo key + interpolate {{label}}/{{title}} so assertions read clearly.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.label) return `${key}:${opts.label}`;
      if (opts?.title !== undefined) return `${key}:${opts.title}`;
      return key;
    },
  }),
}));

let mockDoc: Y.Doc;
let mockUndoManager: Y.UndoManager;
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: mockDoc, undoManager: mockUndoManager }),
}));

import { UndoFeedback } from "~/components/features/collaboration/UndoFeedback";
import { useUndoControls } from "~/hooks/use-undo-controls";
import { createUndoManager } from "~/lib/undo-manager";

function mountAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <UndoFeedback />
    </MemoryRouter>
  );
}

beforeEach(() => {
  showToast.mockClear();
  mockDoc = new Y.Doc();
  mockUndoManager = createUndoManager([
    mockDoc.getArray("stories"),
    mockDoc.getArray("objects"),
    mockDoc.getArray("glossary"),
    mockDoc.getArray("pages"),
  ]);
});

function addStory(id: string, title: string) {
  const stories = mockDoc.getArray<Y.Map<unknown>>("stories");
  const m = new Y.Map<unknown>();
  m.set("story_id", id);
  m.set("title", new Y.Text(title));
  mockDoc.transact(() => stories.push([m]));
  // Force the later field edit into its OWN undo step — otherwise the 500ms
  // captureTimeout groups the add + edit, and undo() would revert the whole
  // story (a structural delete) instead of just the field.
  mockUndoManager.stopCapturing();
  return m;
}

describe("UndoFeedback", () => {
  test("off-screen undo fires a toast with a Redo action", () => {
    const story = addStory("s1", "First");
    mountAt("/stories/other-story"); // viewing a different story

    mockDoc.transact(() => (story.get("title") as Y.Text).insert(5, "!"));
    mockUndoManager.undo();

    expect(showToast).toHaveBeenCalledTimes(1);
    const arg = showToast.mock.calls[0][0];
    expect(arg.message).toBe("undo_offscreen_undo:undo_label_stories:First");
    expect(arg.type).toBe("info");
    expect(arg.action.label).toBe("undo_action_redo");
  });

  test("on-screen undo fires no toast", () => {
    const story = addStory("s1", "First");
    mountAt("/stories/s1"); // viewing the same story

    mockDoc.transact(() => (story.get("title") as Y.Text).insert(5, "!"));
    mockUndoManager.undo();

    expect(showToast).not.toHaveBeenCalled();
  });

  test("redo of an off-screen change fires a toast with an Undo action", () => {
    const story = addStory("s1", "First");
    mountAt("/glossary"); // different section entirely

    mockDoc.transact(() => (story.get("title") as Y.Text).insert(5, "!"));
    mockUndoManager.undo();
    showToast.mockClear();
    mockUndoManager.redo();

    expect(showToast).toHaveBeenCalledTimes(1);
    const arg = showToast.mock.calls[0][0];
    expect(arg.message).toBe("undo_offscreen_redo:undo_label_stories:First!");
    expect(arg.action.label).toBe("undo_action_undo");
  });

  test("clicking the toast's reverse action does not fire another toast", () => {
    const story = addStory("s1", "First");
    mountAt("/stories/other-story");

    mockDoc.transact(() => (story.get("title") as Y.Text).insert(5, "!"));
    mockUndoManager.undo();

    const onClick = showToast.mock.calls[0][0].action.onClick as () => void;
    showToast.mockClear();
    onClick(); // programmatic redo from the toast action

    expect(showToast).not.toHaveBeenCalled();
  });

  test("a no-op toast reversal does not suppress the next genuine off-screen toast", () => {
    const story = addStory("s1", "First");
    mountAt("/stories/other-story");

    mockDoc.transact(() => (story.get("title") as Y.Text).insert(5, "!"));
    mockUndoManager.undo();

    const onClick = showToast.mock.calls[0][0].action.onClick as () => void;
    mockUndoManager.clear(); // empties both stacks → the reverse action will pop nothing
    onClick();

    // A genuine off-screen undo must still toast.
    showToast.mockClear();
    mockDoc.transact(() => (story.get("title") as Y.Text).insert(0, "X"));
    mockUndoManager.undo();
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

describe("useUndoControls — nothing-to-undo toast", () => {
  test("undo with an empty stack fires the info toast", () => {
    const { result } = renderHook(() => useUndoControls());
    act(() => result.current.undo());
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0].message).toBe("undo_nothing");
    expect(showToast.mock.calls[0][0].type).toBe("info");
  });

  test("undo that pops a real item fires no info toast", () => {
    const stories = mockDoc.getArray<Y.Map<unknown>>("stories");
    const m = new Y.Map<unknown>();
    m.set("story_id", "s1");
    m.set("title", new Y.Text("First"));
    mockDoc.transact(() => stories.push([m]));

    const { result } = renderHook(() => useUndoControls());
    act(() => result.current.undo());
    expect(showToast).not.toHaveBeenCalled();
  });

  test("repeated empty undos are deduped within the suppression window", () => {
    const { result } = renderHook(() => useUndoControls());
    act(() => {
      result.current.undo();
      result.current.undo();
    });
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test("undo while collaboration is not ready fires no toast", () => {
    mockUndoManager = null as unknown as Y.UndoManager;
    const { result } = renderHook(() => useUndoControls());
    act(() => result.current.undo());
    expect(showToast).not.toHaveBeenCalled();
  });
});
