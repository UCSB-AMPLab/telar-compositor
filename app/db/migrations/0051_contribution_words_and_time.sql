-- The two measures the contribution record needs and the database cannot yet
-- answer: how many words each person wrote, and how long they spent working.
--
-- `entity_contributors` (migration 0048) already answers who wrote in what. It
-- is the "edited" measure, and on its own it says nothing about how much: a
-- student who fixed a typo and a student who wrote four hundred words are the
-- same row. The cohort exercise that produced this feature found the difference
-- to be the most diagnostic thing measured — one group put 74% of its words in
-- detail panels, another wrote 1,383 words with none in a panel at all — so a
-- record without it reports the two groups as having done the same work.
--
--
-- WORDS: A COLUMN ON THE CONTRIBUTOR ROW, NOT A TABLE OF ITS OWN
--
-- Words belong to a (person, entity) pair, which is exactly the row that already
-- exists. A separate per-person-per-kind table would hold a number nothing could
-- be checked against, and would need its own rule for what happens when an entity
-- is deleted. Here the existing rule covers it: consumers join against the entity
-- table, so a deleted step takes its word counts out of every total with it.
--
-- NULLABLE, and the default is NULL rather than 0. A row written before this
-- migration, or recovered from `yjs_state`, records that somebody wrote in an
-- entity without recording how much — which is not the same fact as their having
-- written nothing, and the record renders the two differently (an em dash against
-- a grey zero). Only the Durable Object, watching an edit arrive, can tell them
-- apart, so only it writes this column.
--
-- It counts words ADDED, accumulated per transaction: the difference between the
-- word count of a field before an edit and after it, taken when the edit arrives
-- and credited to whoever made it, never below zero. This is the only division
-- that is honestly attributable. Words PRESENT in a field cannot be split between
-- two people who both wrote in it, and the CRDT's own per-character attribution
-- is destroyed by any rehydration of the document. The cost of counting additions
-- is that rewriting your own paragraph counts twice; the caveat travels with the
-- number wherever it is shown.
--
ALTER TABLE entity_contributors ADD COLUMN words_written integer;

--
-- TIME: A ROW PER PERSON PER PROJECT
--
-- Unlike words, time is not a property of any entity. A person moves between a
-- step, an object record and a page inside one stretch of work, and splitting
-- that stretch across the three would invent boundaries the work did not have.
--
-- WHAT IS COUNTED. A change starts a clock that runs for a minute; a further
-- change inside that minute extends it. Total time is the measure of the union
-- of those windows, so a single isolated change records one minute and a run of
-- changes a minute apart records their whole span. The rule is stated to the user
-- in those terms: the clock starts on a change and stops after a minute, unless a
-- new change is detected.
--
-- The alternative considered and rejected was to stop the clock at the last
-- change and count nothing after it. It needs the same one-minute timer — the
-- timer is what tells you a stretch has ended — and differs only in whether the
-- tail is added. It was rejected because the collaboration sidebar shows this
-- number live, ticking: under a last-change rule the visible clock would have to
-- run backwards by up to a minute every time the user went idle, so the number
-- being watched would not be the number being stored.
--
-- TWO MEASURES, ONE STREAM. `editing_seconds` counts any change to the site —
-- writing, framing an image, adding a step, reordering, filling in a record.
-- `writing_seconds` counts the part of that spent typing into a prose field, and
-- is always the smaller. Both come out of the same stamps, so the split costs
-- nothing to collect, and it is what makes the convenor's work legible: uploading
-- and cataloguing images is a large editing time against a small writing one, and
-- a writing-only measure reports it as idleness. That complaint — convenors
-- feeling they carry disproportionate weight — is the reason this feature exists.
--
-- WHY THE STAMPS ARE STORED ALONGSIDE THE TOTALS. `last_change_at` and
-- `last_write_at` are not display fields; they are how a Durable Object that has
-- just started decides whether the change it is holding continues the previous
-- stretch of work or begins a new one. Without them every eviction would restart
-- the clock and credit a fresh minute, which turns an idle pause into a minute of
-- recorded work. The Durable Object reads them at hydration and only ever moves
-- them forward.
--
-- ACCUMULATED, NEVER ASSIGNED. Every write is the window's delta added to what is
-- stored, for the reason migration 0048 gives at length: an instance holds only
-- what it has seen since it started, so an assignment would write one lifetime
-- over the whole history. That is how `fields_edited` came to overwrite a stored
-- count.
--
-- Backwards-compatible in both halves: a nullable column and a new table are
-- invisible to code that does not read them, so a rollback to the previous worker
-- keeps working.
--
CREATE TABLE IF NOT EXISTS member_editing_time (
  id integer PRIMARY KEY AUTOINCREMENT,
  project_id integer NOT NULL REFERENCES projects(id),
  user_id integer NOT NULL REFERENCES users(id),
  editing_seconds integer NOT NULL DEFAULT 0,
  writing_seconds integer NOT NULL DEFAULT 0,
  last_change_at text,
  last_write_at text,
  UNIQUE (project_id, user_id)
);

-- The record reads every member of one project at once, and the Durable Object
-- reads the same set at hydration. The unique constraint above already indexes
-- (project_id, user_id), which serves both, so there is no second index here.
