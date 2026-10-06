/**
 * The post-check on a finished answer: every price-like number in it should
 * be one the Worker gave the model (a level, a bar value or a backtest
 * metric). Numbers that match a provided value, within a small tolerance, are
 * "cited"; numbers that match nothing are "unverified". The check never edits
 * the model's text; it reports, and the Worker logs, stores and shows the
 * report.
 */

export type FactKind = "level" | "bar" | "backtest";

/** A number the Worker provided to the model, with what it is. */
export interface Fact {
  value: number;
  /** Short label for the page and the chart, e.g. "R1" or "52W high". */
  label: string;
  ticker: string;
  kind: FactKind;
  /** The data source that produced it, e.g. "synthetic". */
  source: string;
  /** Percent facts only match numbers written with %; value facts only numbers without. */
  unit: "value" | "percent";
  /** Also match the number with the opposite sign (a drawdown written as -12.5%). */
  signless?: boolean;
}

export interface Citation {
  text: string;
  value: number;
  label: string;
  ticker: string;
  kind: FactKind;
  source: string;
}

export interface Unverified {
  text: string;
  value: number;
}

export interface CheckResult {
  citations: Citation[];
  unverified: Unverified[];
}

export interface NumberToken {
  /** The number as written, without sign, currency or percent sign. */
  text: string;
  value: number;
  /** Digits after the decimal point, as written. */
  decimals: number;
  percent: boolean;
  index: number;
}

/** Relative tolerance: 0.05% of the provided value. */
export const RELATIVE_TOLERANCE = 0.0005;

const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Patterns whose digits are never prices: dates, and ratios or times such as 1:3 or 14:30. */
const MASKS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d+(?:\.\d+)?:\d+(?:\.\d+)?\b/g,
];

/** A count or a period follows: "20-day", "14 sessions", "3 trades". */
export const UNIT_AFTER =
  /^[\s-]?(?:days?|weeks?|months?|years?|sessions?|bars?|candles?|periods?|trades?|shares?|contracts?|lots?|pips?|ticks?|bps|basis\s+points?|minutes?|hours?|times)\b/i;
/** An indicator length: "SMA 200", "the 200 SMA", "RSI 14". */
const INDICATOR_BEFORE = /\b(?:SMA|EMA|MA|RSI|ATR|MACD|period|length|lookback)\s*$/i;
const INDICATOR_AFTER = /^\s?(?:SMA|EMA|MA|RSI|ATR)\b/i;

function maskText(text: string): string {
  let masked = text;
  for (const re of MASKS) masked = masked.replace(re, (m) => " ".repeat(m.length));
  return masked;
}

/**
 * The price-like numbers in `text`, and every percentage. A number counts as
 * price-like when it has a decimal part, a thousands separator or a $ sign,
 * or is a whole number of at least 100. Skipped: digits inside words or
 * tickers (R1, S001, 4H), dates, ratios and times, list markers, counts and
 * periods ("20-day", "14 sessions"), indicator lengths ("SMA 200"), and whole
 * numbers from 1900 to 2100 written without $, comma or decimals (years).
 */
