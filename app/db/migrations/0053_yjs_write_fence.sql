-- The row's write revision, and the three database rules that make it a fence.
--
-- @version v1.5.0-beta
--
-- `yjs_write` is 0 on every row no instance has ever claimed, and thereafter a
-- value that only moves up, never resets and never repeats. A row is enrolled
-- once its revision has moved at all, whatever its tags say afterwards.
--
-- `projects_yjs_fence` refuses any statement that assigns the blob or either
-- tag on an enrolled row without also moving the revision. Its condition is the
-- revision, not the tags, so a row whose tags are cleared or malformed stays
-- enrolled. On a virgin row it is inert, which is what lets code written before
-- the loader that claims rows keep writing unclaimed rows while the two coexist.
--
-- `projects_yjs_write_monotonic` makes monotonicity a property of the database
-- for numeric revisions: an assignment at or below the current value aborts. The
-- column's INTEGER affinity does not exclude a non-integer number or text, which
-- is why the loader validates every revision it reads; the trigger orders
-- whatever compares.
--
-- `yjs_write_guard` is how a batch proves, inside its own transaction, that the
-- row still holds the revision it expects. The insert aborts unless the
-- project's revision IS exactly the expected value; `IS NOT` is NULL-safe, so a
-- missing project row aborts too, and an aborting statement aborts the whole
-- batch. The batch's last statement deletes the guard row, so the table is
-- empty outside a transaction.
ALTER TABLE projects ADD COLUMN yjs_write INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER projects_yjs_fence
BEFORE UPDATE OF yjs_state, yjs_generation, yjs_seq ON projects
FOR EACH ROW
WHEN OLD.yjs_write > 0 AND NEW.yjs_write IS OLD.yjs_write
BEGIN
  SELECT RAISE(ABORT, 'yjs_fence');
END;
CREATE TRIGGER projects_yjs_write_monotonic
BEFORE UPDATE OF yjs_write ON projects
FOR EACH ROW
WHEN NEW.yjs_write <= OLD.yjs_write
BEGIN
  SELECT RAISE(ABORT, 'yjs_write_stale');
END;
CREATE TABLE yjs_write_guard (
  project_id INTEGER NOT NULL,
  expected INTEGER NOT NULL
);
CREATE TRIGGER yjs_write_guard_assert
BEFORE INSERT ON yjs_write_guard
FOR EACH ROW
WHEN (SELECT yjs_write FROM projects WHERE id = NEW.project_id) IS NOT NEW.expected
BEGIN
  SELECT RAISE(ABORT, 'yjs_write_guard');
END;
