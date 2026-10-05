/**
 * @vitest-environment jsdom
 *
 * focus-scope.test.tsx — a focus scope knows where focus is from the moment
 * it subscribes, not only from the focus events after it. React focuses an
 * `autoFocus` field during commit, before any effect runs, and a dialog open
 * from the start focuses inside itself before the scope listens; both must
 * count as focus arriving. So must a dialog opened later whose `autoFocus`
 * field takes focus before the dialog registers. A focused layer that is
 * removed takes focus with it without a focus event, and that counts as
 * leaving. Strict Mode's replay of the effects must neither repeat an
 * arrival nor report a departure.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { StrictMode, useRef, useState, type ReactNode } from "react";
import { render, cleanup, act, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, fallback?: string) => fallback ?? k }),
}));

import { FocusScopeContext, useFocusScope } from "~/components/ui/focus-scope";
import { Dialog } from "~/components/ui/Dialog";

afterEach(() => {
  cleanup();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function Scope({ onEnter, onLeave, children }: { onEnter: () => void; onLeave: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const scope = useFocusScope(root, { onEnter, onLeave });
  return (
    <FocusScopeContext.Provider value={scope}>
      <div ref={root}>{children}</div>
    </FocusScopeContext.Provider>
  );
}

function mount(children: ReactNode, strict = false) {
  const onEnter = vi.fn();
  const onLeave = vi.fn();
  const tree = (
    <div>
      <button type="button">outside</button>
      <Scope onEnter={onEnter} onLeave={onLeave}>
        {children}
      </Scope>
    </div>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { onEnter, onLeave };
}

describe.each([false, true])("a focus scope (Strict Mode: %s)", (strict) => {
  it("counts a field focused by autoFocus at mount as focus arriving", async () => {
    const { onEnter, onLeave } = mount(<input aria-label="field" autoFocus />, strict);
    expect(document.activeElement).toBe(screen.getByLabelText("field"));
    await settle();
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
    act(() => screen.getByText("outside").focus());
    await settle();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("counts focus in a dialog open from the start as focus arriving", async () => {
    const { onEnter, onLeave } = mount(
      <Dialog open onClose={() => {}}>
        <h2>Pick an image</h2>
        <input aria-label="address" />
      </Dialog>,
      strict,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("address"));
    await settle();
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
    act(() => screen.getByText("outside").focus());
    await settle();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("counts focus in a dialog opened later, with an autoFocus field, as focus arriving", async () => {
    function Later() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)}>
            <h2>Pick an image</h2>
            <input aria-label="address" autoFocus />
          </Dialog>
        </>
      );
    }
    const { onEnter, onLeave } = mount(<Later />, strict);
    act(() => screen.getByText("open").click());
    expect(document.activeElement).toBe(screen.getByLabelText("address"));
    await settle();
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("reports leaving when a focused layer is removed", async () => {
    function Removable() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onClose={() => setOpen(false)}>
          <h2>Pick an image</h2>
          <button type="button" onClick={() => setOpen(false)}>
            remove
          </button>
        </Dialog>
      );
    }
    const { onEnter, onLeave } = mount(<Removable />, strict);
    await settle();
    expect(onEnter).toHaveBeenCalledTimes(1);
    const remove = screen.getByText("remove");
    act(() => remove.focus());
    // The dialog gives focus back to its opener, the body; nothing in the scope holds it.
    act(() => remove.click());
    await settle();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when focus starts outside", async () => {
    const { onEnter, onLeave } = mount(<input aria-label="field" />, strict);
    await settle();
    expect(onEnter).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });
});
