import { beforeEach, describe, expect, it } from "vitest";
import { api, clearD1, expectProblem, getState, initSession } from "./helpers";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

function expectCors(res: Response) {
  for (const [name, value] of Object.entries(CORS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
}

beforeEach(clearD1);

describe("CORS preflight", () => {
  it.each(["/api/tickers", "/api/history/NQ", "/api/session/s1/chat", "/anything"])(
    "OPTIONS %s returns 200 with an empty body and CORS headers",
    async (path) => {
      const res = await api(path, { method: "OPTIONS" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expectCors(res);
    },
  );
});

describe("Worker routes backed by D1", () => {
  it("GET /api/tickers returns 200 and an empty result set on an empty database", async () => {
    const res = await api("/api/tickers");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json<{ results: unknown[] }>()).results).toEqual([]);
  });

  it("GET /api/history/:ticker returns 200 and an empty result set for an unknown ticker", async () => {
    const res = await api("/api/history/NQ");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json<{ results: unknown[] }>()).results).toEqual([]);
  });

  it.each([
    ["POST", "/api/tickers"],
    ["DELETE", "/api/tickers"],
    ["POST", "/api/history/NQ"],
    ["DELETE", "/api/history/NQ"],
  ])("%s %s is not routed (404)", async (method, path) => {
    const res = await api(path, { method });
    expect(res.status).toBe(404);
  });
});

describe("unknown paths", () => {
  it.each(["/", "/api", "/api/unknown", "/api/history/", "/api/session/"])(
    "GET %s returns a problem-details 404 with CORS headers",
    async (path) => {
      const res = await api(path);
      expectCors(res);
      await expectProblem(res, 404, "Not Found");
    },
  );
});

describe("session routes forwarded to the TradeSession Durable Object", () => {
  it("GET /state returns the default state of a new session", async () => {
    const res = await api("/api/session/fresh/state");
    expect(res.status).toBe(200);
    expectCors(res);
    const state = await res.json<Record<string, unknown>>();
    expect(state).toMatchObject({ ticker: "", timeframe: "4H", messages: [] });
  });

  it("POST /init stores the upper-cased ticker and the timeframe", async () => {
    const res = await initSession("s-init", "xauusd", "1H");
    expect(res.status).toBe(200);
    expectCors(res);
    expect(await res.json()).toMatchObject({
      ok: true,
      session: { sessionId: "s-init", ticker: "XAUUSD", timeframe: "1H", messages: [] },
    });
    expect(await getState("s-init")).toMatchObject({ ticker: "XAUUSD", timeframe: "1H" });
  });

  it("DELETE /clear returns 200", async () => {
    const res = await api("/api/session/s-clear/clear", { method: "DELETE" });
    expect(res.status).toBe(200);
    expectCors(res);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("each session ID maps to its own Durable Object", async () => {
    await initSession("s-a", "NQ", "1H");
    expect((await getState("s-a")).ticker).toBe("NQ");
    expect((await getState("s-b")).ticker).toBe("");
  });

  it.each([
    ["POST", "/state"],
    ["DELETE", "/state"],
    ["GET", "/init"],
    ["GET", "/chat"],
    ["DELETE", "/chat"],
    ["GET", "/clear"],
    ["POST", "/clear"],
    ["GET", ""],
    ["GET", "/unknown"],
  ])("%s /api/session/:id%s is rejected by the Durable Object with 404", async (method, sub) => {
    const res = await api(`/api/session/s-methods${sub}`, { method });
    expectCors(res);
    await expectProblem(res, 404, "Not Found");
  });
});
