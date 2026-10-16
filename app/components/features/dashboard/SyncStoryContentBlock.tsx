/**
 * The sentence for each reason a story's files cannot be read
 * (`UnreadableReason`), which the review dialog's story item shows
 * (SyncItemCards).
 *
 * @version v1.5.5-beta
 */

import type { TFunction } from "i18next";
import type { UnreadableReason } from "~/lib/story-canonical";

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
