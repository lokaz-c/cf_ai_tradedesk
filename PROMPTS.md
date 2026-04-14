# PROMPTS.md

This file documents the AI prompts used in building `cf_ai_tradedesk`, as required by the Cloudflare internship assignment.

---

## 1. System Prompt (Worker — `src/index.ts`)

The core system prompt that establishes TradeDesk AI's persona and response structure:

```
You are TradeDesk AI, an expert trading research assistant with deep knowledge of:
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
When you don't have real-time price data, say so and analyze based on the user's description.
```

**Design rationale:** The structured 4-point format ensures consistent, scannable outputs. The disclaimer about real-time data is important for honesty — Llama 3.3 has a training cutoff and cannot see live prices.

---

## 2. Session Context Injection

Appended to the system prompt when a session is active:

```
Current session context: Analyzing {ticker} on the {timeframe} timeframe.
```

**Design rationale:** This primes the model to tailor all responses to the selected instrument and timeframe without requiring the user to repeat it every message.

---

## 3. RAG Context Injection

Appended to the system prompt when past analyses exist for the active ticker:

```
[PAST ANALYSES FOR {ticker}]
Q: {user_query}
A: {first 300 chars of ai_response}...
---
Q: {user_query}
A: {first 300 chars of ai_response}...
```

**Design rationale:** Injecting abbreviated past analyses gives the model continuity across sessions — it can reference "as discussed previously" context without requiring the full conversation history. Truncating to 300 chars per analysis keeps the context window manageable.

---

## 4. Claude.ai — Development Assistant

Claude.ai (claude-sonnet-4-20250514) was used as a coding assistant during development. Key prompts used:

**Architecture planning:**
```
I'm building a Cloudflare internship assignment. Requirements:
- LLM via Workers AI (Llama 3.3)
- Workflow/coordination via Durable Objects
- User input via Pages + voice
- Memory/state persistence

I want to build a trading research assistant. Design the full architecture
mapping each requirement to a Cloudflare primitive, with a Durable Object
that handles session state, streaming AI responses, and D1 for RAG memory.
```

**Durable Object streaming:**
```
Write a Cloudflare Durable Object in TypeScript that:
1. Stores conversation history in DO Storage (last 20 messages)
2. Streams responses from Workers AI Llama 3.3
3. Uses waitUntil() to save the full streamed response to D1 after streaming
4. Supports /init, /chat, /state, and /clear routes
```

**Frontend design:**
```
Build a single-file HTML trading chat interface with:
- Bloomberg terminal aesthetic — dark, monospace, data-dense
- Space Mono + Syne fonts
- Streaming SSE response rendering with marked.js
- Voice input via Web Speech API
- Sidebar with ticker history loaded from the API
- Quick prompt chips
- CSS variables for the full color system
```

**RAG query design:**
```
Design a simple RAG strategy for a trading assistant where:
- Analyses are stored in D1 with (ticker, user_query, ai_response, created_at)
- On each new query, retrieve the 3 most recent analyses for the active ticker
- Truncate each to 300 chars and prepend to the system prompt
Keep it simple — no embeddings, just recency-based retrieval
```

---

## 5. Quick Prompt Suggestions (UI)

The quick-prompt chips in the UI were chosen to cover the most common trader research needs:

- `"What is the current macro bias for this pair?"` — top-down analysis entry point
- `"Identify key support and resistance levels"` — level mapping
- `"Is there a high-probability setup forming right now?"` — actionable setup scan
- `"What risk events should I watch this week?"` — calendar awareness
- `"Analyze the trend structure on this timeframe"` — structural analysis
- `"What is the optimal position size for a 1% risk trade?"` — risk management

These were selected to demonstrate the breadth of the AI's capabilities in a single glance.
