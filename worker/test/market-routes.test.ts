import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { hang, json, mockFetch, networkError, problemResponse } from "./fetch-mock";
import { CHART_BARS } from "../src/market-routes";
import {
  BARS_ROUTE,
  barsFor,
  MARKET_DATA_URL,
  marketDataRateLimited,
  marketDataRoutes,
  symbolFor,
  SYMBOLS_ROUTE,
} from "./fixtures";
import { api, expectProblem, ORIGIN } from "./helpers";

/**
 * Calls the Worker's fetch handler with extra vars, as wrangler.toml would
 * set them. These routes run in the Worker, not a Durable Object, so the
 * vars go in the env argument.
 */
function get(path: string, vars: Record<string, unknown> = { MARKET_DATA_URL, MARKET_DATA_TIMEOUT_MS: 100 }) {
  const request = new Request(`https://tradedesk.test${path}`, {
    headers: { Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.7" },
  });
  return worker.fetch(request, { ...env, ...vars } as never);
}

describe("GET /api/market/bars/:ticker", () => {
  it("returns market-data's bars with the source labelled, cacheable, with CORS", async () => {
    const { requests } = mockFetch(marketDataRoutes());
    const res = await get("/api/market/bars/s001");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const fixture = barsFor("S001", CHART_BARS);
    expect(await res.json()).toEqual({
      ticker: "S001",
      source: "synthetic",
      synthetic: true,
      sourceLabel: "synthetic demo data (generated prices, not real market prices)",
      adjustment: "split",
      from: fixture.from,
      to: fixture.to,
      bars: fixture.bars,
    });
    // One request for the latest year of sessions, not a year-long page trimmed afterwards.
    expect(CHART_BARS).toBe(252);
    expect(requests.map((r) => r.url)).toEqual([`${MARKET_DATA_URL}/v1/bars/S001?last=252`]);
  });

  it("sends the API key from the Worker, never from the browser", async () => {
    const { requests } = mockFetch(marketDataRoutes());
    await get("/api/market/bars/S001", { MARKET_DATA_URL, MARKET_DATA_API_KEY: "server-side-key" });
    expect(requests[0].headers.get("X-API-Key")).toBe("server-side-key");
  });

  it("is 503 when market data is not connected (the default)", async () => {
    const { spy } = mockFetch({});
    const res = await api("/api/market/bars/S001");
    const body = await expectProblem(res, 503, "Service Unavailable");
    expect(body.detail).toBe("Market data is not connected on this deployment.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is 404 for a ticker market-data cannot serve, without a request", async () => {
    const { spy } = mockFetch(marketDataRoutes());
    const body = await expectProblem(await get("/api/market/bars/GBP%2FUSD"), 404, "Not Found");
    expect(body.detail).toContain("GBP/USD is not one");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is 400 for input that is not a ticker at all", async () => {
    mockFetch({});
    await expectProblem(await get("/api/market/bars/%3Cscript%3E"), 400, "Bad Request");
  });

  it.each([
    ["404", () => problemResponse(404, "Unknown ticker: S999"), 404, "Not Found", "Unknown ticker: S999"],
    ["a timeout", hang, 504, "Gateway Timeout", "market-data did not answer within 0.1 s."],
    ["a connection failure", networkError, 502, "Bad Gateway", "market-data could not be reached."],
    ["a 500", () => problemResponse(500, "Unexpected error."), 502, "Bad Gateway", "market-data returned HTTP 500."],
    ["its own 429 without a wait", () => problemResponse(429, "Rate limit"), 503, "Service Unavailable", "market-data is busy (rate limit reached); try again later."],
  ] as const)("maps market-data's %s", async (_name, handler, status, title, detail) => {
    mockFetch({ [BARS_ROUTE]: handler });
    const res = await get("/api/market/bars/S999");
    const body = await expectProblem(res, status, title);
    expect(body.detail).toBe(detail);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("passes market-data's wait on as Retry-After, readable by the page", async () => {
    mockFetch({ [BARS_ROUTE]: () => marketDataRateLimited(12) });
    const res = await get("/api/market/bars/S001");
    const body = await expectProblem(res, 503, "Service Unavailable");
    expect(body.detail).toBe("market-data is busy (rate limit reached); retry in 12 s.");
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("access-control-expose-headers")).toContain("Retry-After");
  });

  it("refuses a source the deployment may not display", async () => {
    mockFetch({ [BARS_ROUTE]: () => json(barsFor("AAPL", 5, "alpaca")) });
    const body = await expectProblem(
      await get("/api/market/bars/AAPL", { MARKET_DATA_URL, MARKET_DATA_API_KEY: "k" }),
      404,
      "Not Found",
    );
    expect(body.detail).toContain("may not display");
  });

  it("is rate-limited per IP", async () => {
    const { spy } = mockFetch(marketDataRoutes());
    const res = await get("/api/market/bars/S001", {
      MARKET_DATA_URL,
      MARKET_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    await expectProblem(res, 429, "Too Many Requests");
    expect(res.headers.get("retry-after")).toBe("60");
    expect(spy).not.toHaveBeenCalled();
  });

  it("only answers GET", async () => {
    const res = await worker.fetch(
      new Request("https://tradedesk.test/api/market/bars/S001", { method: "POST", headers: { Origin: ORIGIN } }),
      { ...env, MARKET_DATA_URL } as never,
    );
    await expectProblem(res, 404, "Not Found");
  });
});

describe("GET /api/market/symbols", () => {
  it("lists symbols, keeping only sources the deployment may show", async () => {
    mockFetch({
      [SYMBOLS_ROUTE]: () =>
        json({
          symbols: [
            symbolFor("S001"),
            symbolFor("AAPL", "alpaca", { name: "Apple", feed: "iex", lastIngestedAt: "2026-10-02T21:05:00Z" }),
            symbolFor("S002", "synthetic", { name: null }),
          ],
          nextAfter: null,
        }),
    });
    const res = await get("/api/market/symbols");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      symbols: [
        { ticker: "S001", name: "Synthetic 001", source: "synthetic", lastBar: "2026-10-02", feed: null, lastIngestedAt: null },
        { ticker: "S002", name: null, source: "synthetic", lastBar: "2026-10-02", feed: null, lastIngestedAt: null },
      ],
    });
  });

  it("pages through market-data's list with nextAfter", async () => {
    const { requests } = mockFetch({
      [SYMBOLS_ROUTE]: (request) =>
        new URL(request.url).searchParams.get("after") === "S002"
          ? json({ symbols: [symbolFor("S003")], nextAfter: null })
          : json({ symbols: [symbolFor("S001"), symbolFor("S002")], nextAfter: "S002" }),
    });
    const res = await get("/api/market/symbols");
    const { symbols } = (await res.json()) as { symbols: { ticker: string }[] };
    expect(symbols.map((s) => s.ticker)).toEqual(["S001", "S002", "S003"]);
    expect(requests).toHaveLength(2);
  });

  it("is 503 when market data is not connected, and 504 when it is slow", async () => {
    mockFetch({ [SYMBOLS_ROUTE]: hang });
    await expectProblem(await api("/api/market/symbols"), 503, "Service Unavailable");
    await expectProblem(await get("/api/market/symbols"), 504, "Gateway Timeout");
  });

  it("is 503 with Retry-After when market-data rate-limits the Worker", async () => {
    mockFetch({ [SYMBOLS_ROUTE]: () => marketDataRateLimited(4) });
    const res = await get("/api/market/symbols");
    expect((await expectProblem(res, 503, "Service Unavailable")).detail).toBe(
      "market-data is busy (rate limit reached); retry in 4 s.",
    );
    expect(res.headers.get("retry-after")).toBe("4");
  });
});
