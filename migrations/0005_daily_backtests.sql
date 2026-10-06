-- Backtests run per UTC day, across all users, next to the chat count. The
-- Worker increments it with one UPSERT before calling quant and refuses the
-- backtest tool once it reaches DAILY_BACKTEST_BUDGET (worker/src/limits.ts).
ALTER TABLE daily_usage ADD COLUMN backtests INTEGER NOT NULL DEFAULT 0;
