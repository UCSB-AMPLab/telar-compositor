// @vitest-environment jsdom
/**
 * The review dialog with a choice per change: each item's card, the defaults
 * it opens with, "Set all to", Apply waiting for every change made on both
 * sides, and the payload Apply sends for what is shown.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, within } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

const submitSpy = vi.fn();
const fetcherData: { current: unknown } = { current: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ submit: submitSpy, state: "idle", data: fetcherData.current }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const blankNew = {
  title: null, creator: null, description: null, period: null, year: null, object_type: null, subjects: null,
  source: null, credit: null, thumbnail: null, featured: false, source_url: null, dimensions: null, image_available: false,
};

/** An object GitHub alone added, one deleted there and edited here, and a setting changed on both sides. */
function mixedDiff(classification: FullSyncDiff["classification"] = "three-way"): FullSyncDiff {
  return {
    objects: {
      newObjects: [{ object_id: "obj-new", ...blankNew }],
      changedObjects: [],
      missingObjects: [{ object_id: "demo-obj3", dbId: 3, title: "Object 3", usedByStories: [], editedInCompositor: classification === "three-way" }],
      unregisteredFiles: [],
      reordered: null,
    },
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [{ key: "title", d1Value: "Mine", repoValue: "Theirs", conflict: classification === "three-way" }], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    hasConflicts: true,
    classification,
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    headSha: HEAD,
  } as FullSyncDiff;
}

function renderWithDiff(diff: FullSyncDiff) {
  const view = render(<SyncConfirmModal open onClose={() => {}} />);
  fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
  view.rerender(<SyncConfirmModal open onClose={() => {}} />);
  return view;
}

const card = (key: string) => screen.getByTestId(`sync-item-${key}`);
const radio = (key: string, name: string) => within(card(key)).getByRole("radio", { name }) as HTMLInputElement;
const applyButton = () => screen.getByText("sync_modal.review.apply") as HTMLButtonElement;
const checked = (key: string) => (within(card(key)).getAllByRole("radio") as HTMLInputElement[]).filter((r) => r.checked);

function applied(): Record<string, any> {
  fireEvent.click(applyButton());
  const call = submitSpy.mock.calls.find(([body]) => (body as { intent?: string }).intent === "apply-full-sync");
  return JSON.parse((call![0] as { changes: string }).changes);
}

beforeEach(() => {
  submitSpy.mockClear();
  fetcherData.current = undefined;
});

describe("the cards", () => {
  it("shows the kind, the name, a badge for a change made in both places, what happened and each version's note", () => {
    renderWithDiff(mixedDiff());
    const both = within(card("object:missing:demo-obj3"));
    expect(both.getByText("sync_modal.review.kind_object")).toBeTruthy();
    expect(both.getByText("demo-obj3")).toBeTruthy();
    expect(both.getByText("sync_modal.review.badge_both")).toBeTruthy();
    expect(both.getByText("sync_modal.review.deleted_both")).toBeTruthy();
    expect(both.getByText("sync_modal.review.note_edits_lost")).toBeTruthy();
    expect(both.getByText("sync_modal.review.note_publish_restores")).toBeTruthy();
    expect(within(card("object:new:obj-new")).queryByText("sync_modal.review.badge_both")).toBeNull();
    expect(within(card("setting:title")).getByText(/sync_modal\.review\.setting_values .*"repo":"Theirs".*"mine":"Mine"/)).toBeTruthy();
  });

  it("opens with GitHub's version for a change GitHub alone made, and none for one made on both sides", () => {
    renderWithDiff(mixedDiff());
    expect(radio("object:new:obj-new", "sync_modal.review.add").checked).toBe(true);
    expect(checked("object:missing:demo-obj3")).toEqual([]);
    expect(checked("setting:title")).toEqual([]);
  });

  it("removes the two-way warning step: a two-way check opens on its list, with no version chosen", () => {
    renderWithDiff(mixedDiff("two-way"));
    expect(screen.queryByText(/sync_modal\.(sync_anyway|publish_first|conflict_warning)/)).toBeNull();
    for (const key of ["object:new:obj-new", "object:missing:demo-obj3", "setting:title"]) expect(checked(key)).toEqual([]);
    expect(applyButton().disabled).toBe(true);
  });
});

describe("Apply waits for the changes made on both sides", () => {
  it("is disabled, and says so, until each has a choice; then sends exactly those choices", () => {
    renderWithDiff(mixedDiff());
    expect(applyButton().disabled).toBe(true);
    expect(screen.getByTestId("when-you-apply").textContent).toContain('sync_modal.review.pending_both {"count":2}');
    fireEvent.click(applyButton());
    expect(submitSpy.mock.calls.some(([body]) => (body as { intent?: string }).intent === "apply-full-sync")).toBe(false);

    fireEvent.click(radio("object:missing:demo-obj3", "sync_modal.review.delete_here_too"));
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(radio("setting:title", "sync_modal.review.keep_compositor"));
    expect(applyButton().disabled).toBe(false);
    expect(screen.getByTestId("when-you-apply").textContent).toContain("sync_modal.review.compositor_does");

    const sent = applied();
    expect(sent.objects.newObjectIds).toEqual(["obj-new"]);
    expect(sent.objects.removedObjectIds).toEqual(["demo-obj3"]);
    expect(sent.objects.removedDocIds).toEqual({ "demo-obj3": 3 });
    expect(sent.config).toEqual({ accept: [], reject: ["title"] });
  });

  it("sends a GitHub-only change the author turned down as not taken", () => {
    renderWithDiff(mixedDiff());
    fireEvent.click(radio("object:new:obj-new", "sync_modal.review.dont_add"));
    fireEvent.click(radio("object:missing:demo-obj3", "sync_modal.review.keep_it_with_edits"));
    fireEvent.click(radio("setting:title", "sync_modal.review.use_github"));
    const sent = applied();
    expect(sent.objects.newObjectIds).toEqual([]);
    expect(sent.objects.removedObjectIds).toEqual([]);
    expect(sent.config).toEqual({ accept: ["title"], reject: [] });
  });
});

