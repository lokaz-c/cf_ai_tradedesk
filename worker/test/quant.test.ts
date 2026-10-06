import { describe, expect, it } from "vitest";
import {
  parseBacktestArgs,
  parseQuantJson,
  readQuantConfig,
  riskProfileName,
  runBacktest,
  strategyName,
  type BacktestRequest,
  type QuantConfig,
} from "../src/quant";
import { hang, json, mockFetch, networkError } from "./fetch-mock";
import {
  BACKTEST_ROUTE,
  backtestResponse,
  QUANT_DATA_INFO,
  QUANT_DATA_ROUTE,
  QUANT_METRICS,
  QUANT_URL,
} from "./fixtures";

const cfg: QuantConfig = { baseUrl: QUANT_URL, timeoutMs: 100 };

const REQUEST: BacktestRequest = {
  strategy: "Moving Average Crossover",
  symbol: "AAPL",
  startDate: "2023-01-01",
  endDate: "2024-12-31",
  riskProfile: "Conservative",
  initialCapital: 100_000,
};

describe("readQuantConfig", () => {
  it("is null without an http(s) QUANT_API_URL, and reads the timeout", () => {
    expect(readQuantConfig({})).toBeNull();
    expect(readQuantConfig({ QUANT_API_URL: "" })).toBeNull();
    expect(readQuantConfig({ QUANT_API_URL: "javascript:alert(1)" })).toBeNull();
    expect(readQuantConfig({ QUANT_API_URL: "https://q.example.com/" })).toEqual({
      baseUrl: "https://q.example.com",
      timeoutMs: 20_000,
    });
    expect(readQuantConfig({ QUANT_API_URL: "http://localhost:8000", QUANT_TIMEOUT_MS: "5000" })?.timeoutMs).toBe(5000);
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

describe("parseQuantJson", () => {
  it("reads the bare Infinity and NaN tokens Flask writes as null", () => {
    expect(parseQuantJson('{"a": Infinity, "b": -Infinity, "c": NaN, "d": [1, Infinity], "e": "Infinity"}')).toEqual({
      a: null,
      b: null,
      c: null,
      d: [1, null],
      e: "Infinity",
    });
  });

  it("still rejects text that is not JSON", () => {
    expect(() => parseQuantJson("<html>")).toThrow();
  });
});

describe("runBacktest", () => {
  it("POSTs the request to /api/backtest/ and returns the metrics as given", async () => {
    const { requests } = mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    const res = await runBacktest(cfg, REQUEST);

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("Content-Type")).toBe("application/json");
    expect(requests[0].json()).toEqual({
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
      },
    });
  });

  it("takes missing dates from quant's data range", async () => {
    const { requests } = mockFetch({
      [QUANT_DATA_ROUTE]: () => json(QUANT_DATA_INFO),
      [BACKTEST_ROUTE]: () => json(backtestResponse()),
    });
    const res = await runBacktest(cfg, { ...REQUEST, startDate: null, endDate: null });
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["GET /api/data", "POST /api/backtest/"]);
    expect(requests[1].json()).toMatchObject({ start_date: "2020-01-01", end_date: "2024-12-31" });
    expect(res.ok && [res.value.startDate, res.value.endDate]).toEqual(["2020-01-01", "2024-12-31"]);
  });

  it("reads profit_factor Infinity as null and keeps the other metrics", async () => {
    const text = JSON.stringify(backtestResponse()).replace('"profit_factor":0.8834', '"profit_factor": Infinity');
    mockFetch({ [BACKTEST_ROUTE]: () => new Response(text, { headers: { "Content-Type": "application/json" } }) });
    const res = await runBacktest(cfg, REQUEST);
    expect(res.ok && res.value.metrics.profit_factor).toBeNull();
    expect(res.ok && res.value.metrics.total_return).toBe(-3.2117);
  });

  it("treats the data as synthetic unless quant says otherwise", async () => {
    mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse({ data: undefined })) });
    const missing = await runBacktest(cfg, REQUEST);
    expect(missing.ok && missing.value.synthetic).toBe(true);

    mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse({ data: { synthetic: false, file: "data/real.csv" } })) });
    const real = await runBacktest(cfg, REQUEST);
    expect(real.ok && [real.value.synthetic, real.value.dataFile]).toEqual([false, "data/real.csv"]);
  });

  it("passes quant's 400 error through", async () => {
    mockFetch({ [BACKTEST_ROUTE]: () => json({ error: "Unknown symbol(s): ZZZ" }, 400) });
    expect(await runBacktest(cfg, REQUEST)).toEqual({ ok: false, kind: "rejected", detail: "Unknown symbol(s): ZZZ" });
  });

  it.each([
    ["a 500", () => json({ error: "Internal server error; the details are in the server log" }, 500), "unavailable", "quant returned HTTP 500."],
    ["a timeout", hang, "timeout", "quant did not finish the backtest within 0.1 s."],
    ["a connection failure", networkError, "unavailable", "quant could not be reached."],
    ["a body that is not JSON", () => new Response("<html>"), "bad_response", "quant returned a body that is not JSON."],
    ["a body without metrics", () => json({ backtest_id: 1 }), "bad_response", "quant returned the backtest in an unexpected shape."],
  ] as const)("reports %s", async (_name, handler, kind, detail) => {
    mockFetch({ [BACKTEST_ROUTE]: handler });
    expect(await runBacktest(cfg, REQUEST)).toEqual({ ok: false, kind, detail });
  });

  it("reports a failed data-range lookup without running the backtest", async () => {
    const { requests } = mockFetch({ [QUANT_DATA_ROUTE]: hang, [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    expect(await runBacktest(cfg, { ...REQUEST, startDate: null })).toMatchObject({ ok: false, kind: "timeout" });
    expect(requests).toHaveLength(1);
  });
});
