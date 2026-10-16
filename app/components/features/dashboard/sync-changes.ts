/**
 * What the sync dialog sends for the author's choices: the selections, the
 * two payload builders (`buildAllOrNothingChanges` for a two-way diff,
 * `buildThreeWayChanges` for a three-way one), and the story and page content
 * choices both fold in; and what the dialog shows of the story and page
 * checks. Pure; the review dialog (SyncConfirmModal) lists the changes as
 * items (`sync-items.ts`), sets a choice for every one of them, and submits
 * what these build.
 *
 * @version v1.5.5-beta
 */

import type { ChangedObject, FullSyncDiff, FullSyncChanges, SyncField } from "~/lib/sync.server";
import type { StoryContentChange } from "~/lib/story-content.server";
import type { PageAddition, PageContentChange, PageFileChange } from "~/lib/page-content.server";

/** A per-change choice: GitHub's version ("repo") or the Compositor's ("d1"). */
export type ConflictChoice = "repo" | "d1";

/**
 * The author's choices, by change. A key absent from a record is a change
 * with no choice, which each builder fills with its own fallback; the review
 * dialog never submits one (`choicesForApply`, sync-items.ts).
 */
export interface ThreeWaySelections {
  /** objectId -> field -> choice; a field choice overrides the object's own. */
  objectFieldChoices: Record<string, Record<string, ConflictChoice>>;
  /** changed objectId -> the object's one choice, covering every field GitHub changed. */
  objectChoices?: Record<string, ConflictChoice>;
  /** new objectId -> true to add it (restore one deleted here), false to leave it out. */
  objectRestore: Record<string, boolean>;
  /** missing objectId -> true to delete it here too, false to keep it. */
  objectDelete: Record<string, boolean>;
  /** changed story_id -> the row's one choice, covering every field GitHub changed. */
  storyChoices: Record<string, ConflictChoice>;
  /** new story_id -> true to add it (restore one deleted here), false to leave it out. */
  storyRestore: Record<string, boolean>;
  /** changed config key -> choice. */
  configChoices: Record<string, ConflictChoice>;
  /** changed term_id -> the term's one choice, covering every field GitHub changed. */
  glossaryChangedChoices: Record<string, ConflictChoice>;
  /** new term_id -> true to add it (restore one deleted here), false to leave it out. */
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
  /** story_id deleted on GitHub -> true to delete it here too, false to keep it. Absent, kept. */
  storyDelete?: Record<string, boolean>;
  /** term_id deleted on GitHub -> true to delete it here too, false to keep it. Absent, kept. */
  glossaryDelete?: Record<string, boolean>;
  /**
   * Image file name with no object -> true to add it as an object, false to
   * leave it out (`SyncDiff.unregisteredFiles`). Absent, added.
   */
  imageAdd?: Record<string, boolean>;
  /**
   * "stories" or "pages", for a file check that did not conclude for a
   * structural cause -> "d1" to keep the Compositor's version of those files
   * (`FullSyncChanges.keepUnreadFiles`). Absent, the check's files are not
   * recorded as read.
   */
  keepUnread?: Record<string, ConflictChoice>;
}

export function emptySelections(): ThreeWaySelections {
  return {
    objectFieldChoices: {},
    objectChoices: {},
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
    storyDelete: {},
    glossaryDelete: {},
    imageAdd: {},
    keepUnread: {},
  };
}

/**
 * The default for a changed object field of a three-way check, which the
 * payload builder applies: GitHub's value for a field only GitHub moved, and for a
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

/** The file checks of `diff` that did not conclude, by name, with their cause. */
export function unreadChecks(diff: FullSyncDiff): Array<{ check: "stories" | "pages"; cause: "structure" | "request"; reason: string; ids?: Array<string | number> }> {
  const out: ReturnType<typeof unreadChecks> = [];
  const story = diff.stories.content;
  if (story && !story.conclusive) out.push({ check: "stories", cause: story.cause ?? "request", reason: story.reason, ...(story.storyIds ? { ids: story.storyIds } : {}) });
  const pages = diff.pages;
  if (pages && !pages.conclusive) out.push({ check: "pages", cause: pages.cause ?? "request", reason: pages.reason, ...(pages.pageIds ? { ids: pages.pageIds } : {}) });
  return out;
}

