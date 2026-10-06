import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { utcDay } from "../src/limits";
import { hang, json, mockFetch } from "./fetch-mock";
import { BACKTEST_ROUTE, backtestResponse, marketDataRoutes, QUANT_METRICS } from "./fixtures";
import {
  aiInputs,
  clearD1,
  enableMarketData,
  enableQuant,
  getState,
  initSession,
  metaOf,
  mockAiTools,
  postJson,
  replyText,
  savedAnalysis,
  setSessionVars,
  sseEvents,
  toolCalls,
} from "./helpers";

beforeEach(clearD1);

const MA_ON_AAPL = {
  strategy: "moving average crossover",
  symbol: "AAPL",
  start_date: "2023-01-01",
  end_date: "2024-12-31",
  risk_profile: "Conservative",
};

const SUMMARY = ["Total return ", "-3.21%", " with a max drawdown of ", "12.49%", ", Sharpe ", "-0.22", " over ", "12", " trades."];

async function backtestsToday(): Promise<number> {
  const row = await env.DB.prepare("SELECT backtests FROM daily_usage WHERE day = ?")
    .bind(utcDay(new Date()))
    .first<{ backtests: number }>();
  return row?.backtests ?? 0;
}

/**
 * Sends one chat request (from a fixed address if given), reads the whole
 * response, and waits until the exchange is saved, so nothing leaks into the
 * next test.
 */
async function ask(sessionId: string, message: string, ip?: string) {
  const before = (await getState(sessionId)).messages.length;
  const res = await postJson(`/api/session/${sessionId}/chat`, { message }, ip ? { "CF-Connecting-IP": ip } : undefined);
  const body = await res.text();
  await vi.waitFor(async () => expect((await getState(sessionId)).messages).toHaveLength(before + 2));
  return { res, body };
}

