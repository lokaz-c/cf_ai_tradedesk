import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { api, clearD1, expectProblem, initSession, insertAnalyses, type AnalysisFixture } from "./helpers";

interface HistoryRow {
  id: string;
  session_id: string;
  ticker: string;
  timeframe: string;
  user_query: string;
  ai_response: string;
  created_at: number;
}

beforeEach(clearD1);

describe("schema from migrations/0001_init.sql", () => {
  it("creates the sessions and analyses tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'analyses') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["analyses", "sessions"]);
  });

  it("indexes analyses on ticker, session and recency", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'analyses' AND sql IS NOT NULL ORDER BY name",
    ).all<{ name: string; sql: string }>();
    expect(results.map((r) => [r.name, r.sql.replace(/\s+/g, " ")])).toEqual([
      ["idx_analyses_created", "CREATE INDEX idx_analyses_created ON analyses(created_at DESC)"],
      ["idx_analyses_session", "CREATE INDEX idx_analyses_session ON analyses(session_id)"],
      ["idx_analyses_ticker", "CREATE INDEX idx_analyses_ticker ON analyses(ticker)"],
    ]);
  });
});

describe("GET /api/history/:ticker", () => {
  it("returns at most 20 analyses for that ticker, newest first, with every column", async () => {
    const nq: AnalysisFixture[] = Array.from({ length: 25 }, (_, i) => ({
      id: `nq-${i + 1}`,
      sessionId: "s-history",
      ticker: "NQ",
      timeframe: "1H",
      userQuery: `question ${i + 1}`,
      aiResponse: `answer ${i + 1}`,
      createdAt: (i + 1) * 100,
    }));
    const es: AnalysisFixture[] = [1, 2, 3].map((i) => ({
      id: `es-${i}`,
      ticker: "ES",
      userQuery: "es",
      aiResponse: "es",
      createdAt: 10_000 + i,
    }));
    // Insert in a scrambled order so the result order has to come from ORDER BY.
    await insertAnalyses([
      ...nq.filter((_, i) => i % 2 === 1),
      ...es,
      ...nq.filter((_, i) => i % 2 === 0).reverse(),
    ]);

    const res = await api("/api/history/NQ");
    expect(res.status).toBe(200);
    const { results } = await res.json<{ results: HistoryRow[] }>();

    expect(results).toHaveLength(20);
    expect(results.map((r) => r.created_at)).toEqual(
      Array.from({ length: 20 }, (_, i) => (25 - i) * 100),
    );
    expect(new Set(results.map((r) => r.ticker))).toEqual(new Set(["NQ"]));
    expect(results[0]).toEqual({
      id: "nq-25",
      session_id: "s-history",
      ticker: "NQ",
      timeframe: "1H",
      user_query: "question 25",
      ai_response: "answer 25",
      created_at: 2500,
    });
  });

  // The front end requests encodeURIComponent(ticker), and its default
  // instrument is GBP/USD, so the slash arrives as %2F.
  it.each([
    ["/api/history/GBP%2FUSD", "GBP/USD"],
    ["/api/history/GBP/USD", "GBP/USD"],
    ["/api/history/gbp%2Fusd", "GBP/USD"],
    ["/api/history/nq", "NQ"],
    ["/api/history/US30", "US30"],
  ])("GET %s returns the analyses saved under %s", async (path, ticker) => {
    await insertAnalyses([
      { id: "t1", ticker, userQuery: "q", aiResponse: "a", createdAt: 1 },
      { id: "other", ticker: "OTHER", userQuery: "q", aiResponse: "a", createdAt: 2 },
    ]);
    const res = await api(path);
    expect(res.status).toBe(200);
    const { results } = await res.json<{ results: HistoryRow[] }>();
    expect(results.map((r) => [r.id, r.ticker])).toEqual([["t1", ticker]]);
  });

  it("rejects a malformed percent-encoding with 400", async () => {
    const res = await api("/api/history/%E0%A4%A");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await expectProblem(res, 400, "Bad Request");
    expect(body.detail).toMatch(/^Invalid ticker/);
  });
});

describe("GET /api/tickers", () => {
  it("counts analyses per ticker and orders tickers by their latest analysis", async () => {
    await insertAnalyses([
      { id: "n1", ticker: "NQ", userQuery: "q", aiResponse: "a", createdAt: 1000 },
      { id: "n2", ticker: "NQ", userQuery: "q", aiResponse: "a", createdAt: 3000 },
      { id: "n3", ticker: "NQ", userQuery: "q", aiResponse: "a", createdAt: 2000 },
      { id: "e1", ticker: "ES", userQuery: "q", aiResponse: "a", createdAt: 5000 },
      { id: "e2", ticker: "ES", userQuery: "q", aiResponse: "a", createdAt: 500 },
      { id: "x1", ticker: "XAU/USD", userQuery: "q", aiResponse: "a", createdAt: 4000 },
    ]);

    const res = await api("/api/tickers");
    expect(res.status).toBe(200);
    expect((await res.json<{ results: unknown[] }>()).results).toEqual([
      { ticker: "ES", count: 2, last_analysis: 5000 },
      { ticker: "XAU/USD", count: 1, last_analysis: 4000 },
      { ticker: "NQ", count: 3, last_analysis: 3000 },
    ]);
  });
});

describe("sessions table", () => {
  it("POST /init upserts one row per session with the latest ticker and timeframe", async () => {
    await initSession("s-upsert", "nq", "1H");
    await initSession("s-upsert", "es", "D");

    const { results } = await env.DB.prepare(
      "SELECT id, ticker, timeframe, updated_at FROM sessions WHERE id = ?",
    )
      .bind("s-upsert")
      .all<{ id: string; ticker: string; timeframe: string; updated_at: number }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "s-upsert", ticker: "ES", timeframe: "D" });
    expect(results[0].updated_at).toBeGreaterThan(0);
  });

  it("re-initializing a session that already has analyses keeps them", async () => {
    await initSession("s-reinit", "NQ", "1H");
    await insertAnalyses([
      { id: "r1", sessionId: "s-reinit", ticker: "NQ", userQuery: "q", aiResponse: "a", createdAt: 1 },
    ]);

    const res = await initSession("s-reinit", "ES", "4H");
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM analyses WHERE session_id = ?")
      .bind("s-reinit")
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
