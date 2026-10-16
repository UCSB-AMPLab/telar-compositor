/**
 * The review dialog's items: every change the check lists, one item each,
 * with the versions it offers, its default, and what applying each version
 * does; the notices that carry no choice; and the "When you apply" summary,
 * built from the choices. Pure; SyncItemCards renders them and
 * SyncConfirmModal holds the choices as `ThreeWaySelections`.
 *
 * Defaults: a change GitHub alone made defaults to GitHub's version; a change
 * made on both sides has none, nor has any change of a two-way diff, which
 * has no base to tell the sides apart. Steps deleted on GitHub in a story
 * edited here too reach the dialog as a conflict, so `steps-deleted` is a
 * change GitHub alone made. An item that offers one version has it chosen.
 *
 * An image file in the objects folder with no object, which the review's base
 * did not hold, is an item adding it as an object by default.
 *
 * Stories are compared and accepted whole: one item per story, covering its
 * content and its row together (`withStoryContent`). A story whose file GitHub
 * holds with characters that cannot be read is that story's item, offering
 * GitHub's version or the Compositor's with no default; a file of no story, or
 * one the site does not use or takes from Google Sheets, is a notice. A file
 * check that did not conclude for a structural cause is an item offering only
 * the Compositor's version, not chosen until the author chooses it; one that
 * did not conclude for a request cause is the dialog's to say, with no item.
 * A check that read the head alone, its base no longer a commit GitHub holds
 * (`baseUnresolvedOf`), has no defaults, as a two-way one.
 *
 * @version v1.5.5-beta
 */

import type { FullSyncChanges, FullSyncDiff } from "~/lib/sync.server";
import type { StoryContentChange } from "~/lib/story-content.server";
import type { UnreadableReason } from "~/lib/story-canonical";
import type { UnreadableEffect } from "~/lib/sheet-warnings";
import type { PageContentChange, PageFileChange } from "~/lib/page-content.server";
import {
  baseUnresolvedOf,
  buildAllOrNothingChanges,
  buildThreeWayChanges,
  contentTakeable,
  listedContentChanges,
  listedPageAdditions,
  listedPageChanges,
  listedPageFiles,
  ownValue,
  unreadChecks,
  type ConflictChoice,
  type ThreeWaySelections,
} from "./sync-changes";

export type ItemKind = "object" | "image" | "story" | "setting" | "term" | "page";

/** What applying a version does in the Compositor. */
export type CompositorAction =
  | "take" | "keep" | "add" | "skip" | "restore" | "stay_deleted" | "delete" | "keep_present";

/** What the next publish then does on GitHub. */
export type PublishAction = "overwrite" | "restore" | "add" | "repair";

/** An i18n key of the dashboard namespace, with its values. */
export interface Line {
  key: string;
  values?: Record<string, string | number>;
}

export interface ItemOption {
  choice: ConflictChoice;
  label: string;
  note?: string;
  /** The values `note` names. */
  noteValues?: Record<string, string>;
  does: CompositorAction;
  publish?: PublishAction;
}

/** What the summary names: an item's kind and raw name (a setting's key; `displayName` resolves it). */
export interface Named {
  kind: ItemKind;
  name: string;
  /** An i18n key of the dashboard namespace naming it in place of `name`. */
  nameKey?: string;
}

