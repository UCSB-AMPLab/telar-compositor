/**
 * The review dialog's items (`sync-items.ts`): one per change, each kind's
 * default, "Set all to", the gate on Apply, and "When you apply" checked
 * against the payload the builders produce for the same choices.
 *
 * The agreement tests read the payload with their own mapping
 * (`takenByPayload`), written from the FullSyncChanges contract and not from
 * the items, so the sentence and the payload are two readings of the choices.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, beforeAll } from "vitest";
import i18next, { type TFunction } from "i18next";
import type { FullSyncChanges, FullSyncDiff } from "~/lib/sync.server";
import type { StoryContentChange } from "~/lib/story-content.server";
import type { PageContentChange, PageFileChange } from "~/lib/page-content.server";
import { emptySelections, type ConflictChoice, type ThreeWaySelections } from "~/components/features/dashboard/sync-changes";
import {
  applySummaryOf,
  changesForApply,
  choiceOfItem,
  setAllTo,
  syncItemsOf,
  syncNoticesOf,
  undecidedItems,
  type SyncItem,
} from "~/components/features/dashboard/sync-items";
import { applySentences } from "~/components/features/dashboard/SyncItemCards";
import enDashboard from "~/i18n/locales/en/dashboard.json";
import enObjects from "~/i18n/locales/en/objects.json";
import enConfig from "~/i18n/locales/en/config.json";
import esDashboard from "~/i18n/locales/es/dashboard.json";
import esObjects from "~/i18n/locales/es/objects.json";
import esConfig from "~/i18n/locales/es/config.json";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const blankNew = {
  title: null, creator: null, description: null, period: null, year: null, object_type: null, subjects: null,
  source: null, credit: null, thumbnail: null, featured: false, source_url: null, dimensions: null, image_available: false,
};

function content(id: string, kind: StoryContentChange["kind"], extra: Partial<StoryContentChange> = {}): StoryContentChange {
  return {
    story_id: id, title: `Story ${id}`, kind, acceptByDefault: kind === "github-only",
    summary: { d1Steps: 2, headSteps: 2, changedSteps: 1 }, expected: `hash-${id}`, ...extra,
  };
}

function pageChange(pageId: number, kind: PageContentChange["kind"]): PageContentChange {
  return { pageId, slug: `p${pageId}`, title: `Page ${pageId}`, kind, acceptByDefault: kind === "github-only", expected: `hash-p${pageId}` };
}

function pageFile(name: string, kind: PageFileChange["kind"], pageId: number): PageFileChange {
  return { name, pageId, slug: name.replace(/\.md$/, ""), title: `File ${name}`, kind, acceptByDefault: kind === "deleted", expected: `hash-${name}` };
}

/** A three-way diff holding every kind of change the review lists. */
function everyKind(classification: FullSyncDiff["classification"] = "three-way"): FullSyncDiff {
  return {
    objects: {
      newObjects: [
        { object_id: "obj-new", ...blankNew },
        { object_id: "obj-gone-here", ...blankNew, deletedInCompositor: true },
      ],
      changedObjects: [
        {
          object_id: "obj-edit", dbId: 1, title: "Edited there", changedFields: ["title", "creator"], conflictFields: [],
          d1Values: { title: "a", creator: "b" }, repoValues: { title: "A", creator: "B" },
        },
        {
          object_id: "obj-both", dbId: 2, title: "Edited both", changedFields: ["title", "creator"], conflictFields: ["title"],
          d1Values: { title: "mine", creator: "c" }, repoValues: { title: "theirs", creator: "C" },
        },
      ],
      missingObjects: [
        { object_id: "obj-del", dbId: 3, title: "Deleted there", usedByStories: [] },
        { object_id: "obj-del-edited", dbId: 4, title: "Deleted there, edited here", usedByStories: [], editedInCompositor: true },
      ],
      unregisteredFiles: [],
      reordered: null,
    },
    stories: {
      newStories: [
        { story_id: "st-new", title: "New story", subtitle: null, byline: null, order: 0, isPrivate: false, showSections: false, extraColumns: "" },
        { story_id: "st-gone-here", title: "Gone here", subtitle: null, byline: null, order: 0, isPrivate: false, showSections: false, extraColumns: "", deletedInCompositor: true },
      ],
      changedStories: [
        { story_id: "st-row", title: "Row there", changedFields: ["title"], conflictFields: [], conflict: false, d1Values: { title: "x" }, repoValues: { title: "X" } },
        { story_id: "st-row-both", title: "Row both", changedFields: ["title", "subtitle"], conflictFields: ["title"], conflict: true, d1Values: { title: "y" }, repoValues: { title: "Y" } },
        { story_id: "st-text", title: "Text there", changedFields: ["byline"], conflictFields: [], conflict: false, d1Values: { byline: "z" }, repoValues: { byline: "Z" } },
      ],
      missingStories: [
        { story_id: "st-missing", title: "Missing story", dbId: 21 },
        { story_id: "st-missing-edited", title: "Missing, edited here", dbId: 22, editedInCompositor: true },
      ],
      content: {
        conclusive: true, suppressedEditorOnly: 0,
        changes: [
          content("st-text", "github-only"),
          content("st-text-both", "conflict"),
          content("st-steps", "steps-deleted"),
          content("st-bad", "unreadable", { expected: null, reason: { code: "step_missing", row: 2 } }),
        ],
      },
    },
    config: {
      changedFields: [
        { key: "title", d1Value: "Mine", repoValue: "Theirs", conflict: true },
        { key: "subtitle", d1Value: "s", repoValue: "S", conflict: false },
      ],
      versionChange: null,
    },
    glossary: {
      added: [
        { term_id: "t-new", title: "New term", definition: "d", related_terms: "", extra_columns: "" },
        { term_id: "t-gone-here", title: "Gone term", definition: "d", related_terms: "", extra_columns: "", deletedInCompositor: true },
      ],
      changed: [
        { term_id: "t-edit", title: "Term", dbId: 1, d1Title: "Term", repoTitle: "Term!", d1Definition: "", repoDefinition: "", d1RelatedTerms: "", repoRelatedTerms: "", d1ExtraColumns: "", repoExtraColumns: "", changedFields: ["title"], conflictFields: [], conflict: false },
        { term_id: "t-both", title: "Both", dbId: 2, d1Title: "Both", repoTitle: "Both!", d1Definition: "", repoDefinition: "", d1RelatedTerms: "", repoRelatedTerms: "", d1ExtraColumns: "", repoExtraColumns: "", changedFields: ["title"], conflictFields: ["title"], conflict: true },
      ],
      removed: [
        { term_id: "t-removed", title: "Removed term", dbId: 3 },
        { term_id: "t-removed-edited", title: "Removed, edited here", dbId: 4, editedInCompositor: true },
        { term_id: "#held", title: "Held", dbId: 5, held: true },
      ],
    },
    pages: {
      conclusive: true, suppressedEditorOnly: 0,
      changes: [pageChange(5, "github-only"), pageChange(6, "conflict")],
      files: [
        pageFile("p7.md", "deleted", 7),
        pageFile("p8.md", "deleted-conflict", 8),
        pageFile("p9.md", "not-on-github", 9),
        pageFile("p10.md", "edited-renamed-here", 10),
        pageFile("p11.md", "deleted-here-edited", 11),
      ],
      additions: [],
    },
    hasConflicts: true,
    classification,
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    headSha: HEAD,
    projectId: 7,
    baseSha: "f".repeat(40),
  } as FullSyncDiff;
}

