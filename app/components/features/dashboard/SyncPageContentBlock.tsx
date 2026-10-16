/**
 * The sync dialog's page notices (`PageReviewNotices`), and its notice for
 * stories or objects edited while they were reviewed
 * (`ChangedWhileReviewedNotice`).
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";

/** The notices' look, as the dialog's other notices have it. */
const NOTICE_CLASS = "font-body text-sm text-charcoal bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4";

/** The page half of `ReviewNotices`: pages an accept refused as edited while reviewed. */
export function PageReviewNotices({ pagesChangedWhileReviewed }: { pagesChangedWhileReviewed: string[] }) {
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
