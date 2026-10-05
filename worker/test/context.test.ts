import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MODEL,
  aiInputs,
  chat,
  clearD1,
  initSession,
  insertAnalyses,
  mockAiStream,
  sessionStub,
  type StoredMessage,
} from "./helpers";

// The worker keeps the last 20 stored messages and the 3 most recent
// same-ticker analyses, truncating each saved answer to 300 characters.
const MESSAGE_WINDOW = 20;
const ANALYSES_LIMIT = 3;
const ANSWER_CHARS = 300;

function history(n: number): StoredMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i + 1}`,
  }));
}

/** Writes a session straight into DO storage, before the object first loads it. */
async function seedSession(sessionId: string, ticker: string, messages: StoredMessage[]) {
  await runInDurableObject(sessionStub(sessionId), async (_instance, state) => {
    await state.storage.put("session", {
      sessionId,
      ticker,
      timeframe: "4H",
      messages,
      createdAt: Date.now(),
    });
  });
}

beforeEach(clearD1);

describe("message window", () => {
  it.each([0, 1, 19, 20, 21, 30])(
    "with %i stored messages, sends the last min(n, 20) and then the new message",
    async (n) => {
      const id = `window-${n}`;
      const stored = history(n);
      await seedSession(id, "", stored);
      const ai = mockAiStream(["ok"]);

      await chat(id, "new question");

      const { model, messages, stream, max_tokens } = aiInputs(ai);
      expect(model).toBe(MODEL);
      expect(stream).toBe(true);
      expect(max_tokens).toBe(1024);
      expect(messages[0].role).toBe("system");
      expect(messages.slice(1, -1)).toEqual(stored.slice(-MESSAGE_WINDOW));
      expect(messages).toHaveLength(1 + Math.min(n, MESSAGE_WINDOW) + 1);
      expect(messages.at(-1)).toEqual({ role: "user", content: "new question" });
    },
  );

  it("includes the previous exchange, persisted from the tee'd stream, in the next request", async () => {
    const ai = mockAiStream(["first ", "answer"]);
    await chat("follow-up", "first question");
    await chat("follow-up", "second question");

    expect(aiInputs(ai, 1).messages.slice(1)).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
  });
});

describe("system prompt", () => {
  it("without a ticker, has no session line and no past analyses", async () => {
    await insertAnalyses([
      { id: "a1", ticker: "NQ", userQuery: "q", aiResponse: "a", createdAt: 1000 },
    ]);
    const ai = mockAiStream(["ok"]);
    await chat("no-ticker", "hello");

    const system = aiInputs(ai).messages[0].content;
    expect(system).toContain("You are TradeDesk AI");
    expect(system).not.toContain("Current session context");
    expect(system).not.toContain("[PAST ANALYSES");
  });

  it("with a ticker but no saved analyses, adds only the session line", async () => {
    await initSession("ticker-only", "es", "D");
    const ai = mockAiStream(["ok"]);
    await chat("ticker-only", "hello");

    const system = aiInputs(ai).messages[0].content;
    expect(system.endsWith("\n\nCurrent session context: Analyzing ES on the D timeframe.")).toBe(
      true,
    );
  });

  it("appends the 3 most recent same-ticker analyses, newest first, answers cut to 300 chars", async () => {
    const long = (c: string) => c.repeat(ANSWER_CHARS + 100);
    await insertAnalyses([
      { id: "nq1", ticker: "NQ", userQuery: "q1", aiResponse: long("a"), createdAt: 1000 },
      { id: "nq2", ticker: "NQ", userQuery: "q2", aiResponse: long("b"), createdAt: 2000 },
      { id: "nq3", ticker: "NQ", userQuery: "q3", aiResponse: long("c"), createdAt: 3000 },
      { id: "nq4", ticker: "NQ", userQuery: "q4", aiResponse: "short", createdAt: 4000 },
      { id: "nq5", ticker: "NQ", userQuery: "q5", aiResponse: long("e"), createdAt: 5000 },
      // Newer, but a different ticker: must not be included.
      { id: "es1", ticker: "ES", userQuery: "es-q", aiResponse: "es-a", createdAt: 9000 },
    ]);
    await initSession("with-ticker", "nq", "15M");
    const ai = mockAiStream(["ok"]);
    await chat("with-ticker", "levels?");

    const system = aiInputs(ai).messages[0].content;
    const expectedSuffix =
      "\n\nCurrent session context: Analyzing NQ on the 15M timeframe." +
      "\n\n[PAST ANALYSES FOR NQ]\n" +
      [
        `Q: q5\nA: ${"e".repeat(ANSWER_CHARS)}...`,
        "Q: q4\nA: short...",
        `Q: q3\nA: ${"c".repeat(ANSWER_CHARS)}...`,
      ].join("\n---\n");
    expect(system.endsWith(expectedSuffix)).toBe(true);
    expect(system.match(/^Q: /gm)).toHaveLength(ANALYSES_LIMIT);
    expect(system).not.toContain("q1");
    expect(system).not.toContain("q2");
    expect(system).not.toContain("es-q");
  });

  it("reads analyses from D1 on every request rather than caching them", async () => {
    await initSession("fresh-reads", "DAX", "1H");
    const ai = mockAiStream(["ok"]);
    await chat("fresh-reads", "first");
    expect(aiInputs(ai, 0).messages[0].content).not.toContain("[PAST ANALYSES");

    // The first exchange was written to D1 in the background; add a newer row too.
    await insertAnalyses([
      {
        id: "dax-new",
        ticker: "DAX",
        userQuery: "inserted directly",
        aiResponse: "x",
        createdAt: Math.floor(Date.now() / 1000) + 60,
      },
    ]);
    await chat("fresh-reads", "second");

    const system = aiInputs(ai, 1).messages[0].content;
    expect(system).toContain("[PAST ANALYSES FOR DAX]\nQ: inserted directly\nA: x...");
    expect(system).toContain("Q: first\nA: ok...");
  });
});

