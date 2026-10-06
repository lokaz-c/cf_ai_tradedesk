/**
 * cf_ai_tradedesk — Cloudflare AI Trading Research Assistant
 * Worker entry point + TradeSession Durable Object
 */

import { collectStreamedText } from "../../shared/sse";
import {
  badRequest,
  BodyTooLargeError,
  contentTooLarge,
  corsHeaders,
  notFound,
  parseOrigins,
  problem,
  readJsonObject,
} from "./http";
import {
  chatBodyByteLimit,
  clientKey,
  consumeDailyBudget,
  readLimits,
  secondsUntilUtcMidnight,
  selectHistory,
  type LimitVars,
} from "./limits";
import { CONTEXT_SQL, HISTORY_SQL, TICKERS_SQL } from "./queries";
import { streamWithTrailer } from "./stream";
import {
  buildToolset,
  dataBlock,
  groundAnswer,
  readMaxToolRounds,
  runToolRounds,
  type GroundingMeta,
  type ToolOutcome,
  type ToolVars,
} from "./tools";
import {
  INVALID_TICKER,
  isSessionId,
  parseChatBody,
  parseInitBody,
  parseTickerPath,
} from "./validation";

export interface Env extends LimitVars, ToolVars {
  /** Comma-separated browser origins allowed to call the API. */
  ALLOWED_ORIGINS?: string;
  AI: Ai;
  DB: D1Database;
  TRADE_SESSION: DurableObjectNamespace;
  /** Per-IP limit on chat requests ([[ratelimits]] in wrangler.toml). */
  CHAT_RATE_LIMITER: RateLimit;
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Saved questions and answers added to the context are cut to this many characters. */
const SAVED_TEXT_CHARS = 300;

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

Rules for numbers:
- State a price, level, high, low, pivot or close only if it appears in a [MARKET DATA] block or a tool result in this conversation. Quote it as given; you may round it to two decimals. Never use prices from memory.
- If you have no data for what the user asks, write "no data" instead of a number.
- If a block is marked SYNTHETIC DEMO DATA, say once that the levels come from synthetic demo data and are not real market prices. Never describe them as current or real prices.
- If a block says market data is unavailable, or has no data for a ticker, say so plainly and do not guess.`;

/** Added to the system prompt when no market data service is configured. */
const NO_DATA_SOURCE = `No market data source is connected to this deployment, so you have no price data for any instrument. Do not state price levels; explain the concepts and write "no data" where a level would go.`;

/** Added to the system prompt of the tool rounds. */
const TOOL_GUIDANCE = `You have tools that fetch market data. Before stating any level for a ticker, call get_levels; for recent price action, call get_recent_bars. Use the session's ticker unless the user names another one. If the question needs no market data, answer without calling a tool.`;

/**
 * Logs answers with price-like numbers that match no provided value. The
 * count is also stored with the analysis (analyses.grounding).
 */
function logUnverified(session: SessionState, meta: GroundingMeta): void {
  if (meta.unverified.length === 0) return;
  console.warn(
    JSON.stringify({
      event: "unverified_numbers",
      sessionId: session.sessionId,
      ticker: session.ticker,
      count: meta.unverified.length,
      values: meta.unverified.map((u) => u.text),
    }),
  );
}

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
      let body: Record<string, unknown> | null;
      try {
        body = await readJsonObject(request);
      } catch (e) {
        if (e instanceof BodyTooLargeError) return contentTooLarge("The request body is too large.");
        throw e;
      }
      const parsed = parseInitBody(body);
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

    // POST /chat — send message, get streaming AI response.
    // The router has already applied the per-IP rate limit.
    if (request.method === "POST" && url.pathname === "/chat") {
      const limits = readLimits(this.env);
      let raw: Record<string, unknown> | null;
      try {
        raw = await readJsonObject(request, chatBodyByteLimit(limits));
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          return contentTooLarge(`Messages are limited to ${limits.maxMessageChars} characters.`);
        }
        throw e;
      }
      const parsed = parseChatBody(raw, limits.maxMessageChars);
      if (!parsed.ok) {
        return parsed.status === 413 ? contentTooLarge(parsed.detail) : badRequest(parsed.detail);
      }
      const body = parsed.value;

      // Only valid requests count against the daily budget.
      if (limits.dailyChatBudget === 0) {
        return problem(503, "Service Unavailable", "Chat is turned off on this deployment.");
      }
      const now = new Date();
      if (!(await consumeDailyBudget(this.env.DB, limits.dailyChatBudget, now))) {
        const retryAfter = secondsUntilUtcMidnight(now);
        return problem(
          429,
          "Too Many Requests",
          `The demo has reached its limit of ${limits.dailyChatBudget} chat requests for today. It resets at 00:00 UTC.`,
          { "Retry-After": String(retryAfter) },
        );
      }

      const session = await this.getSession();

      // The newest stored messages: at most 20, and at most maxHistoryChars characters.
      const recentMessages = selectHistory(session.messages, limits.maxHistoryChars);

