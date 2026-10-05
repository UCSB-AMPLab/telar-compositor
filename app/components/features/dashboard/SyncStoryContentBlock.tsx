/**
 * The sync dialog's story content changes: the stories whose steps or panels
 * changed on GitHub, one card per story, each with the one choice that covers
 * both the story's content and, when they changed too, its row fields (title,
 * subtitle, byline, private, sections).
 *
 * Every card carries a choice the author can take here. A change GitHub alone
 * made is a checkbox, taken by default; deleted steps are a checkbox, left
 * unticked by default; a conflict uses the conflicts block's keep-mine /
 * use-GitHub radios, keeping the Compositor's version by default, or
 * GitHub's when the recorded base could not say which side changed; a story
 * Telar cannot read has the single choice of keeping the Compositor's
 * version, which the next publish writes back. Presentational: the modal owns
 * the choices and the builders that turn them into the accept's payload.
 *
 * @version v1.5.0-beta
 */

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { UnreadableReason } from "~/lib/story-canonical";
import type { StoryContentChange } from "~/lib/story-content.server";
import type { FullSyncDiff } from "~/lib/sync.server";
import type { ConflictChoice } from "./sync-changes";
import { ChoiceRadios, ValuePair, displayValue } from "./SyncConflictsBlock";

interface Props {
  changes: readonly StoryContentChange[];
  /** The row changes of the same stories, which the story's choice also covers. */
  rows: FullSyncDiff["stories"]["changedStories"];
  choiceOf: (change: StoryContentChange) => ConflictChoice;
  onChoice: (storyId: string, choice: ConflictChoice) => void;
}

export function SyncStoryContentBlock({ changes, rows, choiceOf, onChoice }: Props) {
  const { t } = useTranslation("dashboard");
  if (changes.length === 0) return null;
  return (
    <div className="mb-6">
      <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">{t("sync_modal.content_heading")}</h4>
      <p className="font-body text-sm text-gray-600 mb-3">{t("sync_modal.content_intro")}</p>
      <div className="space-y-2">
        {changes.map((change) => (
          <ContentCard
            key={change.story_id}
            change={change}
            row={rows.find((r) => r.story_id === change.story_id)}
            choice={choiceOf(change)}
            onChoice={(c) => onChoice(change.story_id, c)}
          />
        ))}
      </div>
    </div>
  );
}

type ChangedRow = FullSyncDiff["stories"]["changedStories"][number];

interface CardProps {
  change: StoryContentChange;
  row: ChangedRow | undefined;
  choice: ConflictChoice;
  onChoice: (choice: ConflictChoice) => void;
}

