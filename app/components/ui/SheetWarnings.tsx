/**
 * SheetWarnings — the problems a read of the author's sheets found, one
 * sentence each, in a collapsible amber list.
 *
 * Shared by every screen that reads a sheet: the import's review step, the
 * objects sync dialog, the full sync dialog and the Start page's orphan
 * restore, and the Pages tab's import. Each `SheetWarning` is written from
 * `common:sheet_warnings.<code>` with its fields and its sheet, so the reader
 * sees the sentence in their own language and knows which sheet to open. A
 * file with unreadable characters gets two sentences: what the site does with
 * it, then what repairs it.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SheetRow, SheetWarning, UnreadableEffect, UnreadableRepair } from "~/lib/sheet-warnings";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Names as the author typed them, each in quotes, in the order given. */
function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/** The row's interpolation value and which of the two sentences names it. */
function rowFields(row: SheetRow): { variant: "named" | "numbered"; row: string | number } {
  return "label" in row ? { variant: "named", row: row.label } : { variant: "numbered", row: row.position };
}

/** A row's sentence: the one naming it by its label where it has one, else by its position. */
function rowSentence(t: Translate, sheetRow: SheetRow, sheet: string, namedKey: string, numberedKey: string): string {
  const { variant, row } = rowFields(sheetRow);
  return t(variant === "named" ? namedKey : numberedKey, { row, sheet });
}

/** One warning's sentence. Every key is written out so the catalogue scan can see it. */
export function sheetWarningText(t: Translate, w: SheetWarning): string {
  return (SENTENCES[w.code] as (t: Translate, w: SheetWarning) => string)(t, w);
}

type Sentences = { [C in SheetWarning["code"]]: (t: Translate, w: Extract<SheetWarning, { code: C }>) => string };

/** Each code's sentence, from its fields and its sheet. */
const SENTENCES: Sentences = {
  ragged_row: (t, w) =>
    rowSentence(t, w.row, w.sheet, "sheet_warnings.ragged_row.named", "sheet_warnings.ragged_row.numbered"),
  bilingual_header_row: (t, w) =>
    rowSentence(
      t, w.row, w.sheet, "sheet_warnings.bilingual_header_row.named", "sheet_warnings.bilingual_header_row.numbered",
    ),
  blank_header: (t, w) => t("sheet_warnings.blank_header", { column: w.column, sheet: w.sheet }),
  column_collision_only_filled: (t, w) =>
    t("sheet_warnings.column_collision_only_filled", {
      name: w.name,
      headers: quoted(w.headers),
      kept: w.kept,
      column: w.column,
      sheet: w.sheet,
    }),
  column_collision_last: (t, w) =>
    t("sheet_warnings.column_collision_last", {
      name: w.name,
      headers: quoted(w.headers),
      column: w.column,
      sheet: w.sheet,
    }),
  reserved_column: (t, w) =>
    t("sheet_warnings.reserved_column", {
      count: w.columns.length,
      columns: quoted(w.columns),
      sheet: w.sheet,
    }),
  header_spelling: (t, w) => headerSpellingText(t, w),
  instruction_column: (t, w) =>
    t("sheet_warnings.instruction_column", {
      count: w.columns.length,
      columns: quoted(w.columns),
      sheet: w.sheet,
    }),
  folded_columns: (t, w) =>
    t("sheet_warnings.folded_columns", {
      groups: w.groups.map((group) => quoted(group)).join("; "),
      sheet: w.sheet,
    }),
  coordinate_invalid: (t, w) =>
    t("sheet_warnings.coordinate_invalid", {
      step: w.step,
      column: w.column,
      value: w.value,
      sheet: w.sheet,
    }),
  page_below_one: (t, w) => t("sheet_warnings.page_below_one", { step: w.step, value: w.value, sheet: w.sheet }),
  page_truncated: (t, w) =>
    t("sheet_warnings.page_truncated", {
      step: w.step,
      value: w.value,
      readAs: w.readAs,
      sheet: w.sheet,
    }),
  object_site_id_shared: (t, w) =>
    w.sameRowEverywhere
      ? t("sheet_warnings.object_site_id_shared", { ids: quoted(w.ids), shown: w.shown, sheet: w.sheet })
      : t("sheet_warnings.object_site_id_shared_split", { ids: quoted(w.ids), sheet: w.sheet }),
  object_id_repeated: (t, w) =>
    w.sameRowEverywhere
      ? t("sheet_warnings.object_id_repeated", { id: quoted([w.id]), sheet: w.sheet })
      : t("sheet_warnings.object_id_repeated_split", { id: quoted([w.id]), sheet: w.sheet }),
  tree_truncated: (t) => t("sheet_warnings.tree_truncated"),
  unreadable_characters: (t, w) => unreadableText(t, w),
};

