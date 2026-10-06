// DOM helpers for the chat page. Everything that came from the network or from
// the user (tickers, questions, timestamps, model replies) goes through these:
// plain values are set with textContent, and markdown replies are converted to
// HTML and then sanitized with DOMPurify before they reach the DOM.

import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const markdown = new Marked({ async: false, gfm: true });

/**
 * Converts markdown to HTML that is safe to assign to innerHTML: marked does
 * not sanitize, so its output goes through DOMPurify, restricted to HTML (no
 * SVG or MathML, which a chat reply never needs).
 */
export function renderMarkdown(text) {
  const html = markdown.parse(String(text ?? ''));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** Replaces the contents of `el` with the sanitized rendering of `text`. */
export function setMarkdown(el, text) {
  el.innerHTML = renderMarkdown(text);
}

/** Formats a unix timestamp in seconds; returns "" for anything that is not a number. */
export function formatTimestamp(seconds) {
  const n = typeof seconds === 'number' ? seconds : Number.NaN;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** A muted one-line notice, e.g. for an empty history list. */
export function buildNotice(doc, className, text) {
  return element(doc, 'div', className, text);
}

/** The clickable header of one ticker group in the history sidebar. */
export function buildTickerHeader(doc, row) {
  const header = element(doc, 'div', 'ticker-group-header');
  header.append(
    element(doc, 'span', 'ticker-name', row.ticker),
    element(doc, 'span', 'ticker-count', `${row.count} analyses`),
  );
  return header;
}

/** One saved analysis in the history sidebar: the question and when it was asked. */
export function buildAnalysisItem(doc, item) {
  const node = element(doc, 'div', 'analysis-item');
  node.append(
    element(doc, 'div', 'analysis-query', item.user_query),
    element(doc, 'div', 'analysis-time', formatTimestamp(item.created_at)),
  );
  return node;
}

/** The three animated dots shown while waiting for the first token. */
export function buildTypingIndicator(doc) {
  const indicator = element(doc, 'div', 'typing-indicator');
  for (let i = 0; i < 3; i++) indicator.append(element(doc, 'div', 'typing-dot'));
  return indicator;
}

/**
 * A chat message. User messages are shown as plain text; assistant messages
 * are rendered as sanitized markdown. Returns the message element and its
 * content element, which the caller fills (or streams into).
 */
export function buildMessage(doc, role, { label, text, typing = false } = {}) {
  const root = element(doc, 'div', `message ${role === 'user' ? 'user' : 'assistant'}`);
  const avatar = element(doc, 'div', 'msg-avatar', role === 'user' ? 'YOU' : 'AI');
  const body = element(doc, 'div', 'msg-body');
  const meta = element(doc, 'div', 'msg-meta', label ?? '');
  const content = element(doc, 'div', 'msg-content');

  if (typing) content.append(buildTypingIndicator(doc));
  else if (role === 'user') content.textContent = String(text ?? '');
  else setMarkdown(content, text);

  body.append(meta, content);
  root.append(avatar, body);
  return { root, content };
}

/** Replaces the contents of `el` with an error line in the error colour. */
export function showError(el, text) {
  const line = el.ownerDocument.createElement('span');
  line.style.color = 'var(--red)';
  line.textContent = text;
  el.replaceChildren(line);
}
