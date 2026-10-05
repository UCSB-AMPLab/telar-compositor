/**
 * The vocabulary of the contribution record, shared by the query that reads it
 * and the components that draw it.
 *
 * Apart from `contributions.server.ts` because the record is drawn in the
 * browser and that module reaches D1: a component importing the query's file
 * would pull the database into the client bundle. What travels between them is
 * only this — the five kinds, in the order they are shown, and the shape of one
 * person's row.
 *
 * @version v1.5.0-beta
 */

/** The five kinds of thing the record counts, in the order it shows them. */
export const CONTRIBUTION_KINDS = ["steps", "panels", "objects", "pages", "glossary"] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

/**
 * One measure of one kind for one person.
 *
 * `null` is not zero. It means nobody counted — a project whose work predates
 * the measure — and the record renders the two differently, so the distinction
 * has to survive all the way from the column to the cell.
 */
export interface KindCounts {
  added: number | null;
  edited: number | null;
  words: number | null;
}

export interface MemberContribution {
  userId: number;
  displayName: string;
  /** The person's presence colour, the same one their cursor uses. */
  color: string | null;
  role: string;
  /**
   * True for someone who holds credit on the project and is no longer a member:
   * they left, were removed, or deleted their account. Their credit is part of
   * the project's history and stays on the record under their name.
   */
  former: boolean;
  kinds: Record<ContributionKind, KindCounts>;
  editingSeconds: number;
  writingSeconds: number;
}

export interface ContributionRecord {
  members: MemberContribution[];
  /**
   * Whether this project has any counted words or time at all. False on a site
   * whose work happened before the measures existed, which the record says out
   * loud rather than showing five columns of em dashes with no explanation.
   */
  hasWordsAndTime: boolean;
}

/**
 * Words in a piece of text: runs of non-whitespace.
 *
 * Deliberately the crudest possible rule, and the copy says so where the number
 * is shown — words measure length, not quality. Markdown counts as it is written,
 * so `**bold**` is one word and a link is two; anything cleverer would need a
 * parser per field type and would still be arguing with the reader about what a
 * word is.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
