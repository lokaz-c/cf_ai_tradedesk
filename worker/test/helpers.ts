import { env, exports } from "cloudflare:workers";
import { expect, vi } from "vitest";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SessionState {
  sessionId: string;
  ticker: string;
  timeframe: string;
  messages: StoredMessage[];
  createdAt: number;
}

/**
 * Asserts an RFC 9457 problem details response with the given status, and
 * returns its body.
 */
export async function expectProblem(res: Response, status: number, title: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  const body = await res.json<{ type: string; title: string; status: number; detail: string }>();
  expect(body).toMatchObject({ type: "about:blank", title, status });
  expect(typeof body.detail).toBe("string");
  return body;
}

/** The origin the tests send by default; it is in ALLOWED_ORIGINS in wrangler.toml. */
export const ORIGIN = "https://cf-ai-tradedesk.pages.dev";

/**
 * Sends a request through the Worker's default export (the real router), as
 * the deployed page would: with an allowed Origin unless the caller sets one.
 */
export function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Origin")) headers.set("Origin", ORIGIN);
  return rawApi(path, { ...init, headers });
}

/** Sends a request through the router exactly as given (no default headers). */
export function rawApi(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://tradedesk.test${path}`, init));
}

export function postJson(path: string, body: unknown): Promise<Response> {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Text-generation output in the shape Workers AI streams it:
 * one `data: {"response": "..."}` event per token, then `data: [DONE]`.
 */
export function sseBody(tokens: string[]): string {
  return (
    tokens.map((t) => `data: ${JSON.stringify({ response: t })}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

/** Splits text into raw byte chunks of `size` bytes (may cut UTF-8 sequences). */
export function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * Replaces env.AI.run with a fake that returns `tokens` as a Workers AI SSE
 * stream. `chunkSize` controls how the bytes are split across reads; by
 * default each event arrives in its own chunk.
 */
export function mockAiStream(tokens: string[], chunkSize?: number) {
  const body = sseBody(tokens);
  return vi.spyOn(env.AI, "run").mockImplementation((async () => {
    const chunks = chunkSize
      ? byteChunks(body, chunkSize)
      : body.split(/(?<=\n\n)/).map((e) => new TextEncoder().encode(e));
    return streamOf(chunks);
  }) as never);
}

/** The `inputs` argument of the n-th env.AI.run call. */
export function aiInputs(spy: ReturnType<typeof mockAiStream>, call = 0) {
  const [model, inputs] = spy.mock.calls[call] as unknown as [
    string,
    { messages: StoredMessage[]; stream: boolean; max_tokens: number },
  ];
  return { model, ...inputs };
}

export function sessionStub(sessionId: string) {
  return env.TRADE_SESSION.get(env.TRADE_SESSION.idFromName(sessionId));
}

export async function getState(sessionId: string): Promise<SessionState> {
  const res = await api(`/api/session/${sessionId}/state`);
  expect(res.status).toBe(200);
  return res.json();
}

export function initSession(sessionId: string, ticker: string, timeframe: string) {
  return postJson(`/api/session/${sessionId}/init`, { ticker, timeframe, sessionId });
}

/**
 * Sends a chat message, reads the whole SSE response, then waits until the
 * background persistence (the tee'd copy) has written the exchange to the
 * Durable Object, so no work from this test leaks into the next one.
 */
export async function chat(sessionId: string, message: string) {
  const before = (await getState(sessionId)).messages.length;
  const res = await postJson(`/api/session/${sessionId}/chat`, { message });
  const body = await res.text();
  await vi.waitFor(async () => {
    expect((await getState(sessionId)).messages.length).toBe(before + 2);
  });
  return { res, body };
}

export interface AnalysisFixture {
  id: string;
  sessionId?: string;
  ticker: string;
  timeframe?: string;
  userQuery: string;
  aiResponse: string;
  createdAt: number;
}

/** Inserts analyses (and their parent session rows) with explicit timestamps. */
export async function insertAnalyses(rows: AnalysisFixture[]) {
  const sessionIds = [...new Set(rows.map((r) => r.sessionId ?? "fixture-session"))];
  await env.DB.batch([
    ...sessionIds.map((id) =>
      env.DB.prepare("INSERT OR IGNORE INTO sessions (id) VALUES (?)").bind(id),
    ),
    ...rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO analyses (id, session_id, ticker, timeframe, user_query, ai_response, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        r.id,
        r.sessionId ?? "fixture-session",
        r.ticker,
        r.timeframe ?? "4H",
        r.userQuery,
        r.aiResponse,
        r.createdAt,
      ),
    ),
  ]);
}

export async function clearD1() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM analyses"),
    env.DB.prepare("DELETE FROM sessions"),
  ]);
}
