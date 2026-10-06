/**
 * Tool calling for the chat route. The model is offered tools that fetch real
 * data (market-data levels and bars); the Worker runs the calls, turns each
 * result into a labelled text block, and records the numbers it provided so
 * the post-check (grounding.ts) can compare the answer against them.
 *
 * Request and response format, from the Workers AI docs and
 * @cloudflare/workers-types for @cf/meta/llama-3.3-70b-instruct-fp8-fast:
 * tools are `{ name, description, parameters: { type: "object", properties,
 * required } }`; a non-streamed response carries `tool_calls: [{ name,
 * arguments }]` (no call ids); results go back as an assistant message holding
 * the calls as JSON and one `role: "tool"` message per result. The streaming
 * output schema documents only text events, not tool calls, so tool rounds
 * are never streamed.
 */

import { checkAnswer, type Citation, type Fact, type Unverified } from "./grounding";
import { intVar } from "./limits";
import {
  getBars,
  getLevels,
  isSynthetic,
  readMarketDataConfig,
  sourceLabel,
  type Bar,
  type FailureKind,
  type Levels,
  type MarketDataConfig,
  type MarketDataVars,
} from "./marketdata";

export interface ToolVars extends MarketDataVars {
  /** Non-streamed tool rounds before the final, streamed answer (default 2, 1-4). */
  MAX_TOOL_ROUNDS?: unknown;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What one tool call returned, for the trailer the page reads. */
export interface DataStatus {
  tool: string;
  service: "market-data";
  ticker: string;
  status: "ok" | FailureKind;
  source?: string;
  synthetic?: boolean;
  asOf?: string;
  detail?: string;
}

export interface ToolOutcome {
  call: ToolCall;
  /** The block the model sees, as a tool result and in the final answer's context. */
  text: string;
  facts: Fact[];
  status: DataStatus;
}

export interface Toolset {
  schemas: ToolSchema[];
  execute(call: ToolCall): Promise<ToolOutcome>;
}

export const DEFAULT_MAX_TOOL_ROUNDS = 2;
/** A tool round only needs to emit tool calls; any text it writes is discarded. */
export const TOOL_ROUND_MAX_TOKENS = 256;
export const MAX_CALLS_PER_ROUND = 3;
export const MAX_TOOL_CALLS = 4;
export const MAX_BAR_DAYS = 60;
export const DEFAULT_BAR_DAYS = 20;

export function readMaxToolRounds(env: ToolVars): number {
  return intVar(env.MAX_TOOL_ROUNDS, DEFAULT_MAX_TOOL_ROUNDS, 1, 4);
}

const TICKER_PARAM = {
  type: "string",
  description:
    "Ticker symbol, for example S001 or AAPL: a letter, then letters, digits or a dot, at most 10 characters.",
};

export const MARKET_DATA_TOOLS: ToolSchema[] = [
  {
    name: "get_levels",
    description:
      "Price levels for one ticker from the market-data service: the latest daily close, classic floor pivots " +
      "(P, R1-R3, S1-S3) for the next session, 20-day and 50-day highs and lows, and the 52-week range. " +
      "Call it before stating any price level for a ticker.",
    parameters: { type: "object", properties: { ticker: TICKER_PARAM }, required: ["ticker"] },
  },
  {
    name: "get_recent_bars",
    description:
      "The most recent daily OHLCV bars for one ticker from the market-data service, oldest first. " +
      "Use it for recent price action, swing highs and lows, or the latest session.",
    parameters: {
      type: "object",
      properties: {
        ticker: TICKER_PARAM,
        days: {
          type: "integer",
          description: `Number of most recent trading sessions, 1 to ${MAX_BAR_DAYS} (default ${DEFAULT_BAR_DAYS}).`,
        },
      },
      required: ["ticker"],
    },
  },
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (isObject(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return value === undefined || value === null ? {} : null;
}

function toCall(value: unknown, names: ReadonlySet<string>): ToolCall | null {
  if (!isObject(value)) return null;
  // OpenAI style nests the call under `function`.
  const fn = isObject(value.function) ? value.function : value;
  const name = fn.name;
  if (typeof name !== "string" || !names.has(name)) return null;
  const args = parseArguments(fn.arguments ?? fn.parameters);
  return args ? { name, arguments: args } : null;
}

/**
 * The tool calls in a non-streamed Workers AI response. Reads `tool_calls`;
 * if there are none, also accepts a reply whose whole text is a JSON tool call
 * (`{"name": ..., "parameters": {...}}`, Llama 3's own format), which models
 * sometimes return as text. Unknown tool names are dropped.
 */
export function extractToolCalls(output: unknown, names: ReadonlySet<string>): ToolCall[] {
  if (!isObject(output)) return [];
  if (Array.isArray(output.tool_calls) && output.tool_calls.length > 0) {
    return output.tool_calls.map((c) => toCall(c, names)).filter((c): c is ToolCall => c !== null);
  }
  if (typeof output.response !== "string") return [];
  const text = output.response.trim().replace(/^<\|python_tag\|>/, "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((c) => toCall(c, names)).filter((c): c is ToolCall => c !== null);
  } catch {
    return [];
  }
}

function callKey(call: ToolCall): string {
  const args = Object.keys(call.arguments)
    .sort()
    .map((k) => [k, call.arguments[k]]);
  return `${call.name}:${JSON.stringify(args)}`;
}

const fmt = (n: number | null): string => (n === null ? "no data" : String(n));

function sourceNote(source: string): string {
  return isSynthetic(source)
    ? "SYNTHETIC DEMO DATA: generated prices, not real market prices"
    : sourceLabel(source);
}

export function levelsBlock(l: Levels): string {
  const p = l.pivots;
  return [
    `[MARKET DATA get_levels ${l.ticker}] source: ${l.source} (${sourceNote(l.source)})`,
    `Latest session ${l.asOf}: close ${l.close}`,
    `Floor pivots for the next session (from the ${p.basedOn} session): P ${p.p}, R1 ${p.r1}, R2 ${p.r2}, R3 ${p.r3}, S1 ${p.s1}, S2 ${p.s2}, S3 ${p.s3}`,
    `20-day range: high ${fmt(l.range20d.high)}, low ${fmt(l.range20d.low)}`,
    `50-day range: high ${fmt(l.range50d.high)}, low ${fmt(l.range50d.low)}`,
    `52-week range: high ${fmt(l.range52w.high)}, low ${fmt(l.range52w.low)}`,
  ].join("\n");
}

export function levelFacts(l: Levels): Fact[] {
  const base = { ticker: l.ticker, kind: "level" as const, source: l.source, unit: "value" as const };
  const facts: Fact[] = [
    { ...base, value: l.close, label: "Close" },
    { ...base, value: l.pivots.p, label: "P" },
    { ...base, value: l.pivots.r1, label: "R1" },
    { ...base, value: l.pivots.r2, label: "R2" },
    { ...base, value: l.pivots.r3, label: "R3" },
    { ...base, value: l.pivots.s1, label: "S1" },
    { ...base, value: l.pivots.s2, label: "S2" },
    { ...base, value: l.pivots.s3, label: "S3" },
  ];
  const ranges: [string, number | null][] = [
    ["20D high", l.range20d.high],
    ["20D low", l.range20d.low],
    ["50D high", l.range50d.high],
    ["50D low", l.range50d.low],
    ["52W high", l.range52w.high],
    ["52W low", l.range52w.low],
  ];
  for (const [label, value] of ranges) if (value !== null) facts.push({ ...base, value, label });
  return facts;
}

export function barsBlock(ticker: string, source: string, bars: Bar[]): string {
  return [
    `[MARKET DATA get_recent_bars ${ticker}, last ${bars.length} sessions] source: ${source} (${sourceNote(source)})`,
    "date open high low close volume",
    ...bars.map((b) => `${b.date} ${b.open} ${b.high} ${b.low} ${b.close} ${b.volume}`),
  ].join("\n");
}

/**
 * Facts from bars: the latest bar and the window's high and low. Not every
 * bar: with dozens of closely spaced values almost any number in the recent
 * range would match one, and the check would mean nothing.
 */
export function barFacts(ticker: string, source: string, bars: Bar[]): Fact[] {
  if (bars.length === 0) return [];
  const base = { ticker, kind: "bar" as const, source, unit: "value" as const };
  const last = bars[bars.length - 1];
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  return [
    { ...base, value: last.open, label: `${last.date} open` },
    { ...base, value: last.high, label: `${last.date} high` },
    { ...base, value: last.low, label: `${last.date} low` },
    { ...base, value: last.close, label: `${last.date} close` },
    { ...base, value: high, label: `${bars.length}-session high` },
    { ...base, value: low, label: `${bars.length}-session low` },
  ];
}

const FAILURE_ADVICE: Record<FailureKind, string> = {
  unsupported_ticker: 'NO DATA. Say "no data" for its levels.',
  not_found: 'NO DATA. Say "no data" for its levels.',
  rejected: 'NO DATA. Say "no data" for its levels.',
  not_displayable: 'NO DATA. Say "no data" for its levels.',
  timeout: "UNAVAILABLE. Say that market data is unavailable right now; do not state levels.",
  unavailable: "UNAVAILABLE. Say that market data is unavailable right now; do not state levels.",
  rate_limited: "UNAVAILABLE. Say that market data is unavailable right now; do not state levels.",
  bad_response: "UNAVAILABLE. Say that market data is unavailable right now; do not state levels.",
};

function failureOutcome(call: ToolCall, ticker: string, kind: FailureKind, detail: string): ToolOutcome {
  return {
    call,
    text: `[MARKET DATA ${call.name} ${ticker}] ${FAILURE_ADVICE[kind]} Reason: ${detail}`,
    facts: [],
    status: { tool: call.name, service: "market-data", ticker, status: kind, detail },
  };
}

function tickerArg(call: ToolCall): string {
  const t = call.arguments.ticker;
  return typeof t === "string" && t.trim() ? t.trim().toUpperCase().slice(0, 20) : "(none)";
}

export function daysArg(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_BAR_DAYS;
  return Math.min(MAX_BAR_DAYS, Math.max(1, Math.round(n)));
}

export async function runMarketDataTool(cfg: MarketDataConfig, call: ToolCall): Promise<ToolOutcome> {
  const ticker = tickerArg(call);
  if (call.name === "get_levels") {
    const res = await getLevels(cfg, call.arguments.ticker);
    if (!res.ok) return failureOutcome(call, ticker, res.kind, res.detail);
    const l = res.value;
    return {
      call,
      text: levelsBlock(l),
      facts: levelFacts(l),
      status: {
        tool: call.name,
        service: "market-data",
        ticker: l.ticker,
        status: "ok",
        source: l.source,
        synthetic: isSynthetic(l.source),
        asOf: l.asOf,
      },
    };
  }
  // get_recent_bars
  const days = daysArg(call.arguments.days);
  const res = await getBars(cfg, call.arguments.ticker);
  if (!res.ok) return failureOutcome(call, ticker, res.kind, res.detail);
  const page = res.value;
  if (page.bars.length === 0) {
    return failureOutcome(call, page.ticker, "not_found", `market-data has no bars for ${page.ticker}.`);
  }
  const bars = page.bars.slice(-days);
  return {
    call,
    text: barsBlock(page.ticker, page.source, bars),
    facts: barFacts(page.ticker, page.source, bars),
    status: {
      tool: call.name,
      service: "market-data",
      ticker: page.ticker,
      status: "ok",
      source: page.source,
      synthetic: isSynthetic(page.source),
      asOf: bars[bars.length - 1].date,
    },
  };
}

/** The tools this deployment can offer, or null when no data service is configured. */
export function buildToolset(env: ToolVars): Toolset | null {
  const marketData = readMarketDataConfig(env);
  if (!marketData) return null;
  return {
    schemas: MARKET_DATA_TOOLS,
    execute: (call) => runMarketDataTool(marketData, call),
  };
}

/**
 * Runs up to `maxRounds` non-streamed rounds. Each round offers the tools; if
 * the model asks for calls, the Worker runs them (at most MAX_CALLS_PER_ROUND
 * per round and MAX_TOOL_CALLS in all, repeats skipped) and adds the calls and
 * results to the conversation for the next round. Stops when a round asks for
 * nothing new. A failed model call ends the rounds with what was collected.
 */
export async function runToolRounds(
  ai: Ai,
  model: string,
  messages: ChatMessage[],
  toolset: Toolset,
  maxRounds: number,
): Promise<ToolOutcome[]> {
  const names = new Set(toolset.schemas.map((t) => t.name));
  const conversation = [...messages];
  const outcomes: ToolOutcome[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < maxRounds && outcomes.length < MAX_TOOL_CALLS; round++) {
    let output: unknown;
    try {
      output = await ai.run(model as never, {
        messages: [...conversation],
        tools: toolset.schemas,
        max_tokens: TOOL_ROUND_MAX_TOKENS,
      } as never);
    } catch (e) {
      console.error(JSON.stringify({ event: "tool_round_failed", round, error: String(e) }));
      break;
    }
    const calls: ToolCall[] = [];
    for (const call of extractToolCalls(output, names)) {
      const key = callKey(call);
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push(call);
    }
    const batch = calls.slice(0, Math.min(MAX_CALLS_PER_ROUND, MAX_TOOL_CALLS - outcomes.length));
    if (batch.length === 0) break;
    const results = await Promise.all(batch.map((call) => toolset.execute(call)));
    outcomes.push(...results);
    conversation.push({ role: "assistant", content: JSON.stringify(batch) });
    for (const r of results) conversation.push({ role: "tool", content: r.text });
  }
  return outcomes;
}

/** The data block appended to the system prompt of the final, streamed call. */
export function dataBlock(outcomes: ToolOutcome[]): string {
  if (outcomes.length === 0) {
    return (
      "[NO MARKET DATA RETRIEVED] No data was fetched for this question, so you have no prices: " +
      'do not state any price level; write "no data" if asked for one.'
    );
  }
  return [
    "[DATA FOR THIS ANSWER] The blocks below are the only market data you have for this answer.",
    ...outcomes.map((o) => o.text),
  ].join("\n\n");
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Notes the Worker appends to the answer, so the source of the data (or its
 * absence) is stated in the answer itself and in its saved copy, whatever the
 * model wrote.
 */
export function dataNotes(outcomes: ToolOutcome[], unverified: string[]): string[] {
  const notes: string[] = [];
  const bySource = new Map<string, Set<string>>();
  const failures = new Map<string, string>();
  for (const { status } of outcomes) {
    if (status.status === "ok" && status.source) {
      const tickers = bySource.get(status.source) ?? new Set<string>();
      tickers.add(status.ticker);
      bySource.set(status.source, tickers);
    } else if (status.status !== "ok") {
      failures.set(`${status.ticker}|${status.status}`, `No market data for ${status.ticker}: ${status.detail}`);
    }
  }
  for (const [source, tickers] of bySource) {
    const names = list([...tickers]);
    notes.push(
      isSynthetic(source)
        ? `Market data for ${names} is synthetic demo data generated by market-data, not real market prices.`
        : `Market data for ${names}: ${sourceLabel(source)}, daily bars.`,
    );
  }
  notes.push(...failures.values());
  if (unverified.length > 0) {
    notes.push(`Not found in the retrieved data, so unverified: ${unverified.join(", ")}.`);
  }
  return notes;
}

export function formatNotes(notes: string[]): string {
  if (notes.length === 0) return "";
  return `\n\n---\n\n**Data notes**\n\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

/** The report sent to the page after the answer and stored with it in D1. */
export interface GroundingMeta {
  data: DataStatus[];
  citations: Citation[];
  unverified: Unverified[];
}

/**
 * Runs the post-check on a finished reply and builds the data notes. Pure, so
 * the response stream and the background copy that is saved get the same
 * result from the same text.
 */
export function groundAnswer(
  reply: string,
  outcomes: ToolOutcome[],
  question: string,
): { notes: string; meta: GroundingMeta } {
  const facts = outcomes.flatMap((o) => o.facts);
  const { citations, unverified } = checkAnswer(reply, facts, question);
  return {
    notes: formatNotes(dataNotes(outcomes, unverified.map((u) => u.text))),
    meta: { data: outcomes.map((o) => o.status), citations, unverified },
  };
}
