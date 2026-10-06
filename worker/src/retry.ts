/**
 * Reads how long an upstream service asked us to wait. Both services TradeDesk
 * calls send `Retry-After` with a 429, and quant also sends it with a 503;
 * market-data adds the IETF draft `RateLimit` field
 * (draft-ietf-httpapi-ratelimit-headers-11), for example
 * `"per-ip";r=0;t=12`. The wait shown to the user and the model is always one
 * of these values, never a guess: with no usable header, the message says to
 * try again later without a number.
 */

/**
 * Seconds from a Retry-After value: delta-seconds, or an HTTP-date counted
 * from `now` (RFC 9110, section 10.2.3). Null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Seconds until quota is available again, from a RateLimit field: the largest
 * `t` among the policies with no requests left (`r=0`). Null when no policy is
 * exhausted or the field is absent or malformed.
 */
export function parseRateLimitReset(value: string | null): number | null {
  if (value === null) return null;
  let wait: number | null = null;
  // A Structured Field list: items separated by commas, each a policy name with ;key=value parameters.
  for (const item of value.split(",")) {
    const params = new Map<string, string>();
    for (const part of item.split(";").slice(1)) {
      const [key, raw] = part.split("=", 2).map((s) => s.trim());
      if (key && raw !== undefined) params.set(key, raw);
    }
    const r = params.get("r");
    const t = params.get("t");
    if (r === undefined || t === undefined || !/^\d+$/.test(r) || !/^\d+$/.test(t)) continue;
    if (Number(r) === 0) wait = Math.max(wait ?? 0, Number(t));
  }
  return wait;
}

/** The wait a 429 or 503 response asks for: Retry-After first, then the RateLimit field. */
export function retryAfterFrom(headers: Headers, now = Date.now()): number | null {
  return parseRetryAfter(headers.get("Retry-After"), now) ?? parseRateLimitReset(headers.get("RateLimit"));
}

/** "retry in 12 s", "retry now", or "try again later" when the service gave no wait. */
export function retryPhrase(seconds: number | null): string {
  if (seconds === null) return "try again later";
  return seconds <= 0 ? "retry now" : `retry in ${seconds} s`;
}
