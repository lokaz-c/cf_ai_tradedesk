/**
 * cf_ai_tradedesk — Cloudflare AI Trading Research Assistant
 * Worker entry point + TradeSession Durable Object
 */

import { collectStreamedText } from "../../shared/sse";
import { badRequest, notFound, readJsonObject } from "./http";
import { isSessionId, parseChatBody, parseInitBody, parseTickerPath } from "./validation";

export interface Env {
  AI: Ai;
  DB: D1Database;
  TRADE_SESSION: DurableObjectNamespace;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface SessionState {
  sessionId: string;
  ticker: string;
  timeframe: string;
  messages: Message[];
  createdAt: number;
}

const SYSTEM_PROMPT = `You are TradeDesk AI, an expert trading research assistant with deep knowledge of:
- Technical analysis (price action, candlestick patterns, support/resistance, Fibonacci)
- Macro fundamentals (central bank policy, economic indicators, geopolitical risk)
- Multi-timeframe analysis and confluence setups
- Risk management (position sizing, stop placement, R:R ratios)
- Major markets: Forex (GBP/USD, EUR/USD, USD/JPY), Gold (XAU/USD), Indices (NQ, ES, DAX), Crypto

Your responses are structured, precise, and actionable. When analyzing a market:
1. State the current bias (bullish/bearish/neutral) with reasoning
2. Identify key levels (support, resistance, POI)
3. Describe a potential setup if one exists (entry, stop, target)
4. Note any macro catalysts or risk events to watch

Keep responses concise and trader-focused. Use terminology professionals use.
Never give financial advice — frame everything as analysis and education.
When you don't have real-time price data, say so and analyze based on the user's description.`;

// ─── Durable Object ────────────────────────────────────────────────────────────

export class TradeSession {
  private state: DurableObjectState;
  private env: Env;
  private sessionData: SessionState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async getSession(): Promise<SessionState> {
    if (!this.sessionData) {
      this.sessionData = await this.state.storage.get<SessionState>("session") ?? null;
    }
    if (!this.sessionData) {
      this.sessionData = {
        sessionId: this.state.id.toString(),
        ticker: "",
        timeframe: "4H",
        messages: [],
        createdAt: Date.now(),
      };
    }
    return this.sessionData;
  }

  private async saveSession(session: SessionState): Promise<void> {
    this.sessionData = session;
    await this.state.storage.put("session", session);
  }

  // CORS and the other response headers are added by the Worker router, which
  // is the only caller of this object.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // GET /state — return current session state
    if (request.method === "GET" && url.pathname === "/state") {
      const session = await this.getSession();
      return Response.json(session);
    }

