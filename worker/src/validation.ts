/**
 * Input validation for values the API stores or uses as keys. Anything stored
 * is shown to every visitor in the history sidebar, so the accepted forms are
 * deliberately narrow.
 */

/**
 * A ticker: 1-10 letters or digits, optionally followed by one separator
 * (`/`, `.` or `-`) and 1-10 more. Accepts GBP/USD, XAU/USD, NQ, US30, BRK.B
 * and BTC-USD; rejects spaces, quotes, angle brackets and anything else.
 * Tickers are compared upper-cased.
 */
export const TICKER_PATTERN = /^[A-Z0-9]{1,10}(?:[./-][A-Z0-9]{1,10})?$/;

/** The timeframes the front end offers. */
export const TIMEFRAMES = ["1M", "5M", "15M", "1H", "4H", "D", "W"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Session IDs: the front end sends a UUID; allow URL-safe IDs up to 64 characters. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const INVALID_TICKER =
  "Invalid ticker: use 1-10 letters or digits, optionally followed by '/', '.' or '-' and 1-10 more (for example GBP/USD or NQ).";

/** Returns the upper-cased ticker, or null if it is not a valid ticker. */
export function parseTicker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ticker = value.trim().toUpperCase();
  return TICKER_PATTERN.test(ticker) ? ticker : null;
}

/**
 * Parses the ticker segment of `/api/history/:ticker`. The front end sends
 * `encodeURIComponent(ticker)`, so "GBP/USD" arrives as "GBP%2FUSD"; an
 * unencoded slash also works. Anything that does not decode to a valid ticker
 * (including double-encoded input) returns null.
 */
export function parseTickerPath(segment: string): string | null {
  try {
    return parseTicker(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as readonly string[]).includes(value);
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** A validated value, or the status (400, or 413 for oversized input) and reason. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; detail: string };

const invalid = (detail: string) => ({ ok: false, status: 400, detail }) as const;

export interface InitBody {
  ticker: string;
  timeframe: Timeframe;
  sessionId: string;
}

/** Validates the body of `POST /api/session/:id/init`. */
export function parseInitBody(body: Record<string, unknown> | null): Parsed<InitBody> {
  if (!body) return invalid("Expected a JSON object body.");
  const ticker = parseTicker(body.ticker);
  if (!ticker) return invalid(INVALID_TICKER);
  if (!isTimeframe(body.timeframe)) {
    return invalid(`Invalid timeframe: use one of ${TIMEFRAMES.join(", ")}.`);
  }
  if (!isSessionId(body.sessionId)) {
    return invalid("Invalid sessionId: use 1-64 letters, digits, '-' or '_'.");
  }
  return { ok: true, value: { ticker, timeframe: body.timeframe, sessionId: body.sessionId } };
}

export interface ChatBody {
  message: string;
}

/**
 * Validates the body of `POST /api/session/:id/chat`. A message longer than
 * `maxChars` (JavaScript string length) is refused with 413.
 */
export function parseChatBody(
  body: Record<string, unknown> | null,
  maxChars: number,
): Parsed<ChatBody> {
  if (!body) return invalid("Expected a JSON object body.");
  const { message } = body;
  if (typeof message !== "string" || message.trim() === "") {
    return invalid("Expected a non-empty string field 'message'.");
  }
  if (message.length > maxChars) {
    return { ok: false, status: 413, detail: `Messages are limited to ${maxChars} characters.` };
  }
  return { ok: true, value: { message } };
}
