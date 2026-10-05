/**
 * Attributing the rows the documents can no longer speak for.
 *
 * The Phase 3 recovery reads authorship out of a project's Yjs document, and it
 * has taken everything the documents hold. What it cannot reach is most of the
 * database, for a structural reason: when the Durable Object rehydrates a
 * document from D1 it rewrites every key under its own client id, and the
 * per-session history of everything it rehydrated is gone. Measured across
 * staging, one project still carries real evidence — the one whose document has
 * been continuously live. The rest each show a single client owning every
 * entity.
 *
 * So this module works from D1 alone, and asks a question D1 can answer: which
 * rows did the Telar template ship, and which did a person write? Where a
 * project has had exactly one person on it for its whole life, that question is
 * the whole problem, because there is nobody else the second group could belong
 * to.
 *
 * Two claims, and they are not equally strong.
 *
 * `created_by_actor = 'telar_template'` is a statement of fact, and it is made
 * on every project whether one person works there or thirty: the row still
 * holds what the template shipped, so nobody authored it. `template-content.ts`
 * decides, and it requires the content to be untouched — a starter step someone
 * has written a question into is theirs from that moment.
 *
 * `created_by = <the sole member>` rests on the membership gate and nothing
 * else, so the gate has to be the whole history rather than the current roster:
 * members, everyone who has ever redeemed a join code, and everyone the
 * recovery found in the document. One person across all three, or the project
 * gets template labels only and its remaining rows stay unknown. Unknown is the
 * honest answer there, and it is the answer this module reaches for whenever
 * the evidence runs out.
 *
 * Every UPDATE carries `AND created_by IS NULL AND created_by_actor IS NULL`.
 * That makes the plan idempotent and, more to the point, means nothing here can
 * overwrite an attribution the database already holds — the guarantee lives in
 * the SQL rather than in a caller remembering the order to run things in.
 *
 * PURE, like the recovery planner, and for the same reason: a backfill over
 * people's coursework should be something you read as SQL before any of it
 * runs.
 *
 * @version v1.5.0-beta
 */

import { AUTHOR_ACTORS } from "~/lib/authorship";
import type { RecoveryStatement } from "~/lib/authorship-recovery";
import {
  isTemplateStory,
  isTemplateStep,
  isTemplateObject,
  isTemplateTerm,
  isTemplatePage,
  isTemplateLayer,
} from "~/lib/template-content.server";

/** The unattributed rows of one project, as D1 holds them. */
export interface BackfillInput {
  projectId: number;
  /**
   * The one person who has ever had access, or null when more than one has.
   * Null is not an error: it means the template pass runs and the author pass
   * does not.
   */
  soleMember: number | null;
  stories: Array<{ id: number; story_id?: unknown; title?: unknown }>;
  steps: Array<{ id: number; object_id?: unknown; question?: unknown; answer?: unknown }>;
  layers: Array<{ id: number }>;
  objects: Array<{ id: number; object_id?: unknown; title?: unknown }>;
  terms: Array<{ id: number; term_id?: unknown; definition?: unknown }>;
  pages: Array<{ id: number; slug?: unknown; body?: unknown }>;
}

/** What planning a backfill over one project found. */
export interface BackfillOutcome {
  projectId: number;
  /** Rows the template shipped and nobody has touched. */
  templateRows: number;
  /** Rows credited to the sole member. Zero when the membership gate failed. */
  authoredRows: number;
  /** True when one person has had access for the project's whole life. */
  soleMemberProject: boolean;
  /** Per kind, for reading the plan against what you expected to see. */
  byKind: Record<string, { template: number; authored: number }>;
}

const TABLE_BY_KIND: Record<string, string> = {
  story: "stories",
  step: "steps",
  layer: "layers",
  object: "objects",
  term: "glossary_terms",
  page: "project_pages",
};

/**
 * The guard every statement carries. Written once so no kind can be given a
 * weaker one, which is the mistake that would let a backfill overwrite a real
 * author.
 */
const UNATTRIBUTED = "created_by IS NULL AND created_by_actor IS NULL";

function labelTemplate(kind: string, id: number): RecoveryStatement {
  return {
    sql: `UPDATE ${TABLE_BY_KIND[kind]} SET created_by_actor = ? WHERE id = ? AND ${UNATTRIBUTED}`,
    binds: [AUTHOR_ACTORS.telarTemplate, id],
  };
}

function creditMember(kind: string, id: number, userId: number): RecoveryStatement {
  return {
    sql: `UPDATE ${TABLE_BY_KIND[kind]} SET created_by = ? WHERE id = ? AND ${UNATTRIBUTED}`,
    binds: [userId, id],
  };
}

/**
 * Work out what a backfill would write for one project, without writing it.
 *
 * Async only because recognising an about page is a hash comparison; nothing
 * here touches a database or a network.
 */
export async function planAuthorshipBackfill(
  input: BackfillInput,
): Promise<{ outcome: BackfillOutcome; statements: RecoveryStatement[] }> {
  const statements: RecoveryStatement[] = [];
  const byKind: Record<string, { template: number; authored: number }> = {};
  const count = (kind: string, key: "template" | "authored"): void => {
    const entry = byKind[kind] ?? { template: 0, authored: 0 };
    entry[key] += 1;
    byKind[kind] = entry;
  };

  // One pass per kind, each deciding template-or-not with its own rule and
  // falling through to the same authorship decision. Kept flat rather than
  // abstracted over the six shapes: the predicates take different fields, and a
  // generic row type would hide which cells each rule actually reads.
  const decide = (kind: string, id: number, isTemplate: boolean): void => {
    if (isTemplate) {
      statements.push(labelTemplate(kind, id));
      count(kind, "template");
      return;
    }
    if (input.soleMember === null) return;
    statements.push(creditMember(kind, id, input.soleMember));
    count(kind, "authored");
  };

  for (const row of input.stories) decide("story", row.id, isTemplateStory(row));
  for (const row of input.steps) decide("step", row.id, isTemplateStep(row));
  for (const row of input.layers) decide("layer", row.id, isTemplateLayer());
  for (const row of input.objects) decide("object", row.id, isTemplateObject(row));
  for (const row of input.terms) decide("term", row.id, isTemplateTerm(row));
  for (const row of input.pages) decide("page", row.id, await isTemplatePage(row));

  const templateRows = Object.values(byKind).reduce((n, e) => n + e.template, 0);
  const authoredRows = Object.values(byKind).reduce((n, e) => n + e.authored, 0);

  return {
    outcome: {
      projectId: input.projectId,
      templateRows,
      authoredRows,
      soleMemberProject: input.soleMember !== null,
      byKind,
    },
    statements,
  };
}
