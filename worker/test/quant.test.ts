import { describe, expect, it } from "vitest";
import {
  isCalendarDate,
  parseBacktestArgs,
  rangeDays,
  readQuantConfig,
  riskProfileName,
  runBacktest,
  strategyName,
  type BacktestRequest,
  type QuantConfig,
} from "../src/quant";
import { hang, json, mockFetch, networkError } from "./fetch-mock";
import {
  backtestResponse,
  oneWinnerResponse,
  QUANT_DATA_INFO,
  QUANT_METRICS,
  quantProblem,
  quantRoutes,
  QUANT_URL,
} from "./fixtures";

const cfg: QuantConfig = { baseUrl: QUANT_URL, apiKey: null, timeoutMs: 100 };

const REQUEST: BacktestRequest = {
  strategy: "Moving Average Crossover",
  symbol: "AAPL",
  startDate: "2023-01-01",
  endDate: "2024-12-31",
  riskProfile: "Conservative",
  initialCapital: 100_000,
};

/** The method and path of each request quant received. */
const calls = (requests: { method: string; url: string }[]) => requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);

describe("readQuantConfig", () => {
  it("is null without an http(s) QUANT_API_URL", () => {
    expect(readQuantConfig({})).toBeNull();
    expect(readQuantConfig({ QUANT_API_URL: "" })).toBeNull();
    expect(readQuantConfig({ QUANT_API_URL: "javascript:alert(1)" })).toBeNull();
  });

  it("defaults to a 60 s timeout and no key", () => {
    expect(readQuantConfig({ QUANT_API_URL: "https://q.example.com/" })).toEqual({
      baseUrl: "https://q.example.com",
      apiKey: null,
      timeoutMs: 60_000,
    });
  });

  it("reads QUANT_API_KEY and the timeout, up to 120 s", () => {
    expect(readQuantConfig({ QUANT_API_URL: "http://localhost:8000", QUANT_API_KEY: " k-1 ", QUANT_TIMEOUT_MS: "5000" })).toEqual({
      baseUrl: "http://localhost:8000",
      apiKey: "k-1",
      timeoutMs: 5000,
    });
    expect(readQuantConfig({ QUANT_API_URL: "https://q.test", QUANT_API_KEY: "  " })?.apiKey).toBeNull();
    expect(readQuantConfig({ QUANT_API_URL: "https://q.test", QUANT_TIMEOUT_MS: 120_000 })?.timeoutMs).toBe(120_000);
    expect(readQuantConfig({ QUANT_API_URL: "https://q.test", QUANT_TIMEOUT_MS: 120_001 })?.timeoutMs).toBe(60_000);
    expect(readQuantConfig({ QUANT_API_URL: "https://q.test", QUANT_TIMEOUT_MS: 50 })?.timeoutMs).toBe(60_000);
  });
});

describe("names", () => {
  it.each([
    ["Moving Average Crossover", "Moving Average Crossover"],
    ["moving-average crossover strategy", "Moving Average Crossover"],
    ["MA cross", "Moving Average Crossover"],
    ["RSI", "RSI Mean Reversion"],
    ["mean reversion", "RSI Mean Reversion"],
    ["trend following", "Trend Following"],
    ["Breakout", "Trend Following"],
  ])("maps the strategy %s to %s", (raw, name) => {
    expect(strategyName(raw)).toBe(name);
  });

  it("returns null for an unknown strategy", () => {
    expect(strategyName("martingale")).toBeNull();
    expect(strategyName(undefined)).toBeNull();
  });

  it("maps risk profiles", () => {
    expect(riskProfileName("conservative profile")).toBe("Conservative");
    expect(riskProfileName("none")).toBe("No Risk Management");
    expect(riskProfileName("YOLO")).toBeNull();
  });
});

