/**
 * What the sync dialog sends for the author's choices: the three-way
 * selections, the two payload builders (`buildAllOrNothingChanges` for a
 * two-way diff, `buildThreeWayChanges` for a three-way one), and the story
 * and page content choices both fold in; and what the dialog shows of the
 * story and page checks. Pure; the modal (SyncConfirmModal) renders the
 * choices and submits what these build.
 *
 * @version v1.5.0-beta
 */

import type { ChangedObject, FullSyncDiff, FullSyncChanges, SyncField } from "~/lib/sync.server";
import type { StoryContentChange } from "~/lib/story-content.server";
import type { PageAddition, PageContentChange, PageFileChange } from "~/lib/page-content.server";

/** A per-conflict choice: keep GitHub's value ("repo") or the editor's ("d1"). */
export type ConflictChoice = "repo" | "d1";

/**
 * The user's conflict resolutions, gathered by the three-way diffReady step.
 * Every record defaults to keep-mine when a key is absent, so an untouched
 * modal applies exactly the "Keep my version" product ruling, except where the
 * diff marks GitHub's value the default (`objectFieldChoiceOf`, `rowChoiceOf`).
 */
export interface ThreeWaySelections {
  /** objectId -> field -> choice (only conflict fields are tracked). */
  objectFieldChoices: Record<string, Record<string, ConflictChoice>>;
  /** deleted-here objectId -> true when the user chose Restore. */
  objectRestore: Record<string, boolean>;
  /** deleted-in-repo/edited-here objectId -> true when the user chose Delete. */
  objectDelete: Record<string, boolean>;
  /** conflict story_id -> choice. */
  storyChoices: Record<string, ConflictChoice>;
  /** deleted-here (repo edited, editor deleted) story_id -> true on Restore. */
  storyRestore: Record<string, boolean>;
  /** conflict config key -> choice. */
  configChoices: Record<string, ConflictChoice>;
  /** conflict changed term_id -> choice. */
  glossaryChangedChoices: Record<string, ConflictChoice>;
  /** deleted-here term_id -> true when the user chose Restore. */
  glossaryRestore: Record<string, boolean>;
  /**
   * story_id -> the story's one choice when its content changed: "repo" takes
   * GitHub's content and row fields, "d1" keeps the Compositor's. Absent, the
   * change's own default (`contentChoiceOf`).
   */
  storyContentChoices: Record<string, ConflictChoice>;
  /**
   * String(page id) -> the page's choice when its file changed: "repo" takes
   * GitHub's version, "d1" keeps the Compositor's. Absent, the change's own
   * default (`pageChoiceOf`).
   */
  pageContentChoices: Record<string, ConflictChoice>;
  /**
   * File name -> the choice on a page file present on one side only: "repo"
   * follows GitHub, "d1" keeps the Compositor's pages. Absent, the change's
   * own default (`pageFileChoiceOf`).
   */
  pageFileChoices?: Record<string, ConflictChoice>;
}

export function emptySelections(): ThreeWaySelections {
  return {
    objectFieldChoices: {},
    objectRestore: {},
    objectDelete: {},
    storyChoices: {},
    storyRestore: {},
    configChoices: {},
    glossaryChangedChoices: {},
    glossaryRestore: {},
    storyContentChoices: {},
    pageContentChoices: {},
    pageFileChoices: {},
  };
}

/**
 * An object conflict field's choice: the author's, else GitHub's for a field
 * the base could not place (`repoDefaultFields`), else keep-mine.
 */
export function objectFieldChoiceOf(o: ChangedObject, field: SyncField, sel: ThreeWaySelections): ConflictChoice {
  return ownValue(sel.objectFieldChoices, o.object_id)?.[field] ?? threeWayFieldDefault(o, field);
}

/**
 * The default for a changed object field of a three-way check, which both
 * sync dialogs apply: GitHub's value for a field only GitHub moved, and for a
 * conflict the base could not place (`repoDefaultFields`); the editor's for
 * any other conflict.
 */
export function threeWayFieldDefault(
  o: Pick<ChangedObject, "conflictFields" | "repoDefaultFields">,
  field: SyncField,
): ConflictChoice {
  if (!o.conflictFields.includes(field)) return "repo";
  return o.repoDefaultFields?.includes(field) ? "repo" : "d1";
}

/**
 * A story, config or glossary row conflict's choice: the author's, else
 * GitHub's for a row the diff defaults to it (`repoByDefault`), else keep-mine.
 */
