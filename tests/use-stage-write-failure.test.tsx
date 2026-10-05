// @vitest-environment jsdom
/**
 * The stage's capture, object change and page choice report a write that came
 * back failed, on the step its submission targeted.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStageWriteFailure, type StageFetchers } from "~/hooks/use-stage-write-failure";

const idle = { data: undefined, formData: undefined };
const none: StageFetchers = { capture: idle, object: idle, page: idle };
const unreachable = () => ({ ok: false, reason: "unreachable" });

/** A fetcher submitting to the step with id `stepId`. */
function submittingTo(stepId: number) {
  const formData = new FormData();
  formData.set("stepId", String(stepId));
  return { data: undefined, formData };
}

function mount(selectionKey = "id:1") {
  return renderHook((props: { fetchers: StageFetchers; key: string }) => useStageWriteFailure(props.fetchers, props.key), {
    initialProps: { fetchers: none, key: selectionKey },
  });
}

describe("useStageWriteFailure", () => {
  it("reports nothing before any answer", () => {
    expect(mount().result.current).toEqual([]);
  });

  it.each(["capture", "object", "page"] as const)("reports a failed %s write", (write) => {
    const view = mount();
    view.rerender({ fetchers: { ...none, [write]: submittingTo(1) }, key: "id:1" });
    view.rerender({ fetchers: { ...none, [write]: { data: unreachable(), formData: undefined } }, key: "id:1" });
    expect(view.result.current).toEqual([write]);
  });

  it("clears when the next answer to the same control on that step succeeds", () => {
    const view = mount();
    view.rerender({ fetchers: { ...none, object: submittingTo(1) }, key: "id:1" });
    view.rerender({ fetchers: { ...none, object: { data: unreachable(), formData: undefined } }, key: "id:1" });
    view.rerender({ fetchers: { ...none, object: submittingTo(1) }, key: "id:1" });
    view.rerender({ fetchers: { ...none, object: { data: { ok: true }, formData: undefined } }, key: "id:1" });
    expect(view.result.current).toEqual([]);
  });

  it("reports a failure on the step its submission targeted, though another is selected when it answers", () => {
    const view = mount();
    view.rerender({ fetchers: { ...none, capture: submittingTo(1) }, key: "id:1" });
    view.rerender({ fetchers: { ...none, capture: submittingTo(1) }, key: "id:2" });
    view.rerender({ fetchers: { ...none, capture: { data: unreachable(), formData: undefined } }, key: "id:2" });
    expect(view.result.current).toEqual([]);
    view.rerender({ fetchers: { ...none, capture: { data: unreachable(), formData: undefined } }, key: "id:1" });
    expect(view.result.current).toEqual(["capture"]);
  });

  it("never moves an old failure when another control answers later", () => {
    const view = mount();
    const failedCapture = { data: unreachable(), formData: undefined };
    view.rerender({ fetchers: { ...none, capture: submittingTo(1) }, key: "id:1" });
    view.rerender({ fetchers: { ...none, capture: failedCapture }, key: "id:1" });
    // A new capture on step 2 is out, its fetcher still holding the old answer.
    const capturing = { data: failedCapture.data, formData: submittingTo(2).formData };
    view.rerender({ fetchers: { ...none, capture: capturing, page: submittingTo(2) }, key: "id:2" });
    view.rerender({ fetchers: { ...none, capture: capturing, page: { data: { ok: true }, formData: undefined } }, key: "id:2" });
    expect(view.result.current).toEqual([]);
    view.rerender({ fetchers: { ...none, capture: capturing, page: { data: { ok: true }, formData: undefined } }, key: "id:1" });
    expect(view.result.current).toEqual(["capture"]);
  });

  it("reports every failed control on the step", () => {
    const view = mount();
    view.rerender({ fetchers: { ...none, capture: submittingTo(1), page: submittingTo(1) }, key: "id:1" });
    view.rerender({
      fetchers: { ...none, capture: { data: unreachable(), formData: undefined }, page: { data: unreachable(), formData: undefined } },
      key: "id:1",
    });
    expect(view.result.current).toEqual(["capture", "page"]);
  });
});
