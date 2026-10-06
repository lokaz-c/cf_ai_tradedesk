/**
 * An RFC 9457 problem details response (`application/problem+json`). `type` is
 * left as "about:blank", so `title` is the HTTP status phrase and `detail`
 * explains this occurrence.
 */
export function problem(
  status: number,
  title: string,
  detail: string,
  headers?: HeadersInit,
): Response {
  const res = Response.json({ type: "about:blank", title, status, detail }, { status, headers });
  res.headers.set("Content-Type", "application/problem+json");
  return res;
}

export const badRequest = (detail: string) => problem(400, "Bad Request", detail);
export const notFound = (detail = "No route matches this method and path.") =>
  problem(404, "Not Found", detail);
export const contentTooLarge = (detail: string) => problem(413, "Content Too Large", detail);

/** Thrown by readJsonObject when the body is longer than its byte limit. */
export class BodyTooLargeError extends Error {}

/** Default byte limit for JSON request bodies. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

/** Reads a request body as UTF-8 text, giving up once it exceeds `maxBytes`. */
async function readText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Parses a JSON request body that must be an object. Returns null for an
 * empty body, invalid JSON, or any other JSON value; throws BodyTooLargeError
 * if the body is longer than `maxBytes`.
 */
export async function readJsonObject(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  const text = await readText(request, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Used when ALLOWED_ORIGINS is not set. */
export const DEFAULT_ALLOWED_ORIGINS = "https://cf-ai-tradedesk.pages.dev,http://localhost:5173";

/**
 * Parses ALLOWED_ORIGINS: comma-separated origins, compared exactly with the
 * request's Origin header. Spaces and trailing slashes are ignored.
 */
export function parseOrigins(value: unknown): Set<string> {
  const list = typeof value === "string" ? value : DEFAULT_ALLOWED_ORIGINS;
  return new Set(
    list
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/**
 * CORS headers for a request from `origin`, or null if that origin is not in
 * the allow-list. The allowed origin is echoed (never `*`), and Retry-After is
 * exposed so the page can read it from a 429.
 */
export function corsHeaders(origin: string, allowed: ReadonlySet<string>): Record<string, string> | null {
  if (!allowed.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After",
  };
}
