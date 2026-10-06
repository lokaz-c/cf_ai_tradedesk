/**
 * The run_backtest tool: validates the model's arguments, applies the
 * backtest limits (one per chat request, a per-IP rate limit and a daily
 * budget), runs the backtest on quant, and turns the result into a data block
 * and the facts the post-check compares the answer against.
 */

import type { Fact } from "./grounding";
import { clientKey, consumeDailyBacktest, intVar } from "./limits";
import {
  parseBacktestArgs,
  runBacktest,
  STRATEGIES,
  RISK_PROFILES,
  type BacktestMetrics,
  type BacktestRun,
  type QuantConfig,
} from "./quant";
import type { ToolCall, ToolOutcome, ToolSchema } from "./tools";

export interface BacktestVars {
  /** Backtests accepted per UTC day across all users (default 20); 0 turns the tool off. */
  DAILY_BACKTEST_BUDGET?: unknown;
}

export interface BacktestEnv extends BacktestVars {
  DB: D1Database;
  /** Per-IP limit on backtests ([[ratelimits]] in wrangler.toml), tighter than chat's. */
  BACKTEST_RATE_LIMITER: RateLimit;
}

export const DEFAULT_DAILY_BACKTEST_BUDGET = 20;
export const MAX_BACKTESTS_PER_REQUEST = 1;

export function readBacktestBudget(env: BacktestVars): number {
  return intVar(env.DAILY_BACKTEST_BUDGET, DEFAULT_DAILY_BACKTEST_BUDGET, 0, 100_000);
}

export const BACKTEST_TOOL: ToolSchema = {
  name: "run_backtest",
  description:
    "Runs a backtest of one strategy on one symbol with the quant backtester and returns its metrics " +
    "(total return, CAGR, max drawdown, volatility, Sharpe ratio, win rate, trades, final equity). " +
    "quant's data is a synthetic dataset; symbol names are labels only. Call it at most once per question.",
  parameters: {
    type: "object",
    properties: {
      strategy: { type: "string", description: `One of: ${STRATEGIES.join(", ")}.` },
      symbol: { type: "string", description: "One symbol from quant's dataset, for example AAPL or MSFT." },
      start_date: { type: "string", description: "First date, YYYY-MM-DD. Omit to use the start of quant's data." },
      end_date: { type: "string", description: "Last date, YYYY-MM-DD. Omit to use the end of quant's data." },
      risk_profile: {
        type: "string",
        description: `One of: ${RISK_PROFILES.join(", ")}. Default: No Risk Management.`,
      },
      initial_capital: { type: "number", description: "Starting capital (default 100000)." },
    },
    required: ["strategy", "symbol"],
  },
};

/** How each metric is labelled for the model, the page and the post-check. */
export const METRICS: { key: keyof BacktestMetrics; label: string; unit: "percent" | "currency" | "ratio" | "count"; signless?: boolean; note?: string }[] = [
  { key: "total_return", label: "Total return", unit: "percent" },
  { key: "cagr", label: "CAGR", unit: "percent" },
  { key: "max_drawdown", label: "Max drawdown", unit: "percent", signless: true, note: "a loss from the peak, reported as a positive number" },
  { key: "volatility", label: "Volatility", unit: "percent", note: "annualised" },
  { key: "sharpe_ratio", label: "Sharpe ratio", unit: "ratio" },
  { key: "win_rate", label: "Win rate", unit: "percent" },
  { key: "avg_win", label: "Average win", unit: "currency" },
  { key: "avg_loss", label: "Average loss", unit: "currency", signless: true },
  { key: "num_trades", label: "Trades", unit: "count" },
  { key: "final_equity", label: "Final equity", unit: "currency" },
  { key: "profit_factor", label: "Profit factor", unit: "ratio" },
  { key: "max_consecutive_wins", label: "Max consecutive wins", unit: "count" },
  { key: "max_consecutive_losses", label: "Max consecutive losses", unit: "count" },
];

const UNIT_TEXT = { percent: "percent", currency: "currency", ratio: "", count: "" } as const;

