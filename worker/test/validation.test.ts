import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  clearD1,
  expectProblem,
  getState,
  initSession,
  insertAnalyses,
  mockAiStream,
  postJson,
} from "./helpers";
import { parseTicker, parseTickerPath, TIMEFRAMES } from "../src/validation";

const XSS = '<img src=x onerror="alert(1)">';

beforeEach(clearD1);

describe("parseTicker", () => {
  it.each([
    ["GBP/USD", "GBP/USD"],
    ["gbp/usd", "GBP/USD"],
    [" xau/usd ", "XAU/USD"],
    ["NQ", "NQ"],
    ["US30", "US30"],
    ["BRK.B", "BRK.B"],
    ["btc-usd", "BTC-USD"],
    ["ABCDEFGHIJ/KLMNOPQRST", "ABCDEFGHIJ/KLMNOPQRST"],
  ])("accepts %j as %s", (input, expected) => {
    expect(parseTicker(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "GBP USD",
    "GBP/USD/EUR",
    "GBP//USD",
    "/USD",
    "GBP/",
    "ABCDEFGHIJK",
    "NQ1!",
    "ES=F",
    "^GSPC",
    "GBP%2FUSD",
    "'; DROP TABLE analyses; --",
    XSS,
    "N\nQ",
    "NÉQ",
  ])("rejects %j", (input) => {
    expect(parseTicker(input)).toBeNull();
  });

  it.each([123, null, undefined, ["NQ"], { ticker: "NQ" }])("rejects the non-string %j", (input) => {
    expect(parseTicker(input)).toBeNull();
  });
});

describe("parseTickerPath", () => {
  it.each([
    ["GBP%2FUSD", "GBP/USD"],
    ["gbp%2fusd", "GBP/USD"],
    ["GBP/USD", "GBP/USD"],
    ["NQ", "NQ"],
    ["BRK.B", "BRK.B"],
  ])("decodes %s to %s", (segment, expected) => {
    expect(parseTickerPath(segment)).toBe(expected);
  });

  it.each(["GBP%252FUSD", "%E0%A4%A", "GBP%20USD", encodeURIComponent(XSS), "%3Cscript%3E"])(
    "rejects %s",
    (segment) => {
      expect(parseTickerPath(segment)).toBeNull();
    },
  );
});

describe("POST /api/session/:id/init validation", () => {
  it("rejects a ticker containing HTML with 400 and stores nothing", async () => {
    const res = await initSession("v-xss", XSS, "4H");
    const body = await expectProblem(res, 400, "Bad Request");
    expect(body.detail).toMatch(/^Invalid ticker/);

    expect((await getState("v-xss")).ticker).toBe("");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("keeps the previous ticker when a later init is rejected", async () => {
    expect((await initSession("v-keep", "NQ", "1H")).status).toBe(200);
    expect((await initSession("v-keep", "N Q", "1H")).status).toBe(400);
    expect(await getState("v-keep")).toMatchObject({ ticker: "NQ", timeframe: "1H" });
  });

  it.each(TIMEFRAMES)("accepts the timeframe %s", async (timeframe) => {
    expect((await initSession(`v-tf-${timeframe}`, "NQ", timeframe)).status).toBe(200);
  });

  it.each(["4h", "2H", "", XSS])("rejects the timeframe %j", async (timeframe) => {
    const body = await expectProblem(await initSession("v-tf", "NQ", timeframe), 400, "Bad Request");
    expect(body.detail).toMatch(/^Invalid timeframe/);
  });

  it.each([XSS, "", "a".repeat(65), 42])("rejects the body sessionId %j", async (sessionId) => {
    const res = await postJson("/api/session/v-sid/init", { ticker: "NQ", timeframe: "4H", sessionId });
    const body = await expectProblem(res, 400, "Bad Request");
    expect(body.detail).toMatch(/^Invalid sessionId/);
  });

  it.each([
    ["invalid JSON", "{"],
    ["an empty body", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a missing ticker", JSON.stringify({ timeframe: "4H", sessionId: "v-body" })],
  ])("rejects %s with 400", async (_label, raw) => {
    const res = await api("/api/session/v-body/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    await expectProblem(res, 400, "Bad Request");
  });
});

describe("POST /api/session/:id/chat validation", () => {
  it.each([
    ["invalid JSON", "{"],
    ["an empty body", ""],
    ["a missing message", "{}"],
    ["an empty message", JSON.stringify({ message: "   " })],
    ["a non-string message", JSON.stringify({ message: 42 })],
  ])("rejects %s with 400 without calling the model", async (_label, raw) => {
    const ai = mockAiStream(["unused"]);
    const res = await api("/api/session/v-chat/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    await expectProblem(res, 400, "Bad Request");
    expect(ai).not.toHaveBeenCalled();
    expect((await getState("v-chat")).messages).toEqual([]);
  });
});

describe("session IDs in the path", () => {
  it.each(["%3Cimg%3E", "a".repeat(65), "has.dot", "%20"])(
    "rejects /api/session/%s/state with 400",
    async (id) => {
      const spy = vi.spyOn(env.TRADE_SESSION, "idFromName");
      const res = await api(`/api/session/${id}/state`);
      const body = await expectProblem(res, 400, "Bad Request");
      expect(body.detail).toMatch(/^Invalid session ID/);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("accepts the UUIDs the front end generates", async () => {
    const res = await api(`/api/session/${crypto.randomUUID()}/state`);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/history/:ticker validation", () => {
  it.each([encodeURIComponent(XSS), "GBP%252FUSD", "GBP%20USD", "NQ1!"])(
    "rejects %s with 400",
    async (segment) => {
      const body = await expectProblem(await api(`/api/history/${segment}`), 400, "Bad Request");
      expect(body.detail).toMatch(/^Invalid ticker/);
    },
  );
});

describe("stored HTML comes back as JSON data, never as a page", () => {
  // Rows written before tickers were validated, or a question or reply that
  // contains markup: the API returns them as JSON strings, unchanged, with
  // nosniff. Escaping them on screen is the front end's job (frontend/test).
  it("serves /api/tickers and /api/history as JSON with nosniff", async () => {
    await insertAnalyses([
      { id: "x1", ticker: XSS, userQuery: XSS, aiResponse: `**ok** ${XSS}`, createdAt: 1 },
      { id: "x2", ticker: "NQ", userQuery: XSS, aiResponse: `<script>alert(1)</script>`, createdAt: 2 },
    ]);

    const tickers = await api("/api/tickers");
    expect(tickers.headers.get("content-type")).toBe("application/json");
    expect(tickers.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await tickers.json<{ results: { ticker: string }[] }>()).results.map((r) => r.ticker)).toEqual([
      "NQ",
      XSS,
    ]);

    const history = await api("/api/history/NQ");
    expect(history.headers.get("content-type")).toBe("application/json");
    expect(history.headers.get("x-content-type-options")).toBe("nosniff");
    const [row] = (await history.json<{ results: { user_query: string; ai_response: string }[] }>()).results;
    expect(row).toMatchObject({ user_query: XSS, ai_response: "<script>alert(1)</script>" });
  });

  it("sends nosniff on Durable Object responses too", async () => {
    const res = await api("/api/session/v-headers/state");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
