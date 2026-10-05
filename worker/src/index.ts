/**
 * cf_ai_tradedesk — Cloudflare AI Trading Research Assistant
 * Worker entry point + TradeSession Durable Object
 */

import { collectStreamedText } from "../../shared/sse";

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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /state — return current session state
    if (request.method === "GET" && url.pathname === "/state") {
      const session = await this.getSession();
      return Response.json(session, { headers: corsHeaders });
    }

    // POST /init — initialize or update session context
    if (request.method === "POST" && url.pathname === "/init") {
      const body = await request.json<{ ticker: string; timeframe: string; sessionId: string }>();
      const session = await this.getSession();
      session.ticker = body.ticker.toUpperCase();
      session.timeframe = body.timeframe;
      session.sessionId = body.sessionId;

      // Persist session to D1
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO sessions (id, ticker, timeframe, updated_at)
         VALUES (?, ?, ?, unixepoch())`
      ).bind(session.sessionId, session.ticker, session.timeframe).run();

      await this.saveSession(session);
      return Response.json({ ok: true, session }, { headers: corsHeaders });
    }

    // POST /chat — send message, get streaming AI response
    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await request.json<{ message: string }>();
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
          ...corsHeaders,
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
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
}

// ─── Worker Router ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Route: /api/session/:sessionId/*
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const subPath = sessionMatch[2] ?? "/";

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
      let ticker: string;
      try {
        ticker = decodeURIComponent(historyMatch[1]).toUpperCase();
      } catch {
        return Response.json({ error: "Invalid ticker" }, { status: 400, headers: corsHeaders });
      }
      const results = await env.DB.prepare(
        `SELECT id, session_id, ticker, timeframe, user_query, ai_response, created_at
         FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT 20`
      ).bind(ticker).all();

      return Response.json(results, { headers: corsHeaders });
    }

    // Route: GET /api/tickers — get all tickers with saved analyses
    if (url.pathname === "/api/tickers" && request.method === "GET") {
      const results = await env.DB.prepare(
        `SELECT ticker, COUNT(*) as count, MAX(created_at) as last_analysis
         FROM analyses GROUP BY ticker ORDER BY last_analysis DESC`
      ).all();
      return Response.json(results, { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
