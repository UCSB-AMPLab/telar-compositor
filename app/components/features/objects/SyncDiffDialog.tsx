/**
 * SyncDiffDialog — three-section diff review dialog for object sync.
 *
 * Shows new, changed, and missing objects from the repo sync diff.
 * Each section has checkboxes and apply/cancel controls.
 * Changed objects show per-field diffs with repo/keep-mine radio choices.
 * What opens ticked and chosen, and what the apply posts, is
 * `sync-selections`: a three-way check opens on the full sync's defaults, a
 * two-way one ticks every row and keeps the editor's value of every field.
 * A reorder of objects on GitHub is one line after them, with no choice: it
 * is applied with the sync whatever is ticked.
 * What the check found wrong in objects.csv and the tree is listed above the
 * sections, whether or not there is anything to apply. A `notice` from the
 * page, saying why the list changed, is shown above both.
 *
 * The apply carries the commit the diff was read at (`headSha`), and the
 * server applies only while it is still GitHub's head. The checkboxes and
 * field choices are local to one check: the page keys the dialog on the check
 * it shows, so a new check starts from the defaults.
 *
 * Dismissal (Escape, overlay click) is disabled while `isApplying`, matching
 * the Cancel button's own disabled state — an apply already submitted must
 * not be left with no dialog to surface its outcome in.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle } from "lucide-react";
import { Dialog } from "~/components/ui/Dialog";
import { SheetWarnings } from "~/components/ui/SheetWarnings";
import type { ChangedObject, MissingObject, NewObject, SyncDiff, SyncField } from "~/lib/sync.server";
import { ownValue } from "~/components/features/dashboard/sync-changes";
import {
  buildObjectsSyncPayload,
  changedObjectTicked,
  isThreeWayCheck,
  listsDeletionConflict,
  missingObjectTicked,
  newObjectTicked,
  objectsFieldChoice,
  unregisteredFileTicked,
  type ObjectsSyncSelections,
  type SyncApplyPayload,
} from "./sync-selections";

export type { SyncApplyPayload } from "./sync-selections";

/** A check with nothing on it: no row new, changed or missing, no image file with no row, and no reorder. */
function listsNothing(diff: SyncDiff): boolean {
  const lists = [diff.newObjects, diff.changedObjects, diff.missingObjects, diff.unregisteredFiles];
  return diff.reordered == null && lists.every((list) => list.length === 0);
}