export function backtestBlock(run: BacktestRun): string {
  const data = run.synthetic
    ? `Data: SYNTHETIC. quant's dataset ${run.dataFile}: ${run.dataDescription} These are not real prices; say so.`
    : `Data: ${run.dataFile}, which quant reports as not synthetic. ${run.dataDescription}`;
  const lines = METRICS.map(({ key, label, unit, note }) => {
    const value = run.metrics[key];
    const units = [UNIT_TEXT[unit], note].filter(Boolean).join(", ");
    const shown = value === null ? "not a finite number in quant's response" : String(value);
    return `${key} (${label}${units ? `, ${units}` : ""}): ${shown}`;
  });
  return [
    `[BACKTEST run_backtest ${run.symbol}] quant run ${run.backtestId ?? "(no id)"}: ${run.strategy} on ${run.symbol}, ` +
      `${run.startDate} to ${run.endDate}, risk profile ${run.riskProfile}, initial capital ${run.initialCapital}.`,
    data,
    "Metrics exactly as quant returned them:",
    ...lines,
    "Report only these numbers.",
  ].join("\n");
}

export function backtestFacts(run: BacktestRun): Fact[] {
  const source = run.synthetic ? "synthetic" : "quant";
  const base = { ticker: run.symbol, kind: "backtest" as const, source };
  const facts: Fact[] = [{ ...base, value: run.initialCapital, label: "Initial capital", unit: "value" }];
  for (const { key, label, unit, signless } of METRICS) {
    const value = run.metrics[key];
    if (value === null) continue;
    facts.push({ ...base, value, label, unit: unit === "percent" ? "percent" : "value", signless });
  }
  return facts;
}

function failure(call: ToolCall, symbol: string, status: string, detail: string): ToolOutcome {
  return {
    call,
    text: `[BACKTEST run_backtest ${symbol}] NOT RUN. Say that the backtest could not be run and why; do not invent results. Reason: ${detail}`,
    facts: [],
    status: { tool: call.name, service: "quant", ticker: symbol, status, detail },
  };
}

/**
 * A run_backtest executor for one chat request. Limits are checked in order
 * of cost: the per-request cap, then the per-IP rate limit, then the daily
 * budget (a D1 write). Invalid arguments are refused before any of them.
 */
export function backtestExecutor(cfg: QuantConfig, env: BacktestEnv, clientIp: string | null) {
  let used = 0;
  return async (call: ToolCall): Promise<ToolOutcome> => {
    const raw = typeof call.arguments.symbol === "string" ? call.arguments.symbol.trim().toUpperCase().slice(0, 20) : "";
    const symbol = raw || "(none)";
    const parsed = parseBacktestArgs(call.arguments);
    if (!parsed.ok) return failure(call, symbol, parsed.kind, parsed.detail);
    if (used >= MAX_BACKTESTS_PER_REQUEST) {
      return failure(call, symbol, "per_request_limit", "Only one backtest runs per question.");
    }
    used++;
    const { success } = await env.BACKTEST_RATE_LIMITER.limit({ key: clientKey(clientIp) });
    if (!success) {
      return failure(call, symbol, "rate_limited", "Too many backtests from your network; try again in a minute.");
    }
    const budget = readBacktestBudget(env);
    if (budget === 0) return failure(call, symbol, "budget_exhausted", "Backtests are turned off on this deployment.");
    if (!(await consumeDailyBacktest(env.DB, budget, new Date()))) {
      return failure(
        call,
        symbol,
        "budget_exhausted",
        `The demo has reached its limit of ${budget} backtests for today. It resets at 00:00 UTC.`,
      );
    }
    const res = await runBacktest(cfg, parsed.value);
    if (!res.ok) return failure(call, symbol, res.kind, res.detail);
    const run = res.value;
    return {
      call,
      text: backtestBlock(run),
      facts: backtestFacts(run),
      status: {
        tool: call.name,
        service: "quant",
        ticker: run.symbol,
        status: "ok",
        source: run.synthetic ? "synthetic" : "quant",
        synthetic: run.synthetic,
      },
      backtest: run,
    };
  };
}

/** The data note for a backtest outcome. */
export function backtestNote(outcome: ToolOutcome): string {
  const { status, backtest } = outcome;
  if (status.status === "ok" && backtest) {
    return backtest.synthetic
      ? `Backtest results for ${backtest.symbol} come from quant's synthetic dataset (${backtest.dataFile}); symbol names are labels only, not real prices.`
      : `Backtest results for ${backtest.symbol} come from quant's dataset ${backtest.dataFile}, which quant reports as not synthetic.`;
  }
  return `Backtest not run for ${status.ticker}: ${status.detail}`;
}