export function rowChoiceOf(map: Record<string, ConflictChoice>, id: string, repoByDefault?: boolean): ConflictChoice {
  return ownValue(map, id) ?? (repoByDefault ? "repo" : "d1");
}

/**
 * `record[key]` when the record holds it as its own property. A story, object
 * or term id is any string its domain allows, "constructor" and "__proto__"
 * included, so a plain object's inherited properties must never read as a
 * choice.
 */
export function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// ---------------------------------------------------------------------------
// Story content changes
// ---------------------------------------------------------------------------

/**
 * The content changes the dialog lists on the story content cards: every kind
 * but "restore-choice", which the restore / keep-deleted card carries as the
 * story's one choice (the check lists that story among the new stories).
 */
export function listedContentChanges(diff: FullSyncDiff): StoryContentChange[] {
  const content = diff.stories.content;
  if (!content?.conclusive) return [];
  return content.changes.filter((c) => c.kind !== "restore-choice");
}

/** True when the check could not read the story files, so it lists no story. */
export function contentInconclusive(diff: FullSyncDiff): boolean {
  return diff.stories.content !== undefined && !diff.stories.content.conclusive;
}

/**
 * Whether GitHub's version of the story can be taken: not for a story Telar
 * cannot read, and not without the hash of the version the author reviewed,
 * which the accept needs to refuse a story edited since.
 */
function contentTakeable(change: StoryContentChange): boolean {
  return change.kind !== "unreadable" && change.expected !== null;
}

/** The story's one choice: the author's, else the change's default. */
export function contentChoiceOf(change: StoryContentChange, sel: ThreeWaySelections): ConflictChoice {
  if (!contentTakeable(change)) return "d1";
  return ownValue(sel.storyContentChoices, change.story_id) ?? (change.acceptByDefault ? "repo" : "d1");
}

/**
 * Folds the story content choices into a payload's stories: each listed
 * story's one choice decides its content and, when its row changed too, its
 * row, whatever the row alone would have defaulted to: a row's own
 * `repoByDefault` gives way to the content card's choice, and the card's own
 * default already gives way to a row that defaults to the author
 * (`withRowDefaults`, sync.server.ts). Adds the check's HEAD,
 * which the accept reads at and records, and `storyContentChecked` when that
 * check read the story files to a conclusion, without which the accept keeps
 * head_sha. `contentExpected` is built from entries, so every story id, a
 * `__proto__` included, is an own property of it.
 */
