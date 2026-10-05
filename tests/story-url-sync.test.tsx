// @vitest-environment jsdom
/**
 * story-url-sync.test.tsx — in-editor navigation → URL.
 *
 * `activeStepIndex` and the open panels drive the editor; the URL mirrors
 * them with `setSearchParams(..., { replace: true })`, one write per action,
 * from the user-action handlers and never inside the one-shot deep-link read:
 *
 *   - select step N>0         → ?step=N, no ?layer (`selectStepIn`)
 *   - select the title card   → neither
 *   - open a layer of step N  → ?step=N and ?layer together (`useLayerPanels`)
 *   - close layer 2           → ?layer=1
 *   - close layer 1           → no ?layer
 *
 * The handlers are the real ones, `selectStepIn` and `useLayerPanels`,
 * mounted in a MemoryRouter; the URL is read live. Opening another step's
 * layer is one write: two writes from one render each read the URL as it
 * was, and the second put the old step back.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router";
import { selectStepIn } from "~/lib/step-selection";
import { useLayerPanels } from "~/hooks/use-layer-panels";

const ROUTE_SRC = readFileSync(join(process.cwd(), "app/routes/_app.stories.$storyId.tsx"), "utf8");

// A harness exposing the user actions as buttons and the current URL as
// text, driven through fireEvent.
function NavHarness() {
  const [searchParams, setSearchParams] = useSearchParams();
  const panels = useLayerPanels(setSearchParams);
  const select = (index: number) =>
    selectStepIn({ setActiveStepIndex: () => {}, closePanels: panels.closeAll, setSearchParams }, index);
  return (
    <div>
      <div data-testid="search">{searchParams.toString()}</div>
      <div data-testid="level">{panels.level}</div>
      <button onClick={() => select(0)}>title-card</button>
      <button onClick={() => select(3)}>select-step-3</button>
      <button onClick={() => panels.open(3, 1)}>open-3-l1</button>
      <button onClick={() => panels.open(3, 2)}>open-3-l2</button>
      <button onClick={() => panels.close(2)}>close-l2</button>
      <button onClick={() => panels.close(1)}>close-l1</button>
    </div>
  );
}

function renderHarness(initial = "/stories/abc") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <NavHarness />
    </MemoryRouter>,
  );
}

const search = () => screen.getByTestId("search").textContent;

describe("in-editor navigation mirrors to ?step/?layer", () => {
  it("selecting step 3 writes ?step=3", () => {
    renderHarness();
    fireEvent.click(screen.getByText("select-step-3"));
    expect(search()).toBe("step=3");
  });

  it("selecting the title card (index 0) drops ?step and ?layer, and closes the panels", () => {
    renderHarness("/stories/abc?step=3");
    fireEvent.click(screen.getByText("open-3-l2"));
    fireEvent.click(screen.getByText("title-card"));
    expect(search()).toBe("");
    expect(screen.getByTestId("level").textContent).toBe("0");
  });

  it("opening layer 1 writes ?layer=1 beside ?step", () => {
    renderHarness("/stories/abc?step=3");
    fireEvent.click(screen.getByText("open-3-l1"));
    expect(search()).toBe("step=3&layer=1");
  });

  it("opening layer 2 writes ?layer=2", () => {
    renderHarness("/stories/abc?step=3&layer=1");
    fireEvent.click(screen.getByText("open-3-l2"));
    expect(search()).toBe("step=3&layer=2");
  });

  it("opening another step's layer writes both params at once", () => {
    renderHarness("/stories/abc?step=1&layer=2");
    fireEvent.click(screen.getByText("open-3-l1"));
    expect(search()).toBe("step=3&layer=1");
  });

  it("closing layer 2 leaves ?layer=1; closing layer 1 drops ?layer but keeps ?step", () => {
    renderHarness("/stories/abc?step=3");
    fireEvent.click(screen.getByText("open-3-l2"));
    fireEvent.click(screen.getByText("close-l2"));
    expect(search()).toBe("step=3&layer=1");
    expect(screen.getByTestId("level").textContent).toBe("1");
    fireEvent.click(screen.getByText("close-l1"));
    expect(search()).toBe("step=3");
    expect(screen.getByTestId("level").textContent).toBe("0");
  });

  it("selecting another step drops a previously-open ?layer", () => {
    renderHarness("/stories/abc?step=1&layer=2");
    fireEvent.click(screen.getByText("select-step-3"));
    expect(search()).toBe("step=3");
  });
});

// ---------------------------------------------------------------------------
// The one-shot deep-link read must NOT be re-triggered by mirror writes.
// ---------------------------------------------------------------------------

/**
 * The route's guarded deep-link read, as a ref-guarded read that consumes
 * ?step once and sets the ref BEFORE reading, so later searchParams changes
 * (the handlers' writes) never re-run the read body.
 */
function DeepLinkHarness({ onConsume }: { onConsume: () => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const panels = useLayerPanels(setSearchParams);
  const consumedRef = useRef(false);

  if (!consumedRef.current && searchParams.get("step") !== null) {
    consumedRef.current = true;
    onConsume();
  }

  return (
    <div>
      <button onClick={() => panels.open(5, 1)}>open-5-l1</button>
      <button onClick={() => panels.close(1)}>close-l1</button>
    </div>
  );
}

describe("mirror writes do not re-trigger the deep-link read", () => {
  it("the guarded deep-link read consumes ?step exactly once across multiple writes", () => {
    const onConsume = vi.fn();
    render(
      <MemoryRouter initialEntries={["/stories/abc?step=2"]}>
        <DeepLinkHarness onConsume={onConsume} />
      </MemoryRouter>,
    );
    expect(onConsume).toHaveBeenCalledTimes(1);
    act(() => {
      fireEvent.click(screen.getByText("open-5-l1"));
    });
    act(() => {
      fireEvent.click(screen.getByText("close-l1"));
    });
    expect(onConsume).toHaveBeenCalledTimes(1);
  });

  it("the route writes the URL through selectStepIn and useLayerPanels, and never inside the guarded deep-link read (source pin)", () => {
    // 1. The panels' state and their URL writes are the hook's.
    expect(ROUTE_SRC).toContain("const panelState = useLayerPanels(setSearchParams);");
    // 2. A step selection is the one sequence, and a layer opens through the hook.
    expect(ROUTE_SRC).toMatch(/onStepSelect=\{[^}]*selectStep\(idx\)/);
    expect(ROUTE_SRC).toMatch(/function selectStep\(index: number\) \{\s*selectStepIn\(/);
    expect(ROUTE_SRC).toContain("panelState.open(stepIndex, layerNumber, opener);");
    // No other writer of ?layer is left in the route.
    expect(ROUTE_SRC).not.toMatch(/\.set\("layer"/);
    // 3. The deep-link read consumes-then-guards and writes nothing.
    const readEffect = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("const deepLinkConsumedRef"),
      ROUTE_SRC.indexOf("// Section-card count drives"),
    );
    expect(readEffect).toContain("if (deepLinkConsumedRef.current) return;");
    expect(readEffect).toContain("deepLinkConsumedRef.current = true;");
    expect(readEffect).toContain("panelState.openFromLink(validLayer)");
    expect(readEffect).not.toContain("setSearchParams");
    expect(readEffect).not.toContain("panelState.open(");
  });
});
