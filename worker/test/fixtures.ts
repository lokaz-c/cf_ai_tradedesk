// Responses in the shape market-data's /v1 API returns them (see the DTOs in
// lokaz-c/market-data: Dtos.Levels, Dtos.BarsPage, Dtos.SymbolList).
// Hand-made test values, not real prices.

import { json, type FetchHandler } from "./fetch-mock";

export const MARKET_DATA_URL = "https://market-data.test";

/** Pivots from H 102.4, L 99.78, C 101.23, rounded to 4 decimals as market-data does. */
export function levelsFor(ticker: string, source = "synthetic") {
  return {
    ticker,
    source,
    asOf: "2026-10-02",
    close: 101.23,
    pivots: {
      basedOn: "2026-10-02",
      p: 101.1367,
      r1: 102.4933,
      r2: 103.7567,
      r3: 105.1133,
      s1: 99.8733,
      s2: 98.5167,
      s3: 97.2533,
    },
    range20d: { high: 105.2, low: 97.8 },
    range50d: { high: 108.45, low: 95.1 },
    // Under a year of history: market-data sends null.
    range52w: { high: null, low: null },
  };
}

/**
 * The `count` latest weekday bars ending 2026-10-02, oldest first, as
 * `/v1/bars/{ticker}?last=count` returns them: `from` is the first bar and
 * there is no cursor. The newest bars are the same whatever `count` is.
 */
export function barsFor(ticker: string, count = 30, source = "synthetic") {
  const bars: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  const day = new Date(Date.UTC(2026, 9, 2));
  while (bars.length < count) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const i = bars.length;
      const close = 100 + ((i * 37) % 11) / 4;
      bars.push({
        date: day.toISOString().slice(0, 10),
        open: close - 0.5,
        high: close + 1,
        low: close - 1.25,
        close,
        volume: 1_000_000 + i * 1000,
      });
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  bars.reverse();
  return {
    ticker,
    source,
    adjustment: "split",
    from: bars[0]?.date ?? "2026-10-02",
    to: "2026-10-02",
    bars,
    nextAfter: null,
  };
}

/** The `last` query parameter of a /v1/bars request (30 when absent, as a test default). */
export function lastParam(request: Request): number {
  const last = new URL(request.url).searchParams.get("last");
  return last === null ? 30 : Number(last);
}

export const LEVELS_ROUTE = `GET ${MARKET_DATA_URL}/v1/levels/:ticker`;
export const BARS_ROUTE = `GET ${MARKET_DATA_URL}/v1/bars/:ticker`;
export const SYMBOLS_ROUTE = `GET ${MARKET_DATA_URL}/v1/symbols`;

/** A /v1/symbols entry; synthetic symbols have no feed and no ingestion time. */
export function symbolFor(ticker: string, source = "synthetic", extra: Record<string, unknown> = {}) {
  return {
    ticker,
    name: `Synthetic ${ticker.slice(1)}`,
    source,
    firstBar: "2016-10-03",
    lastBar: "2026-10-02",
    lastClose: 101.23,
    feed: null,
    lastIngestedAt: null,
    ...extra,
  };
}

/** A 429 from market-data's rate limiter, with its headers (RateLimitFilter). */
export function marketDataRateLimited(retryAfter: number | null, rateLimit?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/problem+json",
    "RateLimit-Policy": '"per-ip";q=30;w=30',
    "X-RateLimit-Remaining": "0",
  };
  if (retryAfter !== null) headers["Retry-After"] = String(retryAfter);
  if (rateLimit !== undefined) headers.RateLimit = rateLimit;
  else if (retryAfter !== null) headers.RateLimit = `"per-ip";r=0;t=${retryAfter}`;
  const detail = `Rate limit of 60 requests per minute exceeded. Retry in ${retryAfter ?? 1} s.`;
  return new Response(JSON.stringify({ title: "Too Many Requests", status: 429, detail, instance: "/v1/levels/S001" }), {
    status: 429,
    headers,
  });
}

/** Routes for a healthy market-data with synthetic data for any ticker; override either. */
export function marketDataRoutes(
  overrides: { levels?: FetchHandler; bars?: FetchHandler } = {},
): Record<string, FetchHandler> {
  return {
    [LEVELS_ROUTE]: overrides.levels ?? ((_req, { ticker }) => json(levelsFor(ticker))),
    [BARS_ROUTE]: overrides.bars ?? ((req, { ticker }) => json(barsFor(ticker, lastParam(req)))),
  };
}

// quant (lokaz-c/quant, app/routes/backtest_routes.py and
// app/services/backtest_service.py). Hand-made metric values.

export const QUANT_URL = "https://quant.test";
export const BACKTEST_ROUTE = `POST ${QUANT_URL}/api/backtest/`;
export const QUANT_DATA_ROUTE = `GET ${QUANT_URL}/api/data`;

export const QUANT_DATA_SOURCE = {
  synthetic: true,
  file: "data/sample_data.csv",
  description:
    "Synthetic daily bars from a seeded Markov regime-switching GBM (config/data_generator.json). Ticker names are labels only.",
};

export const QUANT_METRICS = {
  total_return: -3.2117,
  cagr: -1.6234,
  max_drawdown: 12.4871,
  volatility: 9.8812,
  sharpe_ratio: -0.2156,
  win_rate: 41.6667,
  avg_win: 812.43,
  avg_loss: -655.1,
  num_trades: 12,
  final_equity: 96788.3,
  profit_factor: 0.8834,
  max_consecutive_wins: 2,
  max_consecutive_losses: 4,
};

export function backtestResponse(overrides: Record<string, unknown> = {}) {
  return {
    backtest_id: 42,
    status: "completed",
    metrics: QUANT_METRICS,
    summary: { equity: 96788.3, cash: 96788.3, positions: 0, total_return: -0.032117 },
    data: QUANT_DATA_SOURCE,
    baseline: null,
    ...overrides,
  };
}

export const QUANT_DATA_INFO = {
  ...QUANT_DATA_SOURCE,
  symbols: ["AAPL", "MSFT", "NVDA"],
  start_date: "2020-01-01",
  end_date: "2024-12-31",
  bars: 1305,
};
