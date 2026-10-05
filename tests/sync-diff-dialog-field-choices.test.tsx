// @vitest-environment jsdom
/**
 * Pins what the objects-tab sync dialog submits for changed fields.
 *
 * The apply server leaves a field absent from the choices map alone, so the
 * submitted map has to carry a choice for every field the dialog displays and
 * not only for the ones the user clicked — otherwise what the radios show and
 * what the button does are two different answers.
 *
 * The default both of them give is "keep mine": a changed field may be an edit
 * made in the editor and not yet published, and no press of Apply should be
 * able to overwrite one that the author has not ruled on.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SyncDiff, SyncField } from "~/lib/sync.server";
import {
  SyncDiffDialog,
  type SyncApplyPayload,
} from "~/components/features/objects/SyncDiffDialog";

// Minimal i18n mock: keys render as themselves, defaults win when given.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
  }),
}));

function emptyDiff(): SyncDiff {
  return {
    newObjects: [],
    changedObjects: [],
    missingObjects: [],
    unregisteredFiles: [], reordered: null,
  };
}

function changedObject(objectId: string, fields: SyncField[]) {
  return {
    object_id: objectId,
    dbId: 1,
    title: `Title of ${objectId}`,
    changedFields: fields,
    conflictFields: [] as SyncField[],
    d1Values: Object.fromEntries(fields.map((f) => [f, `mine-${f}`])),
    repoValues: Object.fromEntries(fields.map((f) => [f, `repo-${f}`])),
  };
}

function renderDialog(diffData: SyncDiff) {
  const onApply = vi.fn<(payload: SyncApplyPayload) => void>();
  const { baseElement: container } = render(
    <SyncDiffDialog
      open
      onClose={() => {}}
      diffData={diffData}
      onApply={onApply}
      isComputing={false}
      isApplying={false}
    />,
  );
  return { onApply, container };
}

function apply() {
  fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));
}

function radio(container: HTMLElement, objectId: string, field: string, value: string) {
  const el = container.querySelector(
    `input[type="radio"][name="${objectId}-${field}"][value="${value}"]`,
  );
  if (!el) throw new Error(`no ${value} radio for ${objectId}.${field}`);
  return el as HTMLInputElement;
}

describe("SyncDiffDialog — submitted field choices", () => {
  it("submits 'd1' for every changed field when no radio is touched", () => {
    const diff = emptyDiff();
    diff.changedObjects = [
      changedObject("obj-1", ["title", "creator"]),
      changedObject("obj-2", ["dimensions"]),
    ];

    const { onApply, container } = renderDialog(diff);

    // The screen shows "keep mine" for all of them before any click, and an
    // Apply pressed there must leave every editor value standing.
    expect(radio(container, "obj-1", "title", "d1").checked).toBe(true);
    expect(radio(container, "obj-2", "dimensions", "d1").checked).toBe(true);

    apply();

    const payload = onApply.mock.calls[0][0];
    expect(payload.changedObjectIds).toEqual(["obj-1", "obj-2"]);
    expect(payload.fieldChoices).toEqual({
      "obj-1": { title: "d1", creator: "d1" },
      "obj-2": { dimensions: "d1" },
    });
  });

  it("submits 'repo' for a field switched to use-repo and 'd1' for its siblings", () => {
    const diff = emptyDiff();
    diff.changedObjects = [changedObject("obj-1", ["title", "creator", "credit"])];

    const { onApply, container } = renderDialog(diff);
    fireEvent.click(radio(container, "obj-1", "creator", "repo"));
    apply();

    expect(onApply.mock.calls[0][0].fieldChoices).toEqual({
      "obj-1": { title: "d1", creator: "repo", credit: "d1" },
    });
  });

  it("omits an unchecked changed object from the map entirely", () => {
    const diff = emptyDiff();
    diff.changedObjects = [
      changedObject("obj-1", ["title"]),
      changedObject("obj-2", ["creator"]),
    ];

    const { onApply, container } = renderDialog(diff);
    // The choice is made BEFORE the object is unchecked: a submission seeded
    // from the stored choices rather than built from the displayed fields
    // carries this one through and writes a repo value to an object the user
    // took out of the sync.
    fireEvent.click(radio(container, "obj-2", "creator", "repo"));
    const checkbox = container.querySelectorAll('input[type="checkbox"]')[1];
    fireEvent.click(checkbox);
    apply();

    const payload = onApply.mock.calls[0][0];
    expect(payload.changedObjectIds).toEqual(["obj-1"]);
    expect(payload.fieldChoices).toEqual({ "obj-1": { title: "d1" } });
    expect("obj-2" in payload.fieldChoices).toBe(false);
  });

  it("submits every new, missing and unregistered id when no checkbox is touched", () => {
    const diff = emptyDiff();
    diff.newObjects = [
      {
        object_id: "new-1",
        title: "New",
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
      },
    ];
    diff.missingObjects = [
      { object_id: "gone-1", dbId: 2, title: "Gone", usedByStories: [] },
    ];
    diff.unregisteredFiles = [{ object_id: "file-1", filename: "file-1.jpg" }];

    const { onApply } = renderDialog(diff);
    apply();

    const payload = onApply.mock.calls[0][0];
    expect(payload.newObjectIds).toEqual(["new-1"]);
    expect(payload.removedObjectIds).toEqual(["gone-1"]);
    expect(payload.unregisteredObjectIds).toEqual(["file-1"]);
  });

  // The author accepts the removal of the object they were shown: its D1 id
  // travels with its key, so the apply removes that row and no other (R10).
  it("submits the D1 id each removed object was shown with", () => {
    const diff = emptyDiff();
    diff.missingObjects = [
      { object_id: "gone-1", dbId: 2, title: "Gone", usedByStories: [] },
      { object_id: "gone-2", dbId: 7, title: "Also gone", usedByStories: [] },
    ];

    const { onApply } = renderDialog(diff);
    apply();

    expect(onApply.mock.calls[0][0].removedDocIds).toEqual({ "gone-1": 2, "gone-2": 7 });
  });

  // The same for a changed object: the apply updates the row the author was
  // shown, and not one re-created under its key since.
  it("submits the D1 id each changed object was shown with", () => {
    const diff = emptyDiff();
    diff.changedObjects = [
      { ...changedObject("obj-1", ["title"]), dbId: 3 },
      { ...changedObject("obj-2", ["creator"]), dbId: 8 },
    ];

    const { onApply } = renderDialog(diff);
    apply();

    expect(onApply.mock.calls[0][0].changedObjectIds).toEqual(["obj-1", "obj-2"]);
    expect(onApply.mock.calls[0][0].changedDocIds).toEqual({ "obj-1": 3, "obj-2": 8 });
  });
});
