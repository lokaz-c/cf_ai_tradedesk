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

/**
 * Parses a JSON request body that must be an object. Returns null for an
 * empty body, invalid JSON, or any other JSON value.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  let value: unknown;
  try {
    value = await request.json();
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
