import { describe, expect, it } from 'vitest';
import { errorMessage, streamReplyInto } from '../src/chat.js';
import { chunkedStream, expectInert, sseBody } from './helpers.js';

// Multi-byte characters, so small reads also split UTF-8 sequences.
const TOKENS = ['Gold ', 'holds 2,350 — ', 'watch €/¥ ', 'crosses ', '✓'];
const REPLY = TOKENS.join('');

describe('streamReplyInto', () => {
  it.each([1, 2, 3, 7, 64, 4096])(
    'shows every token when the stream arrives in %i-byte reads',
    async (size) => {
      const el = document.createElement('div');
      const updates = [];
      const text = await streamReplyInto(el, chunkedStream(sseBody(TOKENS), size), (t) => updates.push(t));

      expect(text).toBe(REPLY);
      expect(el.textContent.trim()).toBe(REPLY);
      // Each update extends the previous one, and the last is the whole reply.
      updates.forEach((u, i) => expect(u.startsWith(updates[i - 1] ?? '')).toBe(true));
      expect(updates.at(-1)).toBe(REPLY);
    },
  );

  it('handles a final event without a trailing newline', async () => {
    const el = document.createElement('div');
    const body = 'data: {"response":"one "}\n\ndata: {"response":"two"}';
    expect(await streamReplyInto(el, chunkedStream(body, 5))).toBe('one two');
  });

  it('ignores [DONE], blank lines, comments and malformed events', async () => {
    const el = document.createElement('div');
    const body = ': keep-alive\n\ndata: not json\n\ndata: {"response":"ok"}\n\ndata: {"other":1}\n\ndata: [DONE]\n\n';
    expect(await streamReplyInto(el, chunkedStream(body, 3))).toBe('ok');
    expect(el.textContent.trim()).toBe('ok');
  });

  it('accepts CRLF line endings', async () => {
    const el = document.createElement('div');
    const body = 'data: {"response":"a"}\r\n\r\ndata: {"response":"b"}\r\n\r\ndata: [DONE]\r\n\r\n';
    expect(await streamReplyInto(el, chunkedStream(body, 2))).toBe('ab');
  });

  it('renders a streamed reply that contains HTML as inert markup', async () => {
    const el = document.createElement('div');
    const tokens = ['Levels: ', '<img src=x ', 'onerror=alert(1)>', ' and ', '<script>alert(1)</script>'];
    await streamReplyInto(el, chunkedStream(sseBody(tokens), 4));
    expectInert(expect, el);
    expect(el.querySelector('img')?.getAttribute('onerror') ?? null).toBeNull();
    expect(el.textContent).toContain('Levels:');
  });
});

describe('errorMessage', () => {
  it('uses the detail of a problem body', async () => {
    const res = new Response(JSON.stringify({ title: 'Bad Request', status: 400, detail: 'Invalid ticker.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/problem+json' },
    });
    expect(await errorMessage(res)).toBe('Invalid ticker.');
  });

  it('falls back to the status when the body is not a problem', async () => {
    expect(await errorMessage(new Response('oops', { status: 502 }))).toBe('Request failed (HTTP 502).');
    expect(await errorMessage(new Response('{}', { status: 500 }))).toBe('Request failed (HTTP 500).');
  });

  it('says how long to wait on a 429 or 503 with Retry-After and no detail', async () => {
    expect(await errorMessage(new Response('', { status: 429, headers: { 'Retry-After': '30' } }))).toBe('Busy, retry in 30 s.');
    expect(await errorMessage(new Response('{}', { status: 503, headers: { 'Retry-After': ' 7 ' } }))).toBe('Busy, retry in 7 s.');
  });

  it('prefers the detail, and gives no wait it was not sent', async () => {
    const detailed = new Response(JSON.stringify({ detail: 'market-data is busy (rate limit reached); retry in 12 s.' }), {
      status: 503,
      headers: { 'Retry-After': '12' },
    });
    expect(await errorMessage(detailed)).toBe('market-data is busy (rate limit reached); retry in 12 s.');
    expect(await errorMessage(new Response('', { status: 503 }))).toBe('Request failed (HTTP 503).');
    expect(await errorMessage(new Response('', { status: 503, headers: { 'Retry-After': 'soon' } }))).toBe(
      'Request failed (HTTP 503).',
    );
    expect(await errorMessage(new Response('', { status: 500, headers: { 'Retry-After': '5' } }))).toBe('Request failed (HTTP 500).');
  });
});
