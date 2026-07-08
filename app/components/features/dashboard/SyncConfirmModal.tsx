/**
 * This file renders the Sync confirmation modal — the multi-step
 * modal for pulling changes made directly in the GitHub repo back
 * into the compositor. It mounts on the Objects page (the daily
 * home) and opens via the `?sync=1` deep-link that the out-of-sync
 * popover and the publish page's stale-head blocker both point at.
 *
 * Provides a state-machine flow:
 *   1. Confirm — prompt user to check what changed in the repo
 *   2. Computing — diffFetcher submits compute-full-sync-diff intent
 *   3. (Optional) Conflict — warns about unpublished local changes
 *   4. DiffReady — diff display with apply button
 *   5. Applying — applyFetcher submits apply-full-sync intent
 *   6. Success — brief confirmation, then page refresh
 *   7. Failed — error display with retry option
 *
 * Two comparison modes, driven by `diff.classification`:
 *   - three-way (base = repo files at head_sha available): editor-only
 *     changes are suppressed, genuine repo↔editor conflicts are surfaced
 *     inline with a per-field / per-row choice (default keep mine), and the
 *     coarse conflict-warning step is skipped. Apply builds a precise
 *     FullSyncChanges from the selections.
 *   - two-way (base unavailable): today's all-or-nothing behaviour, including
 *     the conflict-warning step keyed off unpublishedCount.
 *
 * The sync intents live on the /dashboard action (the app's shared
 * global endpoint), so every fetcher submit here targets it
 * explicitly — a bare POST would hit the rendering route's own
 * action, which does not handle them.
 *
 * @version v1.4.2-beta
 */

