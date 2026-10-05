/**
 * The vocabulary for authorship a person does not hold.
 *
 * Two columns answer "who wrote this", and they answer different questions.
 * `created_by` names the person who MADE an entity; `last_edited_by` names the
 * person who most recently wrote in it. Both point at users, so both have only
 * a person or null to offer — and null was carrying three unrelated cases at
 * once: content the Telar template shipped, content imported from a repo and
 * authored outside the compositor, and content older than the columns.
 *
 * `created_by_actor` states the first two rather than leaving a reader to infer
 * them. It is written server-side at import and never enters the Yjs document,
 * so no client can write it.
 *
 * The rule for every consumer, and the reason this module exists at all: a row
 * with no actor and no `created_by` is UNKNOWN, never NOBODY. Roughly
 * three-quarters of the steps in the database predate the column, and telling a
 * student their work was made by nobody is the one reading that is worse than
 * saying so plainly.
 *
 * @version v1.5.0-beta
 */

/**
 * What made a row, when no person did. Loose text in D1 (matching
 * `projects.kind` and `objects.origin`), validated here rather than by a CHECK
 * constraint, so a further actor costs no migration.
 */
export const AUTHOR_ACTORS = {
  /** The starter story and placeholder object the Telar template ships. */
  telarTemplate: "telar_template",
  /**
   * Content read out of a linked repo's CSVs at import. Authored outside the
   * compositor, by hands it never saw — which is a statement about provenance,
   * not a shrug. The importing user is knowable and is deliberately not used:
   * they become the convenor in the same step, so crediting them carries an air
   * of authority the import cannot support.
   */
  imported: "imported",
} as const;

export type AuthorActor = (typeof AUTHOR_ACTORS)[keyof typeof AUTHOR_ACTORS];

const ACTOR_VALUES: readonly string[] = Object.values(AUTHOR_ACTORS);

/**
 * Whether a stored value is an actor this build knows.
 *
 * Total, and false for anything unrecognised. A value written by a NEWER build
 * reaches an older one during a rollback, and the honest reading of an actor
 * this code cannot name is the same as no actor: fall back to `created_by`, and
 * render unknown. Inventing a label for it would put a name on the row that
 * nothing in the database supports.
 */
export function isAuthorActor(value: unknown): value is AuthorActor {
  return typeof value === "string" && ACTOR_VALUES.includes(value);
}

/**
 * How a row's authorship should be read: a person, a named actor, or unknown.
 *
 * One place decides, so every consumer agrees — and so the unknown case is
 * reached deliberately rather than by a `??` somebody wrote in a hurry.
 */
export type Authorship =
  | { kind: "person"; userId: number }
  | { kind: "actor"; actor: AuthorActor }
  | { kind: "unknown" };

/**
 * Read a row's authorship from the two columns.
 *
 * `created_by` wins when both are set. That combination should not occur — the
 * import writes an actor precisely because it has no person to write — but if
 * it ever does, a real person is the better answer, and preferring the actor
 * would hide somebody's authorship behind a label.
 */
export function readAuthorship(row: {
  created_by?: number | null;
  created_by_actor?: string | null;
}): Authorship {
  if (typeof row.created_by === "number") {
    return { kind: "person", userId: row.created_by };
  }
  if (isAuthorActor(row.created_by_actor)) {
    return { kind: "actor", actor: row.created_by_actor };
  }
  return { kind: "unknown" };
}

/**
 * The `created_by_actor` value to bind when a row's D1 row is being replaced by
 * a stale-id re-INSERT.
 *
 * The value comes back out of D1, not out of the document, so this is the one
 * place the column round-trips. Any string is carried through — including one a
 * NEWER build wrote and this code cannot name. Dropping it would lose real
 * provenance on a recovery path to protect against nothing: it is a bound
 * parameter going back into the column it came from, and `readAuthorship`
 * already reads an actor it does not recognise as unknown.
 */
export function preservedActor(preserved?: Record<string, unknown>): string | null {
  const value = preserved?.created_by_actor;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The entity kinds `entity_contributors.entity_kind` can hold.
 *
 * Loose text in D1, validated here. Steps and layers are separate kinds and both
 * matter: three students in one cohort wrote panels on steps other people had
 * created, and a step-only reading reports them as having contributed nothing,
 * while a panel-only reading erases whoever built the step they wrote in.
 */
export const CONTRIBUTOR_ENTITY_KINDS = {
  story: "story",
  step: "step",
  layer: "layer",
  object: "object",
  term: "term",
  page: "page",
} as const;

export type ContributorEntityKind =
  (typeof CONTRIBUTOR_ENTITY_KINDS)[keyof typeof CONTRIBUTOR_ENTITY_KINDS];

/**
 * How a contributor row was arrived at — see migration 0048.
 *
 * Absent is the strongest: the Durable Object saw the edit arrive on an
 * authenticated socket. The two recovered values are weaker, and
 * `recovered_inferred` is inference outright and must be labelled wherever it is
 * surfaced.
 */
export const CONTRIBUTOR_BASES = {
  /** From the document; the session wrote a `created_by` naming this user. */
  recoveredStated: "recovered_stated",
  /** From the document; the session was resolved by sole-editor inference. */
  recoveredInferred: "recovered_inferred",
} as const;

export type ContributorBasis =
  (typeof CONTRIBUTOR_BASES)[keyof typeof CONTRIBUTOR_BASES];

/**
 * Whether a contributor row rests on inference rather than on a record.
 *
 * The question a view must ask before presenting a name. Total, and false for
 * the absent value, so a live observation reads as what it is.
 */
export function isInferredContributor(basis: unknown): boolean {
  return basis === CONTRIBUTOR_BASES.recoveredInferred;
}
