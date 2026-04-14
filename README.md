# cf_ai_tradedesk

> **AI-powered trading research assistant built entirely on Cloudflare's edge stack.**

A Bloomberg-terminal-inspired chat interface for real-time trading analysis — macro bias, key levels, setup identification, and risk management — powered by Llama 3.3 70B on Workers AI, with persistent memory via Durable Objects and D1.

**Live demo:** `https://cf-ai-tradedesk.pages.dev` *(deploy to get your URL)*

---

## Architecture

```
Browser (Pages)
    │
    ├── Chat UI (Vite + vanilla JS)
    └── Voice input (Web Speech API)
         │
         ▼
Cloudflare Worker (API router)
    │
    ├── /api/session/:id/*  ──→  Durable Object (TradeSession)
    │                                  ├── Conversation history (DO Storage)
    │                                  ├── Workers AI — Llama 3.3 70B streaming
    │                                  └── RAG: past analyses injected into context
    │
    ├── /api/history/:ticker  ──→  D1 (past analyses)
    └── /api/tickers          ──→  D1 (ticker summary)
```

### Components mapped to requirements

| Requirement | Implementation |
|---|---|
| **LLM** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI |
| **Workflow / coordination** | Durable Objects (`TradeSession`) — one DO per session, manages context window and routing |
| **User input** | Cloudflare Pages (chat UI) + Web Speech API (voice input) |
| **Memory / state** | DO Storage (conversation history) + D1 SQLite (persistent analyses per ticker with RAG retrieval) |

---

## Features

- **Streaming responses** — Llama 3.3 streams tokens directly to the browser
- **Session context** — Set your instrument (GBP/USD, XAU/USD, NQ, etc.) and timeframe; the AI tailors every response
- **RAG memory** — Past analyses for a ticker are retrieved from D1 and injected into the AI context window
- **Voice input** — Click the mic button and speak your query
- **History sidebar** — Browse all saved analyses grouped by ticker
- **Quick prompts** — One-click chips for common research queries
- **Ctrl+K** to clear the chat

---

## Getting Started

### Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- `wrangler` CLI: `npm install -g wrangler`

### 1. Clone and install

```bash
git clone https://github.com/yourusername/cf_ai_tradedesk
cd cf_ai_tradedesk
```

### 2. Deploy the Worker

```bash
cd worker
npm install

# Create D1 database
wrangler d1 create tradedesk-db

# Copy the database_id output into wrangler.toml → d1_databases[0].database_id

# Run migrations
wrangler d1 execute tradedesk-db --file=../migrations/0001_init.sql

# Deploy
wrangler deploy
```

Note the deployed Worker URL (e.g. `https://cf-ai-tradedesk.your-subdomain.workers.dev`).

### 3. Deploy the Frontend

```bash
cd ../frontend
npm install

# Set your worker URL
echo "VITE_WORKER_URL=https://cf-ai-tradedesk.your-subdomain.workers.dev" > .env

# Build
npm run build

# Deploy to Pages
wrangler pages deploy dist --project-name cf-ai-tradedesk
```

### Local development

```bash
# Terminal 1 — run worker
cd worker && wrangler dev

# Terminal 2 — run frontend (proxies /api to localhost:8787)
cd frontend && npm run dev
```

---

## Project Structure

```
cf_ai_tradedesk/
├── worker/
│   ├── src/
│   │   └── index.ts          # Worker entry + TradeSession Durable Object
│   ├── wrangler.toml
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── index.html            # Full chat UI (single file)
│   ├── vite.config.js
│   └── package.json
├── migrations/
│   └── 0001_init.sql         # D1 schema
├── README.md
└── PROMPTS.md
```

---

## How the AI works

1. **System prompt** establishes TradeDesk AI as an expert in TA, macro, and risk management
2. **Session context** injects the current ticker and timeframe into every request
3. **RAG layer** queries D1 for the 3 most recent analyses on the active ticker and prepends them to the system prompt — the model references past analysis without re-asking
4. **Durable Object** keeps the last 20 messages in memory for conversational continuity
5. **D1** durably stores every Q&A pair, enabling cross-session recall and the history sidebar

---

## Built with

- [Cloudflare Workers](https://workers.cloudflare.com/) — serverless edge compute
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) — stateful coordination
- [Workers AI](https://developers.cloudflare.com/workers-ai/) — Llama 3.3 70B inference
- [D1](https://developers.cloudflare.com/d1/) — edge SQLite database
- [Cloudflare Pages](https://pages.cloudflare.com/) — frontend hosting
- [Vite](https://vitejs.dev/) — frontend build
- [marked](https://marked.js.org/) — markdown rendering
