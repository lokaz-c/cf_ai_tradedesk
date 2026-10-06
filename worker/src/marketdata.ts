/**
 * Client for the market-data service (github.com/lokaz-c/market-data), the
 * source of every price level TradeDesk shows. Contract, from its /v1 API:
 *
 * - GET /v1/levels/{ticker}: `{ ticker, source, asOf, close, pivots: { basedOn,
 *   p, r1, r2, r3, s1, s2, s3 }, range20d: { high, low }, range50d, range52w }`.
 *   Range values are null until the symbol has that much history.
 * - GET /v1/bars/{ticker}?last=N (1 to 1,000): `{ ticker, source, adjustment,
 *   from, to, bars: [{ date, open, high, low, close, volume, feed? }],
 *   nextAfter: null }`, the N latest split-adjusted bars, oldest first, in one
 *   page. `feed` ("iex" or "sip") is present only on Alpaca bars.
 * - GET /v1/symbols?limit=&after=: `{ symbols: [{ ticker, name, source,
 *   firstBar, lastBar, lastClose, feed, lastIngestedAt }], nextAfter }`, at
 *   most 200 per page, keyset-paginated by ticker: pass `nextAfter` back as
 *   `after`; it is null on the last page.
 * - Errors are RFC 9457 problem details; 404 covers both "unknown ticker" and
 *   "not visible to this caller". Requests without a key that has the
 *   `rate-limit` scope are rate-limited per IP: a 429 carries `Retry-After`
 *   and `RateLimit: "per-ip";r=0;t=<seconds>`. A wrong key is a 401.
 *
 * `MARKET_DATA_API_KEY` is sent as `X-API-Key` when set. It is meant to be a
 * key with only the `rate-limit` scope: that lifts the per-IP limit and
 * leaves market-data serving only its public (synthetic) sources.
 *
 * `source` is "synthetic" or "alpaca". Alpaca's terms forbid public display of
 * its data without written consent, so market-data serves only synthetic data
 * without the `alpaca-data` scope, and this client refuses any source not
 * listed in MARKET_DATA_DISPLAY_SOURCES (default: synthetic), even when a key
 * would let the Worker read it.
 */

import { intVar } from "./limits";
import { retryAfterFrom, retryPhrase } from "./retry";

export interface MarketDataVars {
  /** Base URL of the market-data service, e.g. https://market-data.example.com. Unset turns grounding off. */
  MARKET_DATA_URL?: unknown;
  /**
   * Optional API key, sent as X-API-Key: one with only the `rate-limit` scope.
   * A secret: `wrangler secret put MARKET_DATA_API_KEY`.
   */
  MARKET_DATA_API_KEY?: unknown;
  /** Comma-separated `source` values TradeDesk may show (default "synthetic"). */
  MARKET_DATA_DISPLAY_SOURCES?: unknown;
  /** Per-request timeout in milliseconds (default 4000). */
  MARKET_DATA_TIMEOUT_MS?: unknown;
}

export interface MarketDataConfig {
  baseUrl: string;
  apiKey: string | null;
  displaySources: ReadonlySet<string>;
  timeoutMs: number;
}

export const DEFAULT_MARKET_DATA_TIMEOUT_MS = 4000;
export const DEFAULT_DISPLAY_SOURCES = "synthetic";

/** Returns the configuration, or null when MARKET_DATA_URL is unset or not an http(s) URL. */
export function readMarketDataConfig(env: MarketDataVars): MarketDataConfig | null {
  const raw = typeof env.MARKET_DATA_URL === "string" ? env.MARKET_DATA_URL.trim() : "";
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const key = typeof env.MARKET_DATA_API_KEY === "string" ? env.MARKET_DATA_API_KEY.trim() : "";
  const sources = typeof env.MARKET_DATA_DISPLAY_SOURCES === "string"
    ? env.MARKET_DATA_DISPLAY_SOURCES
    : DEFAULT_DISPLAY_SOURCES;
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    apiKey: key || null,
    displaySources: new Set(
      sources
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    timeoutMs: intVar(env.MARKET_DATA_TIMEOUT_MS, DEFAULT_MARKET_DATA_TIMEOUT_MS, 50, 30_000),
  };
}

/** market-data's ticker format (its Tickers.REGEX), after upper-casing. */
export const MARKET_DATA_TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

export interface Pivots {
  basedOn: string;
  p: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface Range {
  high: number | null;
  low: number | null;
}

export interface Levels {
  ticker: string;
  source: string;
  asOf: string;
  close: number;
  pivots: Pivots;
  range20d: Range;
  range50d: Range;
  range52w: Range;
}

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarsPage {
  ticker: string;
  source: string;
  adjustment: string;
  from: string;
  to: string;
  bars: Bar[];
}

export interface SymbolSummary {
  ticker: string;
  name: string | null;
  source: string;
  lastBar: string | null;
  /** Alpaca feed of the latest bar ("iex" or "sip"); null for synthetic data. */
  feed: string | null;
  /** When market-data last ingested the symbol (ISO 8601); null for synthetic data. */
  lastIngestedAt: string | null;
}

export type FailureKind =
  | "unsupported_ticker"
  | "not_found"
  | "rejected"
  | "timeout"
  | "unavailable"
  | "rate_limited"
  | "not_displayable"
  | "bad_response";

export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: FailureKind;
      detail: string;
      /** For rate_limited: the seconds market-data asked us to wait, when it said. */
      retryAfter?: number;
    };