export interface SyncItem extends Named {
  key: string;
  /** The card's heading when it differs from the name the summary gives it, as text or as an i18n key. */
  title?: string;
  titleKey?: string;
  what: Line;
  /** Field label keys (objects namespace) the `what` line lists as `{{fields}}`. */
  fields?: string[];
  details: Line[];
  /** Why a story cannot be read (`reasonText`, SyncItemCards). */
  reason?: UnreadableReason;
  /** Changed on GitHub and in the Compositor. */
  both: boolean;
  options: ItemOption[];
  defaultChoice: ConflictChoice | null;
  /** The author's choice, when they made one. */
  read: (sel: ThreeWaySelections) => ConflictChoice | undefined;
  write: (sel: ThreeWaySelections, choice: ConflictChoice) => ThreeWaySelections;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const TAKE: ItemOption = { choice: "repo", label: "sync_modal.review.use_github", does: "take" };
const TAKE_BOTH: ItemOption = { ...TAKE, note: "sync_modal.review.note_edits_lost" };
const KEEP: ItemOption = { choice: "d1", label: "sync_modal.review.keep_compositor", note: "sync_modal.review.note_publish_restores", does: "keep", publish: "overwrite" };
const TAKE_TEXT: ItemOption = { choice: "repo", label: "sync_modal.review.use_github_text", does: "take" };
const TAKE_TEXT_BOTH: ItemOption = { ...TAKE_TEXT, note: "sync_modal.review.note_edits_lost" };
const KEEP_TEXT: ItemOption = { choice: "d1", label: "sync_modal.review.keep_compositor_text", note: "sync_modal.review.note_publish_restores", does: "keep", publish: "overwrite" };
const ADD: ItemOption = { choice: "repo", label: "sync_modal.review.add", does: "add" };
const SKIP: ItemOption = { choice: "d1", label: "sync_modal.review.dont_add", does: "skip" };
const RESTORE: ItemOption = { choice: "repo", label: "sync_modal.review.restore", does: "restore" };
const STAY_DELETED: ItemOption = { choice: "d1", label: "sync_modal.review.keep_deleted", does: "stay_deleted" };
const DELETE: ItemOption = { choice: "repo", label: "sync_modal.review.delete_here_too", does: "delete" };
const DELETE_BOTH: ItemOption = { ...DELETE, note: "sync_modal.review.note_edits_lost" };
const KEEP_PRESENT: ItemOption = { choice: "d1", label: "sync_modal.review.keep_it", note: "sync_modal.review.note_publish_restores", does: "keep_present", publish: "restore" };
const KEEP_EDITED: ItemOption = { ...KEEP_PRESENT, label: "sync_modal.review.keep_it_with_edits" };
const BAD_TAKE: ItemOption = { choice: "repo", label: "sync_modal.review.use_github", note: "sync_modal.review.bad_use_gh_note", does: "take", publish: "repair" };
const BAD_KEEP: ItemOption = { choice: "d1", label: "sync_modal.review.keep_compositor", note: "sync_modal.review.bad_keep_note", does: "keep", publish: "overwrite" };
const BAD_ADD: ItemOption = { ...BAD_TAKE, does: "add" };
const BAD_SKIP: ItemOption = { choice: "d1", label: "sync_modal.review.keep_compositor", note: "sync_modal.review.bad_keep_note", does: "skip" };

// ---------------------------------------------------------------------------
// Reading and writing a choice
// ---------------------------------------------------------------------------

type ChoiceMap = "objectChoices" | "storyChoices" | "configChoices" | "glossaryChangedChoices"
  | "storyContentChoices" | "pageContentChoices" | "pageFileChoices" | "keepUnread";
type TakenMap = "objectRestore" | "objectDelete" | "storyRestore" | "glossaryRestore" | "storyDelete" | "glossaryDelete" | "imageAdd";

/** `record` with `id` set to `value`, as an own property whatever the id. */
function withEntry<T>(record: Record<string, T> | undefined, id: string, value: T): Record<string, T> {
  return Object.fromEntries([...Object.entries(record ?? {}), [id, value]]);
}

function choiceIn(map: ChoiceMap, id: string): Pick<SyncItem, "read" | "write"> {
  return {
    read: (sel) => ownValue(sel[map] ?? {}, id),
    write: (sel, choice) => ({ ...sel, [map]: withEntry(sel[map], id, choice) }),
  };
}

function takenIn(map: TakenMap, id: string): Pick<SyncItem, "read" | "write"> {
  return {
    read: (sel) => {
      const taken = ownValue(sel[map] ?? {}, id);
      return taken === undefined ? undefined : taken ? "repo" : "d1";
    },
    write: (sel, choice) => ({ ...sel, [map]: withEntry(sel[map], id, choice === "repo") }),
  };
}

/** An item with no choice to store: its one version is always the one taken. */
const FIXED: Pick<SyncItem, "read" | "write"> = { read: () => undefined, write: (sel) => sel };

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

/** The default: none for a change on both sides or a two-way diff, else GitHub's. */
function defaultOf(both: boolean, twoWay: boolean): ConflictChoice | null {
  return both || twoWay ? null : "repo";
}

/** The `what` lines for a change GitHub made, by what changed and which sides the base tells apart. */
const EDITED = {
  fields: { github: "sync_modal.review.fields_github", both: "sync_modal.review.fields_both", differs: "sync_modal.review.fields_differs" },
  text: { github: "sync_modal.review.text_github", both: "sync_modal.review.text_both", differs: "sync_modal.review.text_differs" },
  details: { github: "sync_modal.review.details_github", both: "sync_modal.review.details_both", differs: "sync_modal.review.details_differs" },
  setting: { github: "sync_modal.review.setting_github", both: "sync_modal.review.setting_both", differs: "sync_modal.review.setting_differs" },
} as const;

/** `what` for a change GitHub made: its sides told apart by the base, or not (two-way). */
function editedLine(stem: keyof typeof EDITED, both: boolean, twoWay: boolean): string {
  return EDITED[stem][twoWay ? "differs" : both ? "both" : "github"];
}

function objectItems(diff: FullSyncDiff, twoWay: boolean): SyncItem[] {
  const changed = diff.objects.changedObjects.map((o): SyncItem => {
    const both = o.conflictFields.length > 0;
    return {
      key: `object:changed:${o.object_id}`, kind: "object", name: o.object_id,
      what: { key: editedLine("fields", both, twoWay) },
      fields: o.changedFields.map((f) => `objects:sync_field.${f}`),
      details: [], both,
      options: [both ? TAKE_BOTH : TAKE, KEEP],
      defaultChoice: defaultOf(both, twoWay),
      ...choiceIn("objectChoices", o.object_id),
    };
  });
  const added = diff.objects.newObjects.map((o): SyncItem => newItem("object", o.object_id, o.object_id, Boolean(o.deletedInCompositor), twoWay, "objectRestore"));
  const missing = diff.objects.missingObjects.map((o): SyncItem => {
    const both = Boolean(o.editedInCompositor);
    return {
      key: `object:missing:${o.object_id}`, kind: "object", name: o.object_id,
      what: { key: both ? "sync_modal.review.deleted_both" : twoWay ? "sync_modal.review.missing_differs" : "sync_modal.review.deleted_github" },
      details: [], both,
      options: both ? [DELETE_BOTH, KEEP_EDITED] : [DELETE, KEEP_PRESENT],
      defaultChoice: defaultOf(both, twoWay),
      ...takenIn("objectDelete", o.object_id),
    };
  });
  return [...changed, ...added, ...missing];
}

/**
 * An image file in the objects folder with no object, which the review's base
 * did not hold: added as an object under the file's stem by default, or left
 * out, which leaves the file on GitHub and is not offered again.
 */
function imageItems(diff: FullSyncDiff): SyncItem[] {
  return diff.objects.unregisteredFiles.map((f): SyncItem => ({
    key: `image:${f.filename}`, kind: "image", name: f.filename,
    what: { key: "sync_modal.review.img_what" },
    details: [], both: false,
    options: [
      { choice: "repo", label: "sync_modal.review.img_add", note: "sync_modal.review.img_add_note", noteValues: { id: f.object_id }, does: "add" },
      { choice: "d1", label: "sync_modal.review.img_skip", note: "sync_modal.review.img_skip_note", does: "skip" },
    ],
    defaultChoice: "repo",
    ...takenIn("imageAdd", f.filename),
  }));
}

/** A row GitHub has and the Compositor does not: added there, or deleted here and edited there. */
function newItem(kind: ItemKind, id: string, name: string, deletedHere: boolean, twoWay: boolean, map: TakenMap): SyncItem {
  return {
    key: `${kind}:new:${id}`, kind, name,
    what: { key: deletedHere ? "sync_modal.review.deleted_here" : twoWay ? "sync_modal.review.added_differs" : "sync_modal.review.added_github" },
    details: [], both: deletedHere,
    options: deletedHere ? [RESTORE, STAY_DELETED] : [ADD, SKIP],
    defaultChoice: defaultOf(deletedHere, twoWay),
    ...takenIn(map, id),
  };
}

/**
 * A story or term the Compositor has and GitHub's sheet does not: deleted
 * there, and maybe edited here. `edited` reads a story's row only, not its
 * steps or layers, so a story deleted on GitHub is never deleted here by
 * default: the author chooses.
 */
function removedItem(kind: ItemKind, id: string, name: string, edited: boolean, twoWay: boolean, map: TakenMap): SyncItem {
  const both = edited && !twoWay;
  return {
    key: `${kind}:missing:${id}`, kind, name,
    what: { key: both ? "sync_modal.review.deleted_both" : twoWay ? "sync_modal.review.missing_differs" : "sync_modal.review.deleted_github" },
    details: [], both,
    options: both ? [DELETE_BOTH, KEEP_EDITED] : [DELETE, KEEP_PRESENT],
    defaultChoice: kind === "story" ? null : defaultOf(both, twoWay),
    ...takenIn(map, id),
  };
}

/** A term whose id publishes none that glossary.csv holds unchanged: every apply removes it (`removeHeld`). */
function heldTermItem(id: string, name: string): SyncItem {
  return {
    key: `term:missing:${id}`, kind: "term", name,
    what: { key: "sync_modal.review.held_term" },
    details: [], both: false,
    options: [DELETE], defaultChoice: "repo",
    ...FIXED,
  };
}

function storyContentItem(change: StoryContentChange, row: FullSyncDiff["stories"]["changedStories"][number] | undefined, twoWay: boolean): SyncItem {
  const name = change.title || row?.title || change.story_id;
  const base = { key: `story:${change.story_id}`, kind: "story" as const, name, ...choiceIn("storyContentChoices", change.story_id) };
  const rowLine: Line[] = row ? [{ key: "sync_modal.review.story_details_too" }] : [];
  if (!contentTakeable(change)) {
    return {
      ...base,
      what: { key: change.kind === "unreadable" ? "sync_modal.content_unreadable" : editedLine("text", true, twoWay) },
      ...(change.reason ? { reason: change.reason } : {}),
      details: rowLine, both: change.kind === "conflict",
      options: [KEEP_TEXT], defaultChoice: "d1",
    };
  }
  if (change.kind === "steps-deleted") {
    return {
      ...base, what: { key: "sync_modal.content_steps_deleted" }, details: rowLine, both: false,
      options: [TAKE, KEEP], defaultChoice: defaultOf(false, twoWay),
    };
  }
  const both = change.kind === "conflict" || Boolean(row?.conflict);
  const { d1Steps, headSteps, changedSteps } = change.summary;
  const summary: Line[] = d1Steps !== null && headSteps !== null
    ? [{ key: "sync_modal.content_summary", values: { d1: d1Steps, head: headSteps, count: changedSteps } }]
    : [];
  return {
    ...base, what: { key: editedLine("text", both, twoWay) }, details: [...summary, ...rowLine], both,
    options: [both ? TAKE_TEXT_BOTH : TAKE_TEXT, KEEP_TEXT], defaultChoice: defaultOf(both, twoWay),
  };
}

function storyItems(diff: FullSyncDiff, twoWay: boolean): SyncItem[] {
  const content = listedContentChanges(diff);
  const onContent = new Set(content.map((c) => c.story_id));
  const rows = diff.stories.changedStories;
  return [
    ...content.map((c) => storyContentItem(c, rows.find((r) => r.story_id === c.story_id), twoWay)),
    ...rows.filter((r) => !onContent.has(r.story_id)).map((r): SyncItem => ({
      key: `story:${r.story_id}`, kind: "story", name: r.title || r.story_id,
      what: { key: editedLine("details", r.conflict, twoWay) }, details: [], both: r.conflict,
      options: [r.conflict ? TAKE_BOTH : TAKE, KEEP], defaultChoice: defaultOf(r.conflict, twoWay),
      ...choiceIn("storyChoices", r.story_id),
    })),
    ...diff.stories.newStories.map((s) => newItem("story", s.story_id, s.title || s.story_id, Boolean(s.deletedInCompositor), twoWay, "storyRestore")),
    ...diff.stories.missingStories.map((s) => removedItem("story", s.story_id, s.title || s.story_id, Boolean(s.editedInCompositor), twoWay, "storyDelete")),
  ];
}

function settingItems(diff: FullSyncDiff, twoWay: boolean): SyncItem[] {
  return diff.config.changedFields.map((c): SyncItem => ({
    key: `setting:${c.key}`, kind: "setting", name: c.key,
    what: { key: editedLine("setting", c.conflict, twoWay) },
    details: [{ key: "sync_modal.review.setting_values", values: { repo: c.repoValue || "—", mine: c.d1Value || "—" } }],
    both: c.conflict,
    options: [c.conflict ? TAKE_BOTH : TAKE, KEEP], defaultChoice: defaultOf(c.conflict, twoWay),
    ...choiceIn("configChoices", c.key),
  }));
}

function termItems(diff: FullSyncDiff, twoWay: boolean): SyncItem[] {
  return [
    ...diff.glossary.changed.map((tm): SyncItem => ({
      key: `term:changed:${tm.term_id}`, kind: "term", name: tm.d1Title || tm.repoTitle || tm.term_id,
      what: { key: editedLine("details", tm.conflict, twoWay) }, details: [], both: tm.conflict,
      options: [tm.conflict ? TAKE_BOTH : TAKE, KEEP], defaultChoice: defaultOf(tm.conflict, twoWay),
      ...choiceIn("glossaryChangedChoices", tm.term_id),
    })),
    ...diff.glossary.added.map((tm) => newItem("term", tm.term_id, tm.title || tm.term_id, Boolean(tm.deletedInCompositor), twoWay, "glossaryRestore")),
    ...diff.glossary.removed.map((tm) => (tm.held
      ? heldTermItem(tm.term_id, tm.title || tm.term_id)
      : removedItem("term", tm.term_id, tm.title || tm.term_id, Boolean(tm.editedInCompositor), twoWay, "glossaryDelete"))),
  ];
}

function pageContentItem(change: PageContentChange, twoWay: boolean): SyncItem {
  const both = change.kind === "conflict";
  const what: Line = both
    ? { key: change.addedBoth ? "sync_modal.page_added_both" : editedLine("text", true, twoWay) }
    : { key: editedLine("text", false, twoWay) };
  return {
    key: `page:content:${change.pageId}`, kind: "page", name: change.title || change.slug,
    what, details: [], both,
    options: [both ? TAKE_TEXT_BOTH : TAKE_TEXT, KEEP_TEXT], defaultChoice: defaultOf(both, twoWay),
    ...choiceIn("pageContentChoices", String(change.pageId)),
  };
}

/** Each page file kind: its `what` line, whether both sides changed it, and its two versions. */
const PAGE_FILE: Record<PageFileChange["kind"], { what: string; both: boolean; options: [ItemOption, ItemOption] }> = {
  "deleted": { what: "sync_modal.page_deleted", both: false, options: [DELETE, KEEP_PRESENT] },
  "deleted-conflict": { what: "sync_modal.page_deleted_conflict", both: true, options: [DELETE_BOTH, KEEP_EDITED] },
  "deleted-renamed-here": { what: "sync_modal.page_deleted_renamed_here", both: true, options: [DELETE_BOTH, KEEP_EDITED] },
  "not-on-github": {
    what: "sync_modal.page_not_on_github", both: false,
    options: [DELETE, { ...KEEP_PRESENT, note: "sync_modal.review.note_publish_adds", publish: "add" }],
  },
  "edited-renamed-here": { what: "sync_modal.page_edited_renamed_here", both: true, options: [TAKE_TEXT_BOTH, KEEP_TEXT] },
  "deleted-here-edited": { what: "sync_modal.review.deleted_here", both: true, options: [RESTORE, STAY_DELETED] },
};

function pageFileItem(change: PageFileChange, twoWay: boolean): SyncItem {
  const kind = PAGE_FILE[change.kind];
  return {
    key: `page:file:${change.name}`, kind: "page", name: change.title || change.slug,
    what: { key: kind.what },
    details: change.inMenu ? [{ key: "sync_modal.page_deleted_menu" }] : [],
    both: kind.both,
    options: kind.options,
    // A no-base file (`not-on-github`) cannot tell which side changed it.
    defaultChoice: change.kind === "not-on-github" ? null : defaultOf(kind.both, twoWay),
    ...choiceIn("pageFileChoices", change.name),
  };
}

// ---------------------------------------------------------------------------
// Files the Compositor could not read
// ---------------------------------------------------------------------------

/** What the site does with a story's unreadable file, the worst first. */
const BAD_WHAT: Array<[UnreadableEffect, string]> = [
  ["build_stops", "sync_modal.review.bad_what_build_stops"],
  ["left_out", "sync_modal.review.bad_what"],
  ["name_shown", "sync_modal.review.bad_what_name_shown"],
];

/** The non-notice unreadable files of each story, in the order the check names them. */
function unreadableByStory(diff: FullSyncDiff): Map<string, Array<{ file: string; effect: UnreadableEffect }>> {
  const byStory = new Map<string, Array<{ file: string; effect: UnreadableEffect }>>();
  for (const entry of diff.unreadable ?? []) {
    if (entry.notice) continue;
    for (const id of entry.storyIds ?? []) byStory.set(id, [...(byStory.get(id) ?? []), { file: entry.file, effect: entry.effect }]);
  }
  return byStory;
}

/** The choice an unreadable file's item stands for: the story's content, row or restore, as the diff lists it; null for none. */
function storyChoiceFor(diff: FullSyncDiff, id: string): { key: string; isNew: boolean; wiring: Pick<SyncItem, "read" | "write"> } | null {
  const change = listedContentChanges(diff).find((c) => c.story_id === id);
  if (change) return contentTakeable(change) ? { key: `story:${id}`, isNew: false, wiring: choiceIn("storyContentChoices", id) } : null;
  if (diff.stories.changedStories.some((r) => r.story_id === id)) return { key: `story:${id}`, isNew: false, wiring: choiceIn("storyChoices", id) };
  if (diff.stories.newStories.some((s) => s.story_id === id)) return { key: `story:new:${id}`, isNew: true, wiring: takenIn("storyRestore", id) };
  // Deleted on GitHub, or no change listed: GitHub's version is nothing the
  // apply could take, so the file is a notice and the next publish repairs it.
  return null;
}

/** The story's name as the diff gives it, else its id. */
function storyNameInDiff(diff: FullSyncDiff, id: string): string {
  const content = diff.stories.content?.conclusive ? diff.stories.content.changes.find((c) => c.story_id === id)?.title : undefined;
  return content
    || diff.stories.changedStories.find((r) => r.story_id === id)?.title
    || diff.stories.newStories.find((s) => s.story_id === id)?.title
    || id;
}

/**
 * The items for the stories whose files GitHub holds with characters that
 * cannot be read, each in place of that story's own item (`replaced`), and
 * the files left as notices: of no story, or of a story with no change that
 * takes GitHub's version.
 */
function unreadableStoryItems(diff: FullSyncDiff, listed: readonly SyncItem[]): { items: SyncItem[]; replaced: Set<string>; leftOver: string[] } {
  const items: SyncItem[] = [];
  const replaced = new Set<string>();
  const covered = new Set<string>();
  for (const [id, files] of unreadableByStory(diff)) {
    const choice = storyChoiceFor(diff, id);
    if (!choice) continue;
    for (const f of files) covered.add(f.file);
    const own = listed.find((item) => item.key === choice.key);
    if (own) replaced.add(own.key);
    const names = files.map((f) => f.file).join(", ");
    items.push({
      key: choice.key, kind: "story", name: names, title: `${storyNameInDiff(diff, id)}: ${names}`,
      what: { key: BAD_WHAT.find(([effect]) => files.some((f) => f.effect === effect))?.[1] ?? "sync_modal.review.bad_what" },
      details: own ? [own.what, ...own.details] : [],
      both: false,
      options: choice.isNew ? [BAD_ADD, BAD_SKIP] : [BAD_TAKE, BAD_KEEP],
      defaultChoice: null,
      ...choice.wiring,
    });
  }
  const leftOver = (diff.unreadable ?? []).filter((e) => !e.notice && !covered.has(e.file)).map((e) => e.file);
  return { items, replaced, leftOver };
}

/** What a structural cause says, by what the reading met: a folder that is not one, or a listing cut short. */
function nocheckWhat(check: "stories" | "pages", reason: string, oneStory: boolean): string {
  const link = /is not a tree/.test(reason);
  if (check === "pages") return link ? "sync_modal.review.nocheck_pages_link" : "sync_modal.review.nocheck_pages_truncated";
  if (oneStory) return "sync_modal.review.nocheck_what";
  return link ? "sync_modal.review.nocheck_stories_link" : "sync_modal.review.nocheck_truncated";
}

/**
 * The items for a file check that did not conclude for a structural cause:
 * one per story or page it names, else one for all of them, each offering
 * only the Compositor's version, with none chosen. Every item of one check
 * holds the check's one choice (`keepUnread`).
 */
function nocheckItems(diff: FullSyncDiff): SyncItem[] {
  return unreadChecks(diff).filter((c) => c.cause === "structure").flatMap((c) => {
    const kind: ItemKind = c.check === "stories" ? "story" : "page";
    const keep: ItemOption = {
      choice: "d1", label: "sync_modal.review.keep_compositor", does: "keep", publish: "overwrite",
      note: c.check === "stories"
        ? (c.ids ? "sync_modal.review.nocheck_keep_note" : "sync_modal.review.nocheck_keep_note_all")
        : "sync_modal.review.nocheck_pages_keep_note",
    };
    const item = (id: string, named: Pick<Named, "name" | "nameKey">): SyncItem => ({
      key: `${kind}:nocheck:${id}`, kind, ...named,
      what: { key: nocheckWhat(c.check, c.reason, c.ids !== undefined) },
      details: [], both: false,
      options: [keep], defaultChoice: null,
      ...choiceIn("keepUnread", c.check),
    });
    if (!c.ids) {
      const [nameKey, titleKey] = c.check === "stories"
        ? ["sync_modal.review.nocheck_all_stories", "sync_modal.review.nocheck_all_stories_title"]
        : ["sync_modal.review.nocheck_all_pages", "sync_modal.review.nocheck_all_pages_title"];
      return [{ ...item("all", { name: "", nameKey }), titleKey }];
    }
    return c.ids.map((id) => item(String(id), { name: c.check === "stories" ? storyNameInDiff(diff, String(id)) : String(id) }));
  });
}

/** Whether nothing tells which side made a change: a two-way diff, or one whose base GitHub no longer holds. */
function noBaseOf(diff: FullSyncDiff): boolean {
  return diff.classification === "two-way" || baseUnresolvedOf(diff);
}

/** Every change the review lists, in the dialog's order. */
export function syncItemsOf(diff: FullSyncDiff): SyncItem[] {
  const twoWay = noBaseOf(diff);
  const listed = [
    ...objectItems(diff, twoWay),
    ...imageItems(diff),
    ...storyItems(diff, twoWay),
    ...settingItems(diff, twoWay),
    ...termItems(diff, twoWay),
    ...listedPageChanges(diff).map((c) => pageContentItem(c, twoWay)),
    ...listedPageFiles(diff).map((c) => pageFileItem(c, twoWay)),
  ];
  const unreadable = unreadableStoryItems(diff, listed);
  const nocheck = nocheckItems(diff);
  const of = (kind: ItemKind) => (item: SyncItem) => item.kind === kind;
  return [
    ...listed.filter(of("object")),
    ...listed.filter(of("image")),
    ...unreadable.items,
    ...nocheck.filter(of("story")),
    ...listed.filter((item) => item.kind === "story" && !unreadable.replaced.has(item.key)),
    ...listed.filter((item) => item.kind !== "object" && item.kind !== "image" && item.kind !== "story"),
    ...nocheck.filter(of("page")),
  ];
}

// ---------------------------------------------------------------------------
// Notices: applied with every accept, with no choice
// ---------------------------------------------------------------------------

export interface SyncNotices {
  /** GitHub reordered the objects both sides hold. */
  objectOrder: boolean;
  /** The Telar version the Compositor follows, when GitHub's differs from it. */
  version: string | null;
  /** Pages GitHub added, which every accept takes; `menu` when GitHub's menu gives one an entry. */
  addedPages: Array<Named & { menu: boolean }>;
  /**
   * Files GitHub holds with characters that cannot be read and that no item
   * offers a choice on: the site does not use them, takes them from Google
   * Sheets, or they belong to no story the review lists. Each with what the
   * site does with it.
   */
  unreadableFiles: Array<{ file: string; effect: UnreadableEffect }>;
}

export function syncNoticesOf(diff: FullSyncDiff): SyncNotices {
  const { leftOver } = unreadableStoryItems(diff, []);
  return {
    objectOrder: diff.objects.reordered != null,
    version: diff.config.versionChange?.repoVersion ?? null,
    addedPages: listedPageAdditions(diff).map((a) => ({ kind: "page", name: a.title || a.slug, menu: Boolean(a.menu) })),
    unreadableFiles: (diff.unreadable ?? [])
      .filter((e) => e.notice || leftOver.includes(e.file))
      .map(({ file, effect }) => ({ file, effect })),
  };
}

/** Notices with nothing in them. */
export const NO_NOTICES: SyncNotices = { objectOrder: false, version: null, addedPages: [], unreadableFiles: [] };

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

/** The item's choice: the author's when it is one the item offers, else its default. */
export function choiceOfItem(item: SyncItem, sel: ThreeWaySelections): ConflictChoice | null {
  const chosen = item.read(sel);
  if (chosen !== undefined && item.options.some((o) => o.choice === chosen)) return chosen;
  return item.defaultChoice;
}

/** The items with no choice yet: Apply waits for them. */
export function undecidedItems(items: readonly SyncItem[], sel: ThreeWaySelections): SyncItem[] {
  return items.filter((item) => choiceOfItem(item, sel) === null);
}

/** "Set all to": `choice` on every item that offers it; an item that does not keeps its own. */
export function setAllTo(items: readonly SyncItem[], sel: ThreeWaySelections, choice: ConflictChoice): ThreeWaySelections {
  return items.reduce((acc, item) => (item.options.some((o) => o.choice === choice) ? item.write(acc, choice) : acc), sel);
}

/**
 * The selections with every item's choice written out, so the builder's
 * fallback is never what decides; null while an item has none.
 */
export function choicesForApply(items: readonly SyncItem[], sel: ThreeWaySelections): ThreeWaySelections | null {
  let explicit = sel;
  for (const item of items) {
    const choice = choiceOfItem(item, sel);
    if (choice === null) return null;
    explicit = item.write(explicit, choice);
  }
  return explicit;
}

/** What Apply submits for the choices; null while an item has none. */
export function changesForApply(diff: FullSyncDiff, sel: ThreeWaySelections): FullSyncChanges | null {
  const explicit = choicesForApply(syncItemsOf(diff), sel);
  if (!explicit) return null;
  return diff.classification === "three-way" ? buildThreeWayChanges(diff, explicit) : buildAllOrNothingChanges(diff, explicit);
}

// ---------------------------------------------------------------------------
// "When you apply"
// ---------------------------------------------------------------------------

export type SummaryAction = CompositorAction | "order" | "version";

export interface SummaryGroup<A> {
  action: A;
  names: Named[];
}

export type ApplySummary =
  | { kind: "pending"; count: number; allBoth: boolean; allStories: boolean }
  | {
      kind: "ready";
      compositor: Array<SummaryGroup<SummaryAction>>;
      publish: Array<SummaryGroup<PublishAction>>;
      version: string | null;
    };

/** Appends `named` to the group for `action`, opening it where it first occurs. */
function addTo<A>(groups: Array<SummaryGroup<A>>, action: A, named: Named): void {
  const group = groups.find((g) => g.action === action);
  if (group) group.names.push(named);
  else groups.push({ action, names: [named] });
}

/**
 * What applying the choices does, by action, in the order the items are
 * listed: in the Compositor, then on GitHub at the next publish. The notices
 * close the Compositor's part, since every accept applies them. Pending
 * while an item has no choice.
 */
export function applySummaryOf(items: readonly SyncItem[], notices: SyncNotices, sel: ThreeWaySelections): ApplySummary {
  const undecided = undecidedItems(items, sel);
  if (undecided.length > 0) {
    return {
      kind: "pending", count: undecided.length,
      allBoth: undecided.every((item) => item.both), allStories: undecided.every((item) => item.kind === "story"),
    };
  }
  const compositor: Array<SummaryGroup<SummaryAction>> = [];
  const publish: Array<SummaryGroup<PublishAction>> = [];
  for (const item of items) {
    const option = item.options.find((o) => o.choice === choiceOfItem(item, sel))!;
    addTo(compositor, option.does, item);
    if (option.publish) addTo(publish, option.publish, item);
  }
  for (const { kind, name } of notices.addedPages) addTo(compositor, "add", { kind, name });
  if (notices.objectOrder) compositor.push({ action: "order", names: [] });
  if (notices.version) compositor.push({ action: "version", names: [] });
  return { kind: "ready", compositor, publish, version: notices.version };
}