    // POST /init — initialize or update session context
    if (request.method === "POST" && url.pathname === "/init") {
      const parsed = parseInitBody(await readJsonObject(request));
      if (!parsed.ok) return badRequest(parsed.detail);
      const session = await this.getSession();
      session.ticker = parsed.value.ticker;
      session.timeframe = parsed.value.timeframe;
      session.sessionId = parsed.value.sessionId;

      // Persist session to D1
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO sessions (id, ticker, timeframe, updated_at)
         VALUES (?, ?, ?, unixepoch())`
      ).bind(session.sessionId, session.ticker, session.timeframe).run();

      await this.saveSession(session);
      return Response.json({ ok: true, session });
    }

    // POST /chat — send message, get streaming AI response
    if (request.method === "POST" && url.pathname === "/chat") {
      const parsed = parseChatBody(await readJsonObject(request));
      if (!parsed.ok) return badRequest(parsed.detail);
      const body = parsed.value;
      const session = await this.getSession();

      // Build message history (keep last 20 for context window)
      const recentMessages = session.messages.slice(-20);

      // Fetch relevant past analyses from D1 for RAG
      let ragContext = "";
      if (session.ticker) {
        const pastAnalyses = await this.env.DB.prepare(
          `SELECT user_query, ai_response, created_at FROM analyses
           WHERE ticker = ? ORDER BY created_at DESC LIMIT 3`
        ).bind(session.ticker).all<{ user_query: string; ai_response: string; created_at: number }>();

        if (pastAnalyses.results.length > 0) {
          ragContext = "\n\n[PAST ANALYSES FOR " + session.ticker + "]\n" +
            pastAnalyses.results.map(a =>
              `Q: ${a.user_query}\nA: ${a.ai_response.slice(0, 300)}...`
            ).join("\n---\n");
        }
      }

      const systemWithContext = SYSTEM_PROMPT +
        (session.ticker ? `\n\nCurrent session context: Analyzing ${session.ticker} on the ${session.timeframe} timeframe.` : "") +
        ragContext;

      const messages: Message[] = [
        ...recentMessages,
        { role: "user", content: body.message }
      ];

      // Stream response from Workers AI
      const aiResponse = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          { role: "system", content: systemWithContext },
          ...messages
        ],
        stream: true,
        max_tokens: 1024,
      }) as ReadableStream;

      // Collect full response for storage (tee the stream)
      const [stream1, stream2] = aiResponse.tee();

      // Background: collect response and save to D1
      this.state.waitUntil((async () => {
        const fullResponse = await collectStreamedText(stream2);

        // Update session messages
        session.messages.push({ role: "user", content: body.message });
        session.messages.push({ role: "assistant", content: fullResponse });
        await this.saveSession(session);

        // Save analysis to D1
        if (session.ticker) {
          const analysisId = crypto.randomUUID();
          await this.env.DB.prepare(
            `INSERT INTO analyses (id, session_id, ticker, timeframe, user_query, ai_response)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(analysisId, session.sessionId, session.ticker, session.timeframe, body.message, fullResponse).run();
        }
      })());

      return new Response(stream1, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // DELETE /clear — clear conversation history
    if (request.method === "DELETE" && url.pathname === "/clear") {
      const session = await this.getSession();
      session.messages = [];
      await this.saveSession(session);
      return Response.json({ ok: true });
    }

    return notFound();
  }
}

// ─── Worker Router ─────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Headers on every response, including those from the Durable Object. */
const API_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  // Responses are JSON or SSE; never let a browser sniff them as HTML.
  "X-Content-Type-Options": "nosniff",
};

/** Copies a response with extra headers; the body (including a stream) passes through. */
function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null);
  }

  // Route: /api/session/:sessionId/*
  const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const subPath = sessionMatch[2] ?? "/";
    if (!isSessionId(sessionId)) {
      return badRequest("Invalid session ID: use 1-64 letters, digits, '-' or '_'.");
    }

    const doId = env.TRADE_SESSION.idFromName(sessionId);
    const stub = env.TRADE_SESSION.get(doId);

    const doUrl = new URL(request.url);
    doUrl.pathname = subPath;
    const doRequest = new Request(doUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    return stub.fetch(doRequest);
  }

  // Route: GET /api/history/:ticker — fetch past analyses for a ticker.
  // The front end URL-encodes the ticker, so "GBP/USD" arrives as "GBP%2FUSD".
  const historyMatch = url.pathname.match(/^\/api\/history\/(.+)$/);
  if (historyMatch && request.method === "GET") {
    const ticker = parseTickerPath(historyMatch[1]);
    if (!ticker) {
      return badRequest(
        "Invalid ticker: use 1-10 letters or digits, optionally followed by '/', '.' or '-' and 1-10 more (for example GBP/USD or NQ).",
      );
    }
    const results = await env.DB.prepare(
      `SELECT id, session_id, ticker, timeframe, user_query, ai_response, created_at
       FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT 20`
    ).bind(ticker).all();

    return Response.json(results);
  }

  // Route: GET /api/tickers — get all tickers with saved analyses
  if (url.pathname === "/api/tickers" && request.method === "GET") {
    const results = await env.DB.prepare(
      `SELECT ticker, COUNT(*) as count, MAX(created_at) as last_analysis
       FROM analyses GROUP BY ticker ORDER BY last_analysis DESC`
    ).all();
    return Response.json(results);
  }

  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withHeaders(await route(request, env), API_HEADERS);
  },
} satisfies ExportedHandler<Env>;
