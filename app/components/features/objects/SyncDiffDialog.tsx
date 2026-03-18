/**
 * SyncDiffDialog — three-section diff review dialog for object sync.
 *
 * Shows new, changed, and missing objects from the repo sync diff.
 * Each section has checkboxes (checked by default) and apply/cancel controls.
 * Changed objects show per-field diffs with repo/keep-mine radio choices.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle } from "lucide-react";
import { Dialog } from "~/components/ui/Dialog";
import type { SyncDiff, SyncField } from "~/lib/sync.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncApplyPayload {
  newObjectIds: string[];
  changedObjectIds: string[];
  fieldChoices: Record<string, Record<string, "repo" | "d1">>;
  removedObjectIds: string[];
  unregisteredObjectIds: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  diffData: SyncDiff | null;
  onApply: (payload: SyncApplyPayload) => void;
  isComputing: boolean;
  isApplying: boolean;
}

// Field display labels — used for diff table headers
const FIELD_LABELS: Record<SyncField, string> = {
  title: "Title",
  creator: "Creator",
  description: "Description",
  period: "Period",
  year: "Year",
  object_type: "Object type",
  subjects: "Subjects",
  source: "Source",
  credit: "Credit",
  featured: "Featured",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncDiffDialog({
  open,
  onClose,
  diffData,
  onApply,
  isComputing,
  isApplying,
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

  // Initialise checked state when diff data arrives
  function getCheckedNew(objectId: string): boolean {
    return objectId in checkedNew ? checkedNew[objectId] : true;
  }
  function getCheckedChanged(objectId: string): boolean {
    return objectId in checkedChanged ? checkedChanged[objectId] : true;
  }
  function getCheckedMissing(objectId: string): boolean {
    return objectId in checkedMissing ? checkedMissing[objectId] : true;
  }
  function getCheckedUnreg(objectId: string): boolean {
    return objectId in checkedUnregistered ? checkedUnregistered[objectId] : true;
  }
  function getFieldChoice(objectId: string, field: string): "repo" | "d1" {
    return fieldChoices[objectId]?.[field] ?? "repo";
  }

  function setFieldChoice(objectId: string, field: string, choice: "repo" | "d1") {
    setFieldChoices((prev) => ({
      ...prev,
      [objectId]: { ...(prev[objectId] ?? {}), [field]: choice },
    }));
  }

  function handleApply() {
    if (!diffData) return;

    const newObjectIds = diffData.newObjects
      .map((o) => o.object_id)
      .filter((id) => getCheckedNew(id));

    const changedObjectIds = diffData.changedObjects
      .map((o) => o.object_id)
      .filter((id) => getCheckedChanged(id));

    const removedObjectIds = diffData.missingObjects
      .map((o) => o.object_id)
      .filter((id) => getCheckedMissing(id));

    const unregisteredObjectIds = diffData.unregisteredFiles
      .map((f) => f.object_id)
      .filter((id) => getCheckedUnreg(id));

    onApply({
      newObjectIds,
      changedObjectIds,
      fieldChoices,
      removedObjectIds,
      unregisteredObjectIds,
    });
  }

  const hasAnyChecked =
    diffData !== null &&
    (diffData.newObjects.some((o) => getCheckedNew(o.object_id)) ||
      diffData.changedObjects.some((o) => getCheckedChanged(o.object_id)) ||
      diffData.missingObjects.some((o) => getCheckedMissing(o.object_id)) ||
      diffData.unregisteredFiles.some((f) => getCheckedUnreg(f.object_id)));

  const hasNoChanges =
    diffData !== null &&
    diffData.newObjects.length === 0 &&
    diffData.changedObjects.length === 0 &&
    diffData.missingObjects.length === 0 &&
    diffData.unregisteredFiles.length === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-[50vw] min-w-[600px] w-full mx-4 p-0 overflow-hidden"
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
      <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-4">
        {/* Loading state */}
        {isComputing && (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-periwinkle border-t-transparent rounded-full animate-spin mr-3" />
            <span className="font-body text-sm text-gray-500">Computing diff…</span>
          </div>
        )}

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
            <div className="bg-green-50 border border-green-200 rounded-lg divide-y divide-green-100">
              {diffData.newObjects.map((obj) => (
                <label
                  key={obj.object_id}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-green-100/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={getCheckedNew(obj.object_id)}
                    onChange={(e) =>
                      setCheckedNew((prev) => ({
                        ...prev,
                        [obj.object_id]: e.target.checked,
                      }))
                    }
                    className="w-4 h-4 rounded border-green-300 accent-green-600"
                  />
                  <span className="font-body text-sm text-charcoal flex-1">
                    {obj.title || obj.object_id}
                  </span>
                  <code className="font-mono text-xs text-gray-400">
                    {obj.object_id}
                  </code>
                </label>
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
                      {obj.title || obj.object_id}
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
                              {FIELD_LABELS[field]}
                            </span>
                            {/* Radio choice */}
                            <div className="flex items-center gap-3">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`${obj.object_id}-${field}`}
                                  value="repo"
                                  checked={getFieldChoice(obj.object_id, field) === "repo"}
                                  onChange={() =>
                                    setFieldChoice(obj.object_id, field, "repo")
                                  }
                                  className="accent-amber-600"
                                />
                                <span className="font-body text-xs text-amber-700">
                                  Use repo
                                </span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`${obj.object_id}-${field}`}
                                  value="d1"
                                  checked={getFieldChoice(obj.object_id, field) === "d1"}
                                  onChange={() =>
                                    setFieldChoice(obj.object_id, field, "d1")
                                  }
                                  className="accent-amber-600"
                                />
                                <span className="font-body text-xs text-gray-600">
                                  Keep mine
                                </span>
                              </label>
                            </div>
                          </div>
                          <div className="flex gap-2 text-xs font-body mt-0.5">
                            {(() => {
                              const useRepo = getFieldChoice(obj.object_id, field) === "repo";
                              return (
                                <>
                                  <div className="flex-1">
                                    <span className="text-gray-400">Current: </span>
                                    <span className={useRepo ? "line-through text-gray-400" : "font-medium text-charcoal"}>
                                      {String(obj.d1Values[field] ?? "—")}
                                    </span>
                                  </div>
                                  <div className="flex-1">
                                    <span className="text-gray-400">Repo: </span>
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

        {/* Missing objects */}
        {!isComputing && diffData && diffData.missingObjects.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className="font-heading font-semibold text-sm text-red-700 bg-red-50 border border-red-200 rounded-full px-3 py-0.5">
                {t("sync_missing")} ({diffData.missingObjects.length})
              </span>
            </div>
            <p className="font-body text-xs text-gray-500 mb-2">
              {t("sync_missing_warning")}
            </p>
            <div className="bg-red-50 border border-red-200 rounded-lg divide-y divide-red-100">
              {diffData.missingObjects.map((obj) => (
                <div key={obj.object_id} className="px-4 py-2.5">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={getCheckedMissing(obj.object_id)}
                      onChange={(e) =>
                        setCheckedMissing((prev) => ({
                          ...prev,
                          [obj.object_id]: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 rounded border-red-300 accent-red-600"
                    />
                    <span className="font-body text-sm text-charcoal flex-1">
                      {obj.title || obj.object_id}
                    </span>
                    <code className="font-mono text-xs text-gray-400">
                      {obj.object_id}
                    </code>
                  </label>
                  {/* Story usage warning */}
                  {obj.usedByStories.length > 0 && (
                    <div className="ml-7 mt-1 rounded bg-yellow-50 border border-yellow-200 px-2 py-1.5">
                      <p className="font-body text-xs text-yellow-800">
                        Used in{" "}
                        {obj.usedByStories
                          .map(
                            (ref) =>
                              `${ref.storyTitle || "unnamed story"} (step ${ref.stepNumber})`
                          )
                          .join(", ")}
                      </p>
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
          className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-5 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:opacity-50"
        >
          {t("sync_cancel")}
        </button>
        {!hasNoChanges && !isComputing && (
          <button
            type="button"
            onClick={handleApply}
            disabled={!hasAnyChecked || isApplying}
            className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-periwinkle hover:bg-periwinkle-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:opacity-50"
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
