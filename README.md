# TradeDesk

A chat assistant for trading research that runs entirely on Cloudflare: a Worker routes each chat session to its own Durable Object, Workers AI serves Llama 3.3 70B, replies stream to the browser as server-sent events, and every exchange is persisted to Durable Object storage and D1 without delaying the stream.

Built in April 2026 as the take-home for Cloudflare's software engineering internship. The brief asks for an LLM, a coordination layer, a chat input and persistent memory; `PROMPTS.md` lists the prompts used while building it, as the brief requires.

## Request path

```
browser (Pages, single-file Vite app)
  └─ POST /api/session/:id/chat ─► Worker ─► TradeSession Durable Object (one per session)
                                                ├─ load last 20 messages from DO storage
                                                ├─ SELECT 3 most recent analyses for the ticker from D1
                                                ├─ Workers AI: llama-3.3-70b-instruct-fp8-fast, streaming
                                                ├─ stream.tee(): one copy ─► SSE response to the browser
                                                └─ other copy ─► waitUntil(): reassemble the reply,
                                                                 append to DO storage, INSERT into D1
```

Why a Durable Object per session: the platform guarantees a single instance per ID, so conversation state is single-threaded and strongly consistent with no locking in application code. Why `tee()` + `waitUntil()`: the browser gets the first token as soon as the model produces it, and persistence runs after the response has been returned.

The "memory" is two things: the Durable Object keeps the last 20 messages of the session, and D1 stores every question/answer pair by ticker so a new session on the same instrument starts with the three most recent analyses prepended to the system prompt. That is a SQL query on recency, not vector search.

## What's in the repo

```
worker/src/index.ts       Worker router + TradeSession Durable Object (~270 lines)
worker/wrangler.toml      bindings: AI, TRADE_SESSION (DO, SQLite-backed), DB (D1)
migrations/0001_init.sql  sessions, analyses; indexes on ticker, session_id, created_at
frontend/index.html       chat UI: streaming render (marked), voice input (Web Speech API),
                          ticker/timeframe session context, quick-prompt chips, history sidebar, Ctrl+K clears
PROMPTS.md                system prompt and the build prompts
```

## Routes

| Method | Route | Handled by |
| --- | --- | --- |
| POST | `/api/session/:id/init` | DO — set ticker and timeframe for the session |
| POST | `/api/session/:id/chat` | DO — stream a reply (SSE), persist it in the background |
| GET | `/api/session/:id/state` | DO — current session and message history |
| DELETE | `/api/session/:id/clear` | DO — reset the session |
| GET | `/api/history/:ticker` | Worker — saved analyses for a ticker (D1) |
| GET | `/api/tickers` | Worker — tickers with analysis counts (D1) |

## Run it

Requires Node 18+, a Cloudflare account and `wrangler` (`npm i -g wrangler`).

```bash
# worker
cd worker && npm install
wrangler d1 create tradedesk-db            # put the returned database_id in wrangler.toml
wrangler d1 execute tradedesk-db --file=../migrations/0001_init.sql
wrangler deploy                            # note the workers.dev URL

# frontend
cd ../frontend && npm install
echo "VITE_WORKER_URL=https://<your-worker>.workers.dev" > .env
npm run build && wrangler pages deploy dist --project-name cf-ai-tradedesk
```

Local development: `wrangler dev` in `worker/` and `npm run dev` in `frontend/` (the Vite dev server proxies `/api` to `localhost:8787`).

## Limits

- No authentication; session IDs are generated client-side, and anyone with an ID can read that session.
- The model gets no market data. It reasons from the prompt and prior analyses only, so treat output as a writing aid, not a signal.
- One D1 migration; the schema has not needed a second.
- No tests yet.
