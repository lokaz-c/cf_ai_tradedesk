/**
 * Client for the quant backtester (github.com/lokaz-c/quant, Flask). Contract,
 * from its app/ package and docs/api.md:
 *
 * - POST /api/backtest/ (trailing slash) with JSON `{ strategy_name,
 *   risk_config_name, start_date, end_date, initial_capital, symbols }` runs
 *   the backtest synchronously and answers 200 with `{ backtest_id, status,
 *   metrics, undefined_metrics, summary, data, baseline }`. There is no job id
 *   to poll: the run is finished when the response arrives.
 * - GET /api/data returns the dataset's label, symbols and date range, and the
 *   server's caps on a run: `{ source, synthetic, description, file?, symbols,
 *   start_date, end_date, limits: { max_symbols, max_range_days,
 *   timeout_seconds } }`. max_range_days counts calendar days from start_date
 *   to end_date inclusive.
 * - Errors are RFC 9457 problem details that keep the earlier `error` field:
 *   `{ title, status, detail, instance, error }`. 400: invalid input or a
 *   request over a cap. 401: an X-API-Key that is not valid. 429: over a rate
 *   limit, with Retry-After. 503: every run slot is taken, with Retry-After.
 *   504: the run passed quant's time limit (limits.timeout_seconds) and was
 *   stopped. 502: quant's own market-data source failed.
 * - Bodies are strict JSON (no bare Infinity or NaN). A metric with no value
 *   for a run is null, and `undefined_metrics` maps each null metric to the
 *   reason, for example `{ "profit_factor": "no losing trades" }`.
 * - `data.synthetic` is false only for real data; the summary must say when
 *   it is synthetic. `data.source` is "synthetic" (the bundled file, named in
 *   `data.file`) or "market-data".
 * - Metrics: total_return, cagr, max_drawdown (positive), volatility and
 *   win_rate are percentages; avg_win, avg_loss (negative) and final_equity
 *   are currency amounts; sharpe_ratio and profit_factor are ratios.
 *
 * QUANT_API_KEY is sent as X-API-Key when set. A key whose digest is in
 * quant's QUANT_API_KEY_SHA256 lifts quant's per-address rate limits, but not
 * its caps, its time limit or its run slots.
 */

import { intVar } from "./limits";
import { seconds } from "./marketdata";
import { parseRetryAfter, retryPhrase } from "./retry";

export interface QuantVars {
  /** Base URL of the quant API, e.g. https://quant.example.com. Unset turns the backtest tool off. */
  QUANT_API_URL?: unknown;
  /** Optional API key, sent as X-API-Key. A secret: `wrangler secret put QUANT_API_KEY`. */
  QUANT_API_KEY?: unknown;
  /** Timeout for a backtest request in milliseconds (default 60000, 100 to 120000). */
  QUANT_TIMEOUT_MS?: unknown;
}

export interface QuantConfig {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
}

/**
 * quant's `make deploy-check` (its README, "Deploying") ran its default request
 * (5 symbols, one year, with a baseline) in 52.7 s at Render's free size.
 */
export const DEFAULT_QUANT_TIMEOUT_MS = 60_000;
/** Above quant's own 90 s limit, so a deployment can choose to wait for quant's 504 instead. */
export const MAX_QUANT_TIMEOUT_MS = 120_000;

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
  const key = typeof env.QUANT_API_KEY === "string" ? env.QUANT_API_KEY.trim() : "";
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    apiKey: key || null,
    timeoutMs: intVar(env.QUANT_TIMEOUT_MS, DEFAULT_QUANT_TIMEOUT_MS, 100, MAX_QUANT_TIMEOUT_MS),
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

export type QuantFailure =
  | "invalid_request"
  | "rejected"
  | "timeout"
  | "unavailable"
  | "rate_limited"
  | "busy"
  | "bad_response";

export type QuantResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: QuantFailure;
      detail: string;
      /** For rate_limited and busy: the seconds quant asked us to wait (Retry-After), when it said. */
      retryAfter?: number;
    };

type QuantFail = Extract<QuantResult<never>, { ok: false }>;

const fail = (kind: QuantFailure, detail: string): QuantFail => ({ ok: false, kind, detail });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

/** A real calendar date in YYYY-MM-DD form (2023-02-30 is not one). */
export function isCalendarDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

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
    return typeof v === "string" && isCalendarDate(v.trim())
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

export type MetricKey = keyof BacktestMetrics;

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
] as const satisfies readonly MetricKey[];

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
  /** null where quant had no value for the run; the reason is in undefinedMetrics. */
  metrics: BacktestMetrics;
  /** quant's reason for each null metric (`undefined_metrics`). */
  undefinedMetrics: Partial<Record<MetricKey, string>>;
  /** Set when a period filled in from quant's data range was cut to its max_range_days. */
  periodNote: string | null;
}

