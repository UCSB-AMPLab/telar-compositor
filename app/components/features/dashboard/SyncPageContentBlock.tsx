/**
 * The sync dialog's page changes: the pages whose file changed on GitHub, one
 * card per page, each with the choice of GitHub's version or the author's,
 * listed beside the story content changes.
 *
 * A change GitHub alone made is a checkbox, taken by default; a conflict uses
 * the conflicts block's keep-mine / use-GitHub radios, keeping the
 * Compositor's version by default. Presentational: the modal owns the
 * choices and the builders that turn them into the accept's payload.
 *
 * Also the dialog's page notices (`PageReviewNotices`), and its notice for
 * stories or objects edited while they were reviewed
 * (`ChangedWhileReviewedNotice`).
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";
import type { PageContentChange } from "~/lib/page-content.server";
import type { ConflictChoice } from "./sync-changes";
import { ChoiceRadios } from "./SyncConflictsBlock";

interface Props {
  changes: readonly PageContentChange[];
  choiceOf: (change: PageContentChange) => ConflictChoice;
  onChoice: (pageId: number, choice: ConflictChoice) => void;
}

export function SyncPageContentBlock({ changes, choiceOf, onChoice }: Props) {
  const { t } = useTranslation("dashboard");
  if (changes.length === 0) return null;
  return (
    <div className="mb-6">
      <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">{t("sync_modal.pages_heading")}</h4>
      <p className="font-body text-sm text-gray-600 mb-3">{t("sync_modal.pages_intro")}</p>
      <div className="space-y-2">
        {changes.map((change) => (
          <PageCard
            key={change.pageId}
            change={change}
            choice={choiceOf(change)}
            onChoice={(c) => onChoice(change.pageId, c)}
          />
        ))}
      </div>
    </div>
  );
}

interface CardProps {
  change: PageContentChange;
  choice: ConflictChoice;
  onChoice: (choice: ConflictChoice) => void;
}

function PageCard({ change, choice, onChoice }: CardProps) {
  const { t } = useTranslation("dashboard");
  const conflict = change.kind === "conflict";
  const tone = conflict ? "bg-amber-50 border-amber-200" : "bg-white border-gray-200";
  return (
    <div data-testid={`page-content-${change.pageId}`} className={`border rounded-lg px-4 py-3 ${tone}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-body text-sm font-medium text-charcoal">{change.title || t("common:untitled")}</span>
        {conflict && (
          <ChoiceRadios
            name={`page-content-${change.pageId}`}
            choice={choice}
            onChoice={onChoice}
            repoLabel={t("sync_modal.conflict_use_repo")}
            mineLabel={t("sync_modal.conflict_keep_mine")}
          />
        )}
      </div>
      {change.takesLanguageFrom ? (
        <p className="font-body text-xs text-gray-600 mb-1">
          {t(conflict ? "sync_modal.page_takes_language_version_conflict" : "sync_modal.page_takes_language_version", { file: change.takesLanguageFrom })}
        </p>
      ) : conflict && (
        <p className="font-body text-xs text-gray-600 mb-1">
          {t(change.addedBoth ? "sync_modal.page_added_both" : "sync_modal.pages_conflict")}
        </p>
      )}
      {!conflict && (
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input
            type="checkbox"
            checked={choice === "repo"}
            onChange={(e) => onChoice(e.target.checked ? "repo" : "d1")}
            className="accent-terracotta"
          />
          <span className="font-body text-xs text-charcoal">{t("sync_modal.pages_use_github")}</span>
        </label>
      )}
    </div>
  );
}

/** The notices' look, as the dialog's other notices have it. */
const NOTICE_CLASS = "font-body text-sm text-charcoal bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4";

/** The page half of `ReviewNotices`: pages an accept refused as edited while reviewed, and page files unread. */
export function PageReviewNotices({
  pagesChangedWhileReviewed,
  pageFilesUnread,
}: {
  pagesChangedWhileReviewed: string[];
  pageFilesUnread: boolean;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <>
      {pagesChangedWhileReviewed.length > 0 && (
        <p className={NOTICE_CLASS}>
          {t("sync_modal.page_changed_none_applied", {
            pages: pagesChangedWhileReviewed.join(", "),
            count: pagesChangedWhileReviewed.length,
          })}
        </p>
      )}
      {pageFilesUnread && <p className={NOTICE_CLASS}>{t("sync_modal.pages_inconclusive")}</p>}
    </>
  );
}

/** Stories, or objects, an accept left because they were edited while they were reviewed: their names as shown. */
export interface ChangedWhileReviewed {
  entity: "story" | "object";
  names: string[];
}

export const NOTHING_CHANGED_WHILE_REVIEWED: ChangedWhileReviewed = { entity: "story", names: [] };

/** Why the list changed after an accept left stories or objects edited while they were reviewed; nothing for none. */
export function ChangedWhileReviewedNotice({ changed }: { changed: ChangedWhileReviewed }) {
  const { t } = useTranslation("dashboard");
  if (changed.names.length === 0) return null;
  const names = changed.names.join(", ");
  const count = changed.names.length;
  return (
    <p className={NOTICE_CLASS}>
      {changed.entity === "object"
        ? t("sync_modal.object_changed_none_applied", { objects: names, count })
        : t("sync_modal.story_changed_none_applied", { stories: names, count })}
    </p>
  );
}
