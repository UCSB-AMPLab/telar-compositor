/**
 * This file renders the attachment list inside the bug-report panel
 * — a collapsible disclosure of auto-captured payload items (URL,
 * environment, recent errors) the user can review and individually
 * remove before the issue body is generated.
 *
 * @version v1.2.0-beta
 */

import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

export type AttachmentItem = {
  /** Stable key matching `removed` Set entries and Payload field names. */
  key: string;
  /** Localised label (e.g. t("bug-report:attach_item_url")). */
  label: string;
  /** Display value (already redacted for error fields). */
  value: string;
  /** True for the post-crash pinned error — no remove button rendered. */
  pinned?: boolean;
};

interface AttachmentListProps {
  items: ReadonlyArray<AttachmentItem>;
  removed: ReadonlySet<string>;
  onRemove: (key: string) => void;
}

export function AttachmentList({
  items,
  removed,
  onRemove,
}: AttachmentListProps) {
  const { t } = useTranslation("bug-report");
  const visibleCount = items.filter((i) => !removed.has(i.key)).length;

  return (
    <details className="border border-gray-200 rounded p-3 bg-cream">
      <summary className="font-heading text-sm cursor-pointer text-charcoal">
        {t("attach_disclosure_label")} ({visibleCount})
      </summary>
      <div className="mt-2 space-y-1">
        {items.map((item) => {
          if (removed.has(item.key)) return null;
          return (
            <div
              key={item.key}
              className="flex justify-between items-start gap-2 text-xs"
            >
              <div className="font-body text-charcoal">
                <span className="font-semibold">{item.label}</span>{" "}
                <span className="text-gray-500 font-mono break-all">
                  {item.value}
                </span>
              </div>
              {!item.pinned && (
                <button
                  type="button"
                  onClick={() => onRemove(item.key)}
                  aria-label={t("attach_remove_aria", { item: item.label })}
                  className="text-gray-400 hover:text-charcoal flex-shrink-0"
                >
                  <X className="w-3.5 h-3.5" aria-hidden />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
