import { describe, expect, it } from "vitest";
import { parseRateLimitReset, parseRetryAfter, retryAfterFrom, retryPhrase } from "../src/retry";

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect([parseRetryAfter("12"), parseRetryAfter(" 0 "), parseRetryAfter("3600")]).toEqual([12, 0, 3600]);
  });

  it("reads an HTTP-date as the seconds from now, rounded up, never negative", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    expect(parseRetryAfter("Mon, 05 Oct 2026 12:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Mon, 05 Oct 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("is null when absent or unusable", () => {
    expect([null, "", "soon", "-5", "1.5", "12 s", "99999999999999999999"].map((v) => parseRetryAfter(v))).toEqual(
      [null, null, null, null, null, null, null],
    );
  });
});

describe("parseRateLimitReset", () => {
  it("reads t from an exhausted policy (draft-ietf-httpapi-ratelimit-headers-11)", () => {
    expect(parseRateLimitReset('"per-ip";r=0;t=12')).toBe(12);
    expect(parseRateLimitReset('"per-ip"; r=0; t=4')).toBe(4);
  });

  it("takes the longest wait among exhausted policies, and ignores the others", () => {
    expect(parseRateLimitReset('"burst";r=0;t=2, "daily";r=0;t=300, "minute";r=5;t=60')).toBe(300);
  });

  it("is null when no policy is exhausted, or the field is absent or malformed", () => {
    expect(parseRateLimitReset('"per-ip";r=29;t=1')).toBeNull();
    expect(parseRateLimitReset(null)).toBeNull();
    expect(parseRateLimitReset("garbage")).toBeNull();
    expect(parseRateLimitReset('"per-ip";r=0')).toBeNull();
    expect(parseRateLimitReset('"per-ip";r=0;t=x')).toBeNull();
  });
});

describe("retryAfterFrom and retryPhrase", () => {
  it("prefers Retry-After and falls back to RateLimit", () => {
    expect(retryAfterFrom(new Headers({ "Retry-After": "5", RateLimit: '"per-ip";r=0;t=9' }))).toBe(5);
    expect(retryAfterFrom(new Headers({ RateLimit: '"per-ip";r=0;t=9' }))).toBe(9);
    expect(retryAfterFrom(new Headers())).toBeNull();
  });

  it("states only a wait it was given", () => {
    expect([retryPhrase(12), retryPhrase(0), retryPhrase(null)]).toEqual(["retry in 12 s", "retry now", "try again later"]);
  });
});
