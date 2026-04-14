-- TradeDesk D1 Schema

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ticker TEXT,
  timeframe TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  timeframe TEXT,
  user_query TEXT NOT NULL,
  ai_response TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_analyses_ticker ON analyses(ticker);
CREATE INDEX IF NOT EXISTS idx_analyses_session ON analyses(session_id);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at DESC);