/** The checks that did not conclude for a request cause: the dialog says so, and offers to check again. */
export function requestUnread(diff: FullSyncDiff | null): { stories: boolean; pages: boolean } {
  const checks = diff ? unreadChecks(diff).filter((c) => c.cause === "request") : [];
  return { stories: checks.some((c) => c.check === "stories"), pages: checks.some((c) => c.check === "pages") };
}

/**
 * True when the check read the stories or pages at the head alone, because
 * its base is no longer a commit GitHub holds: nothing then tells which side
 * made a change, as in a two-way diff.
 */
export function baseUnresolvedOf(diff: FullSyncDiff): boolean {
  const story = diff.stories.content;
  const pages = diff.pages;
  return (story?.conclusive === true && story.baseUnresolved === true) || (pages?.conclusive === true && pages.baseUnresolved === true);
}

/**
 * Whether GitHub's version of the story can be taken: not for a story Telar
 * cannot read, and not without the hash of the version the author reviewed,
 * which the accept needs to refuse a story edited since.
 */
export function contentTakeable(change: StoryContentChange): boolean {
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
    ...(diff.objectsReadSha !== undefined ? { objectsReadSha: diff.objectsReadSha } : {}),
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
 * Whether the check found anything for the dialog to offer or apply: a change
 * listed, files it could not read, GitHub's object order or GitHub's Telar version.
 */
export function hasDiffChanges(diff: FullSyncDiff): boolean {
  const lists = [
    listedContentChanges(diff),
    listedPageChanges(diff),
    listedPageFiles(diff),
    listedPageAdditions(diff),
    diff.objects.newObjects,
    diff.objects.changedObjects,
    diff.objects.missingObjects,
    diff.objects.unregisteredFiles,
    diff.stories.newStories,
    diff.stories.changedStories,
    diff.stories.missingStories,
    diff.config.changedFields,
    diff.glossary.added,
    diff.glossary.changed,
    diff.glossary.removed,
  ];
  const unread = [contentInconclusive(diff), pagesInconclusive(diff)];
  return unread.includes(true) || diff.objects.reordered != null || diff.config.versionChange != null
    || lists.some((list) => list.length > 0);
}

// ---------------------------------------------------------------------------
// The payload builders
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
 * What a builder takes for a change the author made no choice on. Three-way
 * (`buildThreeWayChanges`): GitHub's side of a change GitHub alone made, and
 * of a conflict the diff marks GitHub's (`repoDefaultFields`,
 * `repoByDefault`); the Compositor's side of any other change both made.
 * Two-way (`buildAllOrNothingChanges`): GitHub's side of everything. Either
 * way, a story or term deleted on GitHub is kept, and a file check that did
 * not conclude is not kept over: both happen only on the author's choice.
 */
type Fallback = "three-way" | "two-way";

/**
 * A changed row's per-field choices: the row's own choice over every field
 * GitHub changed when the author made one; else, three-way, the fallback
 * choice for its conflicting fields and GitHub's for the rest, and two-way,
 * GitHub's for all.
 */
function rowChoicesOf(
  row: { changedFields: readonly string[]; conflictFields: readonly string[]; repoByDefault?: boolean },
  chosen: ConflictChoice | undefined,
  fallback: Fallback,
): Record<string, ConflictChoice> {
  const conflictChoice: ConflictChoice = fallback === "two-way" || row.repoByDefault ? "repo" : "d1";
  return Object.fromEntries(
    row.changedFields.map((f) => [f, chosen ?? (row.conflictFields.includes(f) ? conflictChoice : "repo")]),
  );
}

/**
 * The per-field choices of changed stories or terms, by id. Built from
 * entries, so every id, a `__proto__` included, is an own property of it.
 */
function rowFieldChoices(
  rows: ReadonlyArray<{ id: string; row: Parameters<typeof rowChoicesOf>[0] }>,
  choices: Record<string, ConflictChoice>,
  fallback: Fallback,
): Record<string, Record<string, ConflictChoice>> {
  return Object.fromEntries(rows.map(({ id, row }) => [id, rowChoicesOf(row, ownValue(choices, id), fallback)]));
}

