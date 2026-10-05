/**
 * Reads a Workers AI text-generation stream to the end and returns the reply
 * text, i.e. the concatenated `response` fields of its `data: {...}` events.
 *
 * Network reads do not line up with events: a read can end mid-line or in the
 * middle of a multi-byte UTF-8 character. Decode in streaming mode and only
 * parse complete lines, carrying the unfinished tail into the next read.
 */
export async function collectStreamedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";

  const takeLine = (line: string) => {
    if (!line.startsWith("data: ") || line === "data: [DONE]") return;
    try {
      text += JSON.parse(line.slice(6)).response ?? "";
    } catch {
      // Not a JSON payload; ignore it, as before.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(takeLine);
  }
  pending += decoder.decode();
  takeLine(pending);
  return text;
}
