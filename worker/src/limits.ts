/**
 * Limits for a public demo: what a single request may send and receive.
 * Values come from
 * `[vars]` in wrangler.toml; a missing or invalid value falls back to the
 * default here, which matches the shipped wrangler.toml.
 */

export interface LimitVars {
  MAX_MESSAGE_CHARS?: unknown;
  MAX_HISTORY_CHARS?: unknown;
  MAX_OUTPUT_TOKENS?: unknown;
  RATE_LIMIT_PERIOD_SECONDS?: unknown;
}

export interface Limits {
  /** Longest chat message accepted, in UTF-16 code units (JavaScript string length). */
  maxMessageChars: number;
  /** Most characters of stored conversation sent to the model with a request. */
  maxHistoryChars: number;
  /** `max_tokens` for each reply. */
  maxOutputTokens: number;
  /** Retry-After for a per-IP 429; the period of the CHAT_RATE_LIMITER binding. */
  rateLimitPeriodSeconds: number;
}

export const DEFAULT_LIMITS = {
  maxMessageChars: 2000,
  maxHistoryChars: 6000,
  maxOutputTokens: 512,
  rateLimitPeriodSeconds: 60,
} as const;

/** At most this many stored messages are considered for the context. */
export const MESSAGE_WINDOW = 20;

/** Wrangler passes numeric vars as numbers and quoted ones as strings; accept both. */
function intVar(value: unknown, fallback: number, min: number, max: number): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function readLimits(env: LimitVars): Limits {
  const d = DEFAULT_LIMITS;
  return {
    maxMessageChars: intVar(env.MAX_MESSAGE_CHARS, d.maxMessageChars, 1, 100_000),
    maxHistoryChars: intVar(env.MAX_HISTORY_CHARS, d.maxHistoryChars, 0, 1_000_000),
    // The model's context window is 24,000 tokens.
    maxOutputTokens: intVar(env.MAX_OUTPUT_TOKENS, d.maxOutputTokens, 1, 24_000),
    rateLimitPeriodSeconds: intVar(env.RATE_LIMIT_PERIOD_SECONDS, d.rateLimitPeriodSeconds, 1, 86_400),
  };
}

/** Largest chat request body read, in bytes: room for a maximal, fully escaped message. */
export function chatBodyByteLimit(limits: Limits): number {
  return limits.maxMessageChars * 6 + 1024;
}

interface HistoryMessage {
  role: string;
  content: string;
}

/**
 * The stored messages to send with a request: from the last MESSAGE_WINDOW,
 * the newest ones whose combined length fits in `maxChars`. The result starts
 * with a user message, so the model never sees a reply without its question.
 */
export function selectHistory<T extends HistoryMessage>(messages: T[], maxChars: number): T[] {
  const recent = messages.slice(-MESSAGE_WINDOW);
  let used = 0;
  let start = recent.length;
  while (start > 0 && used + recent[start - 1].content.length <= maxChars) {
    used += recent[start - 1].content.length;
    start--;
  }
  while (start < recent.length && recent[start].role !== "user") start++;
  return recent.slice(start);
}

/**
 * The key for the per-IP rate limiter. IPv4 addresses are used as they are.
 * IPv6 addresses are cut to their /64 prefix, because a single client usually
 * controls a whole /64 and could otherwise rotate through addresses. With no
 * address (local development) every request shares one key.
 */
export function clientKey(ip: string | null): string {
  if (!ip) return "unknown";
  const addr = ip.trim().toLowerCase();
  if (!addr.includes(":")) return `ip4:${addr}`;
  const groups = expandIpv6(addr);
  if (!groups) return `ip6:${addr}`;
  // IPv4-mapped (::ffff:a.b.c.d): treat as the IPv4 client.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `ip4:${[groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".")}`;
  }
  return `ip6:${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** Expands an IPv6 address to its eight 16-bit groups, or null if it is malformed. */
function expandIpv6(addr: string): number[] | null {
  let text = addr.split("%")[0]; // drop a zone ID
  // A trailing dotted IPv4 part counts as two groups.
  const v4 = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(2).map(Number);
    if (octets.some((o) => o > 255)) return null;
    text = `${v4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}
