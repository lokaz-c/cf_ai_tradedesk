/**
 * Parses the server-sent event stream that Workers AI text generation returns:
 * one `data: {"response": "..."}` event per token, then `data: [DONE]`.
 *
 * Network reads do not line up with events: a read can end mid-line or in the
 * middle of a multi-byte UTF-8 character. The parser decodes in streaming mode
 * and only parses complete lines, carrying the unfinished tail into the next
 * read. The Worker uses it to persist the reply and the front end uses it to
 * render the reply as it arrives, so both see the same text.
 */
export class SseTextParser {
  private decoder = new TextDecoder();
  private pending = "";

  /** Feeds one network read; returns the reply text completed by it ("" if none). */
  push(chunk: Uint8Array): string {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.map(textOf).join("");
  }

  /** Call once the stream has ended; returns text from a final unterminated line. */
  end(): string {
    const last = this.pending + this.decoder.decode();
    this.pending = "";
    return textOf(last);
  }
}

function textOf(line: string): string {
  // Tolerate CRLF line endings, which the SSE format allows.
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (!line.startsWith("data: ") || line === "data: [DONE]") return "";
  try {
    const response = JSON.parse(line.slice(6)).response;
    return typeof response === "string" ? response : "";
  } catch {
    // Not a JSON payload; ignore it.
    return "";
  }
}

/**
 * Reads a stream to the end, calling `onText` with each piece of reply text as
 * soon as a read completes it. Resolves with the full reply.
 */
export async function readStreamedText(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void = () => {},
): Promise<string> {
  const reader = stream.getReader();
  const parser = new SseTextParser();
  let text = "";
  const take = (piece: string) => {
    if (!piece) return;
    text += piece;
    onText(piece);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    take(parser.push(value));
  }
  take(parser.end());
  return text;
}

/** Reads a Workers AI text-generation stream to the end and returns the reply text. */
export function collectStreamedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return readStreamedText(stream);
}
