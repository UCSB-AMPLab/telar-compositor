/**
 * The three-way sync conflicts block — the part of the Sync review modal that
 * surfaces changes made in BOTH GitHub and the Compositor since the last
 * reconciliation, each with an explicit keep-mine / use-GitHub choice.
 *
 * Extracted from SyncConfirmModal to keep that file within the comprehension
 * threshold. Purely presentational: it renders the cards and reports the
 * user's picks back through callbacks; the modal owns the selection state and
 * the apply builder. The value-pair + per-field radio layout mirrors the
 * objects-tab SyncDiffDialog so the two conflict UIs read the same.
 *
 * @version v1.4.2-beta
 */

import { useTranslation } from "react-i18next";
import type { FullSyncDiff } from "~/lib/sync.server";
import type { ConflictChoice, ThreeWaySelections } from "./SyncConfirmModal";
import { configFieldLabel } from "~/lib/activity-display";

// ---------------------------------------------------------------------------
// Small presentational helpers (objects-tab visual pattern)
// ---------------------------------------------------------------------------

interface ChoiceRadiosProps {
  name: string;
  choice: ConflictChoice;
  onChoice: (c: ConflictChoice) => void;
  repoLabel: string;
  mineLabel: string;
}

function ChoiceRadios({ name, choice, onChoice, repoLabel, mineLabel }: ChoiceRadiosProps) {
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="radio"
          name={name}
          value="repo"
          checked={choice === "repo"}
          onChange={() => onChoice("repo")}
          className="accent-terracotta"
        />
        <span className="font-body text-xs text-terracotta">{repoLabel}</span>
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="radio"
          name={name}
          value="d1"
          checked={choice === "d1"}
          onChange={() => onChoice("d1")}
          className="accent-terracotta"
        />
        <span className="font-body text-xs text-gray-600">{mineLabel}</span>
      </label>
    </div>
  );
}

interface ValuePairProps {
  repoLabel: string;
  mineLabel: string;
  repoValue: string;
  mineValue: string;
  choice: ConflictChoice;
}

/** The GitHub / Compositor value pair, striking through the unselected side. */
function ValuePair({ repoLabel, mineLabel, repoValue, mineValue, choice }: ValuePairProps) {
  const useRepo = choice === "repo";
  return (
    <div className="flex gap-2 text-xs font-body mt-0.5">
      <div className="flex-1">
        <span className="text-gray-400">{repoLabel}: </span>
        <span className={useRepo ? "font-medium text-charcoal" : "line-through text-gray-400"}>
          {repoValue}
        </span>
      </div>
      <div className="flex-1">
        <span className="text-gray-400">{mineLabel}: </span>
        <span className={useRepo ? "line-through text-gray-400" : "font-medium text-charcoal"}>
          {mineValue}
        </span>
      </div>
    </div>
  );
}

