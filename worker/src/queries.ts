// SQL for the analyses table, shared by the Worker, the tests and
// scripts/explain-query-plan.mjs (which prints each query's plan).

/** The 20 most recent analyses for a ticker, with their grounding reports: GET /api/history/:ticker. */
export const HISTORY_SQL = `SELECT id, session_id, ticker, timeframe, user_query, ai_response, grounding, created_at
FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT 20`;

/** The 3 most recent analyses for a ticker, added to the model's context. */
export const CONTEXT_SQL = `SELECT user_query, ai_response, created_at
FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT 3`;

/** Tickers with their analysis count and latest timestamp: GET /api/tickers. */
export const TICKERS_SQL = `SELECT ticker, COUNT(*) as count, MAX(created_at) as last_analysis
FROM analyses GROUP BY ticker ORDER BY last_analysis DESC`;

export const ANALYSES_QUERIES = {
  history: HISTORY_SQL,
  context: CONTEXT_SQL,
  tickers: TICKERS_SQL,
} as const;
