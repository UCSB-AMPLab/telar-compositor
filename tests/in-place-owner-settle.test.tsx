// @vitest-environment jsdom
/**
 * An in-place field closed by its owner saves what the field shows:
 * a cancelled composition that left provisional text in the binding without a
 * change event is settled before the owner reads the draft, whether the owner
 * closes it itself (the alt-text chip) or unmounts it (a route change, where
 * the owner's cleanup runs before the field's).
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    lastEditorByField: new Map(),
  }),
}));

import { useInPlaceEditing } from "~/components/ui/in-place-editing";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { resetTargetSaves } from "~/components/ui/target-saves";

afterEach(() => {
  cleanup();
  resetTargetSaves();
});

function Owner({ onSave }: { onSave: (value: string) => Promise<unknown> }) {
  const editing = useInPlaceEditing({ target: "step:1/alt", yText: null, initialValue: "alpha", onSave });
  return (
    <div>
      <button type="button" data-testid="open" onClick={editing.open} />
      <button type="button" data-testid="chip" onClick={() => editing.done("blur")} />
      {editing.editing && (
        <InlineTextField initialValue="alpha" yText={null} binding={editing.binding} autoFocus onDone={editing.done} />
      )}
    </div>
  );
}

/** A composition cancelled: provisional text reached the binding, the browser put the field back, no change event. */
function cancelledComposition() {
  const box = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.compositionStart(box);
  fireEvent.input(box, { target: { value: "alpha 織" }, inputType: "insertCompositionText", isComposing: true });
  box.value = "alpha";
}

function openAndCancel(onSave: (value: string) => Promise<unknown>) {
  const view = render(<Owner onSave={onSave} />);
  fireEvent.click(screen.getByTestId("open"));
  cancelledComposition();
  return view;
}

describe("an in-place field closed by its owner after a cancelled composition", () => {
  it("saves the restored text when the owner finishes the field itself", async () => {
    const onSave = vi.fn(async () => undefined);
    openAndCancel(onSave);
    await act(async () => {
      fireEvent.click(screen.getByTestId("chip"));
    });
    expect(onSave).not.toHaveBeenCalledWith("alpha 織");
  });

  it("saves the restored text when the owner unmounts with the field open", async () => {
    const onSave = vi.fn(async () => undefined);
    const view = openAndCancel(onSave);
    await act(async () => {
      view.unmount();
    });
    expect(onSave).not.toHaveBeenCalledWith("alpha 織");
  });
});