const byKey = (items: SyncItem[]) => Object.fromEntries(items.map((item) => [item.key, item]));

/**
 * `diff` with files GitHub holds with characters that cannot be read: one of a
 * story whose text GitHub alone changed, two of a story whose row changed, one
 * of a new story, one of a story Telar cannot read, one of a story with no
 * change, one of no story, and one the site does not use.
 */
function withUnreadable(diff: FullSyncDiff): FullSyncDiff {
  return {
    ...diff,
    unreadable: [
      { file: "st-text.csv", storyIds: ["st-text"], effect: "left_out", notice: false },
      { file: "st-row.csv", storyIds: ["st-row"], effect: "left_out", notice: false },
      { file: "telar-content/texts/stories/panel.md", storyIds: ["st-row"], effect: "name_shown", notice: false },
      { file: "st-new.csv", storyIds: ["st-new"], effect: "left_out", notice: false },
      { file: "st-bad.csv", storyIds: ["st-bad"], effect: "left_out", notice: false },
      { file: "st-plain.csv", storyIds: ["st-plain"], effect: "left_out", notice: false },
      { file: "objects.csv", effect: "build_stops", notice: false },
      { file: "_old/story.csv", effect: "not_used", notice: true },
    ],
  };
}

/** The defaults each kind takes in a three-way check. */
const THREE_WAY_DEFAULTS: Record<string, ConflictChoice | null> = {
  "object:changed:obj-edit": "repo",
  "object:changed:obj-both": null,
  "object:new:obj-new": "repo",
  "object:new:obj-gone-here": null,
  "object:missing:obj-del": "repo",
  "object:missing:obj-del-edited": null,
  "story:st-text": "repo",
  "story:st-text-both": null,
  "story:st-steps": "repo",
  "story:st-bad": "d1",
  "story:st-row": "repo",
  "story:st-row-both": null,
  "story:new:st-new": "repo",
  "story:new:st-gone-here": null,
  "story:missing:st-missing": null,
  "story:missing:st-missing-edited": null,
  "setting:title": null,
  "setting:subtitle": "repo",
  "term:changed:t-edit": "repo",
  "term:changed:t-both": null,
  "term:new:t-new": "repo",
  "term:new:t-gone-here": null,
  "term:missing:t-removed": "repo",
  "term:missing:t-removed-edited": null,
  "term:missing:#held": "repo",
  "page:content:5": "repo",
  "page:content:6": null,
  "page:file:p7.md": "repo",
  "page:file:p8.md": null,
  "page:file:p9.md": null,
  "page:file:p10.md": null,
  "page:file:p11.md": null,
};