const fail = (kind: FailureKind, detail: string) => ({ ok: false, kind, detail }) as const;

/** Problem `detail` strings are shown to the model and the page; keep them short. */
const MAX_DETAIL_CHARS = 200;

export function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** A finite number, or a numeric string (BigDecimal can be serialised either way). */
export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function problemDetail(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (isObject(body) && typeof body.detail === "string" && body.detail) {
      return body.detail.slice(0, MAX_DETAIL_CHARS);
    }
  } catch {
    // Not JSON.
  }
  return null;
}

/** GET a market-data path. Every failure becomes a Result, never an exception. */
async function getJson(cfg: MarketDataConfig, path: string, what: string): Promise<Result<unknown>> {
  const headers = new Headers({ Accept: "application/json" });
  if (cfg.apiKey) headers.set("X-API-Key", cfg.apiKey);
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + path, { headers, signal });
  } catch {
    return signal.aborted
      ? fail("timeout", `market-data did not answer within ${seconds(cfg.timeoutMs)}.`)
      : fail("unavailable", "market-data could not be reached.");
  }
  if (!res.ok) {
    const detail = await problemDetail(res);
    switch (res.status) {
      case 404:
        return fail("not_found", detail ?? `market-data has no data for ${what}.`);
      case 400:
        return fail("rejected", detail ?? `market-data rejected the request for ${what}.`);
      case 429: {
        const wait = retryAfterFrom(res.headers);
        return {
          ...fail("rate_limited", `market-data is busy (rate limit reached); ${retryPhrase(wait)}.`),
          ...(wait !== null ? { retryAfter: wait } : {}),
        };
      }
      case 401:
        return fail("unavailable", "market-data rejected the configured API key (MARKET_DATA_API_KEY).");
      default:
        return fail("unavailable", `market-data returned HTTP ${res.status}.`);
    }
  }
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return signal.aborted
      ? fail("timeout", `market-data did not answer within ${seconds(cfg.timeoutMs)}.`)
      : fail("bad_response", "market-data returned a body that is not JSON.");
  }
}

/** Upper-cases the ticker and checks market-data's format before any request is made. */
export function marketDataTicker(raw: unknown): Result<string> {
  const ticker = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (MARKET_DATA_TICKER.test(ticker)) return { ok: true, value: ticker };
  const shown = ticker ? ticker.slice(0, 20) : "(empty)";
  return fail(
    "unsupported_ticker",
    `market-data covers tickers made of letters, digits and dots (for example S001 or AAPL); ${shown} is not one.`,
  );
}

function displayable<T extends { source: string; ticker: string }>(cfg: MarketDataConfig, value: T): Result<T> {
  if (cfg.displaySources.has(value.source.toLowerCase())) return { ok: true, value };
  return fail(
    "not_displayable",
    `market-data returned ${value.source} data for ${value.ticker}, which this deployment may not display (MARKET_DATA_DISPLAY_SOURCES).`,
  );
}

function parseRange(v: unknown): Range | null {
  if (!isObject(v)) return null;
  return { high: num(v.high), low: num(v.low) };
}

export function parseLevels(body: unknown): Levels | null {
  if (!isObject(body) || !isObject(body.pivots)) return null;
  const { ticker, source, asOf } = body;
  const close = num(body.close);
  if (typeof ticker !== "string" || typeof source !== "string" || typeof asOf !== "string" || close === null) {
    return null;
  }
  const p = body.pivots;
  const pivotValues = (["p", "r1", "r2", "r3", "s1", "s2", "s3"] as const).map((k) => num(p[k]));
  if (pivotValues.some((v) => v === null) || typeof p.basedOn !== "string") return null;
  const [pp, r1, r2, r3, s1, s2, s3] = pivotValues as number[];
  const range20d = parseRange(body.range20d);
  const range50d = parseRange(body.range50d);
  const range52w = parseRange(body.range52w);
  if (!range20d || !range50d || !range52w) return null;
  return {
    ticker,
    source,
    asOf,
    close,
    pivots: { basedOn: p.basedOn, p: pp, r1, r2, r3, s1, s2, s3 },
    range20d,
    range50d,
    range52w,
  };
}

function parseBar(v: unknown): Bar | null {
  if (!isObject(v) || typeof v.date !== "string") return null;
  const values = [v.open, v.high, v.low, v.close, v.volume].map(num);
  if (values.some((x) => x === null)) return null;
  const [open, high, low, close, volume] = values as number[];
  return { date: v.date, open, high, low, close, volume };
}