function withStoryContent(diff: FullSyncDiff, sel: ThreeWaySelections, changes: FullSyncChanges): FullSyncChanges {
  const acceptContent: string[] = [];
  const expectedEntries: Array<[string, string]> = [];
  const listed = listedContentChanges(diff);
  const listedIds = new Set(listed.map((c) => c.story_id));
  const accept = changes.stories.accept.filter((id) => !listedIds.has(id));
  const reject = changes.stories.reject.filter((id) => !listedIds.has(id));
  const rows = diff.stories.changedStories;
  const fieldChoices = { ...changes.stories.fieldChoices };
  for (const change of listed) {
    const take = contentChoiceOf(change, sel) === "repo";
    if (take) {
      acceptContent.push(change.story_id);
      expectedEntries.push([change.story_id, change.expected!]);
    }
    const row = rows.find((s) => s.story_id === change.story_id);
    if (!row) continue;
    (take ? accept : reject).push(change.story_id);
    Object.defineProperty(fieldChoices, change.story_id, {
      value: Object.fromEntries(row.changedFields.map((f) => [f, take ? "repo" : "d1"])),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return {
    ...changes,
    stories: {
      ...changes.stories, accept, reject, fieldChoices, acceptContent, contentExpected: Object.fromEntries(expectedEntries),
    },
    ...(diff.headSha ? { headSha: diff.headSha } : {}),
    // The check's identity: the apply is refused unless it still holds.
    ...(diff.projectId !== undefined ? { projectId: diff.projectId } : {}),
    ...(diff.baseSha !== undefined ? { baseSha: diff.baseSha } : {}),
    ...(diff.stories.content?.conclusive === true ? { storyContentChecked: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Page changes
// ---------------------------------------------------------------------------

/** The pages whose file changed on GitHub, as the dialog lists them. */
export function listedPageChanges(diff: FullSyncDiff): PageContentChange[] {
  return diff.pages?.conclusive ? diff.pages.changes : [];
}

/** True when the check could not read the page files, so it lists no page. */
export function pagesInconclusive(diff: FullSyncDiff): boolean {
  return diff.pages !== undefined && !diff.pages.conclusive;
}

/** The page's choice: the author's, else the change's default. */
export function pageChoiceOf(change: PageContentChange, sel: ThreeWaySelections): ConflictChoice {
  return ownValue(sel.pageContentChoices, String(change.pageId)) ?? (change.acceptByDefault ? "repo" : "d1");
}

/** The page files on one side only, as the dialog lists them. */
export function listedPageFiles(diff: FullSyncDiff): PageFileChange[] {
  return diff.pages?.conclusive ? diff.pages.files ?? [] : [];
}

/** The pages GitHub added, listed as pre-accepted. */
export function listedPageAdditions(diff: FullSyncDiff): PageAddition[] {
  return diff.pages?.conclusive ? diff.pages.additions ?? [] : [];
}

/** A page file's choice: the author's, else the change's default. */
export function pageFileChoiceOf(change: PageFileChange, sel: ThreeWaySelections): ConflictChoice {
  return ownValue(sel.pageFileChoices ?? {}, change.name) ?? (change.acceptByDefault ? "repo" : "d1");
}

/**
 * Folds the page choices into a payload: each listed page whose choice is
 * GitHub's version is accepted with the slug of the file the check read and
 * the `expected` hash it recorded, as is GitHub's file of a page renamed here
 * (`edited-renamed-here`); each other page file whose choice is GitHub's is
 * named in `takeFiles` with the hashes reviewed. `pageContentChecked` is set
 * when that check read the page files to a conclusion, without which the
 * accept keeps head_sha.
 */
function withPageContent(diff: FullSyncDiff, sel: ThreeWaySelections, changes: FullSyncChanges): FullSyncChanges {
  const taken = listedPageFiles(diff).filter((change) => pageFileChoiceOf(change, sel) === "repo");
  const renamedHere = taken.filter((change) => change.kind === "edited-renamed-here");
  const acceptContent = [
    ...listedPageChanges(diff).filter((change) => pageChoiceOf(change, sel) === "repo"),
    ...renamedHere.map((change) => ({ ...change, slug: change.name.slice(0, -".md".length) })),
  ].map(({ pageId, slug, expected }) => ({ pageId, slug, expected }));
  const takeFiles = taken.filter((change) => change.kind !== "edited-renamed-here").map((change) => ({
    name: change.name, pageId: change.pageId, expected: change.expected,
  }));
  return {
    ...changes,
    pages: { acceptContent, takeFiles, addFiles: listedPageAdditions(diff).map((a) => a.name) },
    ...(diff.pages?.conclusive === true ? { pageContentChecked: true } : {}),
  };
}

/**
 * What Keep my version posts for `diff`: the diff's own identity, so the
 * choice is bound to the diff the author reviewed and not to anything read
 * when they click. The project, the base it was computed against ("" for
 * none) and its HEAD; a field the diff lacks is left out, and the action
 * answers that as stale.
 */
export function keepMineFields(diff: FullSyncDiff): Record<string, string> {
  return {
    intent: "accept-divergence",
    ...(diff.projectId !== undefined ? { projectId: String(diff.projectId) } : {}),
    ...(diff.baseSha !== undefined ? { baseSha: diff.baseSha ?? "" } : {}),
    ...(diff.headSha ? { headSha: diff.headSha } : {}),
  };
}

export function hasDiffChanges(diff: FullSyncDiff): boolean {
  const lists = [
    listedContentChanges(diff),
    listedPageChanges(diff),
    listedPageFiles(diff),
    listedPageAdditions(diff),
    diff.objects.newObjects,
    diff.objects.changedObjects,
    diff.objects.missingObjects,
    diff.stories.newStories,
    diff.stories.changedStories,
    diff.stories.missingStories,
    diff.config.changedFields,
    diff.glossary.added,
    diff.glossary.changed,
    diff.glossary.removed,
  ];
  const unread = [contentInconclusive(diff), pagesInconclusive(diff)];
  return unread.includes(true) || diff.objects.reordered != null || lists.some((list) => list.length > 0);
}

// ---------------------------------------------------------------------------
// Helper: build all-or-nothing FullSyncChanges from a FullSyncDiff (two-way)
// ---------------------------------------------------------------------------

/** The names of objects `ids` as the check showed them, quoted; the id for one it did not list. */
function shownObjectNames(diff: FullSyncDiff | null | undefined, ids: readonly string[] | undefined): string[] {
  const shown = diff?.objects.changedObjects ?? [];
  return (ids ?? []).map((id) => `“${shown.find((o) => o.object_id === id)?.title || id}”`);
}

/**
 * What an accept refused for stories (`storyNames`, as the dialog showed
 * them) or objects edited while they were reviewed left, for the dialog's
 * notice.
 */
export function changedWhileReviewedOf(
  refusal: { error?: string; objectIds?: string[] },
  storyNames: string[],
  diff: FullSyncDiff | null | undefined,
): { entity: "story" | "object"; names: string[] } {
  if (refusal.error === "story_changed_since_review") return { entity: "story", names: storyNames };
  return { entity: "object", names: shownObjectNames(diff, refusal.objectIds) };
}

/**
 * The Compositor's value of each field taken from GitHub, as the check showed
 * it (`ChangedObject.d1Values`), by object_id: the collaboration object leaves
 * a field whose value has changed since. Built from entries, so every object
 * id, a `__proto__` included, is an own property of it.
 */
export function fieldsSeenFor(
  shown: readonly ChangedObject[],
  fieldChoices: Record<string, Record<string, ConflictChoice>>,
): Record<string, Record<string, string | boolean | null>> {
  return Object.fromEntries(
    shown.flatMap((o) => {
      const choices = ownValue(fieldChoices, o.object_id);
      if (!choices) return [];
      const taken = o.changedFields.filter((f) => ownValue(choices, f) === "repo");
      return taken.length > 0 ? [[o.object_id, Object.fromEntries(taken.map((f) => [f, o.d1Values[f] ?? null]))]] : [];
    }),
  );
}

/**
 * The D1 id each changed or removed object was shown with, by object_id, so
 * the apply updates or removes that row and no other under its key.
 */
function docIdsOf(shown: Array<{ object_id: string; dbId: number }>): Record<string, number> {
  return Object.fromEntries(shown.map((o) => [o.object_id, o.dbId]));
}

/**
 * The per-field choices of changed stories or terms, by id: GitHub's value
 * for a field only GitHub moved, the row's one choice for a conflicting
 * field, as for an object's fields (`buildThreeWayChanges`). Built from
 * entries, so every id, a `__proto__` included, is an own property of it.
 */
function rowFieldChoices(
  rows: Array<[string, { changedFields: readonly string[]; conflictFields: readonly string[] }, ConflictChoice]>,
): Record<string, Record<string, ConflictChoice>> {
  return Object.fromEntries(
    rows.map(([id, row, choice]) => [
      id,
      Object.fromEntries(row.changedFields.map((f) => [f, row.conflictFields.includes(f) ? choice : "repo"])),
    ]),
  );
}

/** The ids with a field taken from GitHub (accepted), and the rest (rejected). */
function splitByRepoField(fieldChoices: Record<string, Record<string, ConflictChoice>>): [string[], string[]] {
  const ids = Object.keys(fieldChoices);
  const taken = (id: string) => Object.values(fieldChoices[id]).includes("repo");
  return [ids.filter(taken), ids.filter((id) => !taken(id))];
}

export function buildAllOrNothingChanges(diff: FullSyncDiff, sel: ThreeWaySelections): FullSyncChanges {
  const fieldChoices: Record<string, Record<string, ConflictChoice>> = Object.fromEntries(
    diff.objects.changedObjects.map((o) => [
      o.object_id,
      Object.fromEntries(o.changedFields.map((f) => [f, "repo" as const])),
    ])
  );
  return withPageContent(diff, sel, withStoryContent(diff, sel, {
    objects: {
      newObjectIds: diff.objects.newObjects.map((o) => o.object_id),
      changedObjectIds: diff.objects.changedObjects.map((o) => o.object_id),
      changedDocIds: docIdsOf(diff.objects.changedObjects),
      fieldChoices,
      fieldsSeen: fieldsSeenFor(diff.objects.changedObjects, fieldChoices),
      removedObjectIds: diff.objects.missingObjects.map((o) => o.object_id),
      removedDocIds: docIdsOf(diff.objects.missingObjects),
      unregisteredObjectIds: [],
    },
    stories: {
      accept: diff.stories.changedStories.map((s) => s.story_id),
      reject: [],
      insertNew: diff.stories.newStories.map((s) => s.story_id),
      fieldChoices: rowFieldChoices(diff.stories.changedStories.map((s) => [s.story_id, s, "repo"])),
    },
    config: {
      accept: diff.config.changedFields.map((c) => c.key),
      reject: [],
    },
    glossary: {
      accept: diff.glossary.changed.map((t) => t.term_id),
      reject: [],
      insertNew: diff.glossary.added.map((t) => t.term_id),
      fieldChoices: rowFieldChoices(diff.glossary.changed.map((t) => [t.term_id, t, "repo"])),
    },
  }));
}

// ---------------------------------------------------------------------------
// Helper: build a precise FullSyncChanges from three-way selections
// ---------------------------------------------------------------------------

/**
 * Maps the diff plus the user's conflict resolutions onto the existing
 * FullSyncChanges contract. Pure — exported for unit testing.
 *
 * Rules:
 *   - Repo-only changes (no conflict) are pre-accepted.
 *   - Object conflict fields: keep-mine -> "d1" choice, use-repo -> "repo";
 *     untouched, the field's default (`objectFieldChoiceOf`).
 *     Non-conflict fields of a partly-conflicted object stay "repo".
 *   - Story and glossary rows: per field as objects are (`rowFieldChoices`),
 *     the row's one choice covering its conflicting fields; a row with no
 *     field taken from GitHub is rejected.
 *   - Config conflict keys: keep-mine -> reject, use-repo -> accept.
 *   - Deleted-here objects/terms: Restore -> included in newObjectIds /
 *     insertNew; Keep-deleted -> omitted (the default).
 *   - A story whose content changed: its one choice decides its content and
 *     its row together (`withStoryContent`).
 *   - A page whose file changed: its choice decides whether GitHub's version
 *     is taken (`withPageContent`).
 */
export function buildThreeWayChanges(
  diff: FullSyncDiff,
  sel: ThreeWaySelections,
): FullSyncChanges {

  // --- objects ---
  const newObjectIds = [
    ...diff.objects.newObjects.filter((o) => !o.deletedInCompositor).map((o) => o.object_id),
    ...diff.objects.newObjects
      .filter((o) => o.deletedInCompositor && ownValue(sel.objectRestore, o.object_id) === true)
      .map((o) => o.object_id),
  ];
  const changedObjectIds = diff.objects.changedObjects.map((o) => o.object_id);
  // Built from entries, so every object id, a `__proto__` included, is an own
  // property of it.
  const fieldChoices: Record<string, Record<string, ConflictChoice>> = Object.fromEntries(
    diff.objects.changedObjects.map((o) => {
      const conflictSet = new Set<string>(o.conflictFields);
      return [
        o.object_id,
        Object.fromEntries(o.changedFields.map((f) => [f, conflictSet.has(f) ? objectFieldChoiceOf(o, f, sel) : "repo"])),
      ];
    }),
  );
  // Unflagged missing objects are pre-accepted for removal; a deleted-in-repo/
  // edited-here object is removed only when the user explicitly chose Delete
  // (default keep-mine leaves it out, so the residue re-flags missing_from_repo).
  const removedObjects = [
    ...diff.objects.missingObjects.filter((o) => !o.editedInCompositor),
    ...diff.objects.missingObjects.filter((o) => o.editedInCompositor && ownValue(sel.objectDelete, o.object_id) === true),
  ];
  const removedObjectIds = removedObjects.map((o) => o.object_id);

  // --- stories ---
  const storyFieldChoices = rowFieldChoices(
    diff.stories.changedStories.map((s) => [s.story_id, s, rowChoiceOf(sel.storyChoices, s.story_id, s.repoByDefault)]),
  );
  const [storyAccept, storyReject] = splitByRepoField(storyFieldChoices);

  // --- config ---
  const configAccept: string[] = [];
  const configReject: string[] = [];
  for (const c of diff.config.changedFields) {
    if (!c.conflict) {
      configAccept.push(c.key);
    } else if (rowChoiceOf(sel.configChoices, c.key) === "repo") {
      configAccept.push(c.key);
    } else {
      configReject.push(c.key);
    }
  }

  // --- glossary ---
  const glossFieldChoices = rowFieldChoices(
    diff.glossary.changed.map((t) => [t.term_id, t, rowChoiceOf(sel.glossaryChangedChoices, t.term_id, t.repoByDefault)]),
  );
  const [glossAccept, glossReject] = splitByRepoField(glossFieldChoices);
  const glossInsertNew = [
    ...diff.glossary.added.filter((t) => !t.deletedInCompositor).map((t) => t.term_id),
    ...diff.glossary.added
      .filter((t) => t.deletedInCompositor && ownValue(sel.glossaryRestore, t.term_id) === true)
      .map((t) => t.term_id),
  ];

  // Genuine new stories insert; a deleted-here (repo edited, editor deleted)
  // story inserts only when the user chose Restore (default keep-deleted).
  const storyInsertNew = [
    ...diff.stories.newStories.filter((s) => !s.deletedInCompositor).map((s) => s.story_id),
    ...diff.stories.newStories
      .filter((s) => s.deletedInCompositor && ownValue(sel.storyRestore, s.story_id) === true)
      .map((s) => s.story_id),
  ];

  return withPageContent(diff, sel, withStoryContent(diff, sel, {
    objects: {
      newObjectIds,
      changedObjectIds,
      changedDocIds: docIdsOf(diff.objects.changedObjects),
      fieldChoices,
      fieldsSeen: fieldsSeenFor(diff.objects.changedObjects, fieldChoices),
      removedObjectIds,
      removedDocIds: docIdsOf(removedObjects),
      unregisteredObjectIds: [],
    },
    stories: { accept: storyAccept, reject: storyReject, insertNew: storyInsertNew, fieldChoices: storyFieldChoices },
    config: { accept: configAccept, reject: configReject },
    glossary: { accept: glossAccept, reject: glossReject, insertNew: glossInsertNew, fieldChoices: glossFieldChoices },
  }));
}

/** True when the three-way diff carries at least one conflict to resolve. */
export function hasConflictItems(diff: FullSyncDiff): boolean {
  return (
    diff.objects.changedObjects.some((o) => o.conflictFields.length > 0) ||
    diff.objects.newObjects.some((o) => o.deletedInCompositor) ||
    diff.objects.missingObjects.some((o) => o.editedInCompositor) ||
    diff.stories.changedStories.some(
      (s) => s.conflict && !listedContentChanges(diff).some((c) => c.story_id === s.story_id),
    ) ||
    diff.stories.newStories.some((s) => s.deletedInCompositor) ||
    diff.config.changedFields.some((c) => c.conflict) ||
    diff.glossary.changed.some((t) => t.conflict) ||
    diff.glossary.added.some((t) => t.deletedInCompositor)
  );
}

// ---------------------------------------------------------------------------
// What the dialog shows of the content checks
// ---------------------------------------------------------------------------

/**
 * The story and page content the diffReady step lists (`pageFiles`: the page
 * files on one side only and the pages GitHub added), and whether each check
 * read its files; nothing without a diff.
 */
export function contentView(diff: FullSyncDiff | null) {
  if (!diff) return { contentChanges: [], storyFilesUnread: false, pageChanges: [], pageFiles: [], pageFilesUnread: false };
  return {
    contentChanges: listedContentChanges(diff),
    storyFilesUnread: contentInconclusive(diff),
    pageChanges: listedPageChanges(diff),
    pageFiles: [...listedPageFiles(diff), ...listedPageAdditions(diff)],
    pageFilesUnread: pagesInconclusive(diff),
  };
}

/** The success step's message key: the story files unread first, then the page files. */
export function successKey(storyFilesUnread: boolean, pageFilesUnread: boolean): string {
  if (storyFilesUnread) return "sync_modal.success_inconclusive";
  return pageFilesUnread ? "sync_modal.success_pages_inconclusive" : "sync_modal.success";
}

/**
 * The notes `ApplyNotes` shows, in order: with nothing to apply and every
 * file read, that nothing needs doing; otherwise, when there is something to
 * apply, that applying it leaves the site out of sync for each set of files
 * unread, then what keeping the Compositor's version does.
 */
export function applyNoteKeys(anythingToApply: boolean, storyFilesUnread: boolean, pageFilesUnread: boolean): string[] {
  if (!anythingToApply && !storyFilesUnread && !pageFilesUnread) return ["sync_modal.no_changes_body"];
  const unreadNotes = anythingToApply
    ? [
        ...(storyFilesUnread ? ["sync_modal.content_inconclusive_apply_note"] : []),
        ...(pageFilesUnread ? ["sync_modal.pages_inconclusive_apply_note"] : []),
      ]
    : [];
  return [...unreadNotes, "sync_modal.use_compositor_helper"];
}