describe("run_backtest", () => {
  it("runs the backtest on quant and streams a summary written from the returned metrics", async () => {
    await initSession("b-run", "AAPL", "D");
    await enableQuant("b-run");
    const { requests } = mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    const ai = mockAiTools([toolCalls(["run_backtest", MA_ON_AAPL])], SUMMARY);

    const { res, body } = await ask("b-run", "Backtest the MA crossover on AAPL for 2023-2024, conservative.");
    expect(res.status).toBe(200);

    // Only quant is configured: the rounds offer run_backtest alone and say there is no market data.
    const round1 = aiInputs(ai, 0);
    expect(round1.tools?.map((t) => t.name)).toEqual(["run_backtest"]);
    expect(round1.messages[0].content).toContain("call run_backtest once");
    expect(round1.messages[0].content).toContain("No market data source is connected");

    expect(requests[0].json()).toEqual({
      strategy_name: "Moving Average Crossover",
      risk_config_name: "Conservative",
      start_date: "2023-01-01",
      end_date: "2024-12-31",
      initial_capital: 100000,
      symbols: ["AAPL"],
    });

    const system = aiInputs(ai, 2).messages[0].content;
    expect(system).toContain(
      "[BACKTEST run_backtest AAPL] quant run 42: Moving Average Crossover on AAPL, 2023-01-01 to 2024-12-31, risk profile Conservative, initial capital 100000.",
    );
    expect(system).toContain("Data: SYNTHETIC. quant's dataset data/sample_data.csv:");
    expect(system).toContain("total_return (Total return, percent): -3.2117");
    expect(system).toContain("max_drawdown (Max drawdown, percent, a loss from the peak, reported as a positive number): 12.4871");
    expect(system).toContain("Report only these numbers.");

    const meta = metaOf(body);
    expect(meta.data).toEqual([
      { tool: "run_backtest", service: "quant", ticker: "AAPL", status: "ok", source: "synthetic", synthetic: true },
    ]);
    expect(meta.backtests).toEqual([
      expect.objectContaining({ backtestId: 42, strategy: "Moving Average Crossover", symbol: "AAPL", synthetic: true, metrics: QUANT_METRICS }),
    ]);
    // Every number in the summary is one quant returned (12 trades is a count, not checked).
    expect(meta.citations.map((c) => [c.text, c.label])).toEqual([
      ["3.21", "Total return"],
      ["12.49", "Max drawdown"],
      ["0.22", "Sharpe ratio"],
    ]);
    expect(meta.unverified).toEqual([]);
    expect(replyText(body)).toContain(
      "- Backtest results for AAPL come from quant's synthetic dataset (data/sample_data.csv); symbol names are labels only, not real prices.",
    );
    expect(await backtestsToday()).toBe(1);
    const saved = await savedAnalysis("b-run");
    expect(JSON.parse(saved.grounding!).backtests[0].metrics).toEqual(QUANT_METRICS);
  });

  it("flags a metric the summary invented", async () => {
    await initSession("b-invent", "AAPL", "D");
    await enableQuant("b-invent");
    mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    mockAiTools([toolCalls(["run_backtest", MA_ON_AAPL])], ["Total return -3.21% and a Sharpe of 1.45."]);
    const { body } = await ask("b-invent", "Backtest it.");
    expect(metaOf(body).unverified).toEqual([{ text: "1.45", value: 1.45 }]);
  });

  it("offers all three tools when market-data and quant are both configured", async () => {
    await initSession("b-both", "S001", "D");
    await enableMarketData("b-both");
    await enableQuant("b-both");
    mockFetch(marketDataRoutes());
    const ai = mockAiTools([], ["ok"]);
    await ask("b-both", "hi");
    expect(aiInputs(ai, 0).tools?.map((t) => t.name)).toEqual(["get_levels", "get_recent_bars", "run_backtest"]);
    expect(aiInputs(ai, 0).messages[0].content).toContain("call get_levels");
  });

  it("refuses invalid arguments before counting or calling quant", async () => {
    await initSession("b-invalid", "AAPL", "D");
    await enableQuant("b-invalid");
    const { spy } = mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    const ai = mockAiTools([toolCalls(["run_backtest", { ...MA_ON_AAPL, strategy: "martingale" }])], ["Not run."]);

    const { body } = await ask("b-invalid", "Backtest martingale.");

    expect(spy).not.toHaveBeenCalled();
    expect(await backtestsToday()).toBe(0);
    expect(aiInputs(ai, 2).messages[0].content).toContain(
      "[BACKTEST run_backtest AAPL] NOT RUN. Say that the backtest could not be run and why; do not invent results. Reason: Unknown strategy.",
    );
    expect(metaOf(body).data[0]).toMatchObject({ service: "quant", status: "invalid_request" });
    expect(replyText(body)).toContain("- Backtest not run for AAPL: Unknown strategy.");
  });

  it("runs at most one backtest per question", async () => {
    await initSession("b-one", "AAPL", "D");
    await enableQuant("b-one");
    const { requests } = mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    mockAiTools(
      [toolCalls(["run_backtest", MA_ON_AAPL], ["run_backtest", { ...MA_ON_AAPL, symbol: "MSFT" }])],
      ["ok"],
    );
    const { body } = await ask("b-one", "Backtest AAPL and MSFT.");
    expect(requests).toHaveLength(1);
    expect(metaOf(body).data.map((d) => d.status).sort()).toEqual(["ok", "per_request_limit"]);
    expect(await backtestsToday()).toBe(1);
  });

  it("is rate-limited per IP with its own binding, more tightly than chat", async () => {
    // wrangler.toml: BACKTEST_RATE_LIMITER allows 2 per 60 s; chat allows 5.
    mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `b-limit-${i}`;
      await initSession(id, "AAPL", "D");
      await enableQuant(id);
      mockAiTools([toolCalls(["run_backtest", MA_ON_AAPL])], ["ok"]);
      const { res, body } = await ask(id, "Backtest it.", "203.0.113.77");
      expect(res.status).toBe(200);
      statuses.push(metaOf(body).data[0].status);
    }
    expect(statuses).toEqual(["ok", "ok", "rate_limited"]);
    expect(await backtestsToday()).toBe(2);
  });

  it("tells the model when the per-IP limit is reached", async () => {
    await initSession("b-limited", "AAPL", "D");
    await enableQuant("b-limited");
    await setSessionVars("b-limited", { BACKTEST_RATE_LIMITER: { limit: async () => ({ success: false }) } });
    const { spy } = mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    const ai = mockAiTools([toolCalls(["run_backtest", MA_ON_AAPL])], ["Limited."]);
    const { body } = await ask("b-limited", "Backtest it.");
    expect(spy).not.toHaveBeenCalled();
    expect(aiInputs(ai, 2).messages[0].content).toContain(
      "Reason: Too many backtests from your network; try again in a minute.",
    );
    expect(metaOf(body).data[0].status).toBe("rate_limited");
  });

  it("stops at the daily backtest budget, and is off at 0", async () => {
    mockFetch({ [BACKTEST_ROUTE]: () => json(backtestResponse()) });
    await env.DB.prepare("INSERT INTO daily_usage (day, chat_requests, backtests) VALUES (?, 0, 20)")
      .bind(utcDay(new Date()))
      .run();

    await initSession("b-budget", "AAPL", "D");
    await enableQuant("b-budget");
    mockAiTools([toolCalls(["run_backtest", MA_ON_AAPL])], ["ok"]);
    const full = await ask("b-budget", "Backtest it.");
    expect(metaOf(full.body).data[0]).toMatchObject({
      status: "budget_exhausted",
      detail: "The demo has reached its limit of 20 backtests for today. It resets at 00:00 UTC.",
    });
    expect(await backtestsToday()).toBe(20);

    await initSession("b-off", "AAPL", "D");
    await enableQuant("b-off", { DAILY_BACKTEST_BUDGET: 0 });
    mockAiTools([toolCalls(["run_backtest", MA_ON_AAPL])], ["ok"]);
    const off = await ask("b-off", "Backtest it.");
    expect(metaOf(off.body).data[0]).toMatchObject({
      status: "budget_exhausted",
      detail: "Backtests are turned off on this deployment.",
    });
  });

  it("says so when quant is slow, and still answers", async () => {
    await initSession("b-slow", "AAPL", "D");
    await enableQuant("b-slow");
    mockFetch({ [BACKTEST_ROUTE]: hang });
    mockAiTools([toolCalls(["run_backtest", MA_ON_AAPL])], ["The backtest timed out."]);
    const { body } = await ask("b-slow", "Backtest it.");
    expect(metaOf(body).data[0]).toMatchObject({
      status: "timeout",
      detail: "quant did not finish the backtest within 0.1 s.",
    });
    expect(metaOf(body).backtests).toEqual([]);
    expect(replyText(body)).toContain("- Backtest not run for AAPL: quant did not finish the backtest within 0.1 s.");
    expect(sseEvents(body).at(-1)).toBe("[DONE]");
  });
});
