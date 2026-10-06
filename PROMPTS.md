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

Rules for numbers:
- State a price, level, high, low, pivot or close only if it appears in a [MARKET DATA] block or a tool result in this conversation. Quote it as given; you may round it to two decimals. Never use prices from memory.
- If you have no data for what the user asks, write "no data" instead of a number.
- If a block is marked SYNTHETIC DEMO DATA, say once that the levels come from synthetic demo data and are not real market prices. Never describe them as current or real prices.
- If a block says market data is unavailable, or has no data for a ticker, say so plainly and do not guess.
- For a backtest, report only the numbers in the [BACKTEST] block, and say that quant's data is synthetic when the block says so. If the block says the backtest was not run, say why and give no results.
```

**Design rationale:** The structured 4-point format ensures consistent, scannable outputs. The original prompt ended with "When you don't have real-time price data, say so and analyze based on the user's description." That let the model fill in levels from its training data. The rules for numbers replaced it when the Worker started fetching levels from market-data: every level must come from a data block, and "no data" is the answer otherwise.

---

## 1b. Grounding prompts (Worker — `src/index.ts`, `src/tools.ts`)

Without `MARKET_DATA_URL`, this line follows the system prompt:

```
No market data source is connected to this deployment, so you have no price data for any instrument. Do not state price levels; explain the concepts and write "no data" where a level would go.
```

With `MARKET_DATA_URL` or `QUANT_API_URL`, the non-streamed tool rounds get the tool definitions (`get_levels` and `get_recent_bars` in `src/tools.ts`, `run_backtest` in `src/backtest.ts`) and guidance built from the tools on offer. With both configured it reads:

```
You have tools that fetch data. Before stating any level for a ticker, call get_levels; for recent price action, call get_recent_bars. Use the session's ticker unless the user names another one. To backtest a strategy on a symbol, call run_backtest once, with the strategy, symbol, dates and risk profile the user gave. If the question needs no data, answer without calling a tool.
```

Without market-data, the second sentence is replaced by `No market data source is connected, so you have no price levels: write "no data" where a level would go.`

The final, streamed call gets no tools. Its system prompt ends with the results as labelled blocks, for example:

```
[DATA FOR THIS ANSWER] The blocks below are the only market data you have for this answer.

[MARKET DATA get_levels S001] source: synthetic (SYNTHETIC DEMO DATA: generated prices, not real market prices)
Latest session {asOf}: close {close}
Floor pivots for the next session (from the {basedOn} session): P {p}, R1 {r1}, R2 {r2}, R3 {r3}, S1 {s1}, S2 {s2}, S3 {s3}
20-day range: high {high}, low {low}
50-day range: high {high}, low {low}
52-week range: high {high or "no data"}, low {low or "no data"}
```

A backtest becomes a block with the run's inputs, the data label and every metric as quant returned it:

```
[BACKTEST run_backtest AAPL] quant run {id}: Moving Average Crossover on AAPL, {start} to {end}, risk profile Conservative, initial capital 100000.
Data: SYNTHETIC. quant's dataset data/sample_data.csv: {quant's description} These are not real prices; say so.
Metrics exactly as quant returned them:
total_return (Total return, percent): {value}
...
Report only these numbers.
```

A failed call becomes a block such as `[MARKET DATA get_levels S999] NO DATA. Say "no data" for its levels. Reason: Unknown ticker: S999`, or `UNAVAILABLE. Say that market data is unavailable right now; do not state levels.` for a timeout or an outage. When no tool was called, the block is `[NO MARKET DATA RETRIEVED]` with an instruction not to state levels.

**Design rationale:** The model decides what to fetch, but the answer is written from text the Worker controls, in one format whatever tools ran. Saying "no data" and "unavailable" in the block itself gives the model the words to use instead of a guess.

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