describe("one item per change, with its default", () => {
  it("lists every change once, a story with its content and its row as one item", () => {
    const items = syncItemsOf(everyKind());
    expect(items.map((item) => item.key).sort()).toEqual(Object.keys(THREE_WAY_DEFAULTS).sort());
    expect(items.filter((item) => item.key === "story:st-text")).toHaveLength(1);
  });

  it("defaults a change GitHub alone made to GitHub's version, and leaves one made on both sides with none", () => {
    const items = syncItemsOf(everyKind());
    const defaults = Object.fromEntries(items.map((item) => [item.key, choiceOfItem(item, emptySelections())]));
    expect(defaults).toEqual(THREE_WAY_DEFAULTS);
  });

  it("marks the changes made on both sides", () => {
    const both = syncItemsOf(everyKind()).filter((item) => item.both).map((item) => item.key).sort();
    expect(both).toEqual([
      "object:changed:obj-both", "object:missing:obj-del-edited", "object:new:obj-gone-here",
      "page:content:6", "page:file:p10.md", "page:file:p11.md", "page:file:p8.md",
      "setting:title", "story:missing:st-missing-edited", "story:new:st-gone-here", "story:st-row-both", "story:st-text-both",
      "term:changed:t-both", "term:missing:t-removed-edited", "term:new:t-gone-here",
    ]);
  });

  it("has no restore, keep-deleted, delete or keep-mine default for a change made on both sides", () => {
    const items = byKey(syncItemsOf(everyKind()));
    for (const key of [
      "object:new:obj-gone-here", "object:missing:obj-del-edited", "story:new:st-gone-here", "term:new:t-gone-here", "page:file:p11.md",
      "story:missing:st-missing-edited", "term:missing:t-removed-edited",
    ]) {
      expect(items[key].defaultChoice).toBeNull();
      expect(items[key].options.map((o) => o.choice)).toEqual(["repo", "d1"]);
    }
  });

  it("has no default for a conflict the base could not place", () => {
    const diff = everyKind();
    diff.objects.changedObjects[1].repoDefaultFields = ["title"];
    diff.stories.changedStories[1].repoByDefault = true;
    const items = byKey(syncItemsOf(diff));
    expect(items["object:changed:obj-both"].defaultChoice).toBeNull();
    expect(items["story:st-row-both"].defaultChoice).toBeNull();
  });

  it("never deletes a story GitHub deleted by default, since its steps may have been edited here", () => {
    expect(byKey(syncItemsOf(everyKind()))["story:missing:st-missing"].defaultChoice).toBeNull();
    expect(byKey(syncItemsOf(everyKind()))["term:missing:t-removed"].defaultChoice).toBe("repo");
  });

  it("has no default at all in a two-way check, except an item with one version", () => {
    const items = syncItemsOf(everyKind("two-way"));
    const chosen = items.filter((item) => choiceOfItem(item, emptySelections()) !== null);
    expect(chosen.map((item) => item.key).sort()).toEqual(["story:st-bad", "term:missing:#held"]);
    for (const item of chosen) expect(item.options).toHaveLength(1);
  });

  it("offers to delete here too a story or a term deleted on GitHub, or to keep it", () => {
    const items = byKey(syncItemsOf(everyKind()));
    for (const key of ["story:missing:st-missing", "term:missing:t-removed"]) {
      expect(items[key].options.map((o) => [o.choice, o.does, o.publish])).toEqual([["repo", "delete", undefined], ["d1", "keep_present", "restore"]]);
      expect(items[key].what.key).toBe("sync_modal.review.deleted_github");
    }
    expect(items["story:missing:st-missing-edited"].what.key).toBe("sync_modal.review.deleted_both");
    expect(items["story:missing:st-missing-edited"].options.map((o) => o.label)).toEqual([
      "sync_modal.review.delete_here_too", "sync_modal.review.keep_it_with_edits",
    ]);
  });

  it("deletes a term whose id publishes none with every apply, with no choice", () => {
    const items = byKey(syncItemsOf(everyKind()));
    expect(items["term:missing:#held"].options.map((o) => [o.choice, o.does])).toEqual([["repo", "delete"]]);
  });

  it("sends a deleted story or term for removal by its D1 id only when deleting it is chosen", () => {
    const diff = everyKind();
    const items = byKey(syncItemsOf(diff));
    let sel = setAllTo(Object.values(items), emptySelections(), "d1");
    expect(changesForApply(diff, sel)?.stories.remove).toBeUndefined();
    expect(changesForApply(diff, sel)?.glossary.remove).toBeUndefined();
    sel = items["story:missing:st-missing-edited"].write(sel, "repo");
    sel = items["term:missing:t-removed"].write(sel, "repo");
    const changes = changesForApply(diff, sel)!;
    expect(changes.stories.remove).toEqual([{ id: "st-missing-edited", dbId: 22 }]);
    expect(changes.glossary.remove).toEqual([{ id: "t-removed", dbId: 3 }]);
    // The held term is the server's to remove (`removeHeld`), never named here.
    expect(changesForApply(diff, setAllTo(Object.values(items), emptySelections(), "repo"))!.glossary.remove).toEqual([
      { id: "t-removed", dbId: 3 }, { id: "t-removed-edited", dbId: 4 },
    ]);
  });
});

describe("Apply waits for every item", () => {
  it("builds nothing while a change has no choice, and builds once every one has", () => {
    const diff = everyKind();
    const items = syncItemsOf(diff);
    expect(undecidedItems(items, emptySelections()).length).toBeGreaterThan(0);
    expect(changesForApply(diff, emptySelections())).toBeNull();
    let sel = emptySelections();
    for (const item of undecidedItems(items, sel)) sel = item.write(sel, "d1");
    expect(undecidedItems(items, sel)).toEqual([]);
    expect(changesForApply(diff, sel)).not.toBeNull();
  });
});

describe("Set all to", () => {
  it.each<ConflictChoice>(["repo", "d1"])("%s: sets every item that offers it, and nothing else", (choice) => {
    const diff = everyKind();
    const items = syncItemsOf(diff);
    const before = emptySelections();
    const after = setAllTo(items, before, choice);
    for (const item of items) {
      const offered = item.options.some((o) => o.choice === choice);
      expect(choiceOfItem(item, after)).toBe(offered ? choice : item.options[0].choice);
    }
    expect(before).toEqual(emptySelections());
    // Writes only the maps the items read: setting all twice is the same as once.
    expect(setAllTo(items, after, choice)).toEqual(after);
  });

  it("never reads a version an item does not offer as its choice", () => {
    const items = byKey(syncItemsOf(everyKind()));
    const sel = { ...emptySelections(), storyContentChoices: { "st-bad": "repo" as const } };
    expect(choiceOfItem(items["story:st-bad"], sel)).toBe("d1");
  });

  it("leaves an item with one version on it", () => {
    const items = byKey(syncItemsOf(everyKind()));
    const after = setAllTo(Object.values(items), emptySelections(), "repo");
    expect(choiceOfItem(items["story:st-bad"], after)).toBe("d1");
    expect(choiceOfItem(items["term:missing:#held"], setAllTo(Object.values(items), emptySelections(), "d1"))).toBe("repo");
  });
});

