// Responses in the shape market-data's /v1 API returns them (see the DTOs in
// lokaz-c/market-data: Dtos.Levels, Dtos.BarsPage). Hand-made test values,
// not real prices.

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

/** `count` weekday bars ending 2026-10-02, oldest first. */
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
    from: "2025-10-02",
    to: "2026-10-02",
    bars,
    nextAfter: null,
  };
}

export const LEVELS_ROUTE = `GET ${MARKET_DATA_URL}/v1/levels/:ticker`;
export const BARS_ROUTE = `GET ${MARKET_DATA_URL}/v1/bars/:ticker`;

/** Routes for a healthy market-data with synthetic data for any ticker; override either. */
export function marketDataRoutes(
  overrides: { levels?: FetchHandler; bars?: FetchHandler } = {},
): Record<string, FetchHandler> {
  return {
    [LEVELS_ROUTE]: overrides.levels ?? ((_req, { ticker }) => json(levelsFor(ticker))),
    [BARS_ROUTE]: overrides.bars ?? ((_req, { ticker }) => json(barsFor(ticker))),
  };
}
