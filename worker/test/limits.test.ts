import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatBodyByteLimit,
  clientKey,
  consumeDailyBudget,
  DEFAULT_LIMITS,
  readLimits,
  secondsUntilUtcMidnight,
  selectHistory,
  utcDay,
} from "../src/limits";
import {
  aiInputs,
  api,
  chat,
  clearD1,
  expectProblem,
  getState,
  initSession,
  insertAnalyses,
  mockAiStream,
  postJson,
  sessionStub,
  type StoredMessage,
} from "./helpers";

// From wrangler.toml: [[ratelimits]] simple.limit, and [vars].
const PER_IP_LIMIT = 5;
const BUDGET = 200;
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_CHARS = 6000;

beforeEach(clearD1);

async function usedToday(): Promise<number> {
  const row = await env.DB.prepare("SELECT chat_requests FROM daily_usage WHERE day = ?")
    .bind(utcDay(new Date()))
    .first<{ chat_requests: number }>();
  return row?.chat_requests ?? 0;
}

async function setUsedToday(n: number) {
  await env.DB.prepare(
    "INSERT INTO daily_usage (day, chat_requests) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET chat_requests = excluded.chat_requests",
  )
    .bind(utcDay(new Date()), n)
    .run();
}

/** Overrides vars for one session's Durable Object instance. */
async function setSessionVars(sessionId: string, vars: Record<string, unknown>) {
  await runInDurableObject(sessionStub(sessionId), (instance) => {
    const object = instance as unknown as { env: Record<string, unknown> };
    object.env = { ...object.env, ...vars };
  });
}

function pairs(count: number, chars: number): StoredMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: String(i % 10).repeat(chars),
  }));
}

async function seedMessages(sessionId: string, messages: StoredMessage[]) {
  await runInDurableObject(sessionStub(sessionId), async (_instance, state) => {
    await state.storage.put("session", {
      sessionId,
      ticker: "",
      timeframe: "4H",
      messages,
      createdAt: Date.now(),
    });
  });
}

describe("readLimits", () => {
  it("reads the vars from wrangler.toml", () => {
    expect(readLimits(env)).toEqual({
      maxMessageChars: MAX_MESSAGE_CHARS,
      maxHistoryChars: MAX_HISTORY_CHARS,
      maxOutputTokens: 512,
      dailyChatBudget: BUDGET,
      rateLimitPeriodSeconds: 60,
    });
  });

  it("uses the defaults when vars are missing", () => {
    const limits = readLimits({});
    expect(limits.maxMessageChars).toBe(DEFAULT_LIMITS.maxMessageChars);
    expect(limits.maxHistoryChars).toBe(DEFAULT_LIMITS.maxHistoryChars);
    expect(limits.maxOutputTokens).toBe(DEFAULT_LIMITS.maxOutputTokens);
    expect(limits.dailyChatBudget).toBe(DEFAULT_LIMITS.dailyChatBudget);
    expect(limits.rateLimitPeriodSeconds).toBe(DEFAULT_LIMITS.rateLimitPeriodSeconds);
  });

  it("accepts numeric strings, and falls back on invalid or out-of-range values", () => {
    const limits = readLimits({
      MAX_MESSAGE_CHARS: "500",
      MAX_HISTORY_CHARS: "lots",
      MAX_OUTPUT_TOKENS: 0,
      DAILY_CHAT_BUDGET: 1.5,
      RATE_LIMIT_PERIOD_SECONDS: "",
    });
    expect(limits.maxMessageChars).toBe(500);
    expect(limits.maxHistoryChars).toBe(DEFAULT_LIMITS.maxHistoryChars);
    expect(limits.maxOutputTokens).toBe(DEFAULT_LIMITS.maxOutputTokens);
    expect(limits.dailyChatBudget).toBe(DEFAULT_LIMITS.dailyChatBudget);
    expect(limits.rateLimitPeriodSeconds).toBe(DEFAULT_LIMITS.rateLimitPeriodSeconds);
  });

  it("allows a daily budget of 0 (chat off)", () => {
    expect(readLimits({ DAILY_CHAT_BUDGET: 0 }).dailyChatBudget).toBe(0);
  });

  it("sizes the chat body limit for a maximal message of 6-byte JSON escapes", () => {
    expect(chatBodyByteLimit(readLimits(env))).toBe(MAX_MESSAGE_CHARS * 6 + 1024);
  });
});

