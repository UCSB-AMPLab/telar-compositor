-- A deleted account leaves its row behind as a tombstone, so that the work the
-- person did keeps their name as part of each project's history: every
-- reference to them (created_by, last_edited_by, contributor, editing-time and
-- activity rows) stays valid, and a warm Durable Object holding their edit
-- still writes an id that resolves. `deleted_at` marks the row as no longer an
-- account. The deletion clears everything else a live account holds.
ALTER TABLE users ADD COLUMN deleted_at text;

-- No membership may name a deleted account, whichever route writes it: an
-- invite, a code or a session cookie left open elsewhere would otherwise make
-- the tombstone a member again, and a member can open a socket. Enforced here
-- so that no route has to remember it, and so that a deletion landing between
-- a route's lookup and its insert cannot slip past it.
CREATE TRIGGER project_members_live_user_insert
BEFORE INSERT ON project_members
FOR EACH ROW
WHEN (SELECT deleted_at FROM users WHERE id = NEW.user_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'user_deleted');
END;
CREATE TRIGGER project_members_live_user_update
BEFORE UPDATE OF user_id ON project_members
FOR EACH ROW
WHEN (SELECT deleted_at FROM users WHERE id = NEW.user_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'user_deleted');
END;
