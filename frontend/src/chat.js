// Network helpers for the chat page.

import { readStreamedText } from '../../shared/sse.ts';
import { setMarkdown } from './render.js';

/**
 * Reads a chat reply stream (Workers AI server-sent events) and re-renders the
 * reply into `el` after every network read. The parser is the one the Worker
 * uses to store the reply, so a token split across two reads is still shown.
 * A grounding report at the end of the stream goes to `onMeta`. Resolves with
 * the full reply text.
 */
export function streamReplyInto(el, body, onUpdate = () => {}, onMeta = () => {}) {
  let text = '';
  return readStreamedText(
    body,
    (piece) => {
      text += piece;
      setMarkdown(el, text);
      onUpdate(text);
    },
    onMeta,
  );
}

/**
 * The message to show for a failed API response: the `detail` of an RFC 9457
 * problem body when there is one, otherwise a generic line with the status.
 */
export async function errorMessage(res) {
  try {
    const body = await res.json();
    if (body && typeof body.detail === 'string' && body.detail) return body.detail;
  } catch {
    // Not JSON; fall through.
  }
  return `Request failed (HTTP ${res.status}).`;
}
