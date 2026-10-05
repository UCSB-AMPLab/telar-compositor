/**
 * What each member of a project contributed to it, assembled for the
 * contribution record.
 *
 * Three measures of content, per kind of thing in the site — added, edited,
 * words — and two of time. They come from three different places, and the reason
 * they cannot be one query is worth stating, because the obvious shortcut is
 * wrong in a way that reports the class backwards.
 *
 *   ADDED comes from `created_by` on the entity itself: who made the thing.
 *
 *   EDITED comes from `entity_contributors`: who wrote in it, which is a
 *   different question and a different set of people. Measured over one cohort,
 *   steps created against steps written in ran 0 against 3, 1 against 3, 2
 *   against 3, 16 against 10, 7 against 3 — one student created no steps and
 *   wrote in three, another created sixteen and wrote in ten. Either measure
 *   alone reports one of them as idle.
 *
 *   WORDS and TIME are only collected live, by the Durable Object, and only
 *   since migration 0051. Nothing can recover them for work done before that, so
 *   a project older than the migration reports them as uncounted rather than as
 *   zero — an em dash, not a nought.
 *
 * Every count joins the entity table. `entity_contributors.entity_id` is
 * polymorphic and carries no foreign key, so nothing removes a contributor row
 * when its entity is deleted; a count taken from that table alone would include
 * deleted steps. The join is the filter.
 *
 * Nothing here sorts by any value. Members come back in alphabetical order and
 * stay that way, because the record is not a ranking and the shape of the code
 * should not make it easy to turn into one.
 *
 * @version v1.5.0-beta
 */

import { sql } from "drizzle-orm";

import type { MemberEditingTime } from "../../workers/contribution-metrics";
import type { getDb } from "~/lib/db.server";
import { CONTRIBUTION_KINDS } from "~/lib/contributions";
import type { ContributionKind, ContributionRecord, KindCounts, MemberContribution } from "~/lib/contributions";

type DbInstance = ReturnType<typeof getDb>;

/**
 * How each kind reaches its project, and what `entity_contributors` calls it.
 *
 * Steps and panels are two and three joins deep — a panel reaches its project
 * through its step and that step's story — which is why `entity_contributors`
 * denormalises `project_id` and why these joins exist only to prove the entity
 * still exists.
 */
const KIND_SOURCES: Record<ContributionKind, {
  contributorKind: string;
  /** FROM + JOINs reaching the project, with the entity aliased `e`. */
  from: ReturnType<typeof sql>;
}> = {
  steps: {
    contributorKind: "step",
    from: sql`steps AS e JOIN stories AS s ON s.id = e.story_id`,
  },
  panels: {
    contributorKind: "layer",
    from: sql`layers AS e JOIN steps AS st ON st.id = e.step_id JOIN stories AS s ON s.id = st.story_id`,
  },
  objects: {
    contributorKind: "object",
    from: sql`objects AS e`,
  },
  pages: {
    contributorKind: "page",
    from: sql`project_pages AS e`,
  },
  glossary: {
    contributorKind: "term",
    from: sql`glossary_terms AS e`,
  },
};

/**
 * Which table carries the project id for one kind.
 *
 * Objects, pages and terms hold it themselves. A step reaches it through its
 * story and a panel through its step's story, which is the whole reason
 * `entity_contributors` denormalises the column.
 */
function projectPredicate(kind: ContributionKind, projectId: number): ReturnType<typeof sql> {
  return kind === "objects" || kind === "pages" || kind === "glossary"
    ? sql`e.project_id = ${projectId}`
    : sql`s.project_id = ${projectId}`;
}

interface MemberRow {
  user_id: number;
  github_name: string | null;
  github_login: string;
  presence_color: string | null;
  role: string;
}

interface CountRow {
  user_id: number;
  n: number;
}

interface EditedRow {
  user_id: number;
  edited: number;
  words: number | null;
  counted: number;
}

function emptyKinds(): Record<ContributionKind, KindCounts> {
  return Object.fromEntries(
    CONTRIBUTION_KINDS.map((k) => [k, { added: 0, edited: 0, words: null }]),
  ) as Record<ContributionKind, KindCounts>;
}

/**
 * The seconds `member_editing_time` holds for a project, per person.
 *
 * Behind the truth by whatever the live instance has booked and not yet
 * written, which is why the caller can hand a figure in instead.
 */
async function readStoredEditingTime(
  db: DbInstance,
  projectId: number,
): Promise<MemberEditingTime[]> {
  const rows = await db.all<{ user_id: number; editing_seconds: number; writing_seconds: number }>(sql`
    SELECT user_id, editing_seconds, writing_seconds
    FROM member_editing_time
    WHERE project_id = ${projectId}
  `);
  return rows.map((row) => ({
    userId: row.user_id,
    editingSeconds: row.editing_seconds,
    writingSeconds: row.writing_seconds,
  }));
}

/**
 * Put each person's seconds on their row, and say whether any were counted.
 *
 * Time is one of the two measures that exist only since migration 0051, so a
 * project with no seconds against anybody reads as uncounted rather than as
 * nought — the em dash, not the zero.
 */
function applyEditingTime(
  members: Map<number, MemberContribution>,
  times: readonly MemberEditingTime[],
): boolean {
  let counted = false;
  for (const row of times) {
    const member = members.get(row.userId);
    if (!member) continue;
    member.editingSeconds = row.editingSeconds;
    member.writingSeconds = row.writingSeconds;
    if (row.editingSeconds > 0) counted = true;
  }
  return counted;
}

function memberEntry(
  userId: number,
  displayName: string,
  color: string | null,
  role: string,
  former: boolean,
): MemberContribution {
  return { userId, displayName, color, role, former, kinds: emptyKinds(), editingSeconds: 0, writingSeconds: 0 };
}