// ---------------------------------------------------------------------------
// The payload, read without the items
// ---------------------------------------------------------------------------

/**
 * The item keys whose GitHub side the payload takes, read from the
 * FullSyncChanges contract alone. A changed object counts as taken when every
 * field it changed is "repo", and as kept when none is; a mix fails.
 */
function takenByPayload(diff: FullSyncDiff, changes: FullSyncChanges): Set<string> {
  const taken = new Set<string>();
  for (const o of diff.objects.changedObjects) {
    const values = o.changedFields.map((f) => changes.objects.fieldChoices[o.object_id]?.[f]);
    expect(new Set(values).size).toBe(1);
    if (values[0] === "repo") taken.add(`object:changed:${o.object_id}`);
  }
  for (const id of changes.objects.newObjectIds) taken.add(`object:new:${id}`);
  for (const id of changes.objects.removedObjectIds) taken.add(`object:missing:${id}`);
  for (const id of changes.stories.acceptContent ?? []) taken.add(`story:${id}`);
  for (const id of changes.stories.accept) taken.add(`story:${id}`);
  for (const id of changes.stories.insertNew) taken.add(`story:new:${id}`);
  for (const key of changes.config.accept) taken.add(`setting:${key}`);
  for (const id of changes.glossary.accept) taken.add(`term:changed:${id}`);
  for (const id of changes.glossary.insertNew) taken.add(`term:new:${id}`);
  for (const { id } of changes.stories.remove ?? []) taken.add(`story:missing:${id}`);
  for (const { id } of changes.glossary.remove ?? []) taken.add(`term:missing:${id}`);
  // A held term is removed by every apply (`removeHeld`), whatever the payload names.
  for (const t of diff.glossary.removed) if (t.held) taken.add(`term:missing:${t.term_id}`);
  const files = diff.pages?.conclusive ? diff.pages.files ?? [] : [];
  for (const page of changes.pages?.acceptContent ?? []) {
    const renamed = files.find((f) => f.pageId === page.pageId && f.kind === "edited-renamed-here");
    taken.add(renamed ? `page:file:${renamed.name}` : `page:content:${page.pageId}`);
  }
  for (const file of changes.pages?.takeFiles ?? []) taken.add(`page:file:${file.name}`);
  return taken;
}

const TAKES = new Set(["take", "add", "restore", "delete"]);

/** The item keys the summary says are taken from GitHub, and those it says are kept. */
function saidBySummary(items: SyncItem[], sel: ThreeWaySelections): { taken: Set<string>; kept: Set<string>; publishes: Set<string> } {
  const summary = applySummaryOf(items, syncNoticesOf(everyKind()), sel);
  if (summary.kind !== "ready") throw new Error("summary pending");
  const keysOf = (names: unknown[]) => names.map((n) => (n as SyncItem).key).filter(Boolean);
  const taken = new Set(summary.compositor.filter((g) => TAKES.has(g.action)).flatMap((g) => keysOf(g.names)));
  const kept = new Set(summary.compositor.filter((g) => !TAKES.has(g.action)).flatMap((g) => keysOf(g.names)));
  const publishes = new Set(summary.publish.flatMap((g) => keysOf(g.names)));
  return { taken, kept, publishes };
}

/** A deterministic mix: item i takes `pick(i)` where it offers it, else its one version. */
function mix(items: SyncItem[], pick: (index: number) => ConflictChoice): ThreeWaySelections {
  return items.reduce((sel, item, index) => {
    const choice = pick(index);
    return item.options.some((o) => o.choice === choice) ? item.write(sel, choice) : item.write(sel, item.options[0].choice);
  }, emptySelections());
}