/** quant's caps on one run (`limits` in GET /api/data); null where quant did not say. */
export interface QuantLimits {
  maxSymbols: number | null;
  maxRangeDays: number | null;
  timeoutSeconds: number | null;
}

interface DataInfo {
  start: string;
  end: string;
  limits: QuantLimits;
}

/** Symbols the run_backtest tool sends per run. */
export const SYMBOLS_PER_RUN = 1;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finiteOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reasons are shown to the model and the page; keep them short. */
const MAX_REASON_CHARS = 120;

interface QuantResponse {
  status: number;
  headers: Headers;
  /** The parsed JSON body; null for an error body that is not JSON. */
  body: unknown;
}

/**
 * One request to quant. Bodies are parsed strictly (quant writes RFC 8259
 * JSON): a 2xx body that is not JSON is a bad_response; an error body that is
 * not JSON is kept as null so the status still explains the failure.
 */
async function request(cfg: QuantConfig, path: string, init: RequestInit = {}): Promise<QuantResult<QuantResponse>> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (cfg.apiKey) headers.set("X-API-Key", cfg.apiKey);
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseUrl + path, { ...init, headers, signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      if (res.ok) return fail("bad_response", "quant returned a body that is not JSON.");
    }
    return { ok: true, value: { status: res.status, headers: res.headers, body } };
  } catch {
    return signal.aborted
      ? fail("timeout", `quant did not finish the backtest within ${seconds(cfg.timeoutMs)} (QUANT_TIMEOUT_MS).`)
      : fail("unavailable", "quant could not be reached.");
  }
}

/** The message of a quant error body: `error` (kept for older clients), else RFC 9457's `detail`. */
function errorText(body: unknown): string | null {
  if (!isObject(body)) return null;
  for (const field of [body.error, body.detail]) {
    if (typeof field === "string" && field.trim()) return field.trim().slice(0, 200);
  }
  return null;
}

/** A number of seconds as quant gave it: 90.0 is written "90". */
const secondsText = (n: number) => String(Number.isInteger(n) ? n : Number(n.toFixed(1)));

/**
 * A non-success response from quant as a failure. Waits and limits in the
 * messages are the ones quant sent (Retry-After, limits.timeout_seconds); when
 * it sent none, the message has no number.
 */
function statusFailure(res: QuantResponse, what: string, limits: QuantLimits | null): QuantFail {
  const { status, headers, body } = res;
  const text = errorText(body);
  const withWait = (failure: QuantFail, wait: number | null): QuantFail =>
    wait === null ? failure : { ...failure, retryAfter: wait };
  switch (status) {
    case 400:
      return fail("rejected", text ?? `quant rejected the request for ${what}.`);
    case 401:
      return fail("unavailable", "quant rejected the configured API key (QUANT_API_KEY).");
    case 429: {
      const wait = parseRetryAfter(headers.get("Retry-After"));
      return withWait(fail("rate_limited", `quant is busy (rate limit reached); ${retryPhrase(wait)}.`), wait);
    }
    case 503: {
      const wait = parseRetryAfter(headers.get("Retry-After"));
      return withWait(
        fail(
          "busy",
          wait === null
            ? "quant is busy or unavailable (HTTP 503); try again later."
            : `quant is busy (it runs a limited number of backtests at once); ${retryPhrase(wait)}.`,
        ),
        wait,
      );
    }
    case 504: {
      // quant's own deadline answers with a problem body; a proxy's 504 does not.
      if (!text) return fail("timeout", "quant's server timed out (HTTP 504) before the backtest finished.");
      const limit = limits?.timeoutSeconds;
      return fail(
        "timeout",
        `quant stopped the backtest at its ${limit ? `${secondsText(limit)} s ` : ""}time limit. A shorter period runs faster.`,
      );
    }
    case 500:
      // quant's 500 detail is generic ("the details are in the server log").
      return fail("unavailable", "quant returned HTTP 500.");
    default:
      return fail("unavailable", `quant returned HTTP ${status}${text ? `: ${text}` : "."}`);
  }
}

function wholeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function parseLimits(v: unknown): QuantLimits {
  if (!isObject(v)) return { maxSymbols: null, maxRangeDays: null, timeoutSeconds: null };
  const timeout = finiteOrNull(v.timeout_seconds);
  const range = wholeNumber(v.max_range_days);
  return {
    maxSymbols: wholeNumber(v.max_symbols),
    maxRangeDays: range !== null && range > 0 ? range : null,
    timeoutSeconds: timeout !== null && timeout > 0 ? timeout : null,
  };
}

