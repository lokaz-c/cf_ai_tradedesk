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
