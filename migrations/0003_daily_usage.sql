-- One row per UTC day: chat requests accepted that day, across all users.
-- The Worker increments it with a single UPSERT before each model call and
-- refuses chat once it reaches DAILY_CHAT_BUDGET (see worker/src/limits.ts).
CREATE TABLE IF NOT EXISTS daily_usage (
  day TEXT PRIMARY KEY,               -- UTC date, YYYY-MM-DD
  chat_requests INTEGER NOT NULL
);