/** GET /api/data: the dataset's date range and quant's caps on a run. */
async function dataInfo(cfg: QuantConfig): Promise<QuantResult<DataInfo>> {
  const res = await request(cfg, "/api/data");
  if (!res.ok) return res;
  const { status, body } = res.value;
  if (status !== 200) return statusFailure(res.value, "its data range", null);
  if (!isObject(body) || typeof body.start_date !== "string" || typeof body.end_date !== "string") {
    return fail("bad_response", "quant returned its data range in an unexpected shape.");
  }
  if (!isCalendarDate(body.start_date) || !isCalendarDate(body.end_date)) {
    return fail("bad_response", "quant returned its data range in an unexpected shape.");
  }
  return { ok: true, value: { start: body.start_date, end: body.end_date, limits: parseLimits(body.limits) } };
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Calendar days from `start` to `end`, both included, as quant counts max_range_days. */
export function rangeDays(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start) + 1;
}

/**
 * The period to run. Missing dates come from quant's data range; a period
 * filled in that way is cut to limits.max_range_days, keeping its most recent
 * part. A period the user gave in full is never changed: if it is longer than
 * the limit it is refused before a run is spent on it.
 */
function resolvePeriod(
  req: Pick<BacktestRequest, "startDate" | "endDate">,
  data: DataInfo,
): QuantResult<{ start: string; end: string; note: string | null }> {
  const max = data.limits.maxRangeDays;
  if (req.startDate && req.endDate) {
    const days = rangeDays(req.startDate, req.endDate);
    if (max !== null && days > max) {
      return fail(
        "invalid_request",
        `quant runs at most ${max} days per backtest (its limits.max_range_days); ${req.startDate} to ${req.endDate} is ${days} days. Ask for a shorter period.`,
      );
    }
    return { ok: true, value: { start: req.startDate, end: req.endDate, note: null } };
  }
  const span = max === null ? null : max - 1;
  let end = req.endDate ?? data.end;
  if (!req.endDate && req.startDate && span !== null) {
    end = fromDayNumber(Math.min(dayNumber(data.end), dayNumber(req.startDate) + span));
  }
  let start = req.startDate ?? data.start;
  if (!req.startDate && span !== null) {
    start = fromDayNumber(Math.max(dayNumber(data.start), dayNumber(end) - span));
  }
  const cut = max !== null && rangeDays(req.startDate ?? data.start, req.endDate ?? data.end) > max;
  const note = cut
    ? `The period was filled in from quant's data range (${data.start} to ${data.end}) and cut to quant's limit of ${max} days per backtest.`
    : null;
  return { ok: true, value: { start, end, note } };
}

function parseUndefinedMetrics(v: unknown, metrics: BacktestMetrics): Partial<Record<MetricKey, string>> {
  const reasons: Partial<Record<MetricKey, string>> = {};
  if (!isObject(v)) return reasons;
  for (const key of METRIC_KEYS) {
    const reason = v[key];
    if (metrics[key] === null && typeof reason === "string" && reason.trim()) {
      reasons[key] = reason.trim().slice(0, MAX_REASON_CHARS);
    }
  }
  return reasons;
}

function dataLabel(data: Record<string, unknown>): string {
  if (typeof data.file === "string") return data.file.slice(0, 100);
  return data.source === "market-data" ? "market-data bars" : "";
}

/**
 * Runs one backtest on quant and waits for the result (quant answers when the
 * run is done). Reads quant's data range and caps first, so a period it would
 * refuse is not sent and a missing period fits its limits.
 */
export async function runBacktest(cfg: QuantConfig, req: BacktestRequest): Promise<QuantResult<BacktestRun>> {
  const info = await dataInfo(cfg);
  if (!info.ok) return info;
  const { limits } = info.value;
  if (limits.maxSymbols !== null && SYMBOLS_PER_RUN > limits.maxSymbols) {
    return fail("rejected", `quant accepts at most ${limits.maxSymbols} symbols per backtest (its limits.max_symbols).`);
  }
  const period = resolvePeriod(req, info.value);
  if (!period.ok) return period;
  const { start: startDate, end: endDate, note } = period.value;
  const res = await request(cfg, "/api/backtest/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  if (status !== 200) return statusFailure(res.value, "the backtest", limits);
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
      dataFile: dataLabel(data),
      dataDescription: typeof data.description === "string" ? data.description.slice(0, 300) : "",
      metrics,
      undefinedMetrics: parseUndefinedMetrics(body.undefined_metrics, metrics),
      periodNote: note,
    },
  };
}
