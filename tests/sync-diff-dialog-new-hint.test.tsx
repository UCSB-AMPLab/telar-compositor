// @vitest-environment jsdom
/**
 * SyncDiffDialog — the line under "New" saying what an unticked new object
 * loses.
 *
 * A new-on-GitHub object is ticked by default; leaving it ticked brings it
 * into the Compositor, unticking it does not, and the next save of the
 * Compositor's objects removes it from the site's files. Nothing said so
 * before this line existed. It reads as a plain hint while every new object
 * stays ticked, and as a warning the moment the author unticks one — the
 * point at which the removal that sentence describes becomes real for this
 * check.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { SyncDiff } from "~/lib/sync.server";
import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
  }),
}));

afterEach(() => {
  cleanup();
});

function emptyDiff(): SyncDiff {
  return { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null };
}

function newObject(objectId: string) {
  return {
    object_id: objectId,
    title: `Title of ${objectId}`,
    creator: null,
    description: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    featured: false,
    source_url: null,
    dimensions: null,
    image_available: false,
  };
}

function renderDialog(diffData: SyncDiff) {
  const { baseElement: container } = render(
    <SyncDiffDialog
      open
      onClose={() => {}}
      diffData={diffData}
      onApply={() => {}}
      isComputing={false}
      isApplying={false}
    />,
  );
  return { container };
}

/** The visible line, and the live region that announces the warning. */
function hint(container: HTMLElement) {
  return {
    line: container.querySelector('[data-testid="sync-new-hint"]') as HTMLElement | null,
    live: container.querySelector('[data-testid="sync-new-hint-live"]') as HTMLElement | null,
  };
}

describe("SyncDiffDialog — sync_new_hint", () => {
  it("is not shown when there are no new objects", () => {
    const { container } = renderDialog(emptyDiff());
    expect(screen.queryByText("sync_new_hint")).toBeNull();
    expect(hint(container).line).toBeNull();
  });

  it("is shown, as a hint, when new objects are listed and all are ticked, with nothing announced", () => {
    const diff = emptyDiff();
    diff.newObjects = [newObject("new-1"), newObject("new-2")];
    const { container } = renderDialog(diff);

    const { line, live } = hint(container);
    expect(line?.textContent).toBe("sync_new_hint");
    expect(line?.dataset.state).toBe("hint");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toBe("");
  });

  // A live region announces a change to its content, not its own arrival or a
  // change of role, so the region is there from the first render and the
  // warning is announced by the text arriving in it.
  it("becomes a warning once one new object is unticked, announced through the region already present", () => {
    const diff = emptyDiff();
    diff.newObjects = [newObject("new-1"), newObject("new-2")];
    const { container } = renderDialog(diff);
    const liveBefore = hint(container).live;

    const firstCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(firstCheckbox);

    const { line, live } = hint(container);
    expect(line?.dataset.state).toBe("warning");
    expect(live).toBe(liveBefore);
    expect(live?.textContent).toBe("sync_new_hint");
  });

  it("returns to a hint once every new object is re-ticked, and the region empties", () => {
    const diff = emptyDiff();
    diff.newObjects = [newObject("new-1")];
    const { container } = renderDialog(diff);

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(hint(container).line?.dataset.state).toBe("warning");

    fireEvent.click(checkbox);
    const { line, live } = hint(container);
    expect(line?.dataset.state).toBe("hint");
    expect(live?.textContent).toBe("");
  });
});