describe("Set all to", () => {
  it("GitHub's version: fills every choice, and Apply sends GitHub's side of each", () => {
    renderWithDiff(mixedDiff());
    fireEvent.click(screen.getByText("sync_modal.review.set_all_gh"));
    expect(radio("object:missing:demo-obj3", "sync_modal.review.delete_here_too").checked).toBe(true);
    expect(radio("setting:title", "sync_modal.review.use_github").checked).toBe(true);
    const sent = applied();
    expect(sent.objects).toMatchObject({ newObjectIds: ["obj-new"], removedObjectIds: ["demo-obj3"] });
    expect(sent.config).toEqual({ accept: ["title"], reject: [] });
  });

  it("the Compositor's version: fills every choice, and the author can still change one after", () => {
    renderWithDiff(mixedDiff("two-way"));
    fireEvent.click(screen.getByText("sync_modal.review.set_all_comp"));
    expect(radio("object:new:obj-new", "sync_modal.review.dont_add").checked).toBe(true);
    fireEvent.click(radio("object:new:obj-new", "sync_modal.review.add"));
    const sent = applied();
    expect(sent.objects).toMatchObject({ newObjectIds: ["obj-new"], removedObjectIds: [] });
    expect(sent.config).toEqual({ accept: [], reject: ["title"] });
  });
});

describe("notices", () => {
  it("shows GitHub's Telar version as a notice with no choice", () => {
    const diff = mixedDiff();
    diff.objects.newObjects = [];
    diff.objects.missingObjects = [];
    diff.config = { changedFields: [], versionChange: { direction: "ahead", repoVersion: "1.2.0", d1Version: "1.1.0" } };
    renderWithDiff(diff);
    expect(within(screen.getByTestId("sync-notices")).getByText('sync_modal.review.notice_version {"version":"1.2.0"}')).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });
});

describe("an image file with no object", () => {
  function imageDiff(): FullSyncDiff {
    const diff = mixedDiff();
    diff.objects = { ...diff.objects, unregisteredFiles: [{ object_id: "demo-leviathan", filename: "demo-leviathan.jpg" }] };
    return diff;
  }

  it("is a card naming the file, adding it by default, with the object's id in the note", () => {
    renderWithDiff(imageDiff());
    const image = within(card("image:demo-leviathan.jpg"));
    expect(image.getByText("sync_modal.review.kind_image")).toBeTruthy();
    expect(image.getByText("demo-leviathan.jpg")).toBeTruthy();
    expect(image.getByText("sync_modal.review.img_what")).toBeTruthy();
    expect(image.getByText('sync_modal.review.img_add_note {"id":"demo-leviathan"}')).toBeTruthy();
    expect(image.getByText("sync_modal.review.img_skip_note")).toBeTruthy();
    expect(checked("image:demo-leviathan.jpg").map((r) => r.value)).toEqual(["repo"]);
  });

  function chooseTheOthers() {
    fireEvent.click(radio("object:missing:demo-obj3", "sync_modal.review.keep_it_with_edits"));
    fireEvent.click(radio("setting:title", "sync_modal.review.keep_compositor"));
  }

  it("sends the file's id when added", () => {
    renderWithDiff(imageDiff());
    chooseTheOthers();
    expect(applied().objects.unregisteredObjectIds).toEqual(["demo-leviathan"]);
  });

  it("sends none when left out", () => {
    renderWithDiff(imageDiff());
    chooseTheOthers();
    fireEvent.click(radio("image:demo-leviathan.jpg", "sync_modal.review.img_skip"));
    expect(applied().objects.unregisteredObjectIds).toEqual([]);
  });
});

describe("opening the dialog", () => {
  const computeCalls = () => submitSpy.mock.calls.filter(([body]) => (body as { intent?: string }).intent === "compute-full-sync-diff");

  it("starts the check at once and shows a loading state, with no confirm step", () => {
    render(<SyncConfirmModal open onClose={() => {}} />);
    expect(computeCalls()).toHaveLength(1);
    expect(screen.getByText("sync_modal.computing")).toBeTruthy();
    expect(screen.queryByText("sync_modal.title")).toBeNull();
  });

  it("opens on the items once the check answers", () => {
    renderWithDiff(mixedDiff());
    expect(screen.queryByText("sync_modal.computing")).toBeNull();
    expect(card("object:new:obj-new")).toBeTruthy();
  });

  it("checks again each time it is opened, and not while closed", () => {
    const view = render(<SyncConfirmModal open={false} onClose={() => {}} />);
    expect(computeCalls()).toHaveLength(0);
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(computeCalls()).toHaveLength(1);
    view.rerender(<SyncConfirmModal open={false} onClose={() => {}} />);
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(computeCalls()).toHaveLength(2);
  });

  it("checks again from Try again after a failure, without a confirm step in between", () => {
    const view = render(<SyncConfirmModal open onClose={() => {}} />);
    fetcherData.current = { ok: false, intent: "compute-full-sync-diff", error: "sheet_unreadable", sheet: "objects.csv" };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    fireEvent.click(screen.getByText("sync_modal.retry"));
    expect(computeCalls()).toHaveLength(2);
    expect(screen.getByText("sync_modal.computing")).toBeTruthy();
  });
});
