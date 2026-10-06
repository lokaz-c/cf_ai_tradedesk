import { vi } from "vitest";

/**
 * A stub for outbound fetch() from the Worker and its Durable Objects, which
 * run in the same isolate as the tests. Routes are "METHOD URL" with `:name`
 * path parameters. A request no route matches throws, so no test can reach a
 * real service. The request's AbortSignal is honoured: a handler that never
 * resolves makes the fetch reject when the caller's timeout fires, as a slow
 * server would.
 *
 * Why not @msw/cloudflare, which the Workers Vitest docs suggest: with MSW 3
 * in this pool, every aborted request (the timeout tests) left an unhandled
 * rejection inside the interceptor, which fails the run.
 */
export type FetchHandler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: FetchHandler;
}

function compile(key: string, handler: FetchHandler): Route {
  const [method, url] = key.split(" ");
  const source = url
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_m, name: string) => `(?<${name}>[^/]+)`);
  return { method, pattern: new RegExp(`^${source}$`), handler };
}

/**
 * A request as the stub saw it. The body is read when the request is made:
 * a body created inside a Durable Object cannot be read from the test.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  json(): unknown;
}

export function mockFetch(routes: Record<string, FetchHandler>) {
  const compiled = Object.entries(routes).map(([key, handler]) => compile(key, handler));
  const requests: RecordedRequest[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const body = await request.clone().text();
    requests.push({
      method: request.method,
      url: request.url,
      headers: new Headers(request.headers),
      body,
      json: () => JSON.parse(body),
    });
    const url = new URL(request.url);
    const route = compiled.find(
      (r) => r.method === request.method && r.pattern.test(url.origin + url.pathname),
    );
    if (!route) throw new Error(`Unmocked fetch: ${request.method} ${request.url}`);
    const params = (url.origin + url.pathname).match(route.pattern)?.groups ?? {};
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw signal.reason;
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve()
        .then(() => route.handler(request, params))
        .then(resolve, reject);
    });
  });
  return { spy, requests };
}

/** A handler that never answers; the caller's timeout ends the request. */
export const hang: FetchHandler = () => new Promise<Response>(() => {});

/** A handler for a connection failure. */
export const networkError: FetchHandler = () => {
  throw new TypeError("Network connection lost.");
};

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function problemResponse(status: number, detail: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title: "Error", status, detail }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}
