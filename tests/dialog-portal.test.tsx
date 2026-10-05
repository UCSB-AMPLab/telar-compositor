/**
 * @vitest-environment jsdom
 *
 * dialog-portal.test.tsx — the shared Dialog renders in `document.body`, not
 * inside the component that opens it, so a CSS-transformed ancestor can
 * neither scale nor clip it; and it registers as a layer of the focus scope
 * it was opened from. Its semantics and focus handling are pinned in
 * dialog-semantics.test.tsx.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef } from "react";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, fallback?: string) => fallback ?? k }),
}));

import { Dialog } from "~/components/ui/Dialog";
import { FocusScopeContext, useFocusScope, type FocusScope } from "~/components/ui/focus-scope";

afterEach(() => {
  cleanup();
});

describe("Dialog portal", () => {
  it("renders in the body, outside a transformed ancestor", () => {
    render(
      <div data-testid="stage" style={{ transform: "scale(0.5)" }}>
        <Dialog open onClose={() => {}}>
          <h2>Delete this step?</h2>
        </Dialog>
      </div>,
    );
    const dialog = screen.getByRole("dialog");
    expect(screen.getByTestId("stage").contains(dialog)).toBe(false);
    expect(dialog.closest(".fixed")?.parentElement).toBe(document.body);
  });

  it("counts as inside the focus scope it was opened from", () => {
    let scope: FocusScope | null = null;
    function Scoped() {
      const root = useRef<HTMLDivElement>(null);
      scope = useFocusScope(root, {});
      return (
        <FocusScopeContext.Provider value={scope}>
          <div ref={root}>
            <Dialog open onClose={() => {}}>
              <h2>Pick an image</h2>
              <button type="button">inside</button>
            </Dialog>
          </div>
        </FocusScopeContext.Provider>
      );
    }
    render(<Scoped />);
    expect(scope!.contains(screen.getByText("inside"))).toBe(true);
    expect(scope!.contains(document.body)).toBe(false);
  });
});