function displayValue(v: string | boolean | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

// ---------------------------------------------------------------------------
// Conflicts block
// ---------------------------------------------------------------------------

interface Props {
  diff: FullSyncDiff;
  selections: ThreeWaySelections;
  onObjectFieldChoice: (objectId: string, field: string, choice: ConflictChoice) => void;
  onObjectRestore: (objectId: string, restore: boolean) => void;
  onObjectDelete: (objectId: string, del: boolean) => void;
  onRowChoice: (kind: "story" | "config" | "glossary", id: string, choice: ConflictChoice) => void;
  onStoryRestore: (storyId: string, restore: boolean) => void;
  onGlossaryRestore: (termId: string, restore: boolean) => void;
}

export function SyncConflictsBlock({
  diff,
  selections,
  onObjectFieldChoice,
  onObjectRestore,
  onObjectDelete,
  onRowChoice,
  onStoryRestore,
  onGlossaryRestore,
}: Props) {
  const { t } = useTranslation("dashboard");
  const useRepoLabel = t("sync_modal.conflict_use_repo");
  const keepMineLabel = t("sync_modal.conflict_keep_mine");
  const repoValueLabel = t("sync_modal.conflict_value_repo");
  const mineValueLabel = t("sync_modal.conflict_value_mine");
  // Object field label lives in the objects namespace (shared with the
  // objects-tab diff dialog).
  const objectFieldLabel = (field: string) => t(`objects:sync_field.${field}`);

  return (
    <div className="mb-6">
      <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">
        {t("sync_modal.conflicts_heading")}
      </h4>
      <p className="font-body text-sm text-gray-600 mb-3">{t("sync_modal.conflicts_intro")}</p>
      <div className="space-y-2">
        {/* Object field conflicts */}
        {diff.objects.changedObjects
          .filter((o) => o.conflictFields.length > 0)
          .map((o) => {
            // Repo-only changed fields on a conflicted object apply
            // pre-accepted, and the object is excluded from the category
            // lists — so they are listed here, muted and without a choice,
            // or the card would silently under-describe the apply.
            const conflictSet = new Set<string>(o.conflictFields);
            const repoOnlyFields = o.changedFields.filter((f) => !conflictSet.has(f));
            return (
            <div key={`obj-${o.object_id}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-body text-sm font-medium text-charcoal">
                  {o.title || t("common:untitled")}
                </span>
                <code className="font-mono text-xs text-gray-400">{o.object_id}</code>
              </div>
              <div className="space-y-1">
                {o.conflictFields.map((field) => {
                  const choice = selections.objectFieldChoices[o.object_id]?.[field] ?? "d1";
                  return (
                    <div key={field} className="flex flex-col gap-1 bg-white/70 rounded border border-amber-100 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-body text-xs font-medium text-gray-600 uppercase tracking-wider">
                          {objectFieldLabel(field)}
                        </span>
                        <ChoiceRadios
                          name={`obj-${o.object_id}-${field}`}
                          choice={choice}
                          onChoice={(c) => onObjectFieldChoice(o.object_id, field, c)}
                          repoLabel={useRepoLabel}
                          mineLabel={keepMineLabel}
                        />
                      </div>
                      <ValuePair
                        repoLabel={repoValueLabel}
                        mineLabel={mineValueLabel}
                        repoValue={displayValue(o.repoValues[field])}
                        mineValue={displayValue(o.d1Values[field])}
                        choice={choice}
                      />
                    </div>
                  );
                })}
                {repoOnlyFields.length > 0 && (
                  <div className="rounded border border-amber-100 bg-white/40 px-3 py-2">
                    <p className="font-body text-xs text-gray-500 mb-1">
                      {t("sync_modal.conflict_also_applying")}
                    </p>
                    <div className="space-y-0.5">
                      {repoOnlyFields.map((field) => (
                        <div key={field} className="flex items-baseline gap-2 text-xs font-body">
                          <span className="font-medium text-gray-500 uppercase tracking-wider">
                            {objectFieldLabel(field)}
                          </span>
                          <span className="text-gray-600">{displayValue(o.repoValues[field])}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            );
          })}

        {/* Deleted-here object conflicts */}
        {diff.objects.newObjects
          .filter((o) => o.deletedInCompositor)
          .map((o) => {
            const restore = selections.objectRestore[o.object_id] ?? false;
            return (
              <div key={`del-${o.object_id}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-body text-sm font-medium text-charcoal">
                    {o.title || o.object_id}
                  </span>
                  <code className="font-mono text-xs text-gray-400">{o.object_id}</code>
                </div>
                <p className="font-body text-xs text-gray-600 mb-2">{t("sync_modal.conflict_deleted_here")}</p>
                <ChoiceRadios
                  name={`del-obj-${o.object_id}`}
                  choice={restore ? "repo" : "d1"}
                  onChoice={(c) => onObjectRestore(o.object_id, c === "repo")}
                  repoLabel={t("sync_modal.conflict_restore")}
                  mineLabel={t("sync_modal.conflict_keep_deleted")}
                />
              </div>
            );
          })}

        {/* Deleted-in-repo / edited-here object conflicts */}
        {diff.objects.missingObjects
          .filter((o) => o.editedInCompositor)
          .map((o) => {
            const del = selections.objectDelete[o.object_id] ?? false;
            return (
              <div key={`del-repo-${o.object_id}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-body text-sm font-medium text-charcoal">
                    {o.title || o.object_id}
                  </span>
                  <code className="font-mono text-xs text-gray-400">{o.object_id}</code>
                </div>
                <p className="font-body text-xs text-gray-600 mb-2">{t("sync_modal.conflict_deleted_in_repo")}</p>
                <ChoiceRadios
                  name={`del-repo-obj-${o.object_id}`}
                  choice={del ? "repo" : "d1"}
                  onChoice={(c) => onObjectDelete(o.object_id, c === "repo")}
                  repoLabel={t("sync_modal.conflict_delete")}
                  mineLabel={keepMineLabel}
                />
              </div>
            );
          })}

        {/* Config conflicts (row grain) */}
        {diff.config.changedFields
          .filter((c) => c.conflict)
          .map((c) => {
            const choice = selections.configChoices[c.key] ?? "d1";
            return (
              <div key={`cfg-${c.key}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-body text-xs font-medium text-gray-600 uppercase tracking-wider">
                    {configFieldLabel(c.key, t) || t("sync_modal.config_setting")}
                  </span>
                  <ChoiceRadios
                    name={`cfg-${c.key}`}
                    choice={choice}
                    onChoice={(ch) => onRowChoice("config", c.key, ch)}
                    repoLabel={useRepoLabel}
                    mineLabel={keepMineLabel}
                  />
                </div>
                <ValuePair
                  repoLabel={repoValueLabel}
                  mineLabel={mineValueLabel}
                  repoValue={displayValue(c.repoValue)}
                  mineValue={displayValue(c.d1Value)}
                  choice={choice}
                />
              </div>
            );
          })}

        {/* Story conflicts (row grain) */}
        {diff.stories.changedStories
          .filter((s) => s.conflict)
          .map((s) => {
            const choice = selections.storyChoices[s.story_id] ?? "d1";
            return (
              <div key={`story-${s.story_id}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-body text-sm font-medium text-charcoal">
                    {s.title || t("common:untitled")}
                  </span>
                  <ChoiceRadios
                    name={`story-${s.story_id}`}
                    choice={choice}
                    onChoice={(ch) => onRowChoice("story", s.story_id, ch)}
                    repoLabel={useRepoLabel}
                    mineLabel={keepMineLabel}
                  />
                </div>
                {s.changedFields.map((field) => (
                  <ValuePair
                    key={field}
                    repoLabel={repoValueLabel}
                    mineLabel={mineValueLabel}
                    repoValue={displayValue(s.repoValues[field as keyof typeof s.repoValues])}
                    mineValue={displayValue(s.d1Values[field as keyof typeof s.d1Values])}
                    choice={choice}
                  />
                ))}
              </div>
            );
          })}

        {/* Deleted-here story conflicts (repo edited, editor deleted) */}
        {diff.stories.newStories
          .filter((s) => s.deletedInCompositor)
          .map((s) => {
            const restore = selections.storyRestore[s.story_id] ?? false;
            return (
              <div key={`story-del-${s.story_id}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-body text-sm font-medium text-charcoal">
                    {s.title || s.story_id}
                  </span>
                </div>
                <p className="font-body text-xs text-gray-600 mb-2">{t("sync_modal.conflict_deleted_here")}</p>
                <ChoiceRadios
                  name={`story-del-${s.story_id}`}
                  choice={restore ? "repo" : "d1"}
                  onChoice={(c) => onStoryRestore(s.story_id, c === "repo")}
                  repoLabel={t("sync_modal.conflict_restore")}
                  mineLabel={t("sync_modal.conflict_keep_deleted")}
                />
              </div>
            );
          })}

        {/* Glossary changed conflicts (row grain) */}
        {diff.glossary.changed
          .filter((tm) => tm.conflict)
          .map((tm) => {
            const choice = selections.glossaryChangedChoices[tm.term_id] ?? "d1";
            return (
              <div key={`gloss-${tm.term_id}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-body text-sm font-medium text-charcoal">
                    {tm.d1Title || tm.repoTitle || tm.term_id}
                  </span>
                  <ChoiceRadios
                    name={`gloss-${tm.term_id}`}
                    choice={choice}
                    onChoice={(ch) => onRowChoice("glossary", tm.term_id, ch)}
                    repoLabel={useRepoLabel}
                    mineLabel={keepMineLabel}
                  />
                </div>
                {tm.d1Title !== tm.repoTitle && (
                  <ValuePair
                    repoLabel={repoValueLabel}
                    mineLabel={mineValueLabel}
                    repoValue={displayValue(tm.repoTitle)}
                    mineValue={displayValue(tm.d1Title)}
                    choice={choice}
                  />
                )}
                {tm.d1Definition !== tm.repoDefinition && (
                  <ValuePair
                    repoLabel={repoValueLabel}
                    mineLabel={mineValueLabel}
                    repoValue={displayValue(tm.repoDefinition)}
                    mineValue={displayValue(tm.d1Definition)}
                    choice={choice}
                  />
                )}
              </div>
            );
          })}

        {/* Deleted-here glossary terms */}
        {diff.glossary.added
          .filter((tm) => tm.deletedInCompositor)
          .map((tm) => {
            const restore = selections.glossaryRestore[tm.term_id] ?? false;
            return (
              <div key={`gloss-del-${tm.term_id}`} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-body text-sm font-medium text-charcoal">{tm.title || tm.term_id}</span>
                </div>
                <p className="font-body text-xs text-gray-600 mb-2">{t("sync_modal.conflict_deleted_here")}</p>
                <ChoiceRadios
                  name={`gloss-del-${tm.term_id}`}
                  choice={restore ? "repo" : "d1"}
                  onChoice={(c) => onGlossaryRestore(tm.term_id, c === "repo")}
                  repoLabel={t("sync_modal.conflict_restore")}
                  mineLabel={t("sync_modal.conflict_keep_deleted")}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}