describe("parseBacktestArgs", () => {
  it("fills the defaults", () => {
    expect(parseBacktestArgs({ strategy: "rsi", symbol: " msft " })).toEqual({
      ok: true,
      value: {
        strategy: "RSI Mean Reversion",
        symbol: "MSFT",
        startDate: null,
        endDate: null,
        riskProfile: "No Risk Management",
        initialCapital: 100_000,
      },
    });
  });

  it("keeps given dates, profile and capital", () => {
    const res = parseBacktestArgs({
      strategy: "Trend Following",
      symbol: "NVDA",
      start_date: "2022-01-03",
      end_date: "2023-06-30",
      risk_profile: "Aggressive",
      initial_capital: "50000",
    });
    expect(res.ok && res.value).toMatchObject({
      startDate: "2022-01-03",
      endDate: "2023-06-30",
      riskProfile: "Aggressive",
      initialCapital: 50_000,
    });
  });

  it.each([
    [{ strategy: "martingale", symbol: "AAPL" }, "Unknown strategy"],
    [{ strategy: "rsi", symbol: "GBP/USD" }, "symbol must be one ticker"],
    [{ strategy: "rsi", symbol: "AAPL", start_date: "01/02/2023" }, "start_date must be a date"],
    [{ strategy: "rsi", symbol: "AAPL", end_date: 2024 }, "end_date must be a date"],
    [{ strategy: "rsi", symbol: "AAPL", start_date: "2023-02-30" }, "start_date must be a date"],
    [{ strategy: "rsi", symbol: "AAPL", end_date: "2023-13-01" }, "end_date must be a date"],
    [{ strategy: "rsi", symbol: "AAPL", risk_profile: "YOLO" }, "Unknown risk profile"],
    [{ strategy: "rsi", symbol: "AAPL", initial_capital: -5 }, "initial_capital must be a positive number"],
  ])("rejects %o", (args, message) => {
    const res = parseBacktestArgs(args);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("invalid_request");
      expect(res.detail).toContain(message);
    }
  });
});

describe("dates", () => {
  it("accepts real calendar dates only", () => {
    expect(["2024-02-29", "2023-01-01"].map(isCalendarDate)).toEqual([true, true]);
    expect(["2023-02-29", "2023-02-30", "2023-13-01", "2023-1-01", ""].map(isCalendarDate)).toEqual([false, false, false, false, false]);
  });

  it("counts calendar days with both ends included, as quant's max_range_days does", () => {
    // quant: the synthetic file's 2020-01-01 to 2024-12-31 is 1,827 days.
    expect(rangeDays("2020-01-01", "2024-12-31")).toBe(1827);
    expect(rangeDays("2024-01-01", "2024-01-01")).toBe(1);
  });
});

