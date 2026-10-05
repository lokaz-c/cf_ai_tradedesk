import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  chat,
  clearD1,
  getState,
  initSession,
  mockAiStream,
  postJson,
  sseBody,
} from "./helpers";

interface AnalysisRow {
  session_id: string;
  ticker: string;
  timeframe: string;
  user_query: string;
  ai_response: string;
}

async function analysesFor(sessionId: string): Promise<AnalysisRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT session_id, ticker, timeframe, user_query, ai_response FROM analyses WHERE session_id = ? ORDER BY rowid",
  )
    .bind(sessionId)
    .all<AnalysisRow>();
  return results;
}

const TOKENS = ["Bias: ", "neutral", " while price holds the range."];
const REPLY = TOKENS.join("");

beforeEach(clearD1);

describe("POST /api/session/:id/chat", () => {
  it("streams the model output to the client unchanged as server-sent events", async () => {
    mockAiStream(TOKENS);
    const { res, body } = await chat("sse", "What is the bias?");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(body).toBe(sseBody(TOKENS));
  });

  it("returns the first event to the client before the model has finished", async () => {
    // The fake model emits one event, then holds the stream open until the test
    // sets `released`. All enqueues happen inside the Durable Object's own
    // pull() calls; the flag is plain memory, so no I/O crosses contexts.
    let released = false;
    vi.spyOn(env.AI, "run").mockImplementation((async () => {
      const enc = new TextEncoder();
      let pulls = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(enc.encode('data: {"response":"first"}\n\n'));
            return;
          }
          while (!released) await new Promise((r) => setTimeout(r, 5));
          controller.enqueue(enc.encode('data: {"response":" token"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      });
    }) as never);

    const res = await postJson("/api/session/early/chat", { message: "hi" });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"response":"first"}\n\n');
    // The model has not finished, so nothing has been persisted yet.
    expect((await getState("early")).messages).toEqual([]);

    released = true;
    while (!(await reader.read()).done) {
      // drain the rest of the response
    }
    await vi.waitFor(async () => {
      expect((await getState("early")).messages).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "first token" },
      ]);
    });
  });

  it("persists the reassembled reply to Durable Object storage and to D1", async () => {
    await initSession("persist", "gbp/usd", "4H");
    mockAiStream(TOKENS);
    await chat("persist", "Where is support?");

    expect((await getState("persist")).messages).toEqual([
      { role: "user", content: "Where is support?" },
      { role: "assistant", content: REPLY },
    ]);
    await vi.waitFor(async () => {
      expect(await analysesFor("persist")).toEqual([
        {
          session_id: "persist",
          ticker: "GBP/USD",
          timeframe: "4H",
          user_query: "Where is support?",
          ai_response: REPLY,
        },
      ]);
    });
  });

  it("without a ticker, persists to Durable Object storage only", async () => {
    mockAiStream(TOKENS);
    await chat("no-ticker", "General question");

    expect((await getState("no-ticker")).messages).toHaveLength(2);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM analyses").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("appends each exchange to the stored history in order", async () => {
    await initSession("order", "NQ", "1H");
    mockAiStream(["one"]);
    await chat("order", "q1");
    mockAiStream(["two"]);
    await chat("order", "q2");

    expect((await getState("order")).messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "one" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "two" },
    ]);
    await vi.waitFor(async () => {
      expect((await analysesFor("order")).map((r) => [r.user_query, r.ai_response])).toEqual([
        ["q1", "one"],
        ["q2", "two"],
      ]);
    });
  });
});

describe("DELETE /api/session/:id/clear", () => {
  it("empties the message history but keeps the ticker, timeframe and saved analyses", async () => {
    await initSession("clear", "ES", "D");
    mockAiStream(TOKENS);
    await chat("clear", "q");
    await vi.waitFor(async () => expect(await analysesFor("clear")).toHaveLength(1));

    const res = await api("/api/session/clear/clear", { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(await getState("clear")).toMatchObject({ ticker: "ES", timeframe: "D", messages: [] });
    expect(await analysesFor("clear")).toHaveLength(1);
  });
});
