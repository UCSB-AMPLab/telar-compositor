/**
 * The two readings that decide whether the instance in front of the author is
 * the one a request or a capture belongs to.
 *
 * Both are exercised directly rather than through the column, because the state
 * they guard against is one the column cannot be driven into from the outside:
 * the record of a destroyed instance is dropped in the same flush that renders
 * the disabled button, so a handler holding a stale record is reachable only by
 * calling the reading itself.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  captureBindingOf,
  framingMatches,
} from "~/components/features/editor/viewer-column-state";
import type { InstanceRecord } from "~/components/features/editor/viewer-column-state";
import type { SourceState } from "~/components/features/objects/IiifViewer";

/** An opaque source key; only equality with itself matters here. */
const SOURCE = "manifest-and-info";

function instanceOn(page: number, generation = 1): InstanceRecord {
  return { meta: { sourceKey: SOURCE, generation, page }, opened: true };
}

function sourceOn(page: number, over: Partial<SourceState> = {}): SourceState {
  return {
    sourceKey: SOURCE,
    generation: 1,
    status: "ready",
    page,
    pageCount: 3,
    pages: [],
    ...over,
  };
}

describe("framingMatches", () => {
  it("matches a request for the page the instance and the source agree on", () => {
    expect(framingMatches({ sourceKey: SOURCE, page: 1 }, instanceOn(1), sourceOn(1)))
      .toBe(true);
  });

  it("refuses a request and an instance for page 2 while the source reports page 3", () => {
    // The author has paged on: the source describes the instance being built,
    // and the one still on screen is not it.
    expect(framingMatches({ sourceKey: SOURCE, page: 1 }, instanceOn(1), sourceOn(2)))
      .toBe(false);
  });

  it("resolves a requested page beyond the count against the count", () => {
    expect(framingMatches({ sourceKey: SOURCE, page: 899 }, instanceOn(2), sourceOn(2)))
      .toBe(true);
  });

  it("refuses another source, another generation and a source that is not ready", () => {
    expect(framingMatches({ sourceKey: "other", page: 1 }, instanceOn(1), sourceOn(1)))
      .toBe(false);
    expect(framingMatches({ sourceKey: SOURCE, page: 1 }, instanceOn(1, 2), sourceOn(1)))
      .toBe(false);
    expect(
      framingMatches(
        { sourceKey: SOURCE, page: 1 },
        instanceOn(1),
        sourceOn(1, { status: "loading" })
      )
    ).toBe(false);
  });
});

describe("captureBindingOf", () => {
  it("binds the capture to the selection, the step, the object and the instance's source", () => {
    expect(captureBindingOf(instanceOn(1), sourceOn(1), "id:4", "id:4", "codex")).toEqual({
      selectionKey: "id:4",
      targetKey: "id:4",
      objectId: "codex",
      sourceKey: SOURCE,
    });
  });

  it("binds nothing when the live record is gone, whatever the last render said", () => {
    // The rendered flag was true a moment ago; paging destroyed the instance
    // it described, and a viewport read now belongs to nothing.
    expect(captureBindingOf(null, sourceOn(1), "id:4", "id:4", "codex")).toBeNull();
  });

  it("binds nothing before the instance has opened", () => {
    expect(
      captureBindingOf(
        { meta: { sourceKey: SOURCE, generation: 1, page: 1 }, opened: false },
        sourceOn(1),
        "id:4",
        "id:4",
        "codex"
      )
    ).toBeNull();
  });

  it("binds nothing when the instance is not the one the source describes", () => {
    expect(captureBindingOf(instanceOn(1), sourceOn(2), "id:4", "id:4", "codex")).toBeNull();
  });

  it("binds nothing for a step with no target key or no object", () => {
    expect(captureBindingOf(instanceOn(1), sourceOn(1), "id:4", null, "codex")).toBeNull();
    expect(captureBindingOf(instanceOn(1), sourceOn(1), "id:4", "id:4", null)).toBeNull();
  });
});