function ContentCard({ change, row, choice, onChoice }: CardProps) {
  const { t } = useTranslation("dashboard");
  const tone = change.kind === "github-only" ? "bg-white border-gray-200" : "bg-amber-50 border-amber-200";
  const checkbox = change.kind === "github-only" || change.kind === "steps-deleted";
  return (
    <div data-testid={`story-content-${change.story_id}`} className={`border rounded-lg px-4 py-3 ${tone}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-body text-sm font-medium text-charcoal">{change.title || t("common:untitled")}</span>
        {change.kind === "conflict" && (
          <ChoiceRadios
            name={`story-content-${change.story_id}`}
            choice={choice}
            onChoice={onChoice}
            repoLabel={t("sync_modal.conflict_use_repo")}
            mineLabel={t("sync_modal.conflict_keep_mine")}
          />
        )}
      </div>
      {change.kind === "unreadable" ? <UnreadableChoice change={change} /> : <ChangeText change={change} />}
      {row && <RowDetails row={row} choice={choice} />}
      {checkbox && (
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={choice === "repo"}
            onChange={(e) => onChoice(e.target.checked ? "repo" : "d1")}
            className="accent-terracotta"
          />
          <span className="font-body text-xs text-charcoal">{t("sync_modal.content_use_github")}</span>
        </label>
      )}
    </div>
  );
}

/** What changed, for a story Telar could read. */
function ChangeText({ change }: { change: StoryContentChange }) {
  const { t } = useTranslation("dashboard");
  if (change.kind === "steps-deleted") {
    return <p className="font-body text-xs text-gray-600 mb-2">{t("sync_modal.content_steps_deleted")}</p>;
  }
  const { d1Steps, headSteps, changedSteps } = change.summary;
  return (
    <>
      {change.kind === "conflict" && (
        <p className="font-body text-xs text-gray-600 mb-1">{t("sync_modal.content_conflict")}</p>
      )}
      {d1Steps !== null && headSteps !== null && (
        <p className="font-body text-xs text-gray-600 mb-1">
          {t("sync_modal.content_summary", { d1: d1Steps, head: headSteps, count: changedSteps })}
        </p>
      )}
    </>
  );
}

/** The story's row fields that changed too, which its one choice covers. */
function RowDetails({ row, choice }: { row: ChangedRow; choice: ConflictChoice }) {
  const { t } = useTranslation("dashboard");
  const repoValues = row.repoValues as Record<string, string | boolean | undefined>;
  const d1Values = row.d1Values as Record<string, string | boolean | undefined>;
  return (
    <div className="mt-1">
      <p className="font-body text-xs text-gray-500">{t("sync_modal.content_also_details")}</p>
      {row.changedFields
        .filter((field) => repoValues[field] !== undefined)
        .map((field) => (
          <ValuePair
            key={field}
            repoLabel={t("sync_modal.conflict_value_repo")}
            mineLabel={t("sync_modal.conflict_value_mine")}
            repoValue={displayValue(repoValues[field])}
            mineValue={displayValue(d1Values[field])}
            choice={choice}
          />
        ))}
    </div>
  );
}

type ReasonWriters = {
  [R in UnreadableReason as R["code"]]: (t: TFunction<"dashboard">, reason: R) => string | null;
};

/**
 * One sentence per reason code. A code with no entry is a type error, and a
 * reason is never printed as the text the server gave. `files_unreadable` has
 * no sentence: the card's opening sentence already says it.
 */
const REASON_TEXT: ReasonWriters = {
  step_missing: (t, r) => t("sync_modal.content_reason_step_missing", { row: r.row }),
  step_not_plain: (t, r) => t("sync_modal.content_reason_step_not_plain", { step: r.step, row: r.row }),
  step_too_precise: (t, r) => t("sync_modal.content_reason_step_too_precise", { step: r.step, row: r.row }),
  step_repeated: (t, r) => t("sync_modal.content_reason_step_repeated", { step: r.step, earlier: r.earlier }),
  layer_number_repeated: (t, r) => t("sync_modal.content_reason_layer_number_repeated", { row: r.row, layer: r.layer }),
  layer_reference_not_plain: (t, r) => t("sync_modal.content_reason_layer_reference_not_plain", { reference: r.reference }),
  layer_reference_directory: (t, r) => t("sync_modal.content_reason_layer_reference_directory", { reference: r.reference }),
  layer_reference_non_ascii: (t, r) => t("sync_modal.content_reason_layer_reference_non_ascii", { reference: r.reference }),
  columns_collide: (t, r) =>
    t("sync_modal.content_reason_columns_collide", { column: r.column, headers: r.headers.map((h) => `"${h}"`).join(", ") }),
  files_unreadable: () => null,
};

export function reasonText<R extends UnreadableReason>(t: TFunction<"dashboard">, reason: R): string | null {
  return (REASON_TEXT[reason.code] as (t: TFunction<"dashboard">, reason: R) => string | null)(t, reason);
}

/** An unreadable story: why, and its one choice, already made. */
function UnreadableChoice({ change }: { change: StoryContentChange }) {
  const { t } = useTranslation("dashboard");
  const why = change.reason ? reasonText(t, change.reason) : null;
  return (
    <>
      <p className="font-body text-xs text-gray-600 mb-1">{t("sync_modal.content_unreadable")}</p>
      {why && <p className="font-body text-xs text-gray-500 mb-2">{why}</p>}
      <label className="flex items-center gap-1.5">
        <input type="radio" name={`story-content-${change.story_id}`} checked readOnly className="accent-terracotta" />
        <span className="font-body text-xs text-gray-600">{t("sync_modal.conflict_keep_mine")}</span>
      </label>
    </>
  );
}