/**
 * Add, as former members, the people `creditedIds` names who hold no
 * membership: someone who left, was removed or deleted their account keeps
 * their credit as part of the project's history. A deleted account's row is a
 * tombstone that keeps the name (`account-tombstone.server.ts`). They have no
 * presence colour, which belongs to a membership.
 */
async function addFormerMembers(
  db: DbInstance,
  members: Map<number, MemberContribution>,
  creditedIds: readonly number[],
): Promise<void> {
  const former = [...new Set(creditedIds)].filter((id) => Number.isSafeInteger(id) && !members.has(id));
  // D1 binds at most 100 parameters to a statement.
  for (let i = 0; i < former.length; i += 90) {
    const chunk = former.slice(i, i + 90);
    const rows = await db.all<{ id: number; github_name: string | null; github_login: string }>(sql`
      SELECT id, github_name, github_login FROM users WHERE id IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const row of rows) {
      members.set(row.id, memberEntry(row.id, row.github_name ?? row.github_login, null, "former", true));
    }
  }
}

/**
 * Put each kind's added and edited counts on the people they belong to.
 * Returns whether any word count was recorded, which is how a project whose
 * work predates the word measure is told apart from one whose people wrote
 * nothing.
 */
function applyContentCounts(
  members: Map<number, MemberContribution>,
  addedByKind: ReadonlyMap<ContributionKind, CountRow[]>,
  editedByKind: ReadonlyMap<ContributionKind, EditedRow[]>,
): boolean {
  let counted = false;
  for (const [kind, rows] of addedByKind) {
    for (const row of rows) {
      const member = members.get(row.user_id);
      if (member) member.kinds[kind].added = row.n;
    }
  }
  for (const [kind, rows] of editedByKind) {
    for (const row of rows) {
      const member = members.get(row.user_id);
      if (!member) continue;
      member.kinds[kind].edited = row.edited;
      if (row.counted > 0) {
        member.kinds[kind].words = row.words ?? 0;
        counted = true;
      }
    }
  }
  return counted;
}

/**
 * Read one project's contribution record.
 *
 * Twelve small queries rather than one compound statement, deliberately: D1
 * refuses a compound SELECT past a fixed number of terms, and a single query
 * pivoting five kinds across three measures runs into that ceiling on the first
 * project large enough to matter. Each one is an indexed aggregate over a few
 * hundred rows.
 *
 * The caller is responsible for the security boundary: this function trusts the
 * `projectId` it is handed, and every route reaching it must have resolved
 * membership first.
 *
 * `times`, when given, is read in place of `member_editing_time` and not
 * beside it. The live figure a caller can obtain from the Durable Object
 * already contains the stored seconds, so adding the two would count a
 * person's last stretch of work twice; a person the figure omits has no
 * seconds, whatever the table says about them.
 */
export async function getContributionRecord(
  db: DbInstance,
  projectId: number,
  times?: readonly MemberEditingTime[],
): Promise<ContributionRecord> {
  const memberRows = await db.all<MemberRow>(sql`
    SELECT m.user_id AS user_id, u.github_name, u.github_login,
           m.presence_color AS presence_color, m.role AS role
    FROM project_members AS m
    JOIN users AS u ON u.id = m.user_id
    WHERE m.project_id = ${projectId}
  `);

  const members = new Map<number, MemberContribution>();
  for (const row of memberRows) {
    members.set(row.user_id, memberEntry(row.user_id, row.github_name ?? row.github_login, row.presence_color, row.role, false));
  }

  // The counts first, then who they belong to: a person with credit and no
  // membership is only found through them.
  const addedByKind = new Map<ContributionKind, CountRow[]>();
  const editedByKind = new Map<ContributionKind, EditedRow[]>();
  for (const kind of CONTRIBUTION_KINDS) {
    const source = KIND_SOURCES[kind];
    const scope = projectPredicate(kind, projectId);

    addedByKind.set(kind, await db.all<CountRow>(sql`
      SELECT e.created_by AS user_id, COUNT(*) AS n
      FROM ${source.from}
      WHERE ${scope} AND e.created_by IS NOT NULL
      GROUP BY e.created_by
    `));

    // COUNT over the column rather than the row: it counts the values that are
    // not null, which is how a person who has been counted and wrote nothing is
    // told apart from one nobody counted. SUM of all-nulls is null, so without
    // it the two would arrive here looking the same.
    editedByKind.set(kind, await db.all<EditedRow>(sql`
      SELECT c.user_id AS user_id, COUNT(*) AS edited,
             SUM(c.words_written) AS words, COUNT(c.words_written) AS counted
      FROM ${source.from}
      JOIN entity_contributors AS c
        ON c.entity_id = e.id AND c.entity_kind = ${source.contributorKind}
       AND c.project_id = ${projectId}
      WHERE ${scope}
      GROUP BY c.user_id
    `));
  }
  const seconds = times ?? await readStoredEditingTime(db, projectId);

  await addFormerMembers(db, members, [
    ...[...addedByKind.values()].flat().map((r) => r.user_id),
    ...[...editedByKind.values()].flat().map((r) => r.user_id),
    ...seconds.filter((t) => t.editingSeconds > 0 || t.writingSeconds > 0).map((t) => t.userId),
  ]);

  let counted = applyContentCounts(members, addedByKind, editedByKind);
  if (applyEditingTime(members, seconds)) counted = true;

  return {
    // Alphabetical, and never by value. The record is not a ranking, and a sort
    // key that could become one has no business being in the code.
    members: [...members.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName)),
    hasWordsAndTime: counted,
  };
}
