import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { hang, json, mockFetch, networkError, problemResponse } from "./fetch-mock";
import { BARS_ROUTE, barsFor, MARKET_DATA_URL, marketDataRoutes } from "./fixtures";
import { api, expectProblem, ORIGIN } from "./helpers";

const SYMBOLS_ROUTE = `GET ${MARKET_DATA_URL}/v1/symbols`;

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
    const fixture = barsFor("S001");
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
    expect(requests.map((r) => r.url)).toEqual([`${MARKET_DATA_URL}/v1/bars/S001?limit=1000`]);
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
    ["its own 429", () => problemResponse(429, "Rate limit"), 503, "Service Unavailable", "market-data is rate-limiting this Worker; try again in a minute."],
  ] as const)("maps market-data's %s", async (_name, handler, status, title, detail) => {
    mockFetch({ [BARS_ROUTE]: handler });
    const body = await expectProblem(await get("/api/market/bars/S999"), status, title);
    expect(body.detail).toBe(detail);
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
            { ticker: "S001", name: "Synthetic 001", source: "synthetic", firstBar: "2016-10-03", lastBar: "2026-10-02", lastClose: 101.23 },
            { ticker: "AAPL", name: "Apple", source: "alpaca", firstBar: "2016-01-04", lastBar: "2026-10-02", lastClose: 1 },
            { ticker: "S002", name: null, source: "synthetic", firstBar: "2016-10-03", lastBar: "2026-10-02", lastClose: 55.5 },
          ],
        }),
    });
    const res = await get("/api/market/symbols");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      symbols: [
        { ticker: "S001", name: "Synthetic 001", source: "synthetic", lastBar: "2026-10-02" },
        { ticker: "S002", name: null, source: "synthetic", lastBar: "2026-10-02" },
      ],
    });
  });

  it("is 503 when market data is not connected, and 504 when it is slow", async () => {
    mockFetch({ [SYMBOLS_ROUTE]: hang });
    await expectProblem(await api("/api/market/symbols"), 503, "Service Unavailable");
    await expectProblem(await get("/api/market/symbols"), 504, "Gateway Timeout");
  });
});
