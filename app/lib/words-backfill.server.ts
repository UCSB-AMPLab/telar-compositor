/**
 * What the word count can be recovered for, and what it cannot.
 *
 * `words_written` is collected live, per edit, as the rise in a field's word
 * count credited to whoever caused it. For work done before migration 0051 there
 * are no edits to credit — only the finished text — so the question is not "how
 * many words did this person write" but "whose are the words that are here".
 *
 * For an entity with EXACTLY ONE contributor that question has an answer. Nobody
 * else ever wrote in it, so every word in it is theirs. That is the same footing
 * the authorship backfill stands on, applied per entity rather than per project,
 * and it covers most of a real site: group work divides by section far more often
 * than it shares one.
 *
 * Nor is there an answer for an entity the template seeded. A person who
 * corrects a sentence in the About page has not written the other two hundred
 * and fifty, and the text does not say which are hers. Measured on staging: of
 * 371 words this would otherwise have credited, 313 were the shipped glossary
 * definition and the shipped About page.
 *
 * For an entity two or more people wrote in there is no answer either. The text carries
 * no record of who typed which sentence — the CRDT's per-character attribution is
 * destroyed by any rehydration of the document — so any split would be invented.
 * Those entities are left uncounted, which the record already renders as an em
 * dash rather than as a nought.
 *
 * WHAT THIS CANNOT DO AT ALL IS TIME. Yjs carries logical clocks, not wall-clock
 * ones, and `activity_log` fires too sparsely to sessionise: measured over the
 * cohort, several students have a single timestamp, which gives an interval of
 * zero. There is nothing to compute a duration from, so editing and writing time
 * begin at the moment they started being collected and no earlier.
 *
 * Pure: it returns statements and never touches D1, so what it would write can be
 * read before any of it runs. The companion script is `scripts/backfill-words.ts`.
 *
 * @version v1.5.0-beta
 */

import { countWords } from "~/lib/contributions";

/**
 * The prose fields of each kind, named as `entity_contributors.entity_kind`
 * names it rather than as the document does.
 *
 * The same fields the live capture counts (`workers/contribution-metrics.ts`),
 * keyed by the contributor table's vocabulary because that is what this reads.
 * A field in one list and not the other would make a backfilled number and a
 * live one mean different things, which is the failure this pairing exists to
 * prevent.
 */
export const PROSE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  story: ["title", "subtitle", "byline"],
  step: ["question", "answer", "alt_text"],
  layer: ["title", "button_label", "content"],
  object: [
    "title", "creator", "description", "alt_text", "period", "object_type",
    "subjects", "source", "credit", "dimensions",
  ],
  term: ["title", "definition"],
  page: ["title", "body"],
};

/** One entity's text, and everyone recorded as having written in it. */
export interface EntityWords {
  kind: string;
  entityId: number;
  /** The values of its prose columns, in any order. */
  values: readonly (string | null)[];
  /** Every user id with a contributor row on this entity. */
  contributors: readonly number[];
  /**
   * The template put words in this entity. Counted words are then a mixture
   * nothing can separate, so it is left uncounted whoever wrote in it.
   */
  templateSeeded?: boolean;
}

export interface WordsBackfillInput {
  projectId: number;
  entities: readonly EntityWords[];
}

export interface WordsBackfillStatement {
  sql: string;
  binds: (string | number)[];
}

export interface WordsBackfillOutcome {
  /** Entities credited: exactly one person wrote in them. */
  soleContributor: number;
  /** Entities left uncounted: more than one person wrote in them. */
  shared: number;
  /** Entities left uncounted: the template put words in them. */
  templateSeeded: number;
  /** Words attributed in total. */
  words: number;
  byKind: Record<string, { credited: number; shared: number; templateSeeded: number; words: number }>;
}

/**
 * Never overwrite a counted value.
 *
 * A row the Durable Object has already written holds a real measurement of
 * words added, and this holds an estimate of words present. Where both exist the
 * observation wins, so the guard lives in the SQL rather than in the order the
 * caller happens to run things in.
 */
const UNCOUNTED = "words_written IS NULL";

export function planWordsBackfill(input: WordsBackfillInput): {
  outcome: WordsBackfillOutcome;
  statements: WordsBackfillStatement[];
} {
  const statements: WordsBackfillStatement[] = [];
  const byKind: WordsBackfillOutcome["byKind"] = {};
  let soleContributor = 0;
  let shared = 0;
  let templateSeeded = 0;
  let words = 0;

  for (const entity of input.entities) {
    const kind = (byKind[entity.kind] ??= { credited: 0, shared: 0, templateSeeded: 0, words: 0 });

    // Checked before the contributor count, because it disqualifies the entity
    // however few people wrote in it: a sole contributor to the About page is
    // still not the author of the About page.
    if (entity.templateSeeded) {
      templateSeeded += 1;
      kind.templateSeeded += 1;
      continue;
    }

    if (entity.contributors.length !== 1) {
      shared += 1;
      kind.shared += 1;
      continue;
    }

    const count = entity.values.reduce(
      (total, value) => total + countWords(typeof value === "string" ? value : ""),
      0,
    );

    soleContributor += 1;
    words += count;
    kind.credited += 1;
    kind.words += count;

    statements.push({
      sql:
        "UPDATE entity_contributors SET words_written = ? " +
        `WHERE project_id = ? AND entity_kind = ? AND entity_id = ? AND user_id = ? AND ${UNCOUNTED}`,
      binds: [count, input.projectId, entity.kind, entity.entityId, entity.contributors[0]],
    });
  }

  return {
    outcome: { soleContributor, shared, templateSeeded, words, byKind },
    statements,
  };
}
