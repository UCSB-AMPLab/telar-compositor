// @vitest-environment jsdom
/**
 * ShareBar.tsx at 0% coverage. It earns its own file, separate from
 * contribution-record.test.tsx: the record-level tests there exercise it only
 * through props the record happens to construct, while the rules that belong
 * to the primitive itself — dropping zero-valued segments rather than drawing
 * slivers, the empty-track-plus-dash "uncounted" state, `asClock`'s h:mm
 * arithmetic, `tint`'s alpha suffix, and `NestedTimeBar`'s writing-capped-at-
 * editing split — are properties of this file alone and are pinned directly
 * against it here.
 *
 * No react-i18next or react-router mocking: neither module imports either.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { ShareBar, NestedTimeBar, asClock, tint } from "~/components/features/contributions/ShareBar";

// ---------------------------------------------------------------------------
// asClock
// ---------------------------------------------------------------------------

describe("asClock", () => {
  it("formats seconds as h:mm, floored to the minute", () => {
    expect(asClock(0)).toBe("0:00");
    expect(asClock(59)).toBe("0:00"); // under a minute floors to 0
    expect(asClock(60)).toBe("0:01");
    expect(asClock(1500)).toBe("0:25");
    expect(asClock(3600)).toBe("1:00");
    expect(asClock(3600 * 2 + 60 * 5)).toBe("2:05");
  });
});

// ---------------------------------------------------------------------------
// tint
// ---------------------------------------------------------------------------

describe("tint", () => {
  it("appends a fixed 40%-alpha hex suffix to a colour", () => {
    expect(tint("#6B7280")).toBe("#6B728066");
    expect(tint("#000000")).toBe("#00000066");
  });
});

// ---------------------------------------------------------------------------
// ShareBar
// ---------------------------------------------------------------------------

describe("ShareBar", () => {
  it("drops zero-valued shares instead of drawing a zero-width segment", () => {
    const { container } = render(
      <ShareBar
        label="added"
        shares={[
          { userId: 1, color: "#111111", value: 0 },
          { userId: 2, color: "#222222", value: 4 },
        ]}
        total="4"
      />
    );
    const track = container.querySelector(".rounded-\\[2px\\]") as HTMLElement;
    expect(track.children).toHaveLength(1);
    expect((track.children[0] as HTMLElement).style.flexGrow).toBe("4");
  });

  it("draws nothing when every share is zero, even though uncounted is false", () => {
    const { container } = render(
      <ShareBar
        label="added"
        shares={[
          { userId: 1, color: "#111111", value: 0 },
          { userId: 2, color: "#222222", value: 0 },
        ]}
        total="0"
      />
    );
    const track = container.querySelector(".rounded-\\[2px\\]") as HTMLElement;
    expect(track.children).toHaveLength(0);
  });

  it("renders an empty track and the fg-faint total text when uncounted", () => {
    const { container, getByText } = render(
      <ShareBar label="words" shares={[]} total="—" uncounted={true} />
    );
    const track = container.querySelector(".rounded-\\[2px\\]") as HTMLElement;
    expect(track.children).toHaveLength(0);
    expect(getByText("—").className).toContain("text-fg-faint");
  });

  it("renders the total text without the faint class when counted", () => {
    const { getByText } = render(
      <ShareBar
        label="added"
        shares={[{ userId: 1, color: "#111111", value: 3 }]}
        total="3"
        uncounted={false}
      />
    );
    expect(getByText("3").className).toContain("text-fg-muted");
    expect(getByText("3").className).not.toContain("text-fg-faint");
  });

  it("keeps segments in the order given — the bar never sorts its shares", () => {
    const { container } = render(
      <ShareBar
        label="added"
        shares={[
          { userId: 3, color: "#333333", value: 1 },
          { userId: 1, color: "#111111", value: 9 },
          { userId: 2, color: "#222222", value: 5 },
        ]}
        total="15"
      />
    );
    const track = container.querySelector(".rounded-\\[2px\\]") as HTMLElement;
    const segments = Array.from(track.children) as HTMLElement[];
    expect(segments.map((s) => s.style.flexGrow)).toEqual(["1", "9", "5"]);
  });

  it("uses a taller track when a custom height is given", () => {
    const { container } = render(
      <ShareBar
        label="added"
        shares={[{ userId: 1, color: "#111111", value: 1 }]}
        total="1"
        height={22}
      />
    );
    const track = container.querySelector(".rounded-\\[2px\\]") as HTMLElement;
    expect(track.style.height).toBe("22px");
  });
});

// ---------------------------------------------------------------------------
// NestedTimeBar
// ---------------------------------------------------------------------------

describe("NestedTimeBar", () => {
  it("splits each person's segment into a writing head and an other-editing remainder", () => {
    const { container } = render(
      <NestedTimeBar
        label="editing"
        people={[{ userId: 1, color: "#111111", editing: 100, writing: 30 }]}
        total={asClock(100)}
      />
    );
    const person = container.querySelector(".flex.h-4 > .flex") as HTMLElement;
    const [writingPart, restPart] = person.children as unknown as HTMLElement[];
    expect(writingPart.style.flexGrow).toBe("30");
    expect(writingPart.style.background).toBe("rgb(17, 17, 17)");
    expect(restPart.style.flexGrow).toBe("70");
    // jsdom normalises the 8-digit hex tint() returns to rgba(...).
    expect(restPart.style.background).toBe("rgba(17, 17, 17, 0.4)");
  });

  it("caps the writing head at the editing total — writing can never draw wider than editing", () => {
    // Should not happen (writing <= editing is the invariant elsewhere), but
    // the bar itself clamps rather than overflow or go negative.
    const { container } = render(
      <NestedTimeBar
        label="editing"
        people={[{ userId: 1, color: "#111111", editing: 10, writing: 999 }]}
        total={asClock(10)}
      />
    );
    const person = container.querySelector(".flex.h-4 > .flex") as HTMLElement;
    const [writingPart, restPart] = person.children as unknown as HTMLElement[];
    expect(writingPart.style.flexGrow).toBe("10"); // min(999, 10)
    expect(restPart.style.flexGrow).toBe("0"); // max(0, 10 - 999)
  });

  it("drops a person with no editing time from the track entirely", () => {
    const { container } = render(
      <NestedTimeBar
        label="editing"
        people={[
          { userId: 1, color: "#111111", editing: 0, writing: 0 },
          { userId: 2, color: "#222222", editing: 50, writing: 10 },
        ]}
        total={asClock(50)}
      />
    );
    const track = container.querySelector(".flex.h-4") as HTMLElement;
    expect(track.children).toHaveLength(1);
  });
});
