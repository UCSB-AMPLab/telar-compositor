/**
 * @vitest-environment jsdom
 *
 * inline-html-undo.test.tsx — wiring assertion for C2 (field-scoped undo).
 *
 * APPROACH: wiring assertion (not real Ctrl+Z through jsdom/CodeMirror).
 *
 * Driving a real keyboard shortcut through jsdom + CodeMirror is unreliable:
 * CodeMirror's Mod-z handler depends on a focused, live DOM environment that
 * jsdom cannot fully replicate. Instead we assert the structural invariant
 * directly: the UndoManager that yCollab receives for the description Y.Text
 * must NOT be the shared document-level manager (which is scoped to the
 * stories/objects/glossary/pages arrays), because calling undo() on the shared
 * manager would revert the most recent edit on those arrays regardless of which
 * field the user was editing.
 *
 * The test captures the UndoManager instance handed to yCollab by intercepting
 * the yCollab call, then asserts:
 *   1. A manager IS wired (not false/null — the editor has undo support).
 *   2. The wired manager is NOT the shared document-level manager.
 *   3. Calling undo() on the wired manager does NOT revert an edit made to the
 *      stories array (i.e. the shared stack is not touched).
 *
 * Pre-fix (shared manager used): assertion 2 fails — the captured manager IS
 * the shared one.
 * Post-fix (local manager scoped to description Y.Text): all three pass.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import * as Y from "yjs";

// ── Yjs fixture ──────────────────────────────────────────────────────────────
// Build a Y.Doc that mirrors the collaboration context layout:
//   - doc.getArray("stories") holds one story Y.Map with a "title" field
//   - config.description holds the description Y.Text
const doc = new Y.Doc();
const storiesArray = doc.getArray<Y.Map<unknown>>("stories");
const storyMap = new Y.Map<unknown>();

// Build the shared UndoManager exactly as use-collaboration.tsx does
// (scoped to the four root arrays).
const sharedUndoManager = new Y.UndoManager(
  [
    doc.getArray("stories"),
    doc.getArray("objects"),
    doc.getArray("glossary"),
    doc.getArray("pages"),
  ],
  { captureTimeout: 500 }
);

// Seed the stories array (this write happens BEFORE any test, so it is
// below the captureTimeout horizon and the shared stack starts empty).
doc.transact(() => {
  storyMap.set("title", "Original title");
  storiesArray.push([storyMap]);
});

// Wait for captureTimeout to expire so the seed write is not on the stack.
// (In practice, captureTimeout groups writes within 500ms. Since the seed
// runs during module init and tests run later, the stack will be empty when
// each test starts.)

const configMap = doc.getMap<unknown>("config");
const descriptionYText = new Y.Text("");
configMap.set("description", descriptionYText);

// ── Intercept yCollab to capture the UndoManager it receives ─────────────────
let capturedUndoManager: unknown = undefined;

vi.mock("y-codemirror.next", async (importOriginal) => {
  const real = await importOriginal<typeof import("y-codemirror.next")>();
  return {
    ...real,
    yCollab: (
      text: unknown,
      awareness: unknown,
      opts: { undoManager?: unknown } = {}
    ) => {
      capturedUndoManager = opts.undoManager;
      return real.yCollab(text as Y.Text, awareness as never, opts as never);
    },
  };
});

// ── Mocks required by InlineHtmlEditor ───────────────────────────────────────
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
}));

// Provide the shared undoManager via the collaboration context (simulating
// the OLD wiring so the pre-fix test can detect the wrong manager).
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: doc,
    provider: null,
    isPublishing: false,
    undoManager: sharedUndoManager,
  }),
}));

import { InlineHtmlEditor } from "~/components/ui/InlineHtmlEditor";

// ── Helpers ───────────────────────────────────────────────────────────────────
function currentStoryTitle(): string {
  return storyMap.get("title") as string;
}

function makeTrackedStoryEdit(): void {
  // Make a write that lands on the shared undo stack.
  // captureTimeout is 500ms; we use a fresh transaction so it registers
  // as a discrete stack item.
  doc.transact(() => {
    storyMap.set("title", "Edited title");
  });
}

beforeEach(() => {
  capturedUndoManager = undefined;
  // Reset the story title back to its original value before each test.
  doc.transact(() => {
    storyMap.set("title", "Original title");
  });
  // Clear the shared undo stack so each test starts clean.
  sharedUndoManager.clear();
});

afterEach(() => {
  cleanup();
});

describe("InlineHtmlEditor — field-scoped undo (C2)", () => {
  it("wires a UndoManager to yCollab (undo is supported in the editor)", async () => {
    const { container } = render(
      <InlineHtmlEditor
        initialValue=""
        yText={descriptionYText}
        placeholder="Describe your site"
      />
    );
    // Click to enter edit mode so the EditorView (and its yCollab extension) mounts.
    const preview = container.querySelector("[data-description-preview]")!;
    fireEvent.click(preview);

    // The editor must have wired SOME manager (not false/null).
    expect(capturedUndoManager).toBeTruthy();
    expect(capturedUndoManager).toBeInstanceOf(Y.UndoManager);
  });

  it("the wired UndoManager is NOT the shared document-level manager", async () => {
    const { container } = render(
      <InlineHtmlEditor
        initialValue=""
        yText={descriptionYText}
        placeholder="Describe your site"
      />
    );
    const preview = container.querySelector("[data-description-preview]")!;
    fireEvent.click(preview);

    // The local manager must be a distinct instance from the shared one.
    expect(capturedUndoManager).not.toBe(sharedUndoManager);
  });

  it("calling undo() on the wired manager does NOT revert a stories-array edit", async () => {
    const { container } = render(
      <InlineHtmlEditor
        initialValue=""
        yText={descriptionYText}
        placeholder="Describe your site"
      />
    );
    const preview = container.querySelector("[data-description-preview]")!;
    fireEvent.click(preview);

    // Make a tracked write to the stories array AFTER the editor mounts.
    makeTrackedStoryEdit();
    expect(currentStoryTitle()).toBe("Edited title");

    // The shared manager should now have the story edit on its stack.
    expect(sharedUndoManager.undoStack.length).toBeGreaterThan(0);

    // Calling undo() on the field-scoped manager must NOT revert the story edit.
    const localManager = capturedUndoManager as Y.UndoManager;
    localManager.undo();

    // Story title is unchanged — the local manager has no jurisdiction over
    // the stories array.
    expect(currentStoryTitle()).toBe("Edited title");
  });
});