describe("When you apply says what the payload does", () => {
  const MIXES: Array<[string, (i: number) => ConflictChoice]> = [
    ["all GitHub's", () => "repo"],
    ["all the Compositor's", () => "d1"],
    ["alternating", (i) => (i % 2 === 0 ? "repo" : "d1")],
    ["the other alternation", (i) => (i % 2 === 0 ? "d1" : "repo")],
    ["every third GitHub's", (i) => (i % 3 === 0 ? "repo" : "d1")],
  ];

  const FIXTURES: Array<[string, (c: FullSyncDiff["classification"]) => FullSyncDiff]> = [
    ["every kind", everyKind],
    ["every kind with files that cannot be read", (c) => withUnreadable(everyKind(c))],
  ];
  for (const [fixture, make] of FIXTURES) for (const classification of ["three-way", "two-way"] as const) {
    it.each(MIXES)(`${fixture}, ${classification}, %s: the items it says are taken are the ones the payload takes`, (_label, pick) => {
      const diff = make(classification);
      const items = syncItemsOf(diff);
      const sel = mix(items, pick);
      const changes = changesForApply(diff, sel);
      expect(changes).not.toBeNull();
      const payload = takenByPayload(diff, changes!);
      const said = saidBySummary(items, sel);
      expect([...said.taken].sort()).toEqual([...payload].sort());
      // Every item is said exactly once, taken or kept.
      expect([...said.kept].filter((key) => said.taken.has(key))).toEqual([]);
      expect(said.taken.size + said.kept.size).toBe(items.length);
      // The next publish speaks for every item whose choice it acts on, and
      // for nothing taken but a file it repairs.
      const chosen = (key: string) => {
        const item = items.find((it) => it.key === key)!;
        return item.options.find((o) => o.choice === choiceOfItem(item, sel))!;
      };
      expect([...said.publishes].sort()).toEqual(items.map((it) => it.key).filter((key) => chosen(key).publish !== undefined).sort());
      expect([...said.publishes].filter((key) => payload.has(key) && chosen(key).publish !== "repair")).toEqual([]);
    });
  }

  it("is pending, with the count, while an item has no choice", () => {
    const items = syncItemsOf(everyKind());
    const summary = applySummaryOf(items, syncNoticesOf(everyKind()), emptySelections());
    expect(summary).toEqual({ kind: "pending", count: undecidedItems(items, emptySelections()).length, allBoth: false, allStories: false });
  });

  it("says the pending changes were made in both places when every one was", () => {
    const diff = everyKind();
    const items = syncItemsOf(diff).filter((item) => item.both);
    expect(applySummaryOf(items, syncNoticesOf(diff), emptySelections())).toMatchObject({ kind: "pending", allBoth: true });
  });

  it("ends with GitHub's object order and Telar version, which every accept applies", () => {
    const diff = everyKind();
    diff.objects.reordered = { order: [] } as never;
    diff.config.versionChange = { direction: "ahead", repoVersion: "1.2.0", d1Version: "1.1.0" };
    const items = syncItemsOf(diff);
    const summary = applySummaryOf(items, syncNoticesOf(diff), setAllTo(items, emptySelections(), "repo"));
    expect(summary.kind === "ready" && summary.compositor.slice(-2).map((g) => g.action)).toEqual(["order", "version"]);
  });
});

// ---------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------

describe("the sentences, in each language", () => {
  const resources = {
    en: { dashboard: enDashboard, objects: enObjects, config: enConfig },
    es: { dashboard: esDashboard, objects: esObjects, config: esConfig },
  };
  const ts: Record<string, TFunction> = {};
  beforeAll(async () => {
    for (const lng of ["en", "es"] as const) {
      const instance = i18next.createInstance();
      await instance.init({ lng, resources, defaultNS: "dashboard", interpolation: { escapeValue: false } });
      ts[lng] = instance.getFixedT(lng, "dashboard");
    }
  });

  /** The mock-up's three changes: an object deleted there and edited here, a story both edited, one GitHub alone edited. */
  function mockupDiff(): FullSyncDiff {
    const diff = everyKind();
    diff.objects = { ...diff.objects, newObjects: [], changedObjects: [], missingObjects: [
      { object_id: "demo-obj3", dbId: 3, title: "Object 3", usedByStories: [], editedInCompositor: true },
    ] };
    diff.stories = { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, suppressedEditorOnly: 0, changes: [
      { ...content("colonial", "conflict"), title: "Colonial Landscapes" },
      { ...content("allegorical", "github-only"), title: "The Allegorical Woman" },
    ] } };
    diff.config = { changedFields: [], versionChange: null };
    diff.glossary = { added: [], changed: [], removed: [] };
    diff.pages = { conclusive: true, suppressedEditorOnly: 0, changes: [], files: [], additions: [] };
    return diff;
  }

  it("names each item under what applying does, then what the next publish does", () => {
    const diff = mockupDiff();
    const items = syncItemsOf(diff);
    let sel = emptySelections();
    sel = byKey(items)["object:missing:demo-obj3"].write(sel, "repo");
    sel = byKey(items)["story:colonial"].write(sel, "d1");
    const summary = applySummaryOf(items, syncNoticesOf(diff), sel);
    expect(applySentences(summary, ts.en, "en")).toEqual([
      "The Compositor deletes demo-obj3, keeps its own version of Colonial Landscapes, and takes GitHub's version of The Allegorical Woman.",
      "Your next publish saves the Compositor's version of Colonial Landscapes over GitHub's.",
    ]);
    expect(applySentences(summary, ts.es, "es")).toEqual([
      "El Compositor elimina demo-obj3, conserva su propia versión de Colonial Landscapes y usa la versión de GitHub de The Allegorical Woman.",
      "La próxima vez que publiques, la versión del Compositor reemplazará la de GitHub en Colonial Landscapes.",
    ]);
  });

  it("asks for the changes made in both places while they have no choice", () => {
    const diff = mockupDiff();
    const items = syncItemsOf(diff);
    const summary = applySummaryOf(items, syncNoticesOf(diff), emptySelections());
    expect(applySentences(summary, ts.en, "en")).toEqual([
      "Choose a version for the 2 changes made in both places. Apply waits until you do.",
    ]);
  });

  it("groups items under one action, in a list", () => {
    const diff = mockupDiff();
    const items = syncItemsOf(diff);
    const sel = setAllTo(items, emptySelections(), "d1");
    const summary = applySummaryOf(items, syncNoticesOf(diff), sel);
    expect(applySentences(summary, ts.en, "en")).toEqual([
      "The Compositor keeps demo-obj3 and keeps its own version of Colonial Landscapes and The Allegorical Woman.",
      "Your next publish puts demo-obj3 back on GitHub and saves the Compositor's version of Colonial Landscapes and The Allegorical Woman over GitHub's.",
    ]);
  });
});

describe("ids that name Object.prototype's own properties", () => {
  it.each(["constructor", "__proto__"])("%s: a choice is written and read back as the item's own", (id) => {
    const diff = everyKind();
    diff.objects.missingObjects = [{ object_id: id, dbId: 9, title: "Odd", usedByStories: [], editedInCompositor: true }];
    const item = syncItemsOf(diff).find((it) => it.key === `object:missing:${id}`)!;
    expect(choiceOfItem(item, emptySelections())).toBeNull();
    const sel = item.write(emptySelections(), "repo");
    expect(Object.hasOwn(sel.objectDelete, id)).toBe(true);
    expect(choiceOfItem(item, sel)).toBe("repo");
  });
});

