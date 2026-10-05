// @vitest-environment jsdom
/**
 * This file pins what an inline field does with the shared text when an input
 * method's composition ends.
 *
 * Every provisional state of a composition reaches the field as a change and
 * is written into the shared Y.Text. When the author cancels, the browser puts
 * the field back as it was before the composition, and on some methods sends
 * no change event for it — so the shared text still holds the provisional
 * characters, every collaborator has them, and the controlled field draws them
 * back on its next render. At the end of a composition the field writes what
 * it shows, but only over its own last write: a collaborator's edit made
 * meanwhile is never replaced.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    lastEditorByField: new Map(),
  }),
}));

import { InlineTextArea } from "~/components/ui/InlineTextArea";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InPlaceText } from "~/components/ui/InPlaceText";

const FIELDS = [
  ["InlineTextArea", InlineTextArea],
  ["InlineTextField", InlineTextField],
] as const;

type Field = (typeof FIELDS)[number][1];

type Extra = { textOnly?: boolean; onDone?: (reason: string) => void };

function renderOn(Field: Field, initialValue: string, extra: Extra = {}) {
  const doc = new Y.Doc();
  const yText = doc.getText("field");
  yText.insert(0, initialValue);
  const element = () => <Field initialValue={initialValue} yText={yText} {...extra} />;
  const rendered = render(element());
  const writes = { count: 0 };
  doc.on("afterTransaction", () => {
    writes.count += 1;
  });
  return { yText, writes, redraw: () => rendered.rerender(element()), unmount: rendered.unmount };
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement | HTMLInputElement;

/** One provisional state of a composition, as the browser reports it. */
const provisional = (value: string) =>
  fireEvent.input(box(), { target: { value }, inputType: "insertCompositionText", isComposing: true });

/**
 * The browser putting the field back without a change event, as a cancelled
 * composition does on some methods. Assigning the element's value is what the
 * browser does; React is not told, which is the point.
 */
const restoredWithoutChange = (value: string) => {
  box().value = value;
};

beforeEach(() => {
  cleanup();
});

