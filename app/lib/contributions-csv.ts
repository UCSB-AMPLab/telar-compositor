/**
 * The contribution record as a CSV, for an instructor who wants the numbers
 * somewhere the record cannot follow them.
 *
 * One row per person and one column per measure, in the record's own order.
 * Nothing is totalled across measures or across kinds, here as on the page: a
 * spreadsheet makes a sum trivially easy to add, and this file will not be the
 * thing that adds it.
 *
 * Uncounted stays empty rather than becoming a zero. An empty cell reads as no
 * data in every spreadsheet there is, and a nought would assert that somebody
 * wrote nothing on a project where nobody was ever counted.
 *
 * Minutes rather than `h:mm`, because a spreadsheet can do arithmetic on a
 * number and not on a clock.
 *
 * @version v1.5.0-beta
 */

import Papa from "papaparse";

import { CONTRIBUTION_KINDS } from "~/lib/contributions";
import type { MemberContribution } from "~/lib/contributions";

const MEASURES = ["added", "edited", "words"] as const;

/**
 * Column headings, in English and unlocalised.
 *
 * The file is a data export read by spreadsheets and scripts, and a header that
 * changed with the reader's interface language would make two exports of the
 * same project incomparable. The page is where the translation belongs.
 */
function columns(): string[] {
  const perKind = CONTRIBUTION_KINDS.flatMap((kind) =>
    MEASURES.map((measure) => `${kind}_${measure}`));
  return ["name", "role", ...perKind, "editing_minutes", "writing_minutes"];
}

export function toContributionCsv(
  projectTitle: string,
  members: readonly MemberContribution[],
): string {
  const rows = members.map((member) => {
    const row: Record<string, string | number> = {
      name: member.displayName,
      role: member.role,
    };
    for (const kind of CONTRIBUTION_KINDS) {
      for (const measure of MEASURES) {
        const value = member.kinds[kind][measure];
        row[`${kind}_${measure}`] = value === null ? "" : value;
      }
    }
    row.editing_minutes = Math.round(member.editingSeconds / 60);
    row.writing_minutes = Math.round(member.writingSeconds / 60);
    return row;
  });

  // The project's name rides in a comment line rather than a column, so every
  // data row stays one person and a reader can still tell two exports apart.
  const comment = Papa.unparse([[`# ${projectTitle}`]], { header: false });
  const body = Papa.unparse(rows, { columns: columns() });
  return `${comment}\n${body}\n`.replace(/\r\n/g, "\n");
}