// ---------------------------------------------------------------------------
// Files the Compositor could not read
// ---------------------------------------------------------------------------

describe("a story whose file cannot be read", () => {
  it("is the story's one item, named with the file, offering either version with none chosen", () => {
    const items = syncItemsOf(withUnreadable(everyKind()));
    const text = byKey(items)["story:st-text"];
    expect(items.filter((item) => item.key === "story:st-text")).toHaveLength(1);
    expect(text.title).toBe("Story st-text: st-text.csv");
    expect(text.name).toBe("st-text.csv");
    expect(text.what.key).toBe("sync_modal.review.bad_what");
    expect(text.details[0].key).toBe("sync_modal.review.text_github");
    expect(text.defaultChoice).toBeNull();
    expect(text.options.map((o) => [o.choice, o.label, o.note, o.does, o.publish])).toEqual([
      ["repo", "sync_modal.review.use_github", "sync_modal.review.bad_use_gh_note", "take", "repair"],
      ["d1", "sync_modal.review.keep_compositor", "sync_modal.review.bad_keep_note", "keep", "overwrite"],
    ]);
  });

  it("is one item for two files of one story, saying what the worse of them does", () => {
    const row = byKey(syncItemsOf(withUnreadable(everyKind())))["story:st-row"];
    expect(row.name).toBe("st-row.csv, telar-content/texts/stories/panel.md");
    expect(row.what.key).toBe("sync_modal.review.bad_what");
    const diff = withUnreadable(everyKind());
    diff.unreadable![1] = { ...diff.unreadable![1], effect: "build_stops" };
    expect(byKey(syncItemsOf(diff))["story:st-row"].what.key).toBe("sync_modal.review.bad_what_build_stops");
  });

  it("takes the story's content, row or restore as the choice says", () => {
    const diff = withUnreadable(everyKind());
    const items = byKey(syncItemsOf(diff));
    let sel = setAllTo(Object.values(items), emptySelections(), "d1");
    for (const key of Object.keys(items)) if (choiceOfItem(items[key], sel) === null) sel = items[key].write(sel, "d1");
    const kept = changesForApply(diff, sel)!;
    expect(kept.stories.acceptContent).not.toContain("st-text");
    expect(kept.stories.accept).not.toContain("st-row");
    expect(kept.stories.insertNew).not.toContain("st-new");
    for (const key of ["story:st-text", "story:st-row", "story:new:st-new"]) sel = items[key].write(sel, "repo");
    const taken = changesForApply(diff, sel)!;
    expect(taken.stories.acceptContent).toContain("st-text");
    expect(taken.stories.accept).toContain("st-row");
    expect(taken.stories.insertNew).toContain("st-new");
    expect(items["story:new:st-new"].options.map((o) => o.does)).toEqual(["add", "skip"]);
  });

  it("leaves as notices a file the site does not use, one of no story, and one of a story with nothing to take", () => {
    const diff = withUnreadable(everyKind());
    expect(syncNoticesOf(diff).unreadableFiles.map((f) => f.file)).toEqual(["st-bad.csv", "st-plain.csv", "objects.csv", "_old/story.csv"]);
    const items = byKey(syncItemsOf(diff));
    expect(items["story:st-bad"].what.key).toBe("sync_modal.content_unreadable");
    expect(items["story:st-plain"]).toBeUndefined();
  });
});

/** `diff` whose story or page check did not conclude, for `cause`. */
function unread(diff: FullSyncDiff, check: "stories" | "pages", cause: "structure" | "request", reason: string): FullSyncDiff {
  const inconclusive = { conclusive: false as const, reason, cause };
  return check === "stories"
    ? { ...diff, stories: { ...diff.stories, content: inconclusive } }
    : { ...diff, pages: inconclusive };
}

