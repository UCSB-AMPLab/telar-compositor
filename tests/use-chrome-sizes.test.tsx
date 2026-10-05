// @vitest-environment jsdom
/**
 * useChromeSizes follows a wrapper's child: when a step's object changes kind
 * and its bottom bar is replaced inside the same wrapper, the new bar is the
 * one measured, and it is measured again when it changes size.
 *
 * jsdom lays nothing out, so each element's size is read from its `data-w`
 * and `data-h`, and ResizeObserver is a fake that is fired by hand.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useChromeSizes } from "~/hooks/use-chrome-sizes";

const observed = new Set<Element>();
const fakes = new Set<{ fire: () => void; targets: Set<Element> }>();

class FakeResizeObserver {
  targets = new Set<Element>();
  constructor(private readonly callback: () => void) {
    fakes.add(this);
  }
  fire() {
    if (this.targets.size) this.callback();
  }
  observe(el: Element) {
    this.targets.add(el);
    observed.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
}

const saved: Record<string, PropertyDescriptor | undefined> = {};

beforeEach(() => {
  saved.ro = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  saved.w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  saved.h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(globalThis, "ResizeObserver", { value: FakeResizeObserver, configurable: true, writable: true });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.w ?? 0);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.h ?? 0);
    },
  });
});

afterEach(() => {
  cleanup();
  observed.clear();
  fakes.clear();
  for (const [key, target] of [["ro", globalThis], ["w", HTMLElement.prototype], ["h", HTMLElement.prototype]] as const) {
    const name = key === "ro" ? "ResizeObserver" : key === "w" ? "offsetWidth" : "offsetHeight";
    const d = saved[key];
    if (d) Object.defineProperty(target, name, d);
    else delete (target as Record<string, unknown>)[name];
  }
});

function Probe({ kind }: { kind: "media" | "iiif" }) {
  const { sizes, measure } = useChromeSizes();
  return (
    <>
      <div ref={measure("bar", true)} data-w="500" data-h="999">
        {kind === "media" ? <div key="media" data-testid="media-bar" data-w="480" data-h="40" /> : <div key="iiif" data-testid="iiif-bar" data-w="480" data-h="80" />}
      </div>
      <output data-testid="bar-h">{sizes.bar.h}</output>
    </>
  );
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("useChromeSizes with a wrapper", () => {
  it("measures the new bar when the same wrapper's bar is replaced, and follows its size", async () => {
    const view = render(<Probe kind="media" />);
    expect(screen.getByTestId("bar-h").textContent).toBe("40");

    view.rerender(<Probe kind="iiif" />);
    await flush();
    const iiif = screen.getByTestId("iiif-bar");
    expect(screen.getByTestId("bar-h").textContent).toBe("80");
    expect(observed.has(iiif)).toBe(true);

    // The new bar drops to one row across the breakpoint.
    iiif.dataset.h = "40";
    act(() => {
      for (const fake of fakes) if (fake.targets.has(iiif)) fake.fire();
    });
    expect(screen.getByTestId("bar-h").textContent).toBe("40");
  });
});
