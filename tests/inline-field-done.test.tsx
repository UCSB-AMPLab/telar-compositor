/**
 * @vitest-environment jsdom
 *
 * inline-field-done.test.tsx — InlineTextField and InlineTextArea take focus
 * with `autoFocus`, say when the author is done (blur, or Escape, which goes
 * no further so an enclosing panel stays open), and with `grow` size to their
 * text: the input's width to its characters, the textarea's height to what
 * its text needs, measured from `scrollHeight`, which jsdom leaves at 0 and
 * the cases set.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

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

import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fields = [
  { name: "InlineTextField", Field: InlineTextField },
  { name: "InlineTextArea", Field: InlineTextArea },
];

describe.each(fields)("$name", ({ Field }) => {
  it("takes focus with autoFocus", () => {
    render(<Field yText={null} initialValue="alpha" autoFocus />);
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("says it is done on blur", () => {
    const onDone = vi.fn();
    render(<Field yText={null} initialValue="alpha" onDone={onDone} />);
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onDone).toHaveBeenCalledWith("blur");
  });

  it("says it is done on Escape, and the key goes no further", () => {
    const onDone = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<Field yText={null} initialValue="alpha" onDone={onDone} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(onDone).toHaveBeenCalledWith("escape");
    expect(outer).not.toHaveBeenCalled();
  });

  it("leaves Escape alone without onDone", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<Field yText={null} initialValue="alpha" />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).toHaveBeenCalledTimes(1);
  });
});

describe("growing with the text", () => {
  it("sizes the input to its text, or its placeholder when empty", () => {
    const { rerender } = render(<InlineTextField yText={null} initialValue="" placeholder="Button label" grow />);
    const box = screen.getByRole("textbox") as HTMLInputElement;
    expect(box.size).toBe("Button label".length);
    fireEvent.change(box, { target: { value: "Open the map, please" } });
    expect(box.size).toBe("Open the map, please".length);
    rerender(<InlineTextField yText={null} initialValue="" />);
    expect((screen.getByRole("textbox") as HTMLInputElement).getAttribute("size")).toBeNull();
  });

  it("sets the textarea's height to what its text needs", () => {
    let needed = 48;
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => needed);
    render(<InlineTextArea yText={null} initialValue="one line" grow />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.style.height).toBe("48px");
    needed = 120;
    fireEvent.change(box, { target: { value: "one line\ntwo\nthree\nfour" } });
    expect(box.style.height).toBe("120px");
  });

  it("leaves the textarea's height alone without grow", () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    render(<InlineTextArea yText={null} initialValue="one line" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).style.height).toBe("");
  });
});