describe("runBacktest", () => {
  it("reads quant's limits, then POSTs the request to /api/backtest/ and returns the metrics as given", async () => {
    const { requests } = mockFetch(quantRoutes());
    const res = await runBacktest(cfg, REQUEST);

    expect(calls(requests)).toEqual(["GET /api/data", "POST /api/backtest/"]);
    expect(requests[1].headers.get("Content-Type")).toBe("application/json");
    expect(requests[1].headers.get("Accept")).toBe("application/json");
    expect(requests[1].json()).toEqual({
      strategy_name: "Moving Average Crossover",
      risk_config_name: "Conservative",
      start_date: "2023-01-01",
      end_date: "2024-12-31",
      initial_capital: 100_000,
      symbols: ["AAPL"],
    });
    expect(res).toEqual({
      ok: true,
      value: {
        backtestId: 42,
        strategy: "Moving Average Crossover",
        symbol: "AAPL",
        startDate: "2023-01-01",
        endDate: "2024-12-31",
        riskProfile: "Conservative",
        initialCapital: 100_000,
        synthetic: true,
        dataFile: "data/sample_data.csv",
        dataDescription:
          "Synthetic daily bars from a seeded Markov regime-switching GBM (config/data_generator.json). Ticker names are labels only.",
        metrics: QUANT_METRICS,
        undefinedMetrics: {},
        periodNote: null,
      },
    });
  });

  it("sends X-API-Key on every request when QUANT_API_KEY is set, and not otherwise", async () => {
    const { requests } = mockFetch(quantRoutes());
    await runBacktest(cfg, REQUEST);
    await runBacktest({ ...cfg, apiKey: "quant-key" }, REQUEST);
    expect(requests.map((r) => r.headers.get("X-API-Key"))).toEqual([null, null, "quant-key", "quant-key"]);
  });

  it("keeps null metrics as null, with quant's reasons", async () => {
    mockFetch(quantRoutes({ backtest: () => json(oneWinnerResponse()) }));
    const res = await runBacktest(cfg, REQUEST);
    expect(res.ok && res.value.metrics).toMatchObject({ avg_loss: null, profit_factor: null, win_rate: 100, num_trades: 1 });
    expect(res.ok && res.value.undefinedMetrics).toEqual({ avg_loss: "no losing trades", profit_factor: "no losing trades" });
  });

  it("ignores reasons for metrics that have a value, and non-text reasons", async () => {
    const body = backtestResponse({
      metrics: { ...QUANT_METRICS, sharpe_ratio: null, cagr: null },
      undefined_metrics: { total_return: "should not appear", sharpe_ratio: 0, cagr: "the run starts and ends on the same day" },
    });
    mockFetch(quantRoutes({ backtest: () => json(body) }));
    const res = await runBacktest(cfg, REQUEST);
    expect(res.ok && res.value.undefinedMetrics).toEqual({ cagr: "the run starts and ends on the same day" });
    expect(res.ok && res.value.metrics.sharpe_ratio).toBeNull();
  });

  it("parses strictly: a bare Infinity is not JSON, and quant no longer sends one", async () => {
    const text = JSON.stringify(backtestResponse()).replace('"profit_factor":0.8834', '"profit_factor": Infinity');
    mockFetch(quantRoutes({ backtest: () => new Response(text, { headers: { "Content-Type": "application/json" } }) }));
    expect(await runBacktest(cfg, REQUEST)).toEqual({
      ok: false,
      kind: "bad_response",
      detail: "quant returned a body that is not JSON.",
    });
  });

  it("treats the data as synthetic unless quant says otherwise, and labels market-data bars", async () => {
    mockFetch(quantRoutes({ backtest: () => json(backtestResponse({ data: undefined })) }));
    const missing = await runBacktest(cfg, REQUEST);
    expect(missing.ok && missing.value.synthetic).toBe(true);

    mockFetch(quantRoutes({ backtest: () => json(backtestResponse({ data: { synthetic: false, file: "data/real.csv" } })) }));
    const real = await runBacktest(cfg, REQUEST);
    expect(real.ok && [real.value.synthetic, real.value.dataFile]).toEqual([false, "data/real.csv"]);

    const fromMarketData = { source: "market-data", reported_source: "synthetic", synthetic: true, description: "Synthetic daily bars generated by the market-data service." };
    mockFetch(quantRoutes({ backtest: () => json(backtestResponse({ data: fromMarketData })) }));
    const md = await runBacktest(cfg, REQUEST);
    expect(md.ok && [md.value.synthetic, md.value.dataFile]).toEqual([true, "market-data bars"]);
  });

  it("takes missing dates from quant's data range when it fits the limit", async () => {
    const { requests } = mockFetch(quantRoutes());
    const res = await runBacktest(cfg, { ...REQUEST, startDate: null, endDate: null });
    expect(requests[1].json()).toMatchObject({ start_date: "2020-01-01", end_date: "2024-12-31" });
    expect(res.ok && [res.value.startDate, res.value.endDate, res.value.periodNote]).toEqual(["2020-01-01", "2024-12-31", null]);
  });

  it("cuts a filled-in period to limits.max_range_days, keeping the most recent part", async () => {
    const longData = { ...QUANT_DATA_INFO, start_date: "2015-01-02", end_date: "2026-10-02" };
    const { requests } = mockFetch(quantRoutes({ data: () => json(longData) }));
    const res = await runBacktest(cfg, { ...REQUEST, startDate: null, endDate: null });
    const sent = requests[1].json() as { start_date: string; end_date: string };
    expect([sent.start_date, sent.end_date]).toEqual(["2021-10-02", "2026-10-02"]);
    expect(rangeDays(sent.start_date, sent.end_date)).toBe(1827);
    expect(res.ok && res.value.periodNote).toBe(
      "The period was filled in from quant's data range (2015-01-02 to 2026-10-02) and cut to quant's limit of 1827 days per backtest.",
    );
  });

  it("fills a missing end or start within the limit", async () => {
    const data = { ...QUANT_DATA_INFO, start_date: "2015-01-02", end_date: "2026-10-02", limits: { max_symbols: 10, max_range_days: 365 } };
    const { requests } = mockFetch(quantRoutes({ data: () => json(data) }));
    await runBacktest(cfg, { ...REQUEST, startDate: "2020-03-01", endDate: null });
    await runBacktest(cfg, { ...REQUEST, startDate: null, endDate: "2016-06-30" });
    await runBacktest(cfg, { ...REQUEST, startDate: "2026-06-01", endDate: null });
    const sent = requests.filter((r) => r.method === "POST").map((r) => r.json() as { start_date: string; end_date: string });
    expect(sent.map((b) => [b.start_date, b.end_date])).toEqual([
      ["2020-03-01", "2021-02-28"],
      // 365 days back from 2016-06-30, counting 2016-02-29.
      ["2015-07-02", "2016-06-30"],
      ["2026-06-01", "2026-10-02"],
    ]);
  });

  it("refuses a period the user gave that is longer than quant allows, without running it", async () => {
    const { requests } = mockFetch(quantRoutes());
    const res = await runBacktest(cfg, { ...REQUEST, startDate: "2015-01-01", endDate: "2024-12-31" });
    expect(res).toEqual({
      ok: false,
      kind: "invalid_request",
      detail:
        "quant runs at most 1827 days per backtest (its limits.max_range_days); 2015-01-01 to 2024-12-31 is 3653 days. Ask for a shorter period.",
    });
    expect(calls(requests)).toEqual(["GET /api/data"]);
  });

  it("respects limits.max_symbols", async () => {
    const { requests } = mockFetch(quantRoutes({ data: () => json({ ...QUANT_DATA_INFO, limits: { max_symbols: 0, max_range_days: 1827 } }) }));
    expect(await runBacktest(cfg, REQUEST)).toEqual({
      ok: false,
      kind: "rejected",
      detail: "quant accepts at most 0 symbols per backtest (its limits.max_symbols).",
    });
    expect(calls(requests)).toEqual(["GET /api/data"]);
  });

  it("runs without clamping when quant sends no limits", async () => {
    const { limits: _omitted, ...older } = QUANT_DATA_INFO;
    const longData = { ...older, start_date: "2010-01-04", end_date: "2026-10-02" };
    const { requests } = mockFetch(quantRoutes({ data: () => json(longData) }));
    const res = await runBacktest(cfg, { ...REQUEST, startDate: null, endDate: null });
    expect(requests[1].json()).toMatchObject({ start_date: "2010-01-04", end_date: "2026-10-02" });
    expect(res.ok && res.value.periodNote).toBeNull();
  });

  it("passes quant's 400 message through, from error or detail", async () => {
    mockFetch(quantRoutes({ backtest: () => quantProblem(400, "Unknown symbol(s): ZZZ") }));
    expect(await runBacktest(cfg, REQUEST)).toEqual({ ok: false, kind: "rejected", detail: "Unknown symbol(s): ZZZ" });
    mockFetch(quantRoutes({ backtest: () => json({ title: "Bad Request", status: 400, detail: "Period is over the cap" }, 400) }));
    expect(await runBacktest(cfg, REQUEST)).toMatchObject({ kind: "rejected", detail: "Period is over the cap" });
  });

  it.each([
    [
      "a 401",
      () => quantProblem(401, "The X-API-Key header is not a valid key."),
      { kind: "unavailable", detail: "quant rejected the configured API key (QUANT_API_KEY)." },
    ],
    [
      "a 429 with Retry-After",
      () => quantProblem(429, "Rate limit of 5 per 1 minute per client address exceeded. Retry in 37 s", { "Retry-After": "37" }),
      { kind: "rate_limited", detail: "quant is busy (rate limit reached); retry in 37 s.", retryAfter: 37 },
    ],
    [
      "a 429 without Retry-After",
      () => quantProblem(429, "Rate limit exceeded"),
      { kind: "rate_limited", detail: "quant is busy (rate limit reached); try again later." },
    ],
    [
      "a 503 with Retry-After (every run slot taken)",
      () => quantProblem(503, "The server is already running as many backtests as it allows at once; retry in 10 s", { "Retry-After": "10" }),
      { kind: "busy", detail: "quant is busy (it runs a limited number of backtests at once); retry in 10 s.", retryAfter: 10 },
    ],
    [
      "a 503 without Retry-After",
      () => new Response("Service Unavailable", { status: 503 }),
      { kind: "busy", detail: "quant is busy or unavailable (HTTP 503); try again later." },
    ],
    [
      "quant's own 504",
      () => quantProblem(504, "The backtest ran past this server's 90 s limit and was stopped."),
      { kind: "timeout", detail: "quant stopped the backtest at its 90 s time limit. A shorter period runs faster." },
    ],
    [
      "a 504 from a proxy",
      () => new Response("<html>Gateway Timeout</html>", { status: 504 }),
      { kind: "timeout", detail: "quant's server timed out (HTTP 504) before the backtest finished." },
    ],
    [
      "a 500",
      () => quantProblem(500, "Internal server error; the details are in the server log"),
      { kind: "unavailable", detail: "quant returned HTTP 500." },
    ],
    [
      "a 502 from its market-data source",
      () => quantProblem(502, "The market-data service failed: HTTP 503"),
      { kind: "unavailable", detail: "quant returned HTTP 502: The market-data service failed: HTTP 503" },
    ],
    ["a timeout", hang, { kind: "timeout", detail: "quant did not finish the backtest within 0.1 s (QUANT_TIMEOUT_MS)." }],
    ["a connection failure", networkError, { kind: "unavailable", detail: "quant could not be reached." }],
    ["a body that is not JSON", () => new Response("<html>"), { kind: "bad_response", detail: "quant returned a body that is not JSON." }],
    [
      "a body without metrics",
      () => json({ backtest_id: 1 }),
      { kind: "bad_response", detail: "quant returned the backtest in an unexpected shape." },
    ],
  ] as const)("reports %s", async (_name, handler, expected) => {
    mockFetch(quantRoutes({ backtest: handler }));
    expect(await runBacktest(cfg, REQUEST)).toEqual({ ok: false, ...expected });
  });

  it("names no time limit for a 504 when quant did not send one", async () => {
    const { limits: _omitted, ...older } = QUANT_DATA_INFO;
    mockFetch(quantRoutes({ data: () => json(older), backtest: () => quantProblem(504, "stopped") }));
    expect(await runBacktest(cfg, REQUEST)).toMatchObject({
      kind: "timeout",
      detail: "quant stopped the backtest at its time limit. A shorter period runs faster.",
    });
  });

  it("reports a failed data lookup without running the backtest", async () => {
    const slow = mockFetch(quantRoutes({ data: hang }));
    expect(await runBacktest(cfg, { ...REQUEST, startDate: null })).toMatchObject({ ok: false, kind: "timeout" });
    expect(slow.requests).toHaveLength(1);

    const limited = mockFetch(quantRoutes({ data: () => quantProblem(429, "Rate limit", { "Retry-After": "5" }) }));
    expect(await runBacktest(cfg, REQUEST)).toEqual({
      ok: false,
      kind: "rate_limited",
      detail: "quant is busy (rate limit reached); retry in 5 s.",
      retryAfter: 5,
    });
    expect(limited.requests).toHaveLength(1);

    mockFetch(quantRoutes({ data: () => json({ ...QUANT_DATA_INFO, end_date: "soon" }) }));
    expect(await runBacktest(cfg, REQUEST)).toMatchObject({ ok: false, kind: "bad_response" });
  });
});