/**
 * A misread heading's sentence: for a Google Sheets tab, what to change there;
 * where `object_id` is among the names, that the site reads no objects; else
 * that the columns' values don't appear. Every key is written out.
 */
function headerSpellingText(t: Translate, w: Extract<SheetWarning, { code: "header_spelling" }>): string {
  const fields = { headers: quoted(w.headers), names: quoted(w.names), sheet: w.sheet };
  const count = w.headers.length;
  if (w.fromGoogleSheets) return t("sheet_warnings.header_spelling_sheets", { ...fields, count });
  if (w.names.includes("object_id")) return t("sheet_warnings.header_spelling_object_id", fields);
  return t("sheet_warnings.header_spelling", { ...fields, count });
}

/** What the site does with the file, then what repairs it. */
function unreadableText(t: Translate, w: Extract<SheetWarning, { code: "unreadable_characters" }>): string {
  return `${EFFECT_TEXT[w.effect](t, w.file)} ${REPAIR_TEXT[w.repair](t)}`;
}

const EFFECT_TEXT: Record<UnreadableEffect, (t: Translate, file: string) => string> = {
  build_stops: (t, file) => t("sheet_warnings.unreadable_characters.build_stops", { file }),
  left_out: (t, file) => t("sheet_warnings.unreadable_characters.left_out", { file }),
  name_shown: (t, file) => t("sheet_warnings.unreadable_characters.name_shown", { file }),
  from_sheets: (t, file) => t("sheet_warnings.unreadable_characters.from_sheets", { file }),
  not_used: (t, file) => t("sheet_warnings.unreadable_characters.not_used", { file }),
};

const REPAIR_TEXT: Record<UnreadableRepair, (t: Translate) => string> = {
  publish: (t) => t("sheet_warnings.unreadable_characters.repair.publish"),
  title_then_publish: (t) => t("sheet_warnings.unreadable_characters.repair.title_then_publish"),
  import_then_publish: (t) => t("sheet_warnings.unreadable_characters.repair.import_then_publish"),
  remove_old_copy: (t) => t("sheet_warnings.unreadable_characters.repair.remove_old_copy"),
};

/**
 * The collapsed line: the count of warnings in the sheets, or of warnings
 * about the site's files when one names a file that is not a sheet.
 */
function defaultSummary(t: Translate, warnings: readonly SheetWarning[]): string {
  const count = warnings.length;
  return warnings.some(namesOtherFile)
    ? t("sheet_warnings.summary_files", { count })
    : t("sheet_warnings.summary", { count });
}

/** Whether a warning names a file that is not a sheet: a page, a layer file, `_config.yml` or `index.md`. */
function namesOtherFile(w: SheetWarning): boolean {
  return w.code === "unreadable_characters" && (w.file.includes("/") || !w.file.endsWith(".csv"));
}

interface SheetWarningsProps {
  warnings: readonly SheetWarning[];
  /** The collapsed line; the count of problems when not given. */
  summary?: string;
  /** Whether the list starts open. */
  defaultOpen?: boolean;
  className?: string;
}

export function SheetWarnings({ warnings, summary, defaultOpen = false, className = "" }: SheetWarningsProps) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(defaultOpen);
  if (warnings.length === 0) return null;
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className={`border border-amber-200 rounded-lg overflow-hidden ${className}`}
    >
      <summary className="flex items-center justify-between px-4 py-3 bg-amber-50 cursor-pointer list-none">
        <span className="text-sm font-body font-medium text-amber-800">
          {summary ?? defaultSummary(t as Translate, warnings)}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-amber-600 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </summary>
      <ul className="px-4 py-3 space-y-1">
        {warnings.map((w, i) => (
          <li key={i} className="text-xs font-body text-gray-600">
            {sheetWarningText(t as Translate, w)}
          </li>
        ))}
      </ul>
    </details>
  );
}