describe("clientKey", () => {
  it.each([
    ["203.0.113.7", "ip4:203.0.113.7"],
    [" 203.0.113.7 ", "ip4:203.0.113.7"],
    ["2001:db8:1:2:3:4:5:6", "ip6:2001:db8:1:2::/64"],
    ["2001:DB8:1:2::9", "ip6:2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "ip6:2001:db8:1:2::/64"],
    ["2001:db8:1:3::1", "ip6:2001:db8:1:3::/64"],
    ["2001:db8::", "ip6:2001:db8:0:0::/64"],
    ["::1", "ip6:0:0:0:0::/64"],
    ["fe80::1%eth0", "ip6:fe80:0:0:0::/64"],
    ["::ffff:203.0.113.7", "ip4:203.0.113.7"],
    ["::ffff:cb00:7107", "ip4:203.0.113.7"],
    ["1:2:3:4:5:6:1.2.3.4", "ip6:1:2:3:4::/64"],
  ])("%s -> %s", (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });

  it("keys a malformed IPv6 address by its full text", () => {
    expect(clientKey("1::2::3")).toBe("ip6:1::2::3");
    expect(clientKey("1:2:3:4:5:6:7:8:9")).toBe("ip6:1:2:3:4:5:6:7:8:9");
    expect(clientKey("12345::1")).toBe("ip6:12345::1");
    expect(clientKey("::ffff:1.2.3.400")).toBe("ip6:::ffff:1.2.3.400");
  });

  it("uses one shared key when there is no address", () => {
    expect(clientKey(null)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
  });
});

describe("selectHistory", () => {
  it("keeps the newest messages that fit in the character budget", () => {
    const messages = pairs(10, 1000); // 10,000 characters
    const selected = selectHistory(messages, 6000);
    expect(selected).toEqual(messages.slice(-6));
  });

  it("counts a message only if all of it fits", () => {
    const messages = pairs(4, 1000);
    expect(selectHistory(messages, 2999)).toEqual(messages.slice(-2));
    expect(selectHistory(messages, 3000)).toEqual(messages.slice(-2)); // the 3rd newest is an answer
    expect(selectHistory(messages, 4000)).toEqual(messages);
  });

  it("never starts with an answer", () => {
    const messages: StoredMessage[] = [
      { role: "user", content: "q".repeat(500) },
      { role: "assistant", content: "a".repeat(100) },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    expect(selectHistory(messages, 110)).toEqual(messages.slice(2));
  });

  it("returns nothing when the newest message alone is over the budget", () => {
    expect(selectHistory(pairs(2, 7000), 6000)).toEqual([]);
    expect(selectHistory(pairs(4, 10), 0)).toEqual([]);
  });

  it("looks at no more than the last 20 messages", () => {
    const messages = pairs(30, 1);
    expect(selectHistory(messages, 1_000_000)).toEqual(messages.slice(-20));
  });
});

describe("UTC day helpers", () => {
  it("utcDay is the UTC calendar date", () => {
    expect(utcDay(new Date("2026-10-05T23:59:59.999Z"))).toBe("2026-10-05");
    expect(utcDay(new Date("2026-10-06T00:00:00Z"))).toBe("2026-10-06");
  });

  it.each([
    ["2026-10-05T23:59:30Z", 30],
    ["2026-10-05T23:59:59.500Z", 1],
    ["2026-10-05T00:00:00Z", 86_400],
    ["2026-10-05T12:00:00Z", 43_200],
    ["2026-12-31T23:00:00Z", 3600],
  ])("secondsUntilUtcMidnight(%s) is %i", (iso, seconds) => {
    expect(secondsUntilUtcMidnight(new Date(iso))).toBe(seconds);
  });
});

describe("consumeDailyBudget", () => {
  const day = new Date("2026-10-05T12:00:00Z");

  it("accepts up to the budget, then refuses without counting further", async () => {
    expect(await consumeDailyBudget(env.DB, 2, day)).toBe(true);
    expect(await consumeDailyBudget(env.DB, 2, day)).toBe(true);
    expect(await consumeDailyBudget(env.DB, 2, day)).toBe(false);
    expect(await consumeDailyBudget(env.DB, 2, day)).toBe(false);
    const row = await env.DB.prepare("SELECT chat_requests FROM daily_usage WHERE day = '2026-10-05'").first();
    expect(row).toEqual({ chat_requests: 2 });
  });

  it("starts again on the next UTC day", async () => {
    expect(await consumeDailyBudget(env.DB, 1, day)).toBe(true);
    expect(await consumeDailyBudget(env.DB, 1, day)).toBe(false);
    expect(await consumeDailyBudget(env.DB, 1, new Date("2026-10-06T00:00:00Z"))).toBe(true);
  });

  it("lets exactly `budget` of many concurrent requests through", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeDailyBudget(env.DB, 5, day)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("with a budget of 0 refuses everything and writes nothing", async () => {
    expect(await consumeDailyBudget(env.DB, 0, day)).toBe(false);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_usage").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("per-IP rate limit on POST /api/session/:id/chat", () => {
  it("returns 429 with Retry-After and a problem body, before the Durable Object runs", async () => {
    vi.spyOn(env.CHAT_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    const ai = mockAiStream(["unused"]);

    const res = await postJson("/api/session/rl-429/chat", { message: "hi" });
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("access-control-expose-headers")).toBe("Retry-After");
    const body = await expectProblem(res, 429, "Too Many Requests");
    expect(body.detail).toBe("Too many chat requests from your network. Try again in 60 seconds.");

    expect(ai).not.toHaveBeenCalled();
    expect((await getState("rl-429")).messages).toEqual([]);
    expect(await usedToday()).toBe(0);
  });

  it("keys the limit on CF-Connecting-IP, and IPv6 on the /64", async () => {
    const limit = vi.spyOn(env.CHAT_RATE_LIMITER, "limit");
    const send = (ip: string) => postJson("/api/session/rl-key/chat", {}, { "CF-Connecting-IP": ip });

    await send("203.0.113.7");
    await send("2001:db8:aa:bb::1");
    await send("2001:db8:aa:bb:ffff::2");
    expect(limit.mock.calls.map(([options]) => options)).toEqual([
      { key: "ip4:203.0.113.7" },
      { key: "ip6:2001:db8:aa:bb::/64" },
      { key: "ip6:2001:db8:aa:bb::/64" },
    ]);
  });

  it("with the local rate-limit binding, blocks one address and not another", async () => {
    // Bodies are invalid, so each allowed request stops at validation (400)
    // without calling the model. Windows are fixed, so a run that crosses a
    // window boundary can see up to twice the limit before a 429.
    const send = (ip: string) => postJson("/api/session/rl-real/chat", {}, { "CF-Connecting-IP": ip });
    const statuses: number[] = [];
    for (let i = 0; i < 2 * PER_IP_LIMIT + 1 && !statuses.includes(429); i++) {
      statuses.push((await send("198.51.100.20")).status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s === 400)).toBe(true);
    expect(statuses.length).toBeGreaterThan(PER_IP_LIMIT);

    expect((await send("198.51.100.21")).status).toBe(400);
  });

  it("applies only to chat", async () => {
    vi.spyOn(env.CHAT_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    expect((await initSession("rl-only", "NQ", "1H")).status).toBe(200);
    expect((await api("/api/session/rl-only/state")).status).toBe(200);
    expect((await api("/api/session/rl-only/clear", { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/tickers")).status).toBe(200);
    expect((await api("/api/history/NQ")).status).toBe(200);
    expect((await postJson("/api/session/rl-only/chat", { message: "hi" })).status).toBe(429);
  });
});

describe("daily chat budget", () => {
  it("refuses chat with 429 once today's budget is used, until 00:00 UTC", async () => {
    await setUsedToday(BUDGET);
    const ai = mockAiStream(["unused"]);

    const before = secondsUntilUtcMidnight(new Date());
    const res = await postJson("/api/session/budget-full/chat", { message: "hi" });
    const after = secondsUntilUtcMidnight(new Date());

    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeLessThanOrEqual(before);
    expect(retryAfter).toBeGreaterThanOrEqual(after);
    const body = await expectProblem(res, 429, "Too Many Requests");
    expect(body.detail).toBe(
      `The demo has reached its limit of ${BUDGET} chat requests for today. It resets at 00:00 UTC.`,
    );
    expect(ai).not.toHaveBeenCalled();
    expect(await usedToday()).toBe(BUDGET);
  });

  it("accepts the last request in the budget, then refuses the next", async () => {
    await setUsedToday(BUDGET - 1);
    mockAiStream(["ok"]);
    const { res } = await chat("budget-last", "hi");
    expect(res.status).toBe(200);
    expect(await usedToday()).toBe(BUDGET);

    expect((await postJson("/api/session/budget-last/chat", { message: "again" })).status).toBe(429);
  });

  it("counts each accepted chat request once", async () => {
    mockAiStream(["ok"]);
    await chat("budget-count", "one");
    await chat("budget-count", "two");
    expect(await usedToday()).toBe(2);
  });

  it("does not count rejected requests", async () => {
    const ai = mockAiStream(["unused"]);
    await postJson("/api/session/budget-free/chat", {});
    await postJson("/api/session/budget-free/chat", { message: "x".repeat(MAX_MESSAGE_CHARS + 1) });
    vi.spyOn(env.CHAT_RATE_LIMITER, "limit").mockResolvedValue({ success: false });
    await postJson("/api/session/budget-free/chat", { message: "hi" });
    expect(ai).not.toHaveBeenCalled();
    expect(await usedToday()).toBe(0);
  });

  it("with DAILY_CHAT_BUDGET = 0, chat returns 503", async () => {
    await setSessionVars("budget-off", { DAILY_CHAT_BUDGET: 0 });
    const ai = mockAiStream(["unused"]);
    const body = await expectProblem(
      await postJson("/api/session/budget-off/chat", { message: "hi" }),
      503,
      "Service Unavailable",
    );
    expect(body.detail).toBe("Chat is turned off on this deployment.");
    expect(ai).not.toHaveBeenCalled();
  });
});

describe("input caps", () => {
  it("accepts a message of exactly MAX_MESSAGE_CHARS characters", async () => {
    const ai = mockAiStream(["ok"]);
    const { res } = await chat("cap-max", "m".repeat(MAX_MESSAGE_CHARS));
    expect(res.status).toBe(200);
    expect(aiInputs(ai).messages.at(-1)?.content).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it("accepts a maximal message of multi-byte characters", async () => {
    mockAiStream(["ok"]);
    const { res } = await chat("cap-utf8", "€".repeat(MAX_MESSAGE_CHARS));
    expect(res.status).toBe(200);
  });

  it("refuses a longer message with 413", async () => {
    const ai = mockAiStream(["unused"]);
    const res = await postJson("/api/session/cap-long/chat", { message: "m".repeat(MAX_MESSAGE_CHARS + 1) });
    const body = await expectProblem(res, 413, "Content Too Large");
    expect(body.detail).toBe(`Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
    expect(ai).not.toHaveBeenCalled();
    expect((await getState("cap-long")).messages).toEqual([]);
  });

  it("stops reading a chat body larger than the byte limit", async () => {
    const ai = mockAiStream(["unused"]);
    const padding = "p".repeat(chatBodyByteLimit(readLimits(env)));
    const res = await postJson("/api/session/cap-body/chat", { message: "hi", padding });
    await expectProblem(res, 413, "Content Too Large");
    expect(ai).not.toHaveBeenCalled();
  });

  it("refuses a body whose Content-Length is over the limit without reading it", async () => {
    const res = await api("/api/session/cap-length/init", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "100000" },
      body: JSON.stringify({ ticker: "NQ", timeframe: "4H", sessionId: "cap-length" }).padEnd(100_000),
    });
    await expectProblem(res, 413, "Content Too Large");
    expect((await getState("cap-length")).ticker).toBe("");
  });

  it("uses MAX_MESSAGE_CHARS from the environment", async () => {
    await setSessionVars("cap-var", { MAX_MESSAGE_CHARS: 10 });
    mockAiStream(["ok"]);
    expect((await postJson("/api/session/cap-var/chat", { message: "12345678901" })).status).toBe(413);
    const { res } = await chat("cap-var", "1234567890");
    expect(res.status).toBe(200);
  });

  it("sends at most MAX_HISTORY_CHARS characters of stored conversation", async () => {
    const stored = pairs(10, 1000);
    await seedMessages("cap-history", stored);
    const ai = mockAiStream(["ok"]);
    await chat("cap-history", "next");

    const sent = aiInputs(ai).messages.slice(1, -1);
    expect(sent).toEqual(stored.slice(-6));
    expect(sent.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
  });

  it("cuts saved questions in the context to 300 characters, like the answers", async () => {
    await insertAnalyses([
      { id: "long-q", ticker: "NQ", userQuery: "q".repeat(1000), aiResponse: "a", createdAt: 1 },
    ]);
    await initSession("cap-saved", "NQ", "1H");
    const ai = mockAiStream(["ok"]);
    await chat("cap-saved", "levels?");
    const system = aiInputs(ai).messages[0].content;
    expect(system).toContain(`Q: ${"q".repeat(300)}\nA: a...`);
    expect(system).not.toContain("q".repeat(301));
  });
});

describe("output cap", () => {
  it("passes MAX_OUTPUT_TOKENS from the environment as max_tokens", async () => {
    await setSessionVars("out-var", { MAX_OUTPUT_TOKENS: 64 });
    const ai = mockAiStream(["ok"]);
    await chat("out-var", "hi");
    expect(aiInputs(ai).max_tokens).toBe(64);
  });
});