describe("a file check that did not conclude", () => {
  it("for a structural cause, is one item offering the Compositor's version, none chosen, and Apply waits for it", () => {
    const diff = unread(everyKind(), "stories", "structure", "telar-content/texts/stories could not be listed completely");
    const items = syncItemsOf(diff);
    const nocheck = byKey(items)["story:nocheck:all"];
    expect(nocheck.titleKey).toBe("sync_modal.review.nocheck_all_stories_title");
    expect(nocheck.nameKey).toBe("sync_modal.review.nocheck_all_stories");
    expect(nocheck.what.key).toBe("sync_modal.review.nocheck_truncated");
    expect(nocheck.options.map((o) => [o.choice, o.note])).toEqual([["d1", "sync_modal.review.nocheck_keep_note_all"]]);
    let sel = setAllTo(items, emptySelections(), "repo");
    for (const item of undecidedItems(items, sel)) if (item !== nocheck) sel = item.write(sel, "repo");
    expect(undecidedItems(items, sel)).toEqual([nocheck]);
    expect(changesForApply(diff, sel)).toBeNull();
    const changes = changesForApply(diff, nocheck.write(sel, "d1"))!;
    expect(changes.keepUnreadFiles).toEqual(["stories"]);
    expect(changes.storyContentChecked).toBeUndefined();
  });

  it("names a folder that is not one as a symlink or submodule, for stories and pages", () => {
    const reason = "telar-content/texts/stories is not a tree at abc";
    expect(byKey(syncItemsOf(unread(everyKind(), "stories", "structure", reason)))["story:nocheck:all"].what.key)
      .toBe("sync_modal.review.nocheck_stories_link");
    const pages = byKey(syncItemsOf(unread(everyKind(), "pages", "structure", "telar-content/texts/pages is not a tree at abc")))["page:nocheck:all"];
    expect(pages.what.key).toBe("sync_modal.review.nocheck_pages_link");
    expect(pages.options[0].note).toBe("sync_modal.review.nocheck_pages_keep_note");
  });

  it("sends the page files kept for a structural cause", () => {
    const diff = unread(everyKind(), "pages", "structure", "telar-content/texts/pages could not be listed completely");
    const items = syncItemsOf(diff);
    let sel = emptySelections();
    for (const item of items) sel = item.write(sel, choiceOfItem(item, sel) ?? "d1");
    expect(changesForApply(diff, sel)!.keepUnreadFiles).toEqual(["pages"]);
  });

  it("for a request cause, is no item, and nothing is kept over it", () => {
    const diff = unread(everyKind(), "stories", "request", "the story trees came back malformed");
    const items = syncItemsOf(diff);
    expect(items.some((item) => item.key.includes("nocheck"))).toBe(false);
    let sel: ThreeWaySelections = { ...emptySelections(), keepUnread: { stories: "d1" } };
    for (const item of items) sel = item.write(sel, choiceOfItem(item, sel) ?? "d1");
    expect(changesForApply(diff, sel)!.keepUnreadFiles).toBeUndefined();
  });

  it("is said in the summary as kept, with the next publish saving it over GitHub's", () => {
    const diff = unread(everyKind(), "stories", "structure", "x could not be listed completely");
    const items = syncItemsOf(diff);
    const sel = setAllTo(items, emptySelections(), "d1");
    const summary = applySummaryOf(items, syncNoticesOf(diff), sel);
    if (summary.kind !== "ready") throw new Error("pending");
    expect(summary.compositor.find((g) => g.action === "keep")!.names).toContainEqual(byKey(items)["story:nocheck:all"]);
    expect(summary.publish.find((g) => g.action === "overwrite")!.names).toContainEqual(byKey(items)["story:nocheck:all"]);
  });
});

describe("a check whose base GitHub no longer holds", () => {
  it.each(["stories", "pages"] as const)("read at the head alone (%s), has no defaults, as a two-way one", (check) => {
    const diff = everyKind();
    if (check === "stories" && diff.stories.content?.conclusive) diff.stories.content.baseUnresolved = true;
    if (check === "pages" && diff.pages?.conclusive) diff.pages.baseUnresolved = true;
    const chosen = syncItemsOf(diff).filter((item) => item.defaultChoice !== null).map((item) => item.key).sort();
    expect(chosen).toEqual(["story:st-bad", "term:missing:#held"]);
  });
});

describe("the files mock-up's sentences", () => {
  const ts: Record<string, TFunction> = {};
  beforeAll(async () => {
    for (const lng of ["en", "es"] as const) {
      const instance = i18next.createInstance();
      await instance.init({
        lng, defaultNS: "dashboard", interpolation: { escapeValue: false },
        resources: {
          en: { dashboard: enDashboard, objects: enObjects, config: enConfig },
          es: { dashboard: esDashboard, objects: esObjects, config: esConfig },
        },
      });
      ts[lng] = instance.getFixedT(lng, "dashboard");
    }
  });

  /** An unreadable story sheet, and the story texts the check could not compare for a structural cause. */
  function filesDiff(): FullSyncDiff {
    const diff = everyKind();
    diff.objects = { ...diff.objects, newObjects: [], changedObjects: [], missingObjects: [] };
    diff.stories = {
      newStories: [], missingStories: [],
      changedStories: [{ story_id: "allegorical", title: "The Allegorical Woman", changedFields: ["title"], conflictFields: [], conflict: false, d1Values: {}, repoValues: {} }],
      content: { conclusive: false, reason: "telar-content/texts/stories could not be listed completely", cause: "structure" },
    };
    diff.config = { changedFields: [], versionChange: null };
    diff.glossary = { added: [], changed: [], removed: [] };
    diff.pages = { conclusive: true, suppressedEditorOnly: 0, changes: [], files: [], additions: [] };
    diff.unreadable = [{ file: "allegorical-woman.csv", storyIds: ["allegorical"], effect: "left_out", notice: false }];
    return diff;
  }

  it("asks for a version for the stories while they have none", () => {
    const items = syncItemsOf(filesDiff());
    const summary = applySummaryOf(items, syncNoticesOf(filesDiff()), emptySelections());
    expect(applySentences(summary, ts.en, "en")).toEqual(["Choose a version for 2 stories. Apply waits until you do."]);
    expect(applySentences(summary, ts.es, "es")).toEqual(["Elige una versión para 2 historias. Después podrás aplicar tus elecciones."]);
  });

  it("says GitHub's version is taken and repaired, and the Compositor's text kept over GitHub's", () => {
    const items = byKey(syncItemsOf(filesDiff()));
    let sel = items["story:allegorical"].write(emptySelections(), "repo");
    sel = items["story:nocheck:all"].write(sel, "d1");
    const summary = applySummaryOf(Object.values(items), syncNoticesOf(filesDiff()), sel);
    expect(applySentences(summary, ts.en, "en")).toEqual([
      "The Compositor takes GitHub's version of allegorical-woman.csv and keeps its own version of your stories.",
      "Your next publish repairs allegorical-woman.csv and saves the Compositor's version of your stories over GitHub's.",
    ]);
    expect(applySentences(summary, ts.es, "es")).toEqual([
      "El Compositor usa la versión de GitHub de allegorical-woman.csv y conserva su propia versión de tus historias.",
      "La próxima vez que publiques, se reparará allegorical-woman.csv y la versión del Compositor reemplazará la de GitHub en tus historias.",
    ]);
  });
});

