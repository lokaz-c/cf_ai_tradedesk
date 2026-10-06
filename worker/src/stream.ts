import { SseTextParser } from "../../shared/sse";
import { SSE_DONE, sseEvent } from "./grounding";

/**
 * Re-emits a Workers AI text stream with a trailer. Each network read becomes
 * one `data: {"response": "..."}` event as soon as it arrives, so the page
 * still renders tokens live. When the model's stream ends, `finish` gets the
 * full reply and returns extra text (the data notes, sent as one more response
 * event) and the grounding report, sent as `data: {"tradedesk": ...}`. Then
 * `data: [DONE]`.
 */
export function streamWithTrailer(
  model: ReadableStream<Uint8Array>,
  finish: (reply: string) => { notes: string; meta: unknown },
): ReadableStream<Uint8Array> {
  const parser = new SseTextParser();
  const encoder = new TextEncoder();
  let reply = "";
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, piece: string) => {
    if (!piece) return;
    reply += piece;
    controller.enqueue(encoder.encode(sseEvent({ response: piece })));
  };
  return model.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        emit(controller, parser.push(chunk));
      },
      flush(controller) {
        emit(controller, parser.end());
        const { notes, meta } = finish(reply);
        if (notes) controller.enqueue(encoder.encode(sseEvent({ response: notes })));
        controller.enqueue(encoder.encode(sseEvent({ tradedesk: meta })));
        controller.enqueue(encoder.encode(SSE_DONE));
      },
    }),
  );
}