describe.each(FIELDS)("%s when a composition is cancelled", (_name, Field) => {
  it("takes the provisional text back out of the shared text", () => {
    const { yText, redraw } = renderOn(Field, "alpha omega");
    fireEvent.compositionStart(box());
    provisional("alpha omega 織");
    expect(yText.toString()).toBe("alpha omega 織");

    restoredWithoutChange("alpha omega");
    fireEvent.compositionEnd(box(), { data: "" });
    redraw();

    expect(yText.toString()).toBe("alpha omega");
    expect(box().value).toBe("alpha omega");
  });

  it("leaves a collaborator's edit made during the composition in place", () => {
    const { yText } = renderOn(Field, "alpha omega");
    fireEvent.compositionStart(box());
    provisional("alpha omega 織");
    // Another editor, writing into the same Y.Text from their own session.
    act(() => {
      yText.insert(0, "REMOTE ");
    });

    restoredWithoutChange("alpha omega");
    fireEvent.compositionEnd(box(), { data: "" });

    expect(yText.toString()).toBe("REMOTE alpha omega 織");
  });

  // An owner can close an in-place field without a blur, as the alt-text chip
  // does on its own click, so the field settles as it goes.
  it("settles when it unmounts", () => {
    const { yText, unmount } = renderOn(Field, "alpha omega");
    fireEvent.compositionStart(box());
    provisional("alpha omega 織");
    restoredWithoutChange("alpha omega");

    unmount();

    expect(yText.toString()).toBe("alpha omega");
  });

  // Equal text is not the same authorship: the collaborator's characters are
  // new ones, and replacing the whole value would delete them.
  it("leaves a collaborator's edit that restored the same text in place", () => {
    const { yText } = renderOn(Field, "alpha omega");
    fireEvent.compositionStart(box());
    provisional("alpha omega X");
    act(() => {
      yText.doc!.transact(() => {
        yText.delete(yText.length - 1, 1);
        yText.insert(yText.length, "X");
      }, "remote");
    });
    const theirs = yText.toString();

    restoredWithoutChange("alpha omega");
    fireEvent.compositionEnd(box(), { data: "" });

    expect(yText.toString()).toBe(theirs);
  });

  // Escape is how an author cancels a composition. Taken as leaving the field,
  // it closed an in-place field before the composition's end could settle it.
  it("does not finish the field on an Escape that belongs to a composition", () => {
    const onDone = vi.fn();
    renderOn(Field, "alpha", { onDone });
    fireEvent.compositionStart(box());
    provisional("alpha 織");

    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    fireEvent.keyDown(box(), { key: "Escape", keyCode: 229 });

    expect(onDone).not.toHaveBeenCalled();
  });

  it("settles before the field is left, whether by Escape or by blur", () => {
    const seen: string[] = [];
    const { yText } = renderOn(Field, "alpha", { onDone: () => seen.push(yText.toString()) });
    fireEvent.compositionStart(box());
    provisional("alpha 織");
    restoredWithoutChange("alpha");
    fireEvent.keyDown(box(), { key: "Escape" });

    provisional("alpha 織");
    restoredWithoutChange("alpha");
    fireEvent.blur(box());

    expect(seen).toEqual(["alpha", "alpha"]);
  });

  it("writes nothing more when a composition commits normally", () => {
    const { yText, writes } = renderOn(Field, "alpha");
    fireEvent.compositionStart(box());
    provisional("alpha 織");
    provisional("alpha 織り");
    const before = writes.count;

    fireEvent.compositionEnd(box(), { data: "織り" });

    expect(writes.count).toBe(before);
    expect(yText.toString()).toBe("alpha 織り");
  });

  // Firefox and Safari can update the field before the end and send the final
  // input after it. The settle then writes the same text the input brings.
  it("ends on the committed text when the final input follows the end", () => {
    const { yText } = renderOn(Field, "alpha");
    fireEvent.compositionStart(box());
    provisional("alpha 織");

    restoredWithoutChange("alpha 織り");
    fireEvent.compositionEnd(box(), { data: "織り" });
    fireEvent.input(box(), {
      target: { value: "alpha 織り" },
      inputType: "insertFromComposition",
      isComposing: false,
    });

    expect(yText.toString()).toBe("alpha 織り");
    expect(box().value).toBe("alpha 織り");
  });
});

describe.each([
  ["single-line", false],
  ["multi-line", true],
] as const)("an in-place %s field closed while a composition was cancelled", (_name, multiline) => {
  it("leaves the shared text as it was before the composition", () => {
    const doc = new Y.Doc();
    const yText = doc.getText("field");
    yText.insert(0, "alpha omega");
    render(<InPlaceText yText={yText} initialValue="alpha omega" multiline={multiline} />);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    fireEvent.compositionStart(box());
    provisional("alpha omega 織");

    restoredWithoutChange("alpha omega");
    fireEvent.keyDown(box(), { key: "Escape" });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(yText.toString()).toBe("alpha omega");
  });
});

describe("the answer field settling a composition", () => {
  // Safari can end a composition before the input that commits it. When the
  // field already shows the committed text, the settle writes it, and it is
  // judged as a composition is: kept, with the notice.
  it("notices a committed image the settle writes", () => {
    const { yText } = renderOn(InlineTextArea, "alpha", { textOnly: true });
    fireEvent.compositionStart(box());
    provisional("alpha ![x](y");

    restoredWithoutChange("alpha ![x](y)");
    fireEvent.compositionEnd(box(), { data: "![x](y)" });

    expect(yText.toString()).toBe("alpha ![x](y)");
    expect(screen.queryByTestId("answer-text-only")?.textContent).toBe("answer_text_only");
  });

  it("clears the notice when the cancelled composition had added the image", () => {
    const { yText } = renderOn(InlineTextArea, "alpha", { textOnly: true });
    fireEvent.compositionStart(box());
    provisional("alpha ![x](y)");
    expect(screen.queryByTestId("answer-text-only")).not.toBeNull();

    restoredWithoutChange("alpha");
    fireEvent.compositionEnd(box(), { data: "" });

    expect(yText.toString()).toBe("alpha");
    expect(screen.queryByTestId("answer-text-only")).toBeNull();
  });
});