/** A reorder of objects on GitHub: one line, with no choice. */
function OrderChangedLine({ diffData }: { diffData: SyncDiff | null }) {
  const { t } = useTranslation("objects");
  if (diffData?.reordered == null) return null;
  return (
    <p
      data-testid="sync-order-changed"
      className="font-body text-sm text-charcoal bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5"
    >
      {t("sync_order_changed")}
    </p>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  diffData: SyncDiff | null;
  onApply: (payload: SyncApplyPayload) => void;
  isComputing: boolean;
  isApplying: boolean;
  /** Why the list changed, shown above it. */
  notice?: string | null;
}

// Field display labels are translated at render via `t("sync_field.<field>")`
// (objects namespace) — see the diff table header below.

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** A conflict's one-line explanation under its row; nothing for a row that is not one. */
function SyncConflictNote({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="ml-7 mt-1 font-body text-xs text-gray-600">{text}</p>;
}

/** The count of Compositor changes a three-way check left untouched; nothing when none. */
function EditorOnlyNote({ diffData }: { diffData: SyncDiff | null }) {
  const { t } = useTranslation("objects");
  const count = diffData?.suppressedEditorOnly ?? 0;
  if (count === 0) return null;
  return (
    <p data-testid="sync-editor-only" className="font-body text-xs text-gray-500">
      {t("dashboard:sync_modal.editor_only_note", { count })}
    </p>
  );
}

/** Why the list changed, above it; nothing without a notice. */
function SyncNotice({ notice }: { notice?: string | null }) {
  if (!notice) return null;
  return (
    <p className="font-body text-sm text-charcoal bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
      {notice}
    </p>
  );
}

export function SyncDiffDialog({
  open,
  onClose,
  diffData,
  onApply,
  isComputing,
  isApplying,
  notice,
}: Props) {
  const { t } = useTranslation("objects");

  // Checkbox state — object_id -> checked
  const [checkedNew, setCheckedNew] = useState<Record<string, boolean>>({});
  const [checkedChanged, setCheckedChanged] = useState<Record<string, boolean>>({});
  const [checkedMissing, setCheckedMissing] = useState<Record<string, boolean>>({});
  const [checkedUnregistered, setCheckedUnregistered] = useState<Record<string, boolean>>({});

  // Per-field source choices for changed objects: objectId -> fieldName -> "repo"|"d1"
  const [fieldChoices, setFieldChoices] = useState<
    Record<string, Record<string, "repo" | "d1">>
  >({});

  const selections: ObjectsSyncSelections = {
    checkedNew, checkedChanged, checkedMissing, checkedUnregistered, fieldChoices,
  };
  const threeWay = isThreeWayCheck(diffData);

  const getCheckedNew = (obj: NewObject) => newObjectTicked(selections, obj);
  const getCheckedChanged = (objectId: string) => changedObjectTicked(selections, objectId);
  const getCheckedMissing = (obj: MissingObject) => missingObjectTicked(selections, obj);
  const getCheckedUnreg = (objectId: string) => unregisteredFileTicked(selections, objectId);
  const getFieldChoice = (obj: ChangedObject, field: SyncField) => objectsFieldChoice(selections, threeWay, obj, field);

  function setFieldChoice(objectId: string, field: string, choice: "repo" | "d1") {
    setFieldChoices((prev) => ({
      ...prev,
      [objectId]: { ...(ownValue(prev, objectId) ?? {}), [field]: choice },
    }));
  }

  function handleApply() {
    if (!diffData) return;
    onApply(buildObjectsSyncPayload(diffData, selections));
  }

  // A reorder has no box: it is applied with the sync whatever is ticked. A
  // deletion conflict left on its default is a choice too, and applying it
  // records the commit reviewed, as the full sync's does.
  const hasAnyChecked =
    diffData !== null &&
    (diffData.reordered != null ||
      listsDeletionConflict(diffData) ||
      diffData.newObjects.some(getCheckedNew) ||
      diffData.changedObjects.some((o) => getCheckedChanged(o.object_id)) ||
      diffData.missingObjects.some(getCheckedMissing) ||
      diffData.unregisteredFiles.some((f) => getCheckedUnreg(f.object_id)));

  const hasNoChanges = diffData !== null && listsNothing(diffData);

  // While an apply is in flight, Escape and an overlay click must not
  // dismiss the dialog — only its Cancel button is disabled otherwise, so
  // without this guard those two paths would leave the dialog closed with
  // the response's removals and commit window still to be surfaced when it
  // arrives.
  function handleDialogClose() {
    if (isApplying) return;
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleDialogClose}
      className="w-full max-w-2xl sm:min-w-[600px] p-0 overflow-hidden"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="font-heading font-semibold text-lg text-charcoal">
          {t("sync_title")}
        </h2>
        <p className="font-body text-sm text-gray-500 mt-1">
          {t("sync_description")}
        </p>
      </div>

      {/* Content area */}
      <div className="max-h-[55dvh] overflow-y-auto px-6 py-4 space-y-4">
        {/* Loading state */}
        {isComputing && (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-anil border-t-transparent rounded-full animate-spin mr-3" />
            <span className="font-body text-sm text-gray-500">{t("sync_computing")}</span>
          </div>
        )}

        <SyncNotice notice={notice} />

        {!isComputing && diffData && <SheetWarnings warnings={diffData.warnings ?? []} defaultOpen />}

        {!isComputing && <EditorOnlyNote diffData={diffData} />}

        {/* No changes */}
        {!isComputing && hasNoChanges && (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <CheckCircle className="w-10 h-10 text-green-500" />
            <p className="font-body text-sm text-gray-600 text-center">
              {t("sync_no_changes")}
            </p>
          </div>
        )}

        {/* New objects */}
        {!isComputing && diffData && diffData.newObjects.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-heading font-semibold text-sm text-green-700 bg-green-50 border border-green-200 rounded-full px-3 py-0.5">
                {t("sync_new")} ({diffData.newObjects.length})
              </span>
            </div>
            {/* Plain hint while every listed new object stays ticked; a warning
                the moment one is unticked, since that object is not brought in
                and the Compositor's next write of the objects sheet leaves it
                out. An object deleted here is left out as the author meant, so
                it does not raise the warning. The warning is announced through
                a live region present from the first render: a region announces
                a change to its content, not its own arrival or a change of
                role. */}
            {(() => {
              const declined = diffData.newObjects.some((o) => !o.deletedInCompositor && !getCheckedNew(o));
              return (
                <>
                  <p
                    data-testid="sync-new-hint"
                    data-state={declined ? "warning" : "hint"}
                    className={
                      declined
                        ? "font-body text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-2"
                        : "font-body text-xs text-gray-500 mb-2"
                    }
                  >
                    {t("sync_new_hint")}
                  </p>
                  <span data-testid="sync-new-hint-live" aria-live="polite" className="sr-only">
                    {declined ? t("sync_new_hint") : ""}
                  </span>
                </>
              );
            })()}
            <div className="bg-green-50 border border-green-200 rounded-lg divide-y divide-green-100">
              {diffData.newObjects.map((obj) => (
                <div key={obj.object_id} className="px-4 py-2.5 hover:bg-green-100/50 transition-colors">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={getCheckedNew(obj)}
                      onChange={(e) =>
                        setCheckedNew((prev) => ({
                          ...prev,
                          [obj.object_id]: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 rounded border-green-300 accent-green-600"
                    />
                    <span className="font-body text-sm text-charcoal flex-1">
                      {obj.title || t("common:untitled")}
                    </span>
                    <code className="font-mono text-xs text-gray-400">
                      {obj.object_id}
                    </code>
                  </label>
                  <SyncConflictNote text={obj.deletedInCompositor ? t("dashboard:sync_modal.conflict_deleted_here") : null} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Unregistered image files */}
        {!isComputing && diffData && diffData.unregisteredFiles.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-heading font-semibold text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-3 py-0.5">
                {t("sync_unregistered")} ({diffData.unregisteredFiles.length})
              </span>
            </div>
            <p className="font-body text-xs text-gray-500 mb-2">
              {t("sync_unregistered_hint")}
            </p>
            <div className="bg-blue-50 border border-blue-200 rounded-lg divide-y divide-blue-100">
              {diffData.unregisteredFiles.map((file) => (
                <label
                  key={file.object_id}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-blue-100/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={getCheckedUnreg(file.object_id)}
                    onChange={(e) =>
                      setCheckedUnregistered((prev) => ({
                        ...prev,
                        [file.object_id]: e.target.checked,
                      }))
                    }
                    className="w-4 h-4 rounded border-blue-300 accent-blue-600"
                  />
                  <span className="font-body text-sm text-charcoal flex-1">
                    {file.object_id}
                  </span>
                  <code className="font-mono text-xs text-gray-400">
                    {file.filename}
                  </code>
                </label>
              ))}
            </div>
          </section>
        )}

        {/* Changed objects */}
        {!isComputing && diffData && diffData.changedObjects.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-heading font-semibold text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-0.5">
                {t("sync_changed")} ({diffData.changedObjects.length})
              </span>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg divide-y divide-amber-100">
              {diffData.changedObjects.map((obj) => (
                <div key={obj.object_id} className="px-4 py-3">
                  <label className="flex items-center gap-3 cursor-pointer mb-2">
                    <input
                      type="checkbox"
                      checked={getCheckedChanged(obj.object_id)}
                      onChange={(e) =>
                        setCheckedChanged((prev) => ({
                          ...prev,
                          [obj.object_id]: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 rounded border-amber-300 accent-amber-600"
                    />
                    <span className="font-body text-sm font-medium text-charcoal">
                      {obj.title || t("common:untitled")}
                    </span>
                    <code className="font-mono text-xs text-gray-400 ml-auto">
                      {obj.object_id}
                    </code>
                  </label>

                  {/* Per-field diff table */}
                  {getCheckedChanged(obj.object_id) && (
                    <div className="ml-7 space-y-1">
                      {obj.changedFields.map((field) => (
                        <div
                          key={field}
                          className="flex flex-col gap-1 bg-white/70 rounded border border-amber-100 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-body text-xs font-medium text-gray-600 uppercase tracking-wider">
                              {t(`sync_field.${field}`)}
                            </span>
                            {/* Radio choice */}
                            <div className="flex items-center gap-3">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`${obj.object_id}-${field}`}
                                  value="repo"
                                  checked={getFieldChoice(obj, field) === "repo"}
                                  onChange={() =>
                                    setFieldChoice(obj.object_id, field, "repo")
                                  }
                                  className="accent-amber-600"
                                />
                                <span className="font-body text-xs text-amber-700">
                                  {t("sync_use_repo")}
                                </span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`${obj.object_id}-${field}`}
                                  value="d1"
                                  checked={getFieldChoice(obj, field) === "d1"}
                                  onChange={() =>
                                    setFieldChoice(obj.object_id, field, "d1")
                                  }
                                  className="accent-amber-600"
                                />
                                <span className="font-body text-xs text-gray-600">
                                  {t("sync_keep_mine")}
                                </span>
                              </label>
                            </div>
                          </div>
                          <div className="flex gap-2 text-xs font-body mt-0.5">
                            {(() => {
                              const useRepo = getFieldChoice(obj, field) === "repo";
                              return (
                                <>
                                  <div className="flex-1">
                                    <span className="text-gray-400">{t("sync_diff_current")} </span>
                                    <span className={useRepo ? "line-through text-gray-400" : "font-medium text-charcoal"}>
                                      {String(obj.d1Values[field] ?? "—")}
                                    </span>
                                  </div>
                                  <div className="flex-1">
                                    <span className="text-gray-400">{t("sync_diff_repo")} </span>
                                    <span className={useRepo ? "font-medium text-charcoal" : "line-through text-gray-400"}>
                                      {String(obj.repoValues[field] ?? "—")}
                                    </span>
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {!isComputing && <OrderChangedLine diffData={diffData} />}

        {/* Missing objects */}
        {!isComputing && diffData && diffData.missingObjects.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-heading font-semibold text-sm text-red-700 bg-red-50 border border-red-200 rounded-full px-3 py-0.5">
                {t("sync_missing")} ({diffData.missingObjects.length})
              </span>
            </div>
            <p className="font-body text-xs text-gray-500 mb-2">
              {t("sync_missing_warning", { file: diffData.objectsSheet ?? "objects.csv" })}
            </p>
            <div className="bg-red-50 border border-red-200 rounded-lg divide-y divide-red-100">
              {diffData.missingObjects.map((obj) => (
                <div key={obj.object_id} className="px-4 py-2.5">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={getCheckedMissing(obj)}
                      onChange={(e) =>
                        setCheckedMissing((prev) => ({
                          ...prev,
                          [obj.object_id]: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 rounded border-red-300 accent-red-600"
                    />
                    <span className="font-body text-sm text-charcoal flex-1">
                      {obj.title || t("common:untitled")}
                    </span>
                    <code className="font-mono text-xs text-gray-400">
                      {obj.object_id}
                    </code>
                  </label>
                  <SyncConflictNote text={obj.editedInCompositor ? t("dashboard:sync_modal.conflict_deleted_in_repo") : null} />
                  {/* Story usage warning */}
                  {obj.usedByStories.length > 0 && (
                    <div className="ml-7 mt-1 rounded bg-yellow-50 border border-yellow-200 px-2 py-1.5">
                      <p className="font-body text-xs text-yellow-800">
                        {t("sync_missing_used", { count: obj.usedByStories.length })}
                      </p>
                      <ul className="space-y-1">
                        {obj.usedByStories.map((ref, i) => (
                          <li key={i} className="font-body text-xs text-yellow-800">
                            {t("used_in_step", {
                              title: ref.storyTitle || t("untitled_story"),
                              step: ref.stepNumber,
                            })}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 bg-gray-50">
        <button
          type="button"
          onClick={onClose}
          disabled={isApplying}
          className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-5 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:text-fg-disabled"
        >
          {t("sync_cancel")}
        </button>
        {!hasNoChanges && !isComputing && (
          <button
            type="button"
            onClick={handleApply}
            disabled={!hasAnyChecked || isApplying}
            className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:bg-disabled disabled:text-fg-disabled"
          >
            {isApplying && (
              <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
            )}
            {t("sync_apply")}
          </button>
        )}
      </div>
    </Dialog>
  );
}