import { useEffect, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import type { FullSyncDiff, FullSyncChanges } from "~/lib/sync.server";
import { configFieldLabel } from "~/lib/activity-display";
import { SyncConflictsBlock } from "./SyncConflictsBlock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Shared useFetcher key so the page hosting the modal can observe the
 * same compute-full-sync-diff response and surface the version-change
 * toast without duplicating the submission.
 */
export const SYNC_DIFF_FETCHER_KEY = "dashboard-sync-diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncStep =
  | "confirm"
  | "computing"
  | "conflict"
  | "diffReady"
  | "applying"
  | "accepting"
  | "success"
  | "acceptedSuccess"
  | "failed";

interface SyncConfirmModalProps {
  open: boolean;
  unpublishedCount: number;
  onClose: () => void;
}

type DiffFetcherData =
  | { ok: true; intent: "compute-full-sync-diff"; diff: FullSyncDiff }
  | { ok: false; intent: "compute-full-sync-diff"; error: string; message?: string }
  | null
  | undefined;

type ApplyFetcherData =
  | { ok: true; intent: "apply-full-sync"; newHeadSha: string }
  | { ok: false; intent: "apply-full-sync"; error: string }
  | { ok: true; intent: "accept-divergence" }
  | { ok: false; intent: "accept-divergence"; error: string; message?: string }
  | null
  | undefined;

/** A per-conflict choice: keep GitHub's value ("repo") or the editor's ("d1"). */
export type ConflictChoice = "repo" | "d1";

/**
 * The user's conflict resolutions, gathered by the three-way diffReady step.
 * Every record defaults to keep-mine when a key is absent, so an untouched
 * modal applies exactly the "Keep my version" product ruling.
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
}

function emptySelections(): ThreeWaySelections {
  return {
    objectFieldChoices: {},
    objectRestore: {},
    objectDelete: {},
    storyChoices: {},
    storyRestore: {},
    configChoices: {},
    glossaryChangedChoices: {},
    glossaryRestore: {},
  };
}

// ---------------------------------------------------------------------------
// Helper: count total changes in a diff
// ---------------------------------------------------------------------------

function hasDiffChanges(diff: FullSyncDiff): boolean {
  return (
    diff.objects.newObjects.length > 0 ||
    diff.objects.changedObjects.length > 0 ||
    diff.objects.missingObjects.length > 0 ||
    diff.stories.newStories.length > 0 ||
    diff.stories.changedStories.length > 0 ||
    diff.stories.missingStories.length > 0 ||
    diff.config.changedFields.length > 0 ||
    diff.glossary.added.length > 0 ||
    diff.glossary.changed.length > 0 ||
    diff.glossary.removed.length > 0
  );
}

// ---------------------------------------------------------------------------
// Helper: build all-or-nothing FullSyncChanges from a FullSyncDiff (two-way)
// ---------------------------------------------------------------------------

function buildAllOrNothingChanges(diff: FullSyncDiff): FullSyncChanges {
  return {
    objects: {
      newObjectIds: diff.objects.newObjects.map((o) => o.object_id),
      changedObjectIds: diff.objects.changedObjects.map((o) => o.object_id),
      fieldChoices: Object.fromEntries(
        diff.objects.changedObjects.map((o) => [
          o.object_id,
          Object.fromEntries(o.changedFields.map((f) => [f, "repo" as const])),
        ])
      ),
      removedObjectIds: diff.objects.missingObjects.map((o) => o.object_id),
      unregisteredObjectIds: [],
    },
    stories: {
      accept: diff.stories.changedStories.map((s) => s.story_id),
      reject: [],
      insertNew: diff.stories.newStories.map((s) => s.story_id),
    },
    config: {
      accept: diff.config.changedFields.map((c) => c.key),
      reject: [],
    },
    glossary: {
      accept: diff.glossary.changed.map((t) => t.term_id),
      reject: [],
      insertNew: diff.glossary.added.map((t) => t.term_id),
    },
  };
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
 *   - Object conflict fields: keep-mine -> "d1" choice, use-repo -> "repo".
 *     Non-conflict fields of a partly-conflicted object stay "repo".
 *   - Story/config/glossary conflict rows: keep-mine -> reject, use-repo ->
 *     accept.
 *   - Deleted-here objects/terms: Restore -> included in newObjectIds /
 *     insertNew; Keep-deleted -> omitted (the default).
 */
export function buildThreeWayChanges(
  diff: FullSyncDiff,
  sel: ThreeWaySelections,
): FullSyncChanges {
  const objChoice = (id: string, field: string): ConflictChoice =>
    sel.objectFieldChoices[id]?.[field] ?? "d1";
  const rowChoice = (map: Record<string, ConflictChoice>, id: string): ConflictChoice =>
    map[id] ?? "d1";

  // --- objects ---
  const newObjectIds = [
    ...diff.objects.newObjects.filter((o) => !o.deletedInCompositor).map((o) => o.object_id),
    ...diff.objects.newObjects
      .filter((o) => o.deletedInCompositor && sel.objectRestore[o.object_id])
      .map((o) => o.object_id),
  ];
  const changedObjectIds = diff.objects.changedObjects.map((o) => o.object_id);
  const fieldChoices: Record<string, Record<string, ConflictChoice>> = {};
  for (const o of diff.objects.changedObjects) {
    const conflictSet = new Set<string>(o.conflictFields);
    fieldChoices[o.object_id] = Object.fromEntries(
      o.changedFields.map((f) => [f, conflictSet.has(f) ? objChoice(o.object_id, f) : "repo"]),
    );
  }
  // Unflagged missing objects are pre-accepted for removal; a deleted-in-repo/
  // edited-here object is removed only when the user explicitly chose Delete
  // (default keep-mine leaves it out, so the residue re-flags missing_from_repo).
  const removedObjectIds = [
    ...diff.objects.missingObjects.filter((o) => !o.editedInCompositor).map((o) => o.object_id),
    ...diff.objects.missingObjects
      .filter((o) => o.editedInCompositor && sel.objectDelete[o.object_id])
      .map((o) => o.object_id),
  ];

  // --- stories ---
  const storyAccept: string[] = [];
  const storyReject: string[] = [];
  for (const s of diff.stories.changedStories) {
    if (!s.conflict) {
      storyAccept.push(s.story_id);
    } else if (rowChoice(sel.storyChoices, s.story_id) === "repo") {
      storyAccept.push(s.story_id);
    } else {
      storyReject.push(s.story_id);
    }
  }

  // --- config ---
  const configAccept: string[] = [];
  const configReject: string[] = [];
  for (const c of diff.config.changedFields) {
    if (!c.conflict) {
      configAccept.push(c.key);
    } else if (rowChoice(sel.configChoices, c.key) === "repo") {
      configAccept.push(c.key);
    } else {
      configReject.push(c.key);
    }
  }

  // --- glossary ---
  const glossAccept: string[] = [];
  const glossReject: string[] = [];
  for (const t of diff.glossary.changed) {
    if (!t.conflict) {
      glossAccept.push(t.term_id);
    } else if (rowChoice(sel.glossaryChangedChoices, t.term_id) === "repo") {
      glossAccept.push(t.term_id);
    } else {
      glossReject.push(t.term_id);
    }
  }
  const glossInsertNew = [
    ...diff.glossary.added.filter((t) => !t.deletedInCompositor).map((t) => t.term_id),
    ...diff.glossary.added
      .filter((t) => t.deletedInCompositor && sel.glossaryRestore[t.term_id])
      .map((t) => t.term_id),
  ];

  // Genuine new stories insert; a deleted-here (repo edited, editor deleted)
  // story inserts only when the user chose Restore (default keep-deleted).
  const storyInsertNew = [
    ...diff.stories.newStories.filter((s) => !s.deletedInCompositor).map((s) => s.story_id),
    ...diff.stories.newStories
      .filter((s) => s.deletedInCompositor && sel.storyRestore[s.story_id])
      .map((s) => s.story_id),
  ];

  return {
    objects: { newObjectIds, changedObjectIds, fieldChoices, removedObjectIds, unregisteredObjectIds: [] },
    stories: { accept: storyAccept, reject: storyReject, insertNew: storyInsertNew },
    config: { accept: configAccept, reject: configReject },
    glossary: { accept: glossAccept, reject: glossReject, insertNew: glossInsertNew },
  };
}

/** True when the three-way diff carries at least one conflict to resolve. */
function hasConflictItems(diff: FullSyncDiff): boolean {
  return (
    diff.objects.changedObjects.some((o) => o.conflictFields.length > 0) ||
    diff.objects.newObjects.some((o) => o.deletedInCompositor) ||
    diff.objects.missingObjects.some((o) => o.editedInCompositor) ||
    diff.stories.changedStories.some((s) => s.conflict) ||
    diff.stories.newStories.some((s) => s.deletedInCompositor) ||
    diff.config.changedFields.some((c) => c.conflict) ||
    diff.glossary.changed.some((t) => t.conflict) ||
    diff.glossary.added.some((t) => t.deletedInCompositor)
  );
}

// ---------------------------------------------------------------------------
// Collapsible category section (pre-accepted, repo-only items)
// ---------------------------------------------------------------------------

interface CategorySectionProps {
  label: string;
  items: string[];
}

function CategorySection({ label, items }: CategorySectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-cream-dark hover:bg-cream-dark/80 transition-colors"
      >
        <span className="font-heading font-semibold text-sm text-charcoal">{label}</span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-charcoal/50" />
        ) : (
          <ChevronDown className="w-4 h-4 text-charcoal/50" />
        )}
      </button>
      {open && (
        <ul className="px-4 py-2 space-y-1 bg-white">
          {items.map((item) => (
            <li key={item} className="font-body text-sm text-charcoal/80">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncConfirmModal({ open, unpublishedCount, onClose }: SyncConfirmModalProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  // Stable fetcher key so the hosting page can subscribe to the same
  // sync-diff response via useFetcher({ key }) and surface the
  // version-change toast (see _app.objects.tsx / useVersionChangeToast).
  const diffFetcher = useFetcher({ key: SYNC_DIFF_FETCHER_KEY });
  const applyFetcher = useFetcher();

  const [step, setStep] = useState<SyncStep>("confirm");
  const [diff, setDiff] = useState<FullSyncDiff | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [selections, setSelections] = useState<ThreeWaySelections>(emptySelections);

  const diffData = diffFetcher.data as DiffFetcherData;
  const applyData = applyFetcher.data as ApplyFetcherData;

  // Reset step when modal opens or closes
  useEffect(() => {
    if (!open) {
      setStep("confirm");
      setDiff(null);
      setErrorMessage("");
      setSelections(emptySelections());
    }
  }, [open]);

  // Handle diff fetcher result. Only act while a compute is in flight: route
  // revalidation after an apply re-runs this effect (unpublishedCount changes)
  // with the same stale diffData, which would otherwise yank a post-apply step
  // back to diffReady/conflict. Guarding on step === "computing" pins it.
  useEffect(() => {
    if (step !== "computing") return;
    if (!diffData) return;
    if (!diffData.ok || diffData.intent !== "compute-full-sync-diff") {
      setErrorMessage(
        diffData.ok ? "" : (diffData.message ?? diffData.error ?? t("unknown_error"))
      );
      setStep("failed");
      return;
    }
    setDiff(diffData.diff);
    setSelections(emptySelections());
    const hasChanges = hasDiffChanges(diffData.diff);
    // Three-way surfaces conflicts inline and precisely, so the coarse
    // conflict-warning step is skipped. Two-way keeps it, keyed off
    // unpublishedCount, exactly as before.
    if (
      hasChanges &&
      diffData.diff.classification === "two-way" &&
      unpublishedCount > 0
    ) {
      setStep("conflict");
    } else {
      setStep("diffReady");
    }
  }, [diffData, unpublishedCount, step]);

  // Handle apply / accept-divergence fetcher result
  useEffect(() => {
    if (!applyData) return;
    if (!applyData.ok) {
      setErrorMessage(applyData.error ?? t("unknown_error"));
      setStep("failed");
      return;
    }
    if (applyData.intent === "accept-divergence") {
      setStep("acceptedSuccess");
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
    if (applyData.intent === "apply-full-sync") {
      setStep("success");
      setTimeout(() => window.location.reload(), 1500);
    }
  }, [applyData]);

  function handleCheckChanges() {
    setStep("computing");
    diffFetcher.submit(
      { intent: "compute-full-sync-diff" },
      { method: "post", action: "/dashboard" }
    );
  }

  function handleApply() {
    if (!diff) return;
    const changes =
      diff.classification === "three-way"
        ? buildThreeWayChanges(diff, selections)
        : buildAllOrNothingChanges(diff);
    setStep("applying");
    applyFetcher.submit(
      { intent: "apply-full-sync", changes: JSON.stringify(changes) },
      { method: "post", action: "/dashboard" }
    );
  }

  function handleAcceptDivergence() {
    setStep("accepting");
    applyFetcher.submit(
      { intent: "accept-divergence" },
      { method: "post", action: "/dashboard" }
    );
  }

  function handlePublishFirst() {
    onClose();
    navigate("/publish");
  }

  // ---------------------------------------------------------------------------
  // Selection setters
  // ---------------------------------------------------------------------------

  function setObjectFieldChoice(objectId: string, field: string, choice: ConflictChoice) {
    setSelections((prev) => ({
      ...prev,
      objectFieldChoices: {
        ...prev.objectFieldChoices,
        [objectId]: { ...(prev.objectFieldChoices[objectId] ?? {}), [field]: choice },
      },
    }));
  }
  function setObjectRestore(objectId: string, restore: boolean) {
    setSelections((prev) => ({
      ...prev,
      objectRestore: { ...prev.objectRestore, [objectId]: restore },
    }));
  }
  function setObjectDelete(objectId: string, del: boolean) {
    setSelections((prev) => ({
      ...prev,
      objectDelete: { ...prev.objectDelete, [objectId]: del },
    }));
  }
  function setStoryRestore(storyId: string, restore: boolean) {
    setSelections((prev) => ({
      ...prev,
      storyRestore: { ...prev.storyRestore, [storyId]: restore },
    }));
  }
  function setRowChoice(kind: "story" | "config" | "glossary", id: string, choice: ConflictChoice) {
    setSelections((prev) => {
      const key =
        kind === "story" ? "storyChoices" : kind === "config" ? "configChoices" : "glossaryChangedChoices";
      return { ...prev, [key]: { ...prev[key], [id]: choice } };
    });
  }
  function setGlossaryRestore(termId: string, restore: boolean) {
    setSelections((prev) => ({
      ...prev,
      glossaryRestore: { ...prev.glossaryRestore, [termId]: restore },
    }));
  }

  // ---------------------------------------------------------------------------
  // Build category sections for the diffReady step (repo-only, pre-accepted)
  // ---------------------------------------------------------------------------

  function buildCategorySections(threeWay: boolean) {
    if (!diff) return [];
    const sections: { label: string; items: string[] }[] = [];

    const itemNew = (name: string) => t("sync_modal.item_new", { name });
    const itemChanged = (name: string) => t("sync_modal.item_changed", { name });
    const itemRemoved = (name: string) => t("sync_modal.item_removed", { name });
    const sectionLabel = (category: string, count: number, anyChanged: boolean) =>
      `${category} (${anyChanged
        ? t("sync_modal.section_count_changed", { count })
        : t("sync_modal.section_count", { count })})`;

    // In three-way mode, conflicts (deleted-here objects, conflict-field
    // objects) move to the dedicated conflicts block, so the category lists
    // show only the pre-accepted repo-only items.
    const newObjects = threeWay
      ? diff.objects.newObjects.filter((o) => !o.deletedInCompositor)
      : diff.objects.newObjects;
    const changedObjects = threeWay
      ? diff.objects.changedObjects.filter((o) => o.conflictFields.length === 0)
      : diff.objects.changedObjects;
    // Deleted-in-repo/edited-here objects render in the conflicts block.
    const missingObjects = threeWay
      ? diff.objects.missingObjects.filter((o) => !o.editedInCompositor)
      : diff.objects.missingObjects;

    const objectItems: string[] = [
      ...newObjects.map((o) => itemNew(o.object_id)),
      ...changedObjects.map((o) => itemChanged(o.object_id)),
      ...missingObjects.map((o) => itemRemoved(o.object_id)),
    ];
    if (objectItems.length > 0) {
      sections.push({
        label: sectionLabel(
          t("sync_modal.objects_category"),
          newObjects.length + changedObjects.length + missingObjects.length,
          changedObjects.length > 0,
        ),
        items: objectItems,
      });
    }

    const storyName = (s: { title?: string | null; story_id: string }) =>
      s.title || t("common:untitled");
    const changedStories = threeWay
      ? diff.stories.changedStories.filter((s) => !s.conflict)
      : diff.stories.changedStories;
    // Deleted-here (repo edited, editor deleted) stories render in the conflicts
    // block, not the pre-accepted category list.
    const newStories = threeWay
      ? diff.stories.newStories.filter((s) => !s.deletedInCompositor)
      : diff.stories.newStories;
    const storyItems: string[] = [
      ...newStories.map((s) => itemNew(storyName(s))),
      ...changedStories.map((s) => itemChanged(storyName(s))),
      ...diff.stories.missingStories.map((s) => itemRemoved(storyName(s))),
    ];
    if (storyItems.length > 0) {
      sections.push({
        label: sectionLabel(
          t("sync_modal.stories_category"),
          newStories.length + changedStories.length + diff.stories.missingStories.length,
          false,
        ),
        items: storyItems,
      });
    }

    const changedConfig = threeWay
      ? diff.config.changedFields.filter((c) => !c.conflict)
      : diff.config.changedFields;
    if (changedConfig.length > 0) {
      sections.push({
        label: sectionLabel(t("sync_modal.config_category"), changedConfig.length, true),
        items: changedConfig.map((c) => configFieldLabel(c.key, t) || t("sync_modal.config_setting")),
      });
    }

    // Glossary category. Three-way filters out conflict (changed) and
    // deleted-here (added) terms — they render in the conflicts block.
    const glossaryName = (tm: { title?: string | null; term_id: string }) => tm.title || tm.term_id;
    const addedTerms = threeWay
      ? diff.glossary.added.filter((tm) => !tm.deletedInCompositor)
      : diff.glossary.added;
    const changedTerms = threeWay
      ? diff.glossary.changed.filter((tm) => !tm.conflict)
      : diff.glossary.changed;
    const glossaryItems: string[] = [
      ...addedTerms.map((tm) => itemNew(glossaryName(tm))),
      ...changedTerms.map((tm) => itemChanged(glossaryName(tm))),
      ...diff.glossary.removed.map((tm) => itemRemoved(glossaryName(tm))),
    ];
    if (glossaryItems.length > 0) {
      sections.push({
        label: sectionLabel(
          t("sync_modal.glossary_category"),
          addedTerms.length + changedTerms.length + diff.glossary.removed.length,
          changedTerms.length > 0,
        ),
        items: glossaryItems,
      });
    }

    return sections;
  }

  const threeWay = diff?.classification === "three-way";
  const categorySections = buildCategorySections(Boolean(threeWay));
  const conflictsPresent = Boolean(diff && threeWay && hasConflictItems(diff));
  const suppressedCount = threeWay ? diff?.suppressedEditorOnly ?? 0 : 0;
  const anythingToApply = categorySections.length > 0 || conflictsPresent;

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg p-0">
      {/* ------------------------------------------------------------------ */}
      {/* Confirm step                                                         */}
      {/* ------------------------------------------------------------------ */}
      {step === "confirm" && (
        <div className="p-6">
          <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
            {t("sync_modal.title")}
          </h3>
          <p className="font-body text-sm text-gray-600 mb-6">
            {t("sync_modal.confirm_body")}
          </p>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleCheckChanges}
              className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.check_changes")}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Computing step                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === "computing" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-terracotta animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.computing")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Conflict step (two-way fallback only)                                */}
      {/* ------------------------------------------------------------------ */}
      {step === "conflict" && (
        <div className="p-6">
          <div className="flex items-start gap-3 mb-5">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-heading font-semibold text-base text-charcoal mb-1">
                {t("sync_modal.title")}
              </h3>
              <p className="font-body text-sm text-gray-600">
                {t("sync_modal.conflict_warning", { count: unpublishedCount })}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setStep("diffReady")}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.sync_anyway")}
            </button>
            <button
              type="button"
              onClick={handlePublishFirst}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-terracotta text-terracotta rounded-full px-5 py-2 hover:bg-terracotta/5 transition-colors"
            >
              {t("sync_modal.publish_first")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* DiffReady step                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === "diffReady" && (
        <div className="p-6">
          <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
            {anythingToApply ? t("sync_modal.changes_found") : t("sync_modal.no_changes")}
          </h3>

          <div className="max-h-[55dvh] overflow-y-auto -mx-2 px-2">
            {/* Conflicts block (three-way, first) */}
            {conflictsPresent && diff && (
              <SyncConflictsBlock
                diff={diff}
                selections={selections}
                onObjectFieldChoice={setObjectFieldChoice}
                onObjectRestore={setObjectRestore}
                onObjectDelete={setObjectDelete}
                onRowChoice={setRowChoice}
                onStoryRestore={setStoryRestore}
                onGlossaryRestore={setGlossaryRestore}
              />
            )}

            {/* Category sections (repo-only, pre-accepted) */}
            {categorySections.length > 0 && (
              <div className="space-y-2 mb-4">
                {categorySections.map((section) => (
                  <CategorySection key={section.label} label={section.label} items={section.items} />
                ))}
              </div>
            )}

            {/* Suppressed editor-only note (three-way) */}
            {suppressedCount > 0 && (
              <p className="font-body text-xs text-gray-500 mb-2">
                {t("sync_modal.editor_only_note", { count: suppressedCount })}
              </p>
            )}

            {anythingToApply && (
              <p className="font-body text-sm text-gray-600 mb-2">
                {t("sync_modal.use_compositor_helper")}
              </p>
            )}
            {!anythingToApply && (
              <p className="font-body text-sm text-gray-600 mb-2">
                {t("sync_modal.no_changes_body")}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-3 justify-end mt-4">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {anythingToApply ? t("cancel") : t("sync_modal.close")}
            </button>
            {anythingToApply && (
              <>
                <button
                  type="button"
                  onClick={handleAcceptDivergence}
                  className="font-heading font-semibold text-sm uppercase tracking-wider border border-charcoal text-charcoal rounded-full px-5 py-2 hover:bg-charcoal hover:text-cream transition-colors"
                >
                  {t("sync_modal.use_compositor_version")}
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
                >
                  {t("sync_modal.apply_sync")}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Applying step                                                        */}
      {/* ------------------------------------------------------------------ */}
      {step === "applying" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-terracotta animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.applying")}</p>
        </div>
      )}

      {/* Accepting (accept-divergence in flight) */}
      {step === "accepting" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-charcoal animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.accepting")}</p>
        </div>
      )}

      {/* Accept-divergence succeeded */}
      {step === "acceptedSuccess" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="font-body text-sm text-gray-700">{t("sync_modal.accepted_success")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Success step                                                         */}
      {/* ------------------------------------------------------------------ */}
      {step === "success" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="font-body text-sm text-gray-700">{t("sync_modal.success")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Failed step                                                          */}
      {/* ------------------------------------------------------------------ */}
      {step === "failed" && (
        <div className="p-6">
          <div className="flex flex-col items-center gap-3 py-6 mb-4">
            <AlertCircle className="w-10 h-10 text-red-500" />
            <p className="font-body text-sm text-gray-700 text-center">{errorMessage}</p>
          </div>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.retry")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
