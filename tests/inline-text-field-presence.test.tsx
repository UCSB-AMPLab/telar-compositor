// @vitest-environment jsdom
/**
 * An inline field's presence (its awareness key) against a stateful
 * awareness stub, across the ways a field can go while it holds focus: a
 * field of the same key replacing it in one commit, and Strict Mode's second
 * run of its effects on mount. Blur and a lone unmount are in
 * layer-panel.test.tsx.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StrictMode } from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

/** An awareness that holds this client's local state, as y-protocols' does. */
function awarenessStub() {
  let state: Record<string, unknown> = { location: { route: "/stories/s", storyId: "s", fieldKey: null } };
  return {
    getLocalState: () => state,
    setLocalStateField: (field: string, value: unknown) => {
      state = { ...state, [field]: value };
    },
  };
}
const collab: { provider: { awareness: ReturnType<typeof awarenessStub> } | null } = { provider: null };

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: collab.provider,
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
}));

import { InlineTextField } from "~/components/ui/InlineTextField";

const fieldKeyNow = () => (collab.provider!.awareness.getLocalState().location as { fieldKey: string | null }).fieldKey;

beforeEach(() => {
  collab.provider = { awareness: awarenessStub() };
});
afterEach(() => cleanup());

describe("an inline field's presence", () => {
  it("survives a field of the same key replacing it in one commit", () => {
    const field = (generation: number) => (
      <InlineTextField key={generation} initialValue="Title" yText={null} fieldKey="layer-L1-title" autoFocus onDone={() => {}} />
    );
    const { rerender } = render(field(1));
    expect(fieldKeyNow()).toBe("layer-L1-title");
    rerender(field(2));
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(fieldKeyNow()).toBe("layer-L1-title");
  });

  it("survives Strict Mode's second run of its effects on mount", () => {
    render(
      <StrictMode>
        <InlineTextField initialValue="Title" yText={null} fieldKey="layer-L1-title" autoFocus onDone={() => {}} />
      </StrictMode>,
    );
    expect(fieldKeyNow()).toBe("layer-L1-title");
  });

  it("survives another field of its key going while this one holds focus", () => {
    const fields = (both: boolean) => (
      <>
        {both && <InlineTextField initialValue="Title" yText={null} fieldKey="layer-L1-title" onDone={() => {}} />}
        <InlineTextField initialValue="Title" yText={null} fieldKey="layer-L1-title" autoFocus onDone={() => {}} />
      </>
    );
    const { rerender } = render(fields(true));
    expect(fieldKeyNow()).toBe("layer-L1-title");
    rerender(fields(false));
    expect(fieldKeyNow()).toBe("layer-L1-title");
  });

  it("is cleared when the last field of its key goes while focused", () => {
    const { unmount } = render(
      <StrictMode>
        <InlineTextField initialValue="Title" yText={null} fieldKey="layer-L1-title" autoFocus onDone={() => {}} />
      </StrictMode>,
    );
    unmount();
    expect(fieldKeyNow()).toBeNull();
  });

  it("is cleared when the focused field goes and another of its key stays unfocused", () => {
    const fields = (both: boolean) => (
      <>
        {both && <InlineTextField initialValue="Title" yText={null} fieldKey="layer-L1-title" autoFocus onDone={() => {}} />}
        <InlineTextField initialValue="Title" yText={null} fieldKey="layer-L1-title" onDone={() => {}} />
      </>
    );
    const { rerender } = render(fields(true));
    expect(fieldKeyNow()).toBe("layer-L1-title");
    rerender(fields(false));
    expect(document.activeElement?.tagName).not.toBe("INPUT");
    expect(fieldKeyNow()).toBeNull();
  });
});
