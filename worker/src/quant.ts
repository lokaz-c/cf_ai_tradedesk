/**
 * Client for the quant backtester (github.com/lokaz-c/quant, Flask). Contract,
 * from its app/ package:
 *
 * - POST /api/backtest/ (trailing slash) with JSON `{ strategy_name,
 *   risk_config_name, start_date, end_date, initial_capital, symbols }` runs
 *   the backtest synchronously and answers 200 with `{ backtest_id, status,
 *   metrics, summary, data, baseline }`. There is no job id to poll: the run
 *   is finished when the response arrives.
 * - Invalid input (unknown strategy, profile or symbol, bad dates or capital)
 *   is a 400 `{ "error": "..." }`; other failures are a 500 with a generic
 *   error.
 * - GET /api/data returns the dataset's label, symbols and date range:
 *   `{ synthetic, file, description, symbols, start_date, end_date, bars }`.
 * - `data.synthetic` is true for the bundled dataset; the summary must say so.
 * - Metrics: total_return, cagr, max_drawdown (positive), volatility and
 *   win_rate are percentages; avg_win, avg_loss (negative) and final_equity
 *   are currency amounts; sharpe_ratio and profit_factor are ratios.
 *   profit_factor is Infinity when no trade lost money, which Flask writes as
 *   the bare token `Infinity` (not valid JSON); the parser reads it as null.
 */

import { intVar } from "./limits";
import { seconds } from "./marketdata";

export interface QuantVars {
  /** Base URL of the quant API, e.g. https://quant.example.com. Unset turns the backtest tool off. */
  QUANT_API_URL?: unknown;
  /** Timeout for a backtest request in milliseconds (default 20000). */
  QUANT_TIMEOUT_MS?: unknown;
}

export interface QuantConfig {
  baseUrl: string;
  timeoutMs: number;
}

export const DEFAULT_QUANT_TIMEOUT_MS = 20_000;

export function readQuantConfig(env: QuantVars): QuantConfig | null {
  const raw = typeof env.QUANT_API_URL === "string" ? env.QUANT_API_URL.trim() : "";
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    timeoutMs: intVar(env.QUANT_TIMEOUT_MS, DEFAULT_QUANT_TIMEOUT_MS, 100, 60_000),
  };
}

/** quant's strategy names (config/strategies.json), with the phrasings a user or model might use. */
const STRATEGY_ALIASES: Record<string, string[]> = {
  "Moving Average Crossover": ["moving average crossover", "moving average cross", "moving average", "ma crossover", "ma cross", "sma crossover", "ma"],
  "RSI Mean Reversion": ["rsi mean reversion", "rsi", "mean reversion", "rsi reversion"],
  "Trend Following": ["trend following", "trend", "breakout", "trend breakout"],
};

/** quant's risk profiles (config/risk_configs.json). */
const PROFILE_ALIASES: Record<string, string[]> = {
  "No Risk Management": ["no risk management", "none", "no risk", "off", "no risk layer"],
  Conservative: ["conservative"],
  Moderate: ["moderate"],
  Aggressive: ["aggressive"],
};

export const STRATEGIES = Object.keys(STRATEGY_ALIASES);
export const RISK_PROFILES = Object.keys(PROFILE_ALIASES);
export const DEFAULT_RISK_PROFILE = "No Risk Management";
export const DEFAULT_INITIAL_CAPITAL = 100_000;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function lookup(table: Record<string, string[]>, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = words(raw).replace(/ (strategy|profile)$/, "");
  for (const [name, aliases] of Object.entries(table)) {
    if (words(name) === key || aliases.includes(key)) return name;
  }
  return null;
}

export const strategyName = (raw: unknown) => lookup(STRATEGY_ALIASES, raw);
export const riskProfileName = (raw: unknown) => lookup(PROFILE_ALIASES, raw);

export interface BacktestRequest {
  strategy: string;
  symbol: string;
  startDate: string | null;
  endDate: string | null;
  riskProfile: string;
  initialCapital: number;
}

export type QuantFailure = "invalid_request" | "rejected" | "timeout" | "unavailable" | "bad_response";
export type QuantResult<T> = { ok: true; value: T } | { ok: false; kind: QuantFailure; detail: string };

const fail = (kind: QuantFailure, detail: string) => ({ ok: false, kind, detail }) as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

/** Validates the tool's arguments before anything is counted or sent. */
export function parseBacktestArgs(args: Record<string, unknown>): QuantResult<BacktestRequest> {
  const strategy = strategyName(args.strategy);
  if (!strategy) {
    return fail("invalid_request", `Unknown strategy. quant has ${STRATEGIES.join(", ")}.`);
  }
  const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
  if (!SYMBOL.test(symbol)) {
    return fail("invalid_request", "symbol must be one ticker: a letter, then letters, digits or a dot, at most 10 characters.");
  }
  const date = (v: unknown, field: string): QuantResult<string | null> => {
    if (v === undefined || v === null || v === "") return { ok: true, value: null };
    return typeof v === "string" && DATE.test(v.trim())
      ? { ok: true, value: v.trim() }
      : fail("invalid_request", `${field} must be a date in YYYY-MM-DD form.`);
  };
  const start = date(args.start_date, "start_date");
  if (!start.ok) return start;
  const end = date(args.end_date, "end_date");
  if (!end.ok) return end;
  let riskProfile = DEFAULT_RISK_PROFILE;
  if (args.risk_profile !== undefined && args.risk_profile !== null && args.risk_profile !== "") {
    const profile = riskProfileName(args.risk_profile);
    if (!profile) return fail("invalid_request", `Unknown risk profile. quant has ${RISK_PROFILES.join(", ")}.`);
    riskProfile = profile;
  }
  let initialCapital = DEFAULT_INITIAL_CAPITAL;
  if (args.initial_capital !== undefined && args.initial_capital !== null && args.initial_capital !== "") {
    const n = typeof args.initial_capital === "number" ? args.initial_capital : Number(args.initial_capital);
    if (!Number.isFinite(n) || n <= 0) return fail("invalid_request", "initial_capital must be a positive number.");
    initialCapital = n;
  }
  return { ok: true, value: { strategy, symbol, startDate: start.value, endDate: end.value, riskProfile, initialCapital } };
}