export function parseBarsPage(body: unknown): BarsPage | null {
  if (!isObject(body) || !Array.isArray(body.bars)) return null;
  const { ticker, source, adjustment, from, to } = body;
  if (typeof ticker !== "string" || typeof source !== "string") return null;
  const bars = body.bars.map(parseBar);
  if (bars.some((b) => b === null)) return null;
  return {
    ticker,
    source,
    adjustment: typeof adjustment === "string" ? adjustment : "split",
    from: typeof from === "string" ? from : "",
    to: typeof to === "string" ? to : "",
    bars: bars as Bar[],
  };
}

/** GET /v1/levels/{ticker}. */
export async function getLevels(cfg: MarketDataConfig, rawTicker: unknown): Promise<Result<Levels>> {
  const ticker = marketDataTicker(rawTicker);
  if (!ticker.ok) return ticker;
  const res = await getJson(cfg, `/v1/levels/${encodeURIComponent(ticker.value)}`, ticker.value);
  if (!res.ok) return res;
  const levels = parseLevels(res.value);
  if (!levels) return fail("bad_response", "market-data returned levels in an unexpected shape.");
  return displayable(cfg, levels);
}

/** The most bars market-data returns for `last` (its MAX_PAGE). */
export const MAX_LAST_BARS = 1000;

/**
 * GET /v1/bars/{ticker}?last=N: the N latest split-adjusted daily bars,
 * oldest first, in one request. N is clamped to 1-1,000.
 */
export async function getBars(cfg: MarketDataConfig, rawTicker: unknown, last: number): Promise<Result<BarsPage>> {
  const ticker = marketDataTicker(rawTicker);
  if (!ticker.ok) return ticker;
  const n = Math.min(MAX_LAST_BARS, Math.max(1, Math.trunc(last) || 1));
  const res = await getJson(cfg, `/v1/bars/${encodeURIComponent(ticker.value)}?last=${n}`, ticker.value);
  if (!res.ok) return res;
  const page = parseBarsPage(res.value);
  if (!page) return fail("bad_response", "market-data returned bars in an unexpected shape.");
  // market-data sends at most N; keep the newest N if a server ever sends more.
  return displayable(cfg, { ...page, bars: page.bars.slice(-n) });
}

/** Rows per /v1/symbols page (market-data's MAX_SYMBOLS_PAGE). */
const SYMBOLS_PAGE = 200;
/** Pages followed before stopping: 1,000 symbols, more than the demo's 50. Guards against a cursor loop. */
const MAX_SYMBOL_PAGES = 5;

function parseSymbol(cfg: MarketDataConfig, s: unknown): SymbolSummary | null {
  if (!isObject(s) || typeof s.ticker !== "string" || typeof s.source !== "string") return null;
  if (!MARKET_DATA_TICKER.test(s.ticker) || !cfg.displaySources.has(s.source.toLowerCase())) return null;
  return {
    ticker: s.ticker,
    name: typeof s.name === "string" ? s.name.slice(0, 80) : null,
    source: s.source,
    lastBar: typeof s.lastBar === "string" ? s.lastBar : null,
    feed: typeof s.feed === "string" ? s.feed.slice(0, 10) : null,
    lastIngestedAt: typeof s.lastIngestedAt === "string" ? s.lastIngestedAt.slice(0, 40) : null,
  };
}

/**
 * GET /v1/symbols, following `nextAfter` page by page: the symbols with data,
 * limited to the sources this deployment may show, in ticker order.
 */
export async function getSymbols(cfg: MarketDataConfig): Promise<Result<SymbolSummary[]>> {
  const symbols: SymbolSummary[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_SYMBOL_PAGES; page++) {
    const path = `/v1/symbols?limit=${SYMBOLS_PAGE}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const res = await getJson(cfg, path, "the symbol list");
    if (!res.ok) return res;
    if (!isObject(res.value) || !Array.isArray(res.value.symbols)) {
      return fail("bad_response", "market-data returned the symbol list in an unexpected shape.");
    }
    for (const s of res.value.symbols) {
      const parsed = parseSymbol(cfg, s);
      if (parsed) symbols.push(parsed);
    }
    const next: unknown = res.value.nextAfter;
    // A missing, malformed or repeated cursor ends the listing.
    if (typeof next !== "string" || !MARKET_DATA_TICKER.test(next) || cursors.has(next)) break;
    cursors.add(next);
    after = next;
  }
  return { ok: true, value: symbols };
}


export function isSynthetic(source: string): boolean {
  return source.toLowerCase() === "synthetic";
}

/** How a source is described to the model and on the page. */
export function sourceLabel(source: string): string {
  switch (source.toLowerCase()) {
    case "synthetic":
      return "synthetic demo data (generated prices, not real market prices)";
    case "alpaca":
      return "Alpaca market data (IEX feed)";
    default:
      return source;
  }
}
