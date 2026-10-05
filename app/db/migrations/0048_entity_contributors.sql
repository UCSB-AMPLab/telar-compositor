-- Who wrote in each entity, as a table rather than a column.
--
-- `created_by` names who made an entity and `last_edited_by` names who most
-- recently wrote in it. Neither answers the question a fair account of group
-- work asks, which is who wrote in it AT ALL. Measured over one cohort, steps
-- created against steps written in ran 0 against 3, 1 against 3, 2 against 3,
-- 16 against 10, 7 against 3: one student created no steps and wrote in three,
-- another created sixteen and wrote in ten. A last-editor column reports only
-- whoever touched a row most recently, so on any shared step it credits one
-- person and erases the others.
--
-- A row per (entity, person) rather than a JSON column on each of the six entity
-- tables. Two reasons, and the second is the one that decided it.
--
-- The queries are all aggregates over people — steps written in, panels written
-- in, per project, per person — which is one GROUP BY here against scanning six
-- tables and parsing JSON per row.
--
-- And a table takes an UPSERT, which is additive. A JSON column is
-- read-modify-write, and the Durable Object only ever holds the contributors it
-- has seen since it started: assigning that set would silently drop everyone who
-- contributed before the last eviction. That is exactly how `fields_edited` came
-- to overwrite a stored count with one lifetime's tally, so the shape of the
-- store is doing the remembering here rather than the discipline of the caller.
--
-- entity_kind is loose text validated in code (`app/lib/authorship.ts`),
-- matching `projects.kind` and `objects.origin`.
--
-- project_id is denormalised so every aggregate is one indexed scan rather than
-- a different join per entity kind — a layer would otherwise reach its project
-- through steps and stories. The Durable Object is bound to one project and only
-- ever writes its own id.
--
-- first_edit_at is written once and never updated; last_edit_at only moves
-- forward. Two Durable Object instances can snapshot out of order, and a stale
-- stamp overwriting a fresher one would read as the person having gone quiet.
--
-- CONSUMERS MUST JOIN against the entity table. entity_id is polymorphic so it
-- carries no foreign key, and nothing deletes a contributor row when its entity
-- is deleted — a set-based cascade (`DELETE FROM steps WHERE story_id = ?`) does
-- not know the ids it removed, and a general prune would put a per-kind scan on a
-- path that runs every thirty seconds. So a count taken from this table alone
-- includes entities that no longer exist. The join is what excludes them, and it
-- is needed regardless to reach a step's words and a story's title.
--
-- Backwards-compatible: a new table is invisible to code that does not read it,
-- so a rollback to the previous worker keeps working.
-- HOW A ROW WAS ARRIVED AT — the `basis` column, because not all of these are
-- records.
--
-- Rows the Durable Object writes as it goes are observations: it saw the edit
-- arrive on an authenticated socket and knows whose it was. Rows recovered from
-- `yjs_state` are weaker, and one of the two recovery routes is inference
-- outright — a session that never wrote a `created_by` cannot be paired
-- directly, and is resolved by noticing that everything it touched belongs to
-- one person, which is very likely their second device or a reloaded tab and is
-- not certainly that.
--
-- Recovering authorship for somebody's coursework and then presenting a guess as
-- a fact is the failure this column exists to prevent. NULL is the strongest
-- value and the default, so live rows need no change and nothing already written
-- is reinterpreted:
--
--   NULL                 observed live by the Durable Object
--   recovered_stated     from the document; the session wrote a created_by
--                        naming this user, so the pairing is recorded
--   recovered_inferred   from the document; the session was resolved only by
--                        sole-editor inference. Must be labelled wherever shown.
--
-- Note that `created_by` takes NO basis column, on the six entity tables or
-- anywhere else. It does not need one, because the backfill only ever writes a
-- `recovered_stated` attribution into it: claiming who MADE an entity is the
-- stronger claim of the two, and an inference is not allowed to make it. An
-- inferred session still appears here as a contributor, where the label can
-- travel with it.
--
-- Backwards-compatible: a nullable column is invisible to code that does not
-- select it, so a rollback to the previous worker keeps working.
--
CREATE TABLE IF NOT EXISTS entity_contributors (
  id integer PRIMARY KEY AUTOINCREMENT,
  project_id integer NOT NULL REFERENCES projects(id),
  entity_kind text NOT NULL,
  entity_id integer NOT NULL,
  user_id integer NOT NULL REFERENCES users(id),
  first_edit_at text,
  last_edit_at text,
  basis text,
  UNIQUE (project_id, entity_kind, entity_id, user_id)
);

-- The per-person aggregate the contributions view reads.
CREATE INDEX IF NOT EXISTS idx_entity_contributors_project_user
  ON entity_contributors (project_id, user_id, entity_kind);

-- The per-entity lookup: who wrote in this step.
CREATE INDEX IF NOT EXISTS idx_entity_contributors_entity
  ON entity_contributors (project_id, entity_kind, entity_id);
