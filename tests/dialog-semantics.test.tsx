/**
 * @vitest-environment jsdom
 *
 * dialog-semantics.test.tsx — the shared Dialog is announced as a modal dialog
 * named by its heading, takes focus when it opens, keeps Tab inside itself,
 * and gives focus back to its opener when it closes.
 *
 * The oracle is the DOM a screen reader and the keyboard read: roles, the
 * accessible-name reference, `document.activeElement`. jsdom does not move
 * focus on Tab by itself, so the Tab cases put focus on the edge element,
 * fire the keydown, and read where the dialog sent it.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { StrictMode, useState } from "react";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, fallback?: string) => fallback ?? k }),
}));

import { Dialog } from "~/components/ui/Dialog";

afterEach(() => {
  cleanup();
});

function Harness({
  autoFocusField = false,
  dismissConfirm,
  heading = true,
}: {
  autoFocusField?: boolean;
  dismissConfirm?: string;
  heading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open it
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} dismissConfirm={dismissConfirm}>
        {heading && <h2>Delete this step?</h2>}
        <input aria-label="note" />
        <input aria-label="detail" autoFocus={autoFocusField} />
        <button type="button">first action</button>
        <button type="button" onClick={() => setOpen(false)}>
          last action
        </button>
      </Dialog>
    </div>
  );
}

function openFrom(opener: HTMLElement): void {
  opener.focus();
  fireEvent.click(opener);
}

describe("Dialog semantics and focus", () => {
  it("is a modal dialog named by its first heading", () => {
    render(<Harness />);
    openFrom(screen.getByText("open it"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)!.textContent).toBe("Delete this step?");
    expect(screen.getByRole("dialog", { name: "Delete this step?" })).toBe(dialog);
  });

  it("carries no name reference when it has no heading", () => {
    render(<Harness heading={false} />);
    openFrom(screen.getByText("open it"));
    expect(screen.getByRole("dialog").hasAttribute("aria-labelledby")).toBe(false);
  });

  it("moves focus to its first control when it opens", () => {
    render(<Harness />);
    const opener = screen.getByText("open it");
    openFrom(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("note"));
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("leaves focus where an autoFocus field put it", () => {
    render(<Harness autoFocusField />);
    openFrom(screen.getByText("open it"));
    // Not the first control, so this tells "left alone" from "moved to the first".
    expect(document.activeElement).toBe(screen.getByLabelText("detail"));
  });

  it("gives focus back to the opener when it closes", () => {
    render(<Harness />);
    const opener = screen.getByText("open it");
    openFrom(opener);
    fireEvent.click(screen.getByText("last action"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("gives focus back after Escape as well", () => {
    render(<Harness />);
    const opener = screen.getByText("open it");
    openFrom(opener);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("wraps Tab from the last control to the first, and Shift-Tab back", () => {
    render(<Harness />);
    openFrom(screen.getByText("open it"));
    const first = screen.getByLabelText("note");
    const last = screen.getByText("last action");
    act(() => last.focus());
    // Prevented, or the browser would move focus on again from where the dialog put it.
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("leaves Tab alone between controls in the middle", () => {
    render(<Harness />);
    openFrom(screen.getByText("open it"));
    const middle = screen.getByText("first action");
    act(() => middle.focus());
    const event = fireEvent.keyDown(middle, { key: "Tab" });
    // Not prevented: the browser moves focus itself.
    expect(event).toBe(true);
    expect(document.activeElement).toBe(middle);
  });

  it("announces the dismiss confirmation and keeps Tab inside it", () => {
    render(<Harness dismissConfirm="Discard what you typed?" />);
    openFrom(screen.getByText("open it"));
    fireEvent.keyDown(document, { key: "Escape" });
    const prompt = screen.getByRole("alertdialog");
    expect(prompt.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("alertdialog", { name: "Discard what you typed?" })).toBe(prompt);
    const buttons = Array.from(prompt.querySelectorAll("button"));
    expect(document.activeElement).toBe(buttons[0]);
    act(() => buttons[buttons.length - 1].focus());
    expect(fireEvent.keyDown(buttons[buttons.length - 1], { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("does not fail when its opener has left the page", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { rerender } = render(
      <Dialog open onClose={() => {}}>
        <button type="button">inside</button>
      </Dialog>
    );
    expect(document.activeElement).toBe(screen.getByText("inside"));
    outside.remove();
    expect(() =>
      rerender(
        <Dialog open={false} onClose={() => {}}>
          <button type="button">inside</button>
        </Dialog>
      )
    ).not.toThrow();
    expect(document.activeElement).not.toBe(outside);
  });

  it("gives focus back to the panel field when the author goes back from the prompt", () => {
    render(<Harness dismissConfirm="Discard what you typed?" />);
    openFrom(screen.getByText("open it"));
    const field = screen.getByLabelText("note");
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(document, { key: "Escape" });
    const back = screen.getByRole("alertdialog").querySelector("button")!;
    fireEvent.click(back);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });

  it("leaves Tab inside a dialog nested in it to that dialog", () => {
    function Nested() {
      const [inner, setInner] = useState(false);
      return (
        <Dialog open onClose={() => {}}>
          <h2>Outer</h2>
          <button type="button" onClick={() => setInner(true)}>
            open inner
          </button>
          <Dialog open={inner} onClose={() => setInner(false)}>
            <h2>Inner</h2>
            <button type="button">inner first</button>
            <button type="button">inner last</button>
          </Dialog>
        </Dialog>
      );
    }
    render(<Nested />);
    fireEvent.click(screen.getByText("open inner"));
    const innerFirst = screen.getByText("inner first");
    const innerLast = screen.getByText("inner last");
    act(() => innerLast.focus());
    fireEvent.keyDown(innerLast, { key: "Tab" });
    expect(document.activeElement).toBe(innerFirst);
    fireEvent.keyDown(innerFirst, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(innerLast);
  });

  it("takes its name from the heading a later stage shows", () => {
    function Staged() {
      const [stage, setStage] = useState(1);
      return (
        <Dialog open onClose={() => {}}>
          {stage === 1 ? <h2 key="a">Review changes</h2> : <h3 key="b">Changes applied</h3>}
          <button type="button" onClick={() => setStage(2)}>
            next
          </button>
        </Dialog>
      );
    }
    render(<Staged />);
    expect(screen.getByRole("dialog", { name: "Review changes" })).toBeTruthy();
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByRole("dialog", { name: "Changes applied" })).toBeTruthy();
  });

  it("leaves role, name, focus and Tab to a caller that manages its own", () => {
    function Own() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            open own
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} managesOwnFocus>
            <div role="dialog" aria-label="Choose a page">
              <h2>Choose a page</h2>
              <button type="button">only</button>
              <button type="button" onClick={() => setOpen(false)}>
                done
              </button>
            </div>
          </Dialog>
        </div>
      );
    }
    render(<Own />);
    const opener = screen.getByText("open own");
    openFrom(opener);
    // One dialog: the caller's.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Choose a page" })).toBeTruthy();
    // Focus stays where the caller left it.
    expect(document.activeElement).toBe(opener);
    const done = screen.getByText("done");
    act(() => done.focus());
    expect(fireEvent.keyDown(done, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(done);
    fireEvent.click(done);
    // No focus handed back: the caller's chain decides where it goes.
    expect(document.activeElement).not.toBe(opener);
  });

  it("gives focus back after a close under Strict Mode's effect replay", () => {
    function Mounted() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            open strict
          </button>
          {open && (
            <Dialog open onClose={() => setOpen(false)}>
              <h2>Strict</h2>
              <button type="button" onClick={() => setOpen(false)}>
                close strict
              </button>
            </Dialog>
          )}
        </div>
      );
    }
    render(
      <StrictMode>
        <Mounted />
      </StrictMode>
    );
    const opener = screen.getByText("open strict");
    openFrom(opener);
    // The replayed cleanup did not pull focus out of the open dialog.
    expect(document.activeElement).toBe(screen.getByText("close strict"));
    fireEvent.click(screen.getByText("close strict"));
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus on a dialog that replaced it", () => {
    function Chain() {
      const [which, setWhich] = useState<"none" | "a" | "b">("none");
      return (
        <div>
          <button type="button" onClick={() => setWhich("a")}>
            start chain
          </button>
          <Dialog open={which === "a"} onClose={() => setWhich("none")}>
            <h2>First</h2>
            <button type="button" onClick={() => setWhich("b")}>
              go on
            </button>
          </Dialog>
          <Dialog open={which === "b"} onClose={() => setWhich("none")}>
            <h2>Second</h2>
            <input aria-label="search" />
          </Dialog>
        </div>
      );
    }
    render(<Chain />);
    openFrom(screen.getByText("start chain"));
    fireEvent.click(screen.getByText("go on"));
    expect(document.activeElement).toBe(screen.getByLabelText("search"));
  });

  it("skips a control the page does not render when it moves focus in and wraps Tab", () => {
    // jsdom lays nothing out; stand in for display:none on the mobile-only select.
    const proto = HTMLElement.prototype as HTMLElement & { checkVisibility?: () => boolean };
    const had = "checkVisibility" in proto;
    const original = proto.checkVisibility;
    proto.checkVisibility = function (this: HTMLElement, options?: { visibilityProperty?: boolean }) {
      if (this.getAttribute("aria-label") === "mobile only") return false;
      // visibility:hidden counts only when asked for; the dialog must ask.
      return !(options?.visibilityProperty && this.hasAttribute("data-invisible"));
    };
    try {
      render(
        <Dialog open onClose={() => {}}>
          <h2>Add object</h2>
          <select aria-label="mobile only" />
          <button type="button">upload</button>
          <button type="button">cancel</button>
          <button type="button" data-invisible>
            invisible
          </button>
        </Dialog>
      );
      const upload = screen.getByText("upload");
      const cancel = screen.getByText("cancel");
      expect(document.activeElement).toBe(upload);
      act(() => cancel.focus());
      expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(upload);
      expect(fireEvent.keyDown(upload, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(cancel);
    } finally {
      if (had) proto.checkVisibility = original;
      else Reflect.deleteProperty(proto, "checkVisibility");
    }
  });

  it("forgets an earlier opener when it is reopened by a caller that manages its own focus", () => {
    function Switch() {
      const [open, setOpen] = useState(false);
      const [own, setOwn] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            first opener
          </button>
          <button
            type="button"
            onClick={() => {
              setOwn(true);
              setOpen(true);
            }}
          >
            second opener
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} managesOwnFocus={own}>
            <h2>Switch</h2>
            <button type="button" onClick={() => setOpen(false)}>
              shut
            </button>
          </Dialog>
        </div>
      );
    }
    render(<Switch />);
    const first = screen.getByText("first opener");
    openFrom(first);
    fireEvent.click(screen.getByText("shut"));
    expect(document.activeElement).toBe(first);
    openFrom(screen.getByText("second opener"));
    const shut = screen.getByText("shut");
    act(() => shut.focus());
    fireEvent.click(shut);
    expect(document.activeElement).not.toBe(first);
  });
});