describe("an image file with no object", () => {
  /** `everyKind` with only two image files GitHub added: map.jpg, and map.png, which shares its stem. */
  function imagesOnly(): FullSyncDiff {
    const diff = everyKind();
    diff.objects = {
      newObjects: [], changedObjects: [], missingObjects: [], reordered: null,
      unregisteredFiles: [{ object_id: "map", filename: "map.jpg" }, { object_id: "plan", filename: "plan.png" }],
    };
    diff.stories = { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, suppressedEditorOnly: 0, changes: [] } };
    diff.config = { changedFields: [], versionChange: null };
    diff.glossary = { added: [], changed: [], removed: [] };
    diff.pages = { conclusive: true, suppressedEditorOnly: 0, changes: [], files: [], additions: [] };
    return diff;
  }

  it("is an item adding it as an object by default, its note naming the id", () => {
    const items = syncItemsOf(imagesOnly());
    const item = byKey(items)["image:map.jpg"];
    expect(item).toMatchObject({ kind: "image", name: "map.jpg", defaultChoice: "repo", both: false, what: { key: "sync_modal.review.img_what" } });
    expect(item.options).toEqual([
      { choice: "repo", label: "sync_modal.review.img_add", note: "sync_modal.review.img_add_note", noteValues: { id: "map" }, does: "add" },
      { choice: "d1", label: "sync_modal.review.img_skip", note: "sync_modal.review.img_skip_note", does: "skip" },
    ]);
    expect(undecidedItems(items, emptySelections())).toEqual([]);
  });

  it("is listed after the objects, before the stories", () => {
    const diff = everyKind();
    diff.objects = { ...diff.objects, unregisteredFiles: [{ object_id: "map", filename: "map.jpg" }] };
    const keys = syncItemsOf(diff).map((item) => item.key);
    const at = keys.indexOf("image:map.jpg");
    expect(keys.slice(0, at).every((key) => key.startsWith("object:"))).toBe(true);
    expect(keys.slice(at + 1).some((key) => key.startsWith("object:"))).toBe(false);
  });

  it("sends the stems of the files added, and none of those left out", () => {
    const diff = imagesOnly();
    const items = syncItemsOf(diff);
    expect(changesForApply(diff, emptySelections())?.objects.unregisteredObjectIds).toEqual(["map", "plan"]);
    const skipped = byKey(items)["image:plan.png"].write(emptySelections(), "d1");
    expect(changesForApply(diff, skipped)?.objects.unregisteredObjectIds).toEqual(["map"]);
    expect(changesForApply(diff, setAllTo(items, emptySelections(), "d1"))?.objects.unregisteredObjectIds).toEqual([]);
  });

  it("sends a stem two files share once", () => {
    const diff = imagesOnly();
    diff.objects.unregisteredFiles = [{ object_id: "map", filename: "map.jpg" }, { object_id: "map", filename: "map.png" }];
    expect(changesForApply(diff, emptySelections())?.objects.unregisteredObjectIds).toEqual(["map"]);
  });

  it("says in When you apply that it adds or does not add the file", () => {
    const items = syncItemsOf(imagesOnly());
    const skipped = byKey(items)["image:plan.png"].write(emptySelections(), "d1");
    const summary = applySummaryOf(items, syncNoticesOf(imagesOnly()), skipped);
    expect(summary).toMatchObject({
      kind: "ready",
      compositor: [{ action: "add", names: [expect.objectContaining({ name: "map.jpg" })] }, { action: "skip", names: [expect.objectContaining({ name: "plan.png" })] }],
      publish: [],
    });
  });

  it("is a change the check does not record the head over", async () => {
    const { hasDiffChanges } = await import("~/components/features/dashboard/sync-changes");
    expect(hasDiffChanges(imagesOnly())).toBe(true);
  });

  it("carries the objects record the check loaded to the apply", () => {
    const diff = { ...imagesOnly(), objectsReadSha: "e".repeat(40) };
    expect(changesForApply(diff, emptySelections())?.objectsReadSha).toBe("e".repeat(40));
  });

  it("reads the note with the id in each language", async () => {
    for (const [lng, catalogue] of [["en", enDashboard], ["es", esDashboard]] as const) {
      const instance = i18next.createInstance();
      await instance.init({ lng, resources: { [lng]: { dashboard: catalogue } }, defaultNS: "dashboard", interpolation: { escapeValue: false } });
      expect(instance.t("sync_modal.review.img_add_note", { id: "map" })).toContain("map");
      expect(instance.t("sync_modal.review.img_add_note", { id: "map" })).not.toContain("{{id}}");
    }
  });
});

describe("a check whose only change is GitHub's Telar version", () => {
  function versionOnly(): FullSyncDiff {
    const diff = everyKind();
    diff.objects = { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null };
    diff.stories = { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, suppressedEditorOnly: 0, changes: [] } };
    diff.glossary = { added: [], changed: [], removed: [] };
    diff.pages = { conclusive: true, suppressedEditorOnly: 0, changes: [], files: [], additions: [] };
    diff.unreadable = [];
    diff.config = { changedFields: [], versionChange: null };
    return diff;
  }

  it("is a change the check does not record the head over", async () => {
    const { hasDiffChanges } = await import("~/components/features/dashboard/sync-changes");
    expect(hasDiffChanges(versionOnly())).toBe(false);
    const diff = versionOnly();
    diff.config = { changedFields: [], versionChange: { direction: "ahead", repoVersion: "1.2.0", d1Version: "1.1.0" } };
    expect(hasDiffChanges(diff)).toBe(true);
  });
});