/**
 * Parses quant's JSON. Python's json module writes Infinity, -Infinity and
 * NaN as bare tokens, which JSON.parse rejects; in value position they are
 * read as null.
 */
export function parseQuantJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/(?<=[:[,]\s*)(?:-?Infinity|NaN)(?=\s*[,}\]])/g, "null"));
  }
}

export interface BacktestMetrics {
  total_return: number | null;
  cagr: number | null;
  max_drawdown: number | null;
  volatility: number | null;
  sharpe_ratio: number | null;
  win_rate: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  num_trades: number | null;
  final_equity: number | null;
  profit_factor: number | null;
  max_consecutive_wins: number | null;
  max_consecutive_losses: number | null;
}

export const METRIC_KEYS = [
  "total_return",
  "cagr",
  "max_drawdown",
  "volatility",
  "sharpe_ratio",
  "win_rate",
  "avg_win",
  "avg_loss",
  "num_trades",
  "final_equity",
  "profit_factor",
  "max_consecutive_wins",
  "max_consecutive_losses",
] as const satisfies readonly (keyof BacktestMetrics)[];

export interface BacktestRun {
  backtestId: number | null;
  strategy: string;
  symbol: string;
  startDate: string;
  endDate: string;
  riskProfile: string;
  initialCapital: number;
  /** True unless quant's `data.synthetic` is explicitly false. */
  synthetic: boolean;
  dataFile: string;
  dataDescription: string;
  metrics: BacktestMetrics;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finiteOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function request(
  cfg: QuantConfig,
  path: string,
  init: RequestInit = {},
): Promise<QuantResult<{ status: number; body: unknown }>> {
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseUrl + path, { ...init, signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = parseQuantJson(text);
    } catch {
      if (res.ok) return fail("bad_response", "quant returned a body that is not JSON.");
    }
    return { ok: true, value: { status: res.status, body } };
  } catch {
    return signal.aborted
      ? fail("timeout", `quant did not finish the backtest within ${seconds(cfg.timeoutMs)}.`)
      : fail("unavailable", "quant could not be reached.");
  }
}

function errorText(body: unknown): string | null {
  return isObject(body) && typeof body.error === "string" && body.error ? body.error.slice(0, 200) : null;
}

/** GET /api/data: the dataset's date range, used when the user gives no dates. */
async function dataRange(cfg: QuantConfig): Promise<QuantResult<{ start: string; end: string }>> {
  const res = await request(cfg, "/api/data", { headers: { Accept: "application/json" } });
  if (!res.ok) return res;
  const { status, body } = res.value;
  if (status !== 200) return fail("unavailable", `quant returned HTTP ${status} for its data range.`);
  if (!isObject(body) || typeof body.start_date !== "string" || typeof body.end_date !== "string") {
    return fail("bad_response", "quant returned its data range in an unexpected shape.");
  }
  return { ok: true, value: { start: body.start_date, end: body.end_date } };
}

/** Runs one backtest on quant and waits for the result (quant answers when the run is done). */
export async function runBacktest(cfg: QuantConfig, req: BacktestRequest): Promise<QuantResult<BacktestRun>> {
  let startDate = req.startDate;
  let endDate = req.endDate;
  if (!startDate || !endDate) {
    const range = await dataRange(cfg);
    if (!range.ok) return range;
    startDate ??= range.value.start;
    endDate ??= range.value.end;
  }
  const res = await request(cfg, "/api/backtest/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      strategy_name: req.strategy,
      risk_config_name: req.riskProfile,
      start_date: startDate,
      end_date: endDate,
      initial_capital: req.initialCapital,
      symbols: [req.symbol],
    }),
  });
  if (!res.ok) return res;
  const { status, body } = res.value;
  if (status === 400) return fail("rejected", errorText(body) ?? "quant rejected the backtest request.");
  if (status !== 200) return fail("unavailable", `quant returned HTTP ${status}.`);
  if (!isObject(body) || !isObject(body.metrics)) {
    return fail("bad_response", "quant returned the backtest in an unexpected shape.");
  }
  const m = body.metrics;
  const metrics = Object.fromEntries(METRIC_KEYS.map((k) => [k, finiteOrNull(m[k])])) as unknown as BacktestMetrics;
  const data = isObject(body.data) ? body.data : {};
  return {
    ok: true,
    value: {
      backtestId: finiteOrNull(body.backtest_id),
      strategy: req.strategy,
      symbol: req.symbol,
      startDate,
      endDate,
      riskProfile: req.riskProfile,
      initialCapital: req.initialCapital,
      synthetic: data.synthetic !== false,
      dataFile: typeof data.file === "string" ? data.file.slice(0, 100) : "",
      dataDescription: typeof data.description === "string" ? data.description.slice(0, 300) : "",
      metrics,
    },
  };
}
