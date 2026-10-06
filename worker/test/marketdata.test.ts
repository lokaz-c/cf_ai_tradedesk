import { describe, expect, it } from "vitest";
import {
  getBars,
  getLevels,
  getSymbols,
  marketDataTicker,
  num,
  readMarketDataConfig,
  type MarketDataConfig,
} from "../src/marketdata";
import { hang, json, mockFetch, networkError, problemResponse } from "./fetch-mock";
import {
  BARS_ROUTE,
  barsFor,
  LEVELS_ROUTE,
  levelsFor,
  MARKET_DATA_URL,
  marketDataRateLimited,
  marketDataRoutes,
  symbolFor,
  SYMBOLS_ROUTE,
} from "./fixtures";

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

  it("names the secret when market-data rejects the key", async () => {
    mockFetch({ [LEVELS_ROUTE]: () => problemResponse(401, "The X-API-Key header is not a valid key.") });
    expect(await getLevels({ ...cfg, apiKey: "wrong" }, "S001")).toEqual({
      ok: false,
      kind: "unavailable",
      detail: "market-data rejected the configured API key (MARKET_DATA_API_KEY).",
    });
  });

  it("says busy and how long to wait on a 429, from Retry-After", async () => {
    mockFetch({ [LEVELS_ROUTE]: () => marketDataRateLimited(12) });
    expect(await getLevels(cfg, "S001")).toEqual({
      ok: false,
      kind: "rate_limited",
      detail: "market-data is busy (rate limit reached); retry in 12 s.",
      retryAfter: 12,
    });
  });

  it("falls back to the RateLimit field's t when Retry-After is missing", async () => {
    mockFetch({ [LEVELS_ROUTE]: () => marketDataRateLimited(null, '"per-ip";r=0;t=7') });
    expect(await getLevels(cfg, "S001")).toMatchObject({
      detail: "market-data is busy (rate limit reached); retry in 7 s.",
      retryAfter: 7,
    });
  });

  it("gives no number when market-data sent no wait", async () => {
    mockFetch({ [LEVELS_ROUTE]: () => problemResponse(429, "Too many requests") });
    const res = await getLevels(cfg, "S001");
    expect(res).toEqual({
      ok: false,
      kind: "rate_limited",
      detail: "market-data is busy (rate limit reached); try again later.",
    });
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
  it("asks market-data for the latest N bars with last=N, in one request", async () => {
    const { requests } = mockFetch(marketDataRoutes());
    const res = await getBars(cfg, "s001", 20);
    expect(requests.map((r) => [r.url, r.headers.get("Accept")])).toEqual([
      [`${MARKET_DATA_URL}/v1/bars/S001?last=20`, "application/json"],
    ]);
    expect(res.ok && res.value.bars).toEqual(barsFor("S001", 20).bars);
    expect(res.ok && [res.value.from, res.value.to]).toEqual([barsFor("S001", 20).from, "2026-10-02"]);
  });

  it("clamps N to market-data's 1-1,000", async () => {
    const { requests } = mockFetch(marketDataRoutes());
    await getBars(cfg, "S001", 0);
    await getBars(cfg, "S001", 5000);
    await getBars(cfg, "S001", 2.7);
    expect(requests.map((r) => new URL(r.url).search)).toEqual(["?last=1", "?last=1000", "?last=2"]);
  });

  it("keeps only the newest N if more bars come back", async () => {
    mockFetch({ [BARS_ROUTE]: () => json(barsFor("S001", 10)) });
    const res = await getBars(cfg, "S001", 3);
    expect(res.ok && res.value.bars).toEqual(barsFor("S001", 3).bars);
  });

  it("tolerates the feed field on Alpaca bars and the cursor field", async () => {
    const page = barsFor("AAPL", 2, "alpaca");
    mockFetch({ [BARS_ROUTE]: () => json({ ...page, bars: page.bars.map((b) => ({ ...b, feed: "iex" })) }) });
    const res = await getBars({ ...cfg, displaySources: new Set(["alpaca"]) }, "AAPL", 2);
    expect(res.ok && res.value.bars.map((b) => b.close)).toEqual(page.bars.map((b) => b.close));
  });

  it("does not call market-data for a ticker it cannot serve", async () => {
    const { spy } = mockFetch(marketDataRoutes());
    expect(await getBars(cfg, "GBP/USD", 20)).toMatchObject({ ok: false, kind: "unsupported_ticker" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes 404s, timeouts and rate limits through", async () => {
    mockFetch({ [BARS_ROUTE]: () => problemResponse(404, "Unknown ticker: NOPE") });
    expect(await getBars(cfg, "NOPE", 20)).toMatchObject({ ok: false, kind: "not_found" });
    mockFetch({ [BARS_ROUTE]: hang });
    expect(await getBars(cfg, "S001", 20)).toMatchObject({ ok: false, kind: "timeout" });
    mockFetch({ [BARS_ROUTE]: () => marketDataRateLimited(3) });
    expect(await getBars(cfg, "S001", 20)).toMatchObject({ ok: false, kind: "rate_limited", retryAfter: 3 });
  });

  it("refuses bars from a source that is not cleared for display", async () => {
    mockFetch({ [BARS_ROUTE]: () => json(barsFor("AAPL", 5, "alpaca")) });
    expect(await getBars({ ...cfg, apiKey: "rate-limit-only" }, "AAPL", 5)).toMatchObject({
      ok: false,
      kind: "not_displayable",
    });
  });
});

describe("getSymbols", () => {
  it("reads one page, with the feed and last-ingestion fields", async () => {
    const { requests } = mockFetch({
      [SYMBOLS_ROUTE]: () =>
        json({
          symbols: [symbolFor("S001"), symbolFor("AAPL", "alpaca", { name: "Apple Inc.", feed: "iex", lastIngestedAt: "2026-10-02T21:05:00Z" })],
          nextAfter: null,
        }),
    });
    const res = await getSymbols({ ...cfg, displaySources: new Set(["synthetic", "alpaca"]) });
    expect(requests.map((r) => new URL(r.url).search)).toEqual(["?limit=200"]);
    expect(res).toEqual({
      ok: true,
      value: [
        { ticker: "S001", name: "Synthetic 001", source: "synthetic", lastBar: "2026-10-02", feed: null, lastIngestedAt: null },
        { ticker: "AAPL", name: "Apple Inc.", source: "alpaca", lastBar: "2026-10-02", feed: "iex", lastIngestedAt: "2026-10-02T21:05:00Z" },
      ],
    });
  });

  it("follows nextAfter until the last page", async () => {
    const pages: Record<string, { symbols: unknown[]; nextAfter: string | null }> = {
      "": { symbols: [symbolFor("S001"), symbolFor("S002")], nextAfter: "S002" },
      S002: { symbols: [symbolFor("S003"), symbolFor("S004")], nextAfter: "S004" },
      S004: { symbols: [symbolFor("S005")], nextAfter: null },
    };
    const { requests } = mockFetch({
      [SYMBOLS_ROUTE]: (request) => json(pages[new URL(request.url).searchParams.get("after") ?? ""]),
    });
    const res = await getSymbols(cfg);
    expect(res.ok && res.value.map((s) => s.ticker)).toEqual(["S001", "S002", "S003", "S004", "S005"]);
    expect(requests.map((r) => new URL(r.url).search)).toEqual(["?limit=200", "?limit=200&after=S002", "?limit=200&after=S004"]);
  });

  it("stops on a repeated cursor and after five pages", async () => {
    const repeat = mockFetch({ [SYMBOLS_ROUTE]: () => json({ symbols: [symbolFor("S001")], nextAfter: "S001" }) });
    await getSymbols(cfg);
    expect(repeat.requests).toHaveLength(2);

    let n = 0;
    const endless = mockFetch({
      [SYMBOLS_ROUTE]: () => {
        n++;
        return json({ symbols: [symbolFor(`S${String(n).padStart(3, "0")}`)], nextAfter: `S${String(n).padStart(3, "0")}` });
      },
    });
    const res = await getSymbols(cfg);
    expect(endless.requests).toHaveLength(5);
    expect(res.ok && res.value).toHaveLength(5);
  });

  it("keeps only displayable sources and valid tickers", async () => {
    mockFetch({
      [SYMBOLS_ROUTE]: () =>
        json({ symbols: [symbolFor("S001"), symbolFor("AAPL", "alpaca"), { ticker: "bad ticker", source: "synthetic" }, "x"], nextAfter: null }),
    });
    const res = await getSymbols(cfg);
    expect(res.ok && res.value.map((s) => s.ticker)).toEqual(["S001"]);
  });

  it("fails as a whole when a later page fails", async () => {
    mockFetch({
      [SYMBOLS_ROUTE]: (request) =>
        new URL(request.url).searchParams.has("after")
          ? marketDataRateLimited(9)
          : json({ symbols: [symbolFor("S001")], nextAfter: "S001" }),
    });
    expect(await getSymbols(cfg)).toMatchObject({ ok: false, kind: "rate_limited", retryAfter: 9 });
  });

  it("rejects a body without a symbol list", async () => {
    mockFetch({ [SYMBOLS_ROUTE]: () => json({ items: [] }) });
    expect(await getSymbols(cfg)).toMatchObject({ ok: false, kind: "bad_response" });
  });
});
