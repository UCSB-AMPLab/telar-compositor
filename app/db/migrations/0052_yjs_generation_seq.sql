-- Two columns that tag a `yjs_state` blob with the generation and sequence
-- number it was current under when it was written, so a later load can tell
-- whether the blob it is about to build against is the one its own log
-- continues or a different lineage entirely.
--
-- A NULL pair means exactly one thing: this blob was written before any code
-- read or wrote these columns. Nothing else can produce a NULL — every write
-- that happens after this migration carries a generation and a sequence, so a
-- NULL pair is a fact about when the row was last written, not a state a
-- current writer can choose. The loader that arrives with the second deploy
-- tags such a blob before it opens a log for it, converting the NULL pair
-- into the first tagged one that log will ever have.
--
-- Until that loader exists, the columns are inert: this migration adds them
-- and nothing reads or writes them, so every row, existing or newly written,
-- keeps NULL here regardless of what else changes about it.
ALTER TABLE projects ADD COLUMN yjs_generation INTEGER;
ALTER TABLE projects ADD COLUMN yjs_seq INTEGER;