      // Fetch relevant past analyses from D1 for RAG
      let ragContext = "";
      if (session.ticker) {
        const pastAnalyses = await this.env.DB.prepare(CONTEXT_SQL).bind(session.ticker).all<{ user_query: string; ai_response: string; created_at: number }>();

        if (pastAnalyses.results.length > 0) {
          ragContext = "\n\n[PAST ANALYSES FOR " + session.ticker + "]\n" +
            pastAnalyses.results.map(a =>
              `Q: ${a.user_query.slice(0, SAVED_TEXT_CHARS)}\nA: ${a.ai_response.slice(0, SAVED_TEXT_CHARS)}...`
            ).join("\n---\n");
        }
      }

      const sessionContext =
        (session.ticker ? `\n\nCurrent session context: Analyzing ${session.ticker} on the ${session.timeframe} timeframe.` : "") +
        ragContext;

      const messages: Message[] = [
        ...recentMessages,
        { role: "user", content: body.message }
      ];

      const toolset = buildToolset(this.env);
      let outcomes: ToolOutcome[] = [];
      let finalSystem: string;
      if (toolset) {
        // Non-streamed tool rounds first: the model picks what to fetch and the
        // Worker fetches it. The streamed answer is then written from a data
        // block built from the results, with no tools offered.
        outcomes = await runToolRounds(
          this.env.AI,
          MODEL,
          [{ role: "system", content: `${SYSTEM_PROMPT}\n\n${TOOL_GUIDANCE}${sessionContext}` }, ...messages],
          toolset,
          readMaxToolRounds(this.env),
        );
        finalSystem = `${SYSTEM_PROMPT}${sessionContext}\n\n${dataBlock(outcomes)}`;
      } else {
        finalSystem = `${SYSTEM_PROMPT}\n\n${NO_DATA_SOURCE}${sessionContext}`;
      }

      // Stream response from Workers AI
      const aiResponse = await this.env.AI.run(MODEL, {
        messages: [
          { role: "system", content: finalSystem },
          ...messages
        ],
        stream: true,
        max_tokens: limits.maxOutputTokens,
      }) as ReadableStream;

      // One copy goes to the client; the other is read in the background and saved.
      const [stream1, stream2] = aiResponse.tee();

      // Background: collect the reply, run the post-check, and save both.
      this.state.waitUntil((async () => {
        const reply = await collectStreamedText(stream2);
        const { notes, meta } = groundAnswer(reply, outcomes, body.message);
        // With a data service configured, the client receives the data notes
        // as part of the answer, so the saved copy includes them too.
        const fullResponse = toolset ? reply + notes : reply;
        logUnverified(session, meta);

        // Update session messages
        session.messages.push({ role: "user", content: body.message });
        session.messages.push({ role: "assistant", content: fullResponse });
        await this.saveSession(session);

        // Save analysis to D1
        if (session.ticker) {
          const analysisId = crypto.randomUUID();
          await this.env.DB.prepare(
            `INSERT INTO analyses (id, session_id, ticker, timeframe, user_query, ai_response, grounding)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(analysisId, session.sessionId, session.ticker, session.timeframe, body.message, fullResponse, JSON.stringify(meta)).run();
        }
      })());

      // Without a data service the model's stream goes out unchanged. With
      // one, the Worker re-emits it and adds the data notes and the report.
      const clientStream = toolset
        ? streamWithTrailer(stream1, (reply) => groundAnswer(reply, outcomes, body.message))
        : stream1;
      return new Response(clientStream, {
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

/** Headers on every response, including those from the Durable Object. */
const BASE_HEADERS: Record<string, string> = {
  // Responses are JSON or SSE; never let a browser sniff them as HTML.
  "X-Content-Type-Options": "nosniff",
  // CORS headers depend on the request's Origin.
  Vary: "Origin",
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

    // Per-IP limit on the route that calls the model, checked before the
    // Durable Object is involved. CF-Connecting-IP is set by Cloudflare.
    if (request.method === "POST" && subPath === "/chat") {
      const key = clientKey(request.headers.get("CF-Connecting-IP"));
      const { success } = await env.CHAT_RATE_LIMITER.limit({ key });
      if (!success) {
        const period = readLimits(env).rateLimitPeriodSeconds;
        return problem(
          429,
          "Too Many Requests",
          `Too many chat requests from your network. Try again in ${period} seconds.`,
          { "Retry-After": String(period) },
        );
      }
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
    if (!ticker) return badRequest(INVALID_TICKER);
    const results = await env.DB.prepare(HISTORY_SQL).bind(ticker).all();

    return Response.json(results);
  }

  // Route: GET /api/tickers — get all tickers with saved analyses
  if (url.pathname === "/api/tickers" && request.method === "GET") {
    const results = await env.DB.prepare(TICKERS_SQL).all();
    return Response.json(results);
  }

  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Browsers send Origin on cross-origin requests. Only origins in
    // ALLOWED_ORIGINS get CORS headers; a browser request from any other
    // origin is refused before it reaches a route. Requests without Origin
    // (curl, server-side code) are not affected: CORS is a browser control,
    // not access control.
    const origin = request.headers.get("Origin");
    let headers = BASE_HEADERS;
    if (origin !== null) {
      const cors = corsHeaders(origin, parseOrigins(env.ALLOWED_ORIGINS));
      if (!cors) {
        return withHeaders(
          problem(403, "Forbidden", "This origin is not allowed to call the API."),
          BASE_HEADERS,
        );
      }
      headers = { ...BASE_HEADERS, ...cors };
    }
    return withHeaders(await route(request, env), headers);
  },
} satisfies ExportedHandler<Env>;
