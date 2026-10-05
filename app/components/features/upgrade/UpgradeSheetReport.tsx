/**
 * What the upgrade does to the site's sheets: one line for each
 * column it deletes or keeps under `#`, saying whether the author chose it,
 * one for each second header row it deletes, and one for each sheet it could
 * not read to check. Shown on the
 * confirmation screen and again on the done screen, whether or not the build
 * succeeds. Its list also carries the colliding columns of the published tabs
 * an upgrade stopped on.
 *
 * @version v1.5.0-beta
 */
import { useTranslation } from "react-i18next";
import type { SheetReportLine } from "~/lib/upgrade-sheets.server";

/** The line's message key and values, or null for a line the author does not read. */
function lineMessage(line: SheetReportLine): { key: string; values: Record<string, string> } | null {
  switch (line.kind) {
    case "dropped": {
      const key = line.chosen ? "repairDroppedChosen" : line.bothEmpty ? "repairDroppedAllEmpty" : "repairDropped";
      return { key, values: { sheet: line.sheet, column: line.column, keeper: line.keeper } };
    }
    case "marked":
      return {
        key: line.chosen && line.heldValues ? "repairMarkedChosen" : "repairMarked",
        values: { sheet: line.sheet, column: line.column, markedAs: line.markedAs },
      };
    case "header_row_deleted":
      return { key: "repairHeaderRowDeleted", values: { sheet: line.sheet } };
    case "unreadable":
      return { key: "repairUnreadable", values: { sheet: line.sheet } };
    default:
      return null;
  }
}

/** Whether the report has a line the author reads. */
export function hasSheetReportLines(lines: readonly SheetReportLine[]): boolean {
  return lines.some((line) => lineMessage(line) !== null);
}

/** A bulleted list of lines about the site's sheets, in the colour `className` gives. */
export function SheetLineList({ items, className = "" }: { items: readonly string[]; className?: string }) {
  return (
    <ul className={`list-disc pl-6 space-y-2 ${className}`}>
      {items.map((item, i) => (
        <li key={i} className="font-body text-sm">
          {item}
        </li>
      ))}
    </ul>
  );
}

export function UpgradeSheetReport({ lines, className = "" }: { lines: readonly SheetReportLine[]; className?: string }) {
  const { t } = useTranslation("upgrade");
  const messages = lines.map(lineMessage).filter((m) => m !== null);
  if (messages.length === 0) return null;
  return (
    <section className={`bg-cream-dark rounded-lg p-4 mb-6 ${className}`}>
      <h3 className="font-heading font-semibold text-sm text-charcoal mb-2">{t("sheetReportHeading")}</h3>
      <SheetLineList items={messages.map((message) => t(message.key, message.values))} className="text-charcoal" />
    </section>
  );
}
