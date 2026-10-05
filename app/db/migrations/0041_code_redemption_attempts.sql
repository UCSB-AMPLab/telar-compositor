-- Course projects, part 6 of 6: the redemption rate limiter.
--
-- One self-resetting row per user: failed redemptions are counted against a
-- fixed hourly window, and the window restarts when window_start is older than
-- an hour. Every redemption surface is post-authentication, so counting per user
-- needs no IP handling. The row is deleted with the user's account.
CREATE TABLE code_redemption_attempts (
  user_id INTEGER PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
