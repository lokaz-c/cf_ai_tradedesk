import { describe, expect, it } from "vitest";
import {
  getBars,
  getLevels,
  marketDataTicker,
  num,
  readMarketDataConfig,
  type MarketDataConfig,
} from "../src/marketdata";
import { hang, json, mockFetch, networkError, problemResponse } from "./fetch-mock";
import { BARS_ROUTE, barsFor, LEVELS_ROUTE, levelsFor, MARKET_DATA_URL, marketDataRoutes } from "./fixtures";

const cfg: MarketDataConfig = {
  baseUrl: MARKET_DATA_URL,
  apiKey: null,
  displaySources: new Set(["synthetic"]),
  timeoutMs: 100,
};

describe("readMarketDataConfig", () => {
  it("is null when MARKET_DATA_URL is unset, empty or not an http(s) URL", () => {
    expect(readMarketDataConfig({})).toBeNull();
    expect(readMarketDataConfig({ MARKET_DATA_URL: "" })).toBeNull();
    expect(readMarketDataConfig({ MARKET_DATA_URL: "   " })).toBeNull();
    expect(readMarketDataConfig({ MARKET_DATA_URL: "not a url" })).toBeNull();
    expect(readMarketDataConfig({ MARKET_DATA_URL: "ftp://example.com" })).toBeNull();
  });

  it("reads the URL, key, display sources and timeout, with defaults", () => {
    expect(readMarketDataConfig({ MARKET_DATA_URL: "https://md.example.com/" })).toEqual({
      baseUrl: "https://md.example.com",
      apiKey: null,
      displaySources: new Set(["synthetic"]),
      timeoutMs: 4000,
    });
    expect(
      readMarketDataConfig({
        MARKET_DATA_URL: "http://localhost:8080",
        MARKET_DATA_API_KEY: " secret ",
        MARKET_DATA_DISPLAY_SOURCES: "Synthetic, alpaca",
        MARKET_DATA_TIMEOUT_MS: "1500",
      }),
    ).toEqual({
      baseUrl: "http://localhost:8080",
      apiKey: "secret",
      displaySources: new Set(["synthetic", "alpaca"]),
      timeoutMs: 1500,
    });
  });

  it("falls back to the default timeout for out-of-range values", () => {
    expect(readMarketDataConfig({ MARKET_DATA_URL: "https://x.test", MARKET_DATA_TIMEOUT_MS: 0 })?.timeoutMs).toBe(4000);
    expect(readMarketDataConfig({ MARKET_DATA_URL: "https://x.test", MARKET_DATA_TIMEOUT_MS: 999_999 })?.timeoutMs).toBe(
      4000,
    );
  });
});

describe("marketDataTicker", () => {
  it.each(["S001", "aapl", "BRK.B", " msft "])("accepts %s", (t) => {
    expect(marketDataTicker(t)).toEqual({ ok: true, value: t.trim().toUpperCase() });
  });

  it.each(["GBP/USD", "BTC-USD", "1ABC", "", "TOOLONGTICKER", 42])("rejects %s", (t) => {
    expect(marketDataTicker(t)).toMatchObject({ ok: false, kind: "unsupported_ticker" });
  });
});

describe("num", () => {
  it("accepts finite numbers and numeric strings only", () => {
    expect(num(185.64)).toBe(185.64);
    expect(num("185.64")).toBe(185.64);
    expect(num(null)).toBeNull();
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(Number.NaN)).toBeNull();
  });
});