export function extractNumbers(text: string): NumberToken[] {
  const masked = maskText(text);
  const tokens: NumberToken[] = [];
  for (const m of masked.matchAll(NUMBER)) {
    const raw = m[0];
    const index = m.index;
    const before = masked[index - 1] ?? "";
    if (/[\p{L}\p{N}_.]/u.test(before)) continue;
    const after = masked.slice(index + raw.length);
    if (/^[\p{L}_]/u.test(after)) continue;

    const dollar = before === "$";
    let signAt = dollar ? index - 2 : index - 1;
    let negative = false;
    const signChar = masked[signAt] ?? "";
    if (signChar === "-" || signChar === "−") {
      const prev = masked[signAt - 1];
      negative = prev === undefined || /[\s([:=,]/.test(prev);
    }
    if (!negative) signAt = -1;

    const percent = /^\s?%/.test(after);
    if (!percent) {
      if (UNIT_AFTER.test(after)) continue;
      if (INDICATOR_BEFORE.test(masked.slice(Math.max(0, index - 12), index))) continue;
      if (INDICATOR_AFTER.test(after)) continue;
      const lineStart = masked.lastIndexOf("\n", index - 1) + 1;
      if (/^[\s#>*-]*$/.test(masked.slice(lineStart, index)) && /^[.)](\s|$)/.test(after)) continue;
    }

    const hasComma = raw.includes(",");
    const decimals = raw.includes(".") ? raw.length - raw.indexOf(".") - 1 : 0;
    const magnitude = Number(raw.replaceAll(",", ""));
    if (!Number.isFinite(magnitude)) continue;
    const value = negative ? -magnitude : magnitude;
    if (!percent) {
      const priceLike = dollar || hasComma || decimals > 0 || magnitude >= 100;
      if (!priceLike) continue;
      const yearLike = !dollar && !hasComma && decimals === 0 && magnitude >= 1900 && magnitude <= 2100;
      if (yearLike) continue;
    }
    tokens.push({ text: raw, value, decimals, percent, index: signAt >= 0 ? signAt : index });
  }
  return tokens;
}

/** How far a written number may be from a provided value and still match it. */
export function tolerance(token: NumberToken, fact: Fact): number {
  // Half a unit in the last written digit covers rounding (185.6432 written as
  // 185.64 or 186); the relative part covers values written to fewer digits.
  return Math.max(0.5 * 10 ** -token.decimals, Math.abs(fact.value) * RELATIVE_TOLERANCE) + 1e-9;
}

function distance(token: NumberToken, fact: Fact): number {
  const direct = Math.abs(token.value - fact.value);
  return fact.signless ? Math.min(direct, Math.abs(Math.abs(token.value) - Math.abs(fact.value))) : direct;
}

const KIND_ORDER: Record<FactKind, number> = { level: 0, bar: 1, backtest: 2 };

/** The closest fact within tolerance; levels win ties over bars and bars over backtest values. */
export function matchFact(token: NumberToken, facts: readonly Fact[]): Fact | null {
  let best: Fact | null = null;
  let bestDistance = Infinity;
  for (const fact of facts) {
    if ((fact.unit === "percent") !== token.percent) continue;
    const d = distance(token, fact);
    if (d > tolerance(token, fact)) continue;
    if (d < bestDistance || (d === bestDistance && best && KIND_ORDER[fact.kind] < KIND_ORDER[best.kind])) {
      best = fact;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Checks an answer against the provided facts. Numbers that also appear in
 * the user's question are neither cited nor flagged. Percentages are only
 * checked when a percent fact (a backtest metric) was provided; otherwise
 * they are usually risk sizes such as "1% per trade" and are skipped.
 */
export function checkAnswer(answer: string, facts: readonly Fact[], question = ""): CheckResult {
  const fromQuestion = extractNumbers(question);
  const checkPercents = facts.some((f) => f.unit === "percent");
  const citations: Citation[] = [];
  const unverified: Unverified[] = [];
  const cited = new Set<string>();
  const flagged = new Set<string>();
  for (const token of extractNumbers(answer)) {
    if (token.percent && !checkPercents) continue;
    const fact = matchFact(token, facts);
    if (fact) {
      const key = `${fact.ticker}|${fact.label}|${fact.value}`;
      if (!cited.has(key)) {
        cited.add(key);
        citations.push({
          text: token.text,
          value: fact.value,
          label: fact.label,
          ticker: fact.ticker,
          kind: fact.kind,
          source: fact.source,
        });
      }
      continue;
    }
    const quoted = fromQuestion.some(
      (q) => q.percent === token.percent && Math.abs(Math.abs(q.value) - Math.abs(token.value)) < 1e-9,
    );
    if (quoted) continue;
    const text = `${token.value < 0 ? "-" : ""}${token.text}${token.percent ? "%" : ""}`;
    if (!flagged.has(text)) {
      flagged.add(text);
      unverified.push({ text, value: token.value });
    }
  }
  return { citations, unverified };
}

// ─── Server-sent events ────────────────────────────────────────────────────

export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";