/** The ids with a field taken from GitHub (accepted), and the rest (rejected). */
function splitByRepoField(fieldChoices: Record<string, Record<string, ConflictChoice>>): [string[], string[]] {
  const ids = Object.keys(fieldChoices);
  const taken = (id: string) => Object.values(fieldChoices[id]).includes("repo");
  return [ids.filter(taken), ids.filter((id) => !taken(id))];
}

/**
 * Whether a change on one side only is taken: the author's yes or no, else
 * the fallback, which three-way leaves out a change the Compositor made too
 * (`bothSides`).
 */
function takenOf(record: Record<string, boolean>, id: string, bothSides: boolean | undefined, fallback: Fallback): boolean {
  return ownValue(record, id) ?? (fallback === "two-way" || !bothSides);
}

/**
 * A changed object's per-field choices: a field's own choice, else the
 * object's one choice, else the fallback (`threeWayFieldDefault` three-way,
 * GitHub's two-way).
 */
function objectChoicesOf(o: ChangedObject, sel: ThreeWaySelections, fallback: Fallback): Record<string, ConflictChoice> {
  const fieldSel = ownValue(sel.objectFieldChoices, o.object_id) ?? {};
  const objectChoice = ownValue(sel.objectChoices ?? {}, o.object_id);
  return Object.fromEntries(
    o.changedFields.map((f) => [
      f,
      ownValue(fieldSel, f) ?? objectChoice ?? (fallback === "two-way" ? "repo" : threeWayFieldDefault(o, f)),
    ]),
  );
}

/** The payload for the author's choices, with `fallback` for a change they made none on. */
function buildChanges(diff: FullSyncDiff, sel: ThreeWaySelections, fallback: Fallback): FullSyncChanges {
  // --- objects ---
  const newObjectIds = diff.objects.newObjects
    .filter((o) => takenOf(sel.objectRestore, o.object_id, o.deletedInCompositor, fallback))
    .map((o) => o.object_id);
  // Built from entries, so every object id, a `__proto__` included, is an own
  // property of it.
  const fieldChoices: Record<string, Record<string, ConflictChoice>> = Object.fromEntries(
    diff.objects.changedObjects.map((o) => [o.object_id, objectChoicesOf(o, sel, fallback)]),
  );
  // A removal not taken leaves the row, which the residue flags missing_from_repo.
  const removedObjects = diff.objects.missingObjects.filter((o) =>
    takenOf(sel.objectDelete, o.object_id, o.editedInCompositor, fallback),
  );
  // An image file with no object is added unless the author leaves it out;
  // files sharing a stem add one object.
  const imageIds = [...new Set(
    diff.objects.unregisteredFiles.filter((f) => ownValue(sel.imageAdd ?? {}, f.filename) !== false).map((f) => f.object_id),
  )];

  // --- stories ---
  const storyFieldChoices = rowFieldChoices(
    diff.stories.changedStories.map((s) => ({ id: s.story_id, row: s })), sel.storyChoices, fallback,
  );
  const [storyAccept, storyReject] = splitByRepoField(storyFieldChoices);
  const storyInsertNew = diff.stories.newStories
    .filter((s) => takenOf(sel.storyRestore, s.story_id, s.deletedInCompositor, fallback))
    .map((s) => s.story_id);

  // --- config ---
  const configTaken = (c: FullSyncDiff["config"]["changedFields"][number]) =>
    (ownValue(sel.configChoices, c.key) ?? (fallback === "two-way" || !c.conflict ? "repo" : "d1")) === "repo";
  const configAccept = diff.config.changedFields.filter(configTaken).map((c) => c.key);
  const configReject = diff.config.changedFields.filter((c) => !configTaken(c)).map((c) => c.key);

  // --- glossary ---
  const glossFieldChoices = rowFieldChoices(
    diff.glossary.changed.map((t) => ({ id: t.term_id, row: t })), sel.glossaryChangedChoices, fallback,
  );
  const [glossAccept, glossReject] = splitByRepoField(glossFieldChoices);
  const glossInsertNew = diff.glossary.added
    .filter((t) => takenOf(sel.glossaryRestore, t.term_id, t.deletedInCompositor, fallback))
    .map((t) => t.term_id);

  // --- rows deleted on GitHub: deleted here only when the author chose it ---
  const chosenRemovals = (rows: ReadonlyArray<{ id: string; dbId: number; held?: true }>, chosen: Record<string, boolean> | undefined) =>
    rows.filter((r) => !r.held && ownValue(chosen ?? {}, r.id) === true).map(({ id, dbId }) => ({ id, dbId }));
  const storyRemove = chosenRemovals(diff.stories.missingStories.map((s) => ({ id: s.story_id, dbId: s.dbId })), sel.storyDelete);
  const glossRemove = chosenRemovals(diff.glossary.removed.map((t) => ({ id: t.term_id, dbId: t.dbId, ...(t.held ? { held: t.held } : {}) })), sel.glossaryDelete);

  // --- file checks that did not conclude for a structural cause ---
  const keepUnreadFiles = unreadChecks(diff)
    .filter((c) => c.cause === "structure" && ownValue(sel.keepUnread ?? {}, c.check) === "d1")
    .map((c) => c.check);

  return withPageContent(diff, sel, withStoryContent(diff, sel, {
    objects: {
      newObjectIds,
      changedObjectIds: diff.objects.changedObjects.map((o) => o.object_id),
      changedDocIds: docIdsOf(diff.objects.changedObjects),
      fieldChoices,
      fieldsSeen: fieldsSeenFor(diff.objects.changedObjects, fieldChoices),
      removedObjectIds: removedObjects.map((o) => o.object_id),
      removedDocIds: docIdsOf(removedObjects),
      unregisteredObjectIds: imageIds,
    },
    stories: {
      accept: storyAccept, reject: storyReject, insertNew: storyInsertNew, fieldChoices: storyFieldChoices,
      ...(storyRemove.length > 0 ? { remove: storyRemove } : {}),
    },
    config: { accept: configAccept, reject: configReject },
    glossary: {
      accept: glossAccept, reject: glossReject, insertNew: glossInsertNew, fieldChoices: glossFieldChoices,
      ...(glossRemove.length > 0 ? { remove: glossRemove } : {}),
    },
    ...(keepUnreadFiles.length > 0 ? { keepUnreadFiles } : {}),
  }));
}

