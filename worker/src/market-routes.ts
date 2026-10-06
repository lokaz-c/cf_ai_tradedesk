/**
 * Read-only market-data routes for the chart panel. The browser never calls
 * market-data itself: the Worker does, so the API key (if any) stays on the
 * server, CORS stays the Worker's allow-list, and the display-source check
 * applies to the chart as it does to the model.
 *
 *   GET /api/market/bars/:ticker   the latest CHART_BARS daily bars (about a year)
 *   GET /api/market/symbols        symbols with data the deployment may show
 */

import { problem } from "./http";
import { clientKey } from "./limits";
import {
  getBars,
  type Result,
  getSymbols,
  isSynthetic,
  readMarketDataConfig,
  sourceLabel,
  type FailureKind,
  type MarketDataVars,
} from "./marketdata";
import { INVALID_TICKER, parseTickerPath } from "./validation";

export interface MarketRouteEnv extends MarketDataVars {
  /** Per-IP limit on these routes ([[ratelimits]] in wrangler.toml). */
  MARKET_RATE_LIMITER: RateLimit;
}

/** market-data answers change once a day; it caches them for five minutes too. */
const CACHE_CONTROL = "public, max-age=300";
const RETRY_AFTER_SECONDS = 60;
/** Bars for the chart: about one year of trading sessions, fetched with market-data's `last`. */
export const CHART_BARS = 252;

const STATUS_FOR: Record<FailureKind, number> = {
  unsupported_ticker: 404,
  not_found: 404,
  rejected: 404,
  not_displayable: 404,
  timeout: 504,
  unavailable: 502,
  rate_limited: 503,
  bad_response: 502,
};

const TITLES: Record<number, string> = {
  404: "Not Found",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * A failed market-data call as a problem response. When market-data rate-limits
 * the Worker, its wait is passed on as Retry-After, so the page can say when
 * to retry.
 */
function failure(res: Extract<Result<unknown>, { ok: false }>): Response {
  const status = STATUS_FOR[res.kind];
  const headers = res.retryAfter !== undefined ? { "Retry-After": String(res.retryAfter) } : undefined;
  return problem(status, TITLES[status], res.detail, headers);
}

/** Handles /api/market/* GET routes; returns null for any other path. */
export async function marketRoute(request: Request, env: MarketRouteEnv, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/market/") || request.method !== "GET") return null;
  const barsMatch = url.pathname.match(/^\/api\/market\/bars\/(.+)$/);
  const isSymbols = url.pathname === "/api/market/symbols";
  if (!barsMatch && !isSymbols) return null;

  const cfg = readMarketDataConfig(env);
  if (!cfg) return problem(503, "Service Unavailable", "Market data is not connected on this deployment.");

  const { success } = await env.MARKET_RATE_LIMITER.limit({ key: clientKey(request.headers.get("CF-Connecting-IP")) });
  if (!success) {
    return problem(
      429,
      "Too Many Requests",
      `Too many market data requests from your network. Try again in ${RETRY_AFTER_SECONDS} seconds.`,
      { "Retry-After": String(RETRY_AFTER_SECONDS) },
    );
  }

  if (isSymbols) {
    const res = await getSymbols(cfg);
    if (!res.ok) return failure(res);
    return Response.json({ symbols: res.value }, { headers: { "Cache-Control": CACHE_CONTROL } });
  }

  const ticker = parseTickerPath(barsMatch![1]);
  if (!ticker) return problem(400, "Bad Request", INVALID_TICKER);
  const res = await getBars(cfg, ticker, CHART_BARS);
  if (!res.ok) return failure(res);
  const page = res.value;
  return Response.json(
    {
      ticker: page.ticker,
      source: page.source,
      synthetic: isSynthetic(page.source),
      sourceLabel: sourceLabel(page.source),
      adjustment: page.adjustment,
      from: page.from,
      to: page.to,
      bars: page.bars,
    },
    { headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