describe("getLevels", () => {
  it("returns the parsed levels for a synthetic symbol", async () => {
    const { requests } = mockFetch(marketDataRoutes());
    expect(await getLevels(cfg, "s001")).toEqual({ ok: true, value: levelsFor("S001") });
    expect(requests.map((r) => [r.method, r.url, r.headers.get("Accept")])).toEqual([
      ["GET", `${MARKET_DATA_URL}/v1/levels/S001`, "application/json"],
    ]);
  });

  it("sends X-API-Key only when a key is configured", async () => {
    const { requests } = mockFetch(marketDataRoutes());
    await getLevels(cfg, "S001");
    await getLevels({ ...cfg, apiKey: "k-123" }, "S001");
    expect(requests.map((r) => r.headers.get("X-API-Key"))).toEqual([null, "k-123"]);
  });

  it("accepts prices serialised as strings", async () => {
    const body = levelsFor("S001");
    mockFetch({ [LEVELS_ROUTE]: () => json({ ...body, close: "101.23", pivots: { ...body.pivots, p: "101.1367" } }) });
    const res = await getLevels(cfg, "S001");
    expect(res.ok && [res.value.close, res.value.pivots.p]).toEqual([101.23, 101.1367]);
  });

  it("does not call market-data for a ticker it cannot serve", async () => {
    const { spy } = mockFetch(marketDataRoutes());
    expect(await getLevels(cfg, "GBP/USD")).toMatchObject({ ok: false, kind: "unsupported_ticker" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a 404 problem to not_found with market-data's detail", async () => {
    mockFetch({ [LEVELS_ROUTE]: () => problemResponse(404, "Unknown ticker: AAPL") });
    expect(await getLevels(cfg, "AAPL")).toEqual({ ok: false, kind: "not_found", detail: "Unknown ticker: AAPL" });
  });

  it.each([
    [400, "rejected"],
    [401, "unavailable"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    mockFetch({ [LEVELS_ROUTE]: () => problemResponse(status, "x") });
    expect(await getLevels(cfg, "S001")).toMatchObject({ ok: false, kind });
  });

  it("times out when market-data is slow", async () => {
    mockFetch({ [LEVELS_ROUTE]: hang });
    const started = Date.now();
    expect(await getLevels(cfg, "S001")).toEqual({
      ok: false,
      kind: "timeout",
      detail: "market-data did not answer within 0.1 s.",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports a connection failure as unavailable", async () => {
    mockFetch({ [LEVELS_ROUTE]: networkError });
    expect(await getLevels(cfg, "S001")).toEqual({
      ok: false,
      kind: "unavailable",
      detail: "market-data could not be reached.",
    });
  });

  it("rejects a body that is not JSON or not shaped like levels", async () => {
    mockFetch({ [LEVELS_ROUTE]: () => new Response("<html>", { status: 200 }) });
    expect(await getLevels(cfg, "S001")).toMatchObject({ ok: false, kind: "bad_response" });
    mockFetch({ [LEVELS_ROUTE]: () => json({ ticker: "S001" }) });
    expect(await getLevels(cfg, "S001")).toMatchObject({ ok: false, kind: "bad_response" });
  });

  it("refuses a source that is not cleared for display, even with a key", async () => {
    mockFetch(marketDataRoutes({ levels: (_r, { ticker }) => json(levelsFor(ticker, "alpaca")) }));
    expect(await getLevels({ ...cfg, apiKey: "k" }, "AAPL")).toMatchObject({ ok: false, kind: "not_displayable" });
    const allowed = await getLevels({ ...cfg, displaySources: new Set(["synthetic", "alpaca"]) }, "AAPL");
    expect(allowed.ok && allowed.value.source).toBe("alpaca");
  });
});

describe("getBars", () => {
  it("requests the default one-year window in one page and returns the bars oldest first", async () => {
    const { requests } = mockFetch(marketDataRoutes());
    const res = await getBars(cfg, "S001");
    expect(requests.map((r) => new URL(r.url).search)).toEqual(["?limit=1000"]);
    expect(res.ok && res.value.bars).toEqual(barsFor("S001").bars);
  });

  it("follows nextAfter when a page is full", async () => {
    const all = barsFor("S001", 6).bars;
    mockFetch({
      [BARS_ROUTE]: (request) => {
        const after = new URL(request.url).searchParams.get("after");
        const bars = after ? all.slice(3) : all.slice(0, 3);
        return json({ ...barsFor("S001", 0), bars, nextAfter: after ? null : all[2].date });
      },
    });
    const res = await getBars(cfg, "S001");
    expect(res.ok && res.value.bars.map((b) => b.date)).toEqual(all.map((b) => b.date));
  });

  it("passes 404s and timeouts through", async () => {
    mockFetch({ [BARS_ROUTE]: () => problemResponse(404, "Unknown ticker: NOPE") });
    expect(await getBars(cfg, "NOPE")).toMatchObject({ ok: false, kind: "not_found" });
    mockFetch({ [BARS_ROUTE]: hang });
    expect(await getBars(cfg, "S001")).toMatchObject({ ok: false, kind: "timeout" });
  });
});
