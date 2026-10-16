// @vitest-environment jsdom
/**
 * The sync dialog's story content changes: one entry per
 * story, one choice per story covering its row fields and its content, and
 * what the accept is sent for that choice.
 *
 * Every listed story carries a choice the author can take in the Compositor:
 * a change GitHub alone made (deleted steps among them) is taken by default,
 * a conflict and any change of a two-way check have no choice made, and Apply waits for
 * one; an unreadable story can only be kept, which the next publish writes
 * back. A check that could not read the story files lists none and says so.
 * Dialogs are queried through `screen`, so the tests hold whether or not the
 * dialog portals to the document body.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, within } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";
import type { StoryContentChange } from "~/lib/story-content.server";
import type { UnreadableReason } from "~/lib/story-canonical";

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

// Keys, with the options a string interpolates, so assertions can read both.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import {
  SyncConfirmModal,
  buildAllOrNothingChanges,
  buildThreeWayChanges,
  emptySelections,
} from "~/components/features/dashboard/SyncConfirmModal";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function change(storyId: string, kind: StoryContentChange["kind"], extra: Partial<StoryContentChange> = {}): StoryContentChange {
  return {
    story_id: storyId,
    title: `Story ${storyId}`,
    kind,
    acceptByDefault: kind === "github-only",
    summary: { d1Steps: 3, headSteps: 4, changedSteps: 2 },
    expected: `hash-${storyId}`,
    ...extra,
  };
}

function diffWith(
  changes: StoryContentChange[],
  extra: { classification?: FullSyncDiff["classification"]; conclusive?: boolean; rows?: string[] } = {},
): FullSyncDiff {
  return {
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null },
    stories: {
      newStories: [],
      changedStories: (extra.rows ?? []).map((id) => ({
        story_id: id, title: `Story ${id}`, changedFields: ["title"], conflictFields: [], conflict: false,
        d1Values: { title: "Here" }, repoValues: { title: "There" },
      })),
      missingStories: [],
      content: extra.conclusive === false
        ? { conclusive: false, reason: "the story trees came back truncated" }
        : { conclusive: true, changes, suppressedEditorOnly: 0 },
    },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    hasConflicts: false,
    classification: extra.classification ?? "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    headSha: HEAD,
  } as FullSyncDiff;
}

function renderWithDiff(diff: FullSyncDiff, unpublishedCount = 0) {
  const view = render(<SyncConfirmModal open onClose={() => {}} />);
  fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
  view.rerender(<SyncConfirmModal open onClose={() => {}} />);
  return view;
}

const TAKE = "sync_modal.review.use_github_text";
const KEEP = "sync_modal.review.keep_compositor_text";

function applyButton(): HTMLButtonElement {
  return screen.getByText(/^sync_modal\.(review\.apply|apply_other_changes)$/) as HTMLButtonElement;
}

function applied(): Record<string, unknown> {
  fireEvent.click(applyButton());
  const call = submitSpy.mock.calls.find(([body]) => (body as { intent?: string }).intent === "apply-full-sync");
  return JSON.parse((call![0] as { changes: string }).changes);
}

function isChecked(el: HTMLElement): boolean {
  return (el as HTMLInputElement).checked;
}

function card(storyId: string): HTMLElement {
  return screen.getByTestId(`sync-item-story:${storyId}`);
}

beforeEach(() => {
  submitSpy.mockClear();
  fetcherData.current = undefined;
});

describe("each kind with its default and its choice", () => {
  it("github-only: listed with its summary and taken by default", () => {
    renderWithDiff(diffWith([change("s1", "github-only")]));
    expect(isChecked(within(card("s1")).getByRole("radio", { name: TAKE }))).toBe(true);
    expect(within(card("s1")).getByText(/sync_modal\.content_summary/).textContent).toContain('"d1":3');
    expect(within(card("s1")).getByText(/sync_modal\.content_summary/).textContent).toContain('"head":4');
    expect(within(card("s1")).getByText(/sync_modal\.content_summary/).textContent).toContain('"count":2');
    expect(applied()).toMatchObject({ stories: { acceptContent: ["s1"], contentExpected: { s1: "hash-s1" } } });
  });

  it("github-only: kept, nothing of it is sent", () => {
    renderWithDiff(diffWith([change("s1", "github-only")]));
    fireEvent.click(within(card("s1")).getByRole("radio", { name: KEEP }));
    expect(applied()).toMatchObject({ stories: { acceptContent: [], contentExpected: {} } });
  });

  it("conflict: changed in both places, with no choice made until the author keeps one", () => {
    renderWithDiff(diffWith([change("s1", "conflict")]));
    const keep = within(card("s1")).getByRole("radio", { name: KEEP });
    const take = within(card("s1")).getByRole("radio", { name: TAKE });
    expect(within(card("s1")).getByText("sync_modal.review.badge_both")).toBeTruthy();
    expect(isChecked(keep)).toBe(false);
    expect(isChecked(take)).toBe(false);
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(keep);
    expect(applied()).toMatchObject({ stories: { acceptContent: [] } });
  });

  it("conflict: taking GitHub's sends the content", () => {
    renderWithDiff(diffWith([change("s1", "conflict")]));
    fireEvent.click(within(card("s1")).getByRole("radio", { name: TAKE }));
    expect(applied()).toMatchObject({ stories: { acceptContent: ["s1"], contentExpected: { s1: "hash-s1" } } });
  });

  it("steps-deleted: says so, and defaults to GitHub's version, as a change GitHub alone made", () => {
    renderWithDiff(diffWith([change("s1", "steps-deleted", { summary: { d1Steps: 3, headSteps: null, changedSteps: 3 } })]));
    expect(within(card("s1")).getByText("sync_modal.content_steps_deleted")).toBeTruthy();
    expect(isChecked(within(card("s1")).getByRole("radio", { name: "sync_modal.review.use_github" }))).toBe(true);
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(within(card("s1")).getByRole("radio", { name: "sync_modal.review.keep_compositor" }));
    expect(applied()).toMatchObject({ stories: { acceptContent: [] } });
  });

  it("steps-deleted: taken, it is sent, and so the story is emptied", () => {
    renderWithDiff(diffWith([change("s1", "steps-deleted", { summary: { d1Steps: 3, headSteps: null, changedSteps: 3 } })]));
    fireEvent.click(within(card("s1")).getByRole("radio", { name: "sync_modal.review.use_github" }));
    expect(applied()).toMatchObject({ stories: { acceptContent: ["s1"] } });
  });

  it("unreadable: the reason, and the one choice to keep the Compositor's version", () => {
    renderWithDiff(diffWith([change("s1", "unreadable", { reason: { code: "layer_reference_directory", reference: "x" }, expected: "hash-s1" })]));
    expect(within(card("s1")).getByText("sync_modal.content_unreadable")).toBeTruthy();
    expect(within(card("s1")).getByText(/sync_modal\.content_reason_layer_reference_directory/)).toBeTruthy();
    const radios = within(card("s1")).getAllByRole("radio");
    expect(radios).toHaveLength(1);
    expect(isChecked(radios[0])).toBe(true);
    expect(radios[0]).toBe(within(card("s1")).getByRole("radio", { name: KEEP }));
    const sent = applied();
    expect(sent).toMatchObject({ headSha: HEAD, stories: { acceptContent: [], contentExpected: {} } });
  });

  it.each<[UnreadableReason, string]>([
    [{ code: "step_missing", row: 2 }, "step_missing"],
    [{ code: "step_not_plain", step: "two", row: 2 }, "step_not_plain"],
    [{ code: "step_too_precise", step: "1.0000000000000001", row: 1 }, "step_too_precise"],
    [{ code: "step_repeated", step: "2", earlier: "2.0" }, "step_repeated"],
    [{ code: "layer_number_repeated", row: 2, layer: 1 }, "layer_number_repeated"],
    [{ code: "layer_reference_not_plain", reference: "./a.md" }, "layer_reference_not_plain"],
    [{ code: "layer_reference_directory", reference: "a.md" }, "layer_reference_directory"],
    [{ code: "layer_reference_non_ascii", reference: "\uA7CE.md" }, "layer_reference_non_ascii"],
    [{ code: "columns_collide", column: "question", headers: ["Question", "pregunta"] }, "columns_collide"],
    [{ code: "files_unreadable" }, "files_unreadable"],
  ])("unreadable: the reason %j is written from its own key, with its values", (reason, code) => {
    renderWithDiff(diffWith([change("s1", "unreadable", { reason })]));
    if (code === "files_unreadable") {
      expect(within(card("s1")).queryByText(/sync_modal\.content_reason_/)).toBeNull();
      return;
    }
    const text = within(card("s1")).getByText(/sync_modal\.content_reason_/).textContent ?? "";
    expect(text).toContain(`sync_modal.content_reason_${code}`);
    for (const value of Object.values(reason).filter((v) => v !== code)) {
      for (const part of Array.isArray(value) ? value : [value]) expect(text).toContain(String(part));
    }
  });

  it("unreadable: a reason that is text, not a code, does not type-check", () => {
    // @ts-expect-error a string is not an UnreadableReason
    const bad: StoryContentChange["reason"] = "a layer reference that names a directory: x";
    expect(bad).toBeTypeOf("string");
  });

  it("restore-choice: carried by the restore / keep-deleted card, never as content", () => {
    const diff = diffWith([change("s9", "restore-choice", { expected: null })]);
    diff.stories.newStories = [{ story_id: "s9", title: "Story s9", deletedInCompositor: true } as never];
    renderWithDiff(diff);
    expect(screen.queryByTestId("sync-item-story:s9")).toBeNull();
    const restoreCard = screen.getByTestId("sync-item-story:new:s9");
    fireEvent.click(within(restoreCard).getByRole("radio", { name: "sync_modal.review.restore" }));
    expect(applied()).toMatchObject({ stories: { insertNew: ["s9"], acceptContent: [] } });
  });

  it("lists a content change in two-way mode with no choice made, even one GitHub alone made", () => {
    renderWithDiff(diffWith([change("s1", "conflict"), change("s2", "github-only")], { classification: "two-way" }));
    for (const id of ["s1", "s2"]) expect(within(card(id)).getAllByRole("radio").some(isChecked)).toBe(false);
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(within(card("s1")).getByRole("radio", { name: KEEP }));
    fireEvent.click(within(card("s2")).getByRole("radio", { name: KEEP }));
    expect(applied()).toMatchObject({ stories: { acceptContent: [] } });
  });
});

describe("one choice for a story's row and its content", () => {
  it("lists the story once, and taking it accepts both", () => {
    renderWithDiff(diffWith([change("s1", "github-only")], { rows: ["s1"] }));
    expect(screen.getAllByTestId(/^sync-item-/)).toHaveLength(1);
    expect(within(card("s1")).getByText("sync_modal.review.story_details_too")).toBeTruthy();
    expect(applied()).toMatchObject({
      stories: { accept: ["s1"], reject: [], acceptContent: ["s1"], fieldChoices: { s1: { title: "repo" } } },
    });
  });

  it("keeping it keeps both", () => {
    renderWithDiff(diffWith([change("s1", "github-only")], { rows: ["s1"] }));
    fireEvent.click(within(card("s1")).getByRole("radio", { name: KEEP }));
    const sent = applied() as { stories: { accept: string[]; reject: string[]; acceptContent: string[]; fieldChoices: unknown } };
    expect(sent.stories.accept).toEqual([]);
    expect(sent.stories.reject).toEqual(["s1"]);
    expect(sent.stories.fieldChoices).toEqual({ s1: { title: "d1" } });
    expect(sent.stories.acceptContent).toEqual([]);
  });

  it("holds in the two-way builder too", () => {
    const diff = diffWith([change("s1", "conflict")], { classification: "two-way", rows: ["s1", "s2"] });
    const kept = buildAllOrNothingChanges(diff, emptySelections());
    expect(kept.stories).toMatchObject({ accept: ["s2"], reject: ["s1"], acceptContent: [] });
    const taken = buildAllOrNothingChanges(diff, { ...emptySelections(), storyContentChoices: { s1: "repo" } });
    expect(taken.stories).toMatchObject({ accept: ["s2", "s1"], reject: [], acceptContent: ["s1"] });
  });
});

describe("the payload", () => {
  it("carries headSha, acceptContent and contentExpected from both builders", () => {
    const diff = diffWith([change("s1", "github-only"), change("s2", "conflict"), change("s3", "unreadable")]);
    const sel = { ...emptySelections(), storyContentChoices: { s2: "repo" as const } };
    for (const built of [buildThreeWayChanges(diff, sel), buildAllOrNothingChanges(diff, sel)]) {
      expect(built.headSha).toBe(HEAD);
      expect(built.stories.acceptContent).toEqual(["s1", "s2"]);
      expect(built.stories.contentExpected).toEqual({ s1: "hash-s1", s2: "hash-s2" });
    }
  });

  it("never takes a story whose content has no expected hash", () => {
    const diff = diffWith([change("s1", "github-only", { expected: null })]);
    expect(buildThreeWayChanges(diff, emptySelections()).stories.acceptContent).toEqual([]);
  });

  it("counts a diff holding only content changes as changes, with no warning step before the review", () => {
    renderWithDiff(diffWith([change("s1", "github-only")], { classification: "two-way" }), 2);
    expect(screen.getByText("sync_modal.review.title")).toBeTruthy();
    expect(card("s1")).toBeTruthy();
  });
});

describe("the story files could not be read", () => {
  it("says so, lists no story, and offers trying again, with no whole-site Keep", () => {
    renderWithDiff(diffWith([], { conclusive: false }));
    expect(screen.getByText("sync_modal.review.request_stories")).toBeTruthy();
    expect(screen.queryByText(/^sync_modal\.apply_/)).toBeNull();
    expect(screen.queryByText("sync_modal.use_compositor_version")).toBeNull();
    submitSpy.mockClear();
    fireEvent.click(screen.getByText("sync_modal.review.try_again"));
    expect(submitSpy).toHaveBeenCalledWith({ intent: "compute-full-sync-diff" }, expect.anything());
  });

  it("labels Apply as applying the other changes, the site staying out of sync", () => {
    const diff = diffWith([], { conclusive: false, rows: ["s2"] });
    renderWithDiff(diff);
    expect(screen.getByText("sync_modal.apply_other_changes")).toBeTruthy();
    expect(screen.getByText("sync_modal.content_inconclusive_apply_note")).toBeTruthy();
    expect(applied()).toMatchObject({ stories: { accept: ["s2"], acceptContent: [] } });
  });

  it("after the accept, says the site is still out of sync", () => {
    const view = renderWithDiff(diffWith([], { conclusive: false, rows: ["s2"] }));
    applied();
    fetcherData.current = { ok: true, intent: "apply-full-sync", newHeadSha: null, storyFilesInconclusive: true };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(screen.getByText("sync_modal.success_inconclusive")).toBeTruthy();
  });
});

describe("story files the check could not read for a structural cause", () => {
  function structural(rows: string[] = []): FullSyncDiff {
    const diff = diffWith([], { rows });
    diff.stories.content = { conclusive: false, reason: "telar-content/texts/stories could not be listed completely", cause: "structure" };
    return diff;
  }

  it("lists them as one item with only the Compositor's version, not chosen, and Apply waits for it", () => {
    renderWithDiff(structural());
    const item = screen.getByTestId("sync-item-story:nocheck:all");
    expect(within(item).getByText("sync_modal.review.nocheck_all_stories_title")).toBeTruthy();
    expect(within(item).getByText("sync_modal.review.nocheck_truncated")).toBeTruthy();
    const [keep] = within(item).getAllByRole("radio") as HTMLInputElement[];
    expect(within(item).getAllByRole("radio")).toHaveLength(1);
    expect(keep.checked).toBe(false);
    expect(within(item).getByText("sync_modal.review.badge_choose")).toBeTruthy();
    expect(screen.queryByTestId("request-unread")).toBeNull();
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(keep);
    expect(applyButton().disabled).toBe(false);
    expect(applied()).toMatchObject({ keepUnreadFiles: ["stories"] });
  });
});

describe("a story whose file GitHub holds with characters that cannot be read", () => {
  it("is the story's card, named with the file, with either version and none chosen", () => {
    const diff = diffWith([change("s1", "github-only")]);
    diff.unreadable = [{ file: "s1.csv", storyIds: ["s1"], effect: "left_out", notice: false }];
    renderWithDiff(diff);
    expect(within(card("s1")).getByText("Story s1: s1.csv")).toBeTruthy();
    expect(within(card("s1")).getByText("sync_modal.review.bad_what")).toBeTruthy();
    const radios = within(card("s1")).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(within(card("s1")).getByRole("radio", { name: "sync_modal.review.use_github" }));
    expect(applied()).toMatchObject({ stories: { acceptContent: ["s1"] } });
  });

  it("is a notice when the site does not use the file", () => {
    const diff = diffWith([change("s1", "github-only")]);
    diff.unreadable = [{ file: "_old/s1.csv", effect: "not_used", notice: true }];
    renderWithDiff(diff);
    expect(screen.getByTestId("unreadable-notice").textContent).toContain("common:sheet_warnings.unreadable_characters.not_used");
    expect(isChecked(within(card("s1")).getByRole("radio", { name: TAKE }))).toBe(true);
  });
});

describe("the accept's refusals", () => {
  it("a story changed while it was reviewed: the list is checked again and says why", () => {
    const view = renderWithDiff(diffWith([change("s1", "github-only")]));
    applied();
    submitSpy.mockClear();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "story_changed_since_review", storyIds: ["s1"] };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(submitSpy).toHaveBeenCalledWith({ intent: "compute-full-sync-diff" }, expect.anything());
    const FRESH = "89abcdef0123456789abcdef0123456789abcdef";
    const recheck = diffWith([change("s1", "github-only", { expected: "hash-s1-fresh" })]);
    recheck.headSha = FRESH;
    fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff: recheck };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    const notice = screen.getByText(/sync_modal\.story_changed_none_applied/);
    expect(notice.textContent).toContain("Story s1");
    expect(card("s1")).toBeTruthy();
    // Applying again sends what the check just read, not what the refused accept carried.
    submitSpy.mockClear();
    expect(applied()).toMatchObject({
      headSha: FRESH,
      stories: { acceptContent: ["s1"], contentExpected: { s1: "hash-s1-fresh" } },
    });
  });

  it("a story that could not be saved: a message to try again", () => {
    const view = renderWithDiff(diffWith([change("s1", "github-only")]));
    applied();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "story_content_failed", storyIds: ["s1"] };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(screen.getByText(/sync_modal\.error_story_failed/).textContent).toContain("Story s1");
    expect(screen.getByText("sync_modal.retry")).toBeTruthy();
  });

  // Answered as the objects page answers a new row it did not add.
  it("a new object row D1 refused: the objects page's not-added message, to try again", () => {
    const view = renderWithDiff(diffWith([change("s1", "github-only")]));
    applied();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "objects_not_added", objectIds: ["o2"] };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(screen.getByText(/objects:sync_not_added/)).toBeTruthy();
    expect(screen.getByText("sync_modal.retry")).toBeTruthy();
  });

  // A fault of the Compositor's, whose message is the same in both places.
  it("an apply held back for entries it cannot store: the Compositor-fault message, not the raw one", () => {
    const view = renderWithDiff(diffWith([change("s1", "github-only")]));
    applied();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "entries_refused", message: "sync apply refused: raw detail" };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(screen.getByText(/sync_modal\.error_entries_refused/)).toBeTruthy();
    expect(screen.queryByText(/raw detail/)).toBeNull();
  });

  it("a glossary term D1 refused: says the terms were not added and to sync again", () => {
    const view = renderWithDiff(diffWith([change("s1", "github-only")]));
    applied();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "inserts_not_added", failed: { glossaryInsert: ["t9"] } };
    view.rerender(<SyncConfirmModal open onClose={() => {}} />);
    expect(screen.getByText(/sync_modal\.error_terms_not_added/)).toBeTruthy();
    expect(screen.queryByText("unknown_error")).toBeNull();
  });
});

describe("whether the check read the story files", () => {
  it("is sent only for a check that concluded for story content", () => {
    const concluded = diffWith([change("s1", "github-only")]);
    const unread = diffWith([], { conclusive: false });
    const unchecked = diffWith([]);
    delete (unchecked.stories as { content?: unknown }).content;
    for (const build of [buildThreeWayChanges, buildAllOrNothingChanges]) {
      expect(build(concluded, emptySelections()).storyContentChecked).toBe(true);
      expect(build(unread, emptySelections())).not.toHaveProperty("storyContentChecked");
      expect(build(unchecked, emptySelections())).not.toHaveProperty("storyContentChecked");
    }
  });
});

describe("story ids that name Object.prototype's own properties", () => {
  it.each(["constructor", "__proto__"])("%s: each kind keeps its default", (id) => {
    const diff = diffWith([change(id, "github-only"), { ...change(`${id}-c`, "conflict") }]);
    diff.stories.content = {
      conclusive: true, suppressedEditorOnly: 0,
      changes: [change(id, "github-only")],
    };
    const taken = JSON.parse(JSON.stringify(buildThreeWayChanges(diff, emptySelections())));
    expect(taken.stories.acceptContent).toEqual([id]);
    expect(Object.hasOwn(taken.stories.contentExpected, id)).toBe(true);
    expect(taken.stories.contentExpected[id]).toBe(`hash-${id}`);

    diff.stories.content = { conclusive: true, suppressedEditorOnly: 0, changes: [change(id, "conflict")] };
    const kept = JSON.parse(JSON.stringify(buildThreeWayChanges(diff, emptySelections())));
    expect(kept.stories.acceptContent).toEqual([]);
    expect(kept.stories.contentExpected).toEqual({});
  });

  it.each(["constructor", "__proto__"])("%s: choosing GitHub's version in the dialog sends it with its hash", (id) => {
    renderWithDiff(diffWith([change(id, "conflict")]));
    expect(within(card(id)).getAllByRole("radio").some(isChecked)).toBe(false);
    fireEvent.click(within(card(id)).getByRole("radio", { name: TAKE }));
    const sent = applied() as { stories: { acceptContent: string[]; contentExpected: Record<string, string> } };
    expect(sent.stories.acceptContent).toEqual([id]);
    expect(Object.hasOwn(sent.stories.contentExpected, id)).toBe(true);
    expect(sent.stories.contentExpected[id]).toBe(`hash-${id}`);
  });

  it.each(["constructor", "__proto__"])("%s: a row conflict and a deleted-here story keep theirs", (id) => {
    const diff = diffWith([]);
    diff.stories.changedStories = [{
      story_id: id, title: "Row", changedFields: ["title"], conflictFields: ["title"], conflict: true,
      d1Values: { title: "Here" }, repoValues: { title: "There" },
    }];
    diff.stories.newStories = [{ story_id: `${id}`, title: "Gone", deletedInCompositor: true } as never];
    const built = buildThreeWayChanges(diff, emptySelections());
    expect(built.stories.reject).toEqual([id]);
    expect(built.stories.insertNew).toEqual([]);
  });
});