/**
 * The payload for a two-way diff: every change the author made a choice on
 * as they chose, and GitHub's side of any other.
 */
export function buildAllOrNothingChanges(diff: FullSyncDiff, sel: ThreeWaySelections): FullSyncChanges {
  return buildChanges(diff, sel, "two-way");
}

// ---------------------------------------------------------------------------
// Helper: build a precise FullSyncChanges from three-way selections
// ---------------------------------------------------------------------------

/**
 * Maps the diff plus the author's choices onto the FullSyncChanges contract.
 * Pure — exported for unit testing.
 *
 * Rules, for a change the author made a choice on:
 *   - A changed object, story or term: the one choice covers every field
 *     GitHub changed; an object's field choice overrides it for that field.
 *     A story or term with no field taken from GitHub is rejected.
 *   - A config key: GitHub's -> accept, the Compositor's -> reject.
 *   - A new object, story or term: added (restored) when taken.
 *   - A missing object, story or term: removed when taken; kept otherwise.
 *   - An image file with no object: added as one unless left out.
 *   - A file check that did not conclude for a structural cause: the
 *     Compositor's version kept (`keepUnreadFiles`) when chosen.
 *   - A story whose content changed: its one choice decides its content and
 *     its row together (`withStoryContent`).
 *   - A page whose file changed: its choice decides whether GitHub's version
 *     is taken (`withPageContent`).
 * A change with no choice takes the three-way fallback (`Fallback`).
 */
export function buildThreeWayChanges(
  diff: FullSyncDiff,
  sel: ThreeWaySelections,
): FullSyncChanges {
  return buildChanges(diff, sel, "three-way");
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
 * unread.
 */
export function applyNoteKeys(anythingToApply: boolean, storyFilesUnread: boolean, pageFilesUnread: boolean): string[] {
  if (!anythingToApply && !storyFilesUnread && !pageFilesUnread) return ["sync_modal.no_changes_body"];
  if (!anythingToApply) return [];
  return [
    ...(storyFilesUnread ? ["sync_modal.content_inconclusive_apply_note"] : []),
    ...(pageFilesUnread ? ["sync_modal.pages_inconclusive_apply_note"] : []),
  ];
}
