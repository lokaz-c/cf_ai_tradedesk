-- History (/api/history/:ticker) and model context both run
--   WHERE ticker = ? ORDER BY created_at DESC LIMIT n
-- With only idx_analyses_ticker, SQLite finds the rows by ticker and then sorts
-- them in a temporary B-tree. A composite index returns them already in
-- created_at order (read backwards for DESC), so the sort goes away and LIMIT
-- stops after n rows. It also covers the per-ticker rollup (/api/tickers).
-- Plans before and after: worker/scripts/explain-query-plan.mjs.
CREATE INDEX IF NOT EXISTS idx_analyses_ticker_created ON analyses(ticker, created_at);

-- idx_analyses_ticker is a prefix of the new index, and no query uses
-- idx_analyses_created, so both only cost a write on every insert.
DROP INDEX IF EXISTS idx_analyses_ticker;
DROP INDEX IF EXISTS idx_analyses_created;
