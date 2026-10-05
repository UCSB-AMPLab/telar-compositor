/**
 * Reading a SET list off a recorded UPDATE.
 *
 * A SET list holds one assignment per TOP-LEVEL comma, not one per comma: an
 * assignment whose right-hand side is a function call — `COALESCE(?, title)`,
 * `COALESCE(NULLIF(?, ''), slug)` — carries commas of its own. Splitting on
 * those shifts every later column out of its bind position, and a probe that
 * then reads `args[cols.indexOf(...)]` reports `undefined` for a column the
 * statement does bind. That is a broken probe reporting a finding, so the
 * split lives in one place rather than in each test that needs it.
 *
 * @version v1.5.0-beta
 */

/** Split a SQL clause on its top-level commas. */
export function splitTopLevel(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < clause.length; i++) {
    const c = clause[i];
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(clause.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(clause.slice(start));
  return parts;
}

/** The columns an UPDATE assigns, in the order its binds arrive. */
export function updateSetColumns(sql: string): string[] {
  const m = sql.match(/UPDATE [\w"]+ SET ([\s\S]+?) WHERE /);
  if (!m) return [];
  return splitTopLevel(m[1]).map((part) => part.split("=")[0].trim().replace(/"/g, ""));
}

/**
 * The right-hand side one column is assigned, or `""` when the UPDATE does not
 * name it.
 *
 * What a null bind DOES is a property of the assignment, not of the bind: the
 * same null holds against `COALESCE(?, col)` and blanks the column against
 * `col = ?`. A test that reads only the bind cannot tell those apart.
 */
export function updateAssignment(sql: string, column: string): string {
  const m = sql.match(/UPDATE [\w"]+ SET ([\s\S]+?) WHERE /);
  if (!m) return "";
  for (const part of splitTopLevel(m[1])) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim().replace(/"/g, "") === column) return part.slice(at + 1).trim();
  }
  return "";
}
