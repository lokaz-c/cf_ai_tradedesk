import { describe, expect, it } from 'vitest';
import {
  buildAnalysisItem,
  buildMessage,
  buildNotice,
  buildTickerHeader,
  formatTimestamp,
  renderMarkdown,
  setMarkdown,
  showError,
} from '../src/render.js';
import { expectInert, PAYLOADS } from './helpers.js';

function container(html) {
  const div = document.createElement('div');
  if (html !== undefined) div.innerHTML = html;
  document.body.append(div);
  return div;
}

describe('renderMarkdown (model replies, live and saved)', () => {
  it.each(PAYLOADS)('returns inert HTML for %s', (payload) => {
    const el = container(renderMarkdown(`Bias: neutral.\n\n${payload}\n\nEnd.`));
    expectInert(expect, el);
    expect(el.textContent).toContain('Bias: neutral.');
    expect(el.textContent).toContain('End.');
  });

  it('keeps the markdown the replies use: headings, emphasis, lists, code and tables', () => {
    const el = container(
      renderMarkdown(
        [
          '## Levels',
          '**Bias:** bullish, *for now*',
          '- support 1.2650',
          '- resistance 1.2800',
          '',
          '`R:R 1:3`',
          '',
          '| Level | Price |',
          '| --- | --- |',
          '| S1 | 1.2650 |',
        ].join('\n'),
      ),
    );
    expect(el.querySelector('h2')?.textContent).toBe('Levels');
    expect(el.querySelector('strong')?.textContent).toBe('Bias:');
    expect(el.querySelector('em')?.textContent).toBe('for now');
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'support 1.2650',
      'resistance 1.2800',
    ]);
    expect(el.querySelector('code')?.textContent).toBe('R:R 1:3');
    expect(el.querySelector('td')?.textContent).toBe('S1');
  });

  it('keeps ordinary links', () => {
    const el = container(renderMarkdown('[calendar](https://example.com/calendar)'));
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com/calendar');
  });

  it('treats null and undefined as empty', () => {
    expect(renderMarkdown(undefined)).toBe('');
    expect(renderMarkdown(null)).toBe('');
  });

  it('setMarkdown replaces the previous contents', () => {
    const el = container('<p>old</p>');
    setMarkdown(el, 'new <img src=x onerror=alert(1)>');
    expect(el.textContent.trim()).toBe('new');
    expectInert(expect, el);
  });
});

describe('history sidebar', () => {
  it.each(PAYLOADS)('shows a stored ticker as text: %s', (payload) => {
    const header = buildTickerHeader(document, { ticker: payload, count: 2 });
    container().append(header);
    expectInert(expect, header);
    expect(header.querySelector('img, a, details')).toBeNull();
    expect(header.querySelector('.ticker-name')?.textContent).toBe(payload);
    expect(header.querySelector('.ticker-count')?.textContent).toBe('2 analyses');
  });

  it('shows a non-numeric count as text', () => {
    const header = buildTickerHeader(document, { ticker: 'NQ', count: '<img src=x onerror=alert(1)>' });
    expectInert(expect, header);
    expect(header.querySelector('img')).toBeNull();
  });

  it.each(PAYLOADS)('shows a stored question as text: %s', (payload) => {
    const item = buildAnalysisItem(document, { user_query: payload, created_at: 1_700_000_000 });
    container().append(item);
    expectInert(expect, item);
    expect(item.querySelector('img, a, details')).toBeNull();
    expect(item.querySelector('.analysis-query')?.textContent).toBe(payload);
  });

  it('formats the stored timestamp, and drops one that is not a number', () => {
    const ok = buildAnalysisItem(document, { user_query: 'q', created_at: 1_700_000_000 });
    expect(ok.querySelector('.analysis-time')?.textContent).toBe(formatTimestamp(1_700_000_000));
    expect(formatTimestamp(1_700_000_000)).not.toBe('');

    const bad = buildAnalysisItem(document, { user_query: 'q', created_at: '<img src=x onerror=alert(1)>' });
    expectInert(expect, bad);
    expect(bad.querySelector('img')).toBeNull();
    expect(bad.querySelector('.analysis-time')?.textContent).toBe('');
  });

  it('formatTimestamp rejects strings, NaN and out-of-range values', () => {
    expect(formatTimestamp('1700000000')).toBe('');
    expect(formatTimestamp(Number.NaN)).toBe('');
    expect(formatTimestamp(1e20)).toBe('');
    expect(formatTimestamp(undefined)).toBe('');
  });

  it('buildNotice sets text only', () => {
    const notice = buildNotice(document, 'history-empty', '<b>none</b>');
    expect(notice.className).toBe('history-empty');
    expect(notice.textContent).toBe('<b>none</b>');
    expect(notice.children).toHaveLength(0);
  });
});

describe('chat messages', () => {
  it.each(PAYLOADS)('shows a user message as plain text: %s', (payload) => {
    const { root, content } = buildMessage(document, 'user', { label: 'You', text: payload });
    container().append(root);
    expectInert(expect, root);
    expect(content.children).toHaveLength(0);
    expect(content.textContent).toBe(payload);
  });

  it.each(PAYLOADS)('renders an assistant reply as inert markdown: %s', (payload) => {
    const { root } = buildMessage(document, 'assistant', { label: 'TradeDesk AI', text: `**ok** ${payload}` });
    container().append(root);
    expectInert(expect, root);
    expect(root.querySelector('strong')?.textContent).toBe('ok');
  });

  it('puts the label (which includes the ticker) in as text', () => {
    const label = 'TradeDesk AI · <img src=x onerror=alert(1)>';
    const { root } = buildMessage(document, 'assistant', { label, text: 'hi' });
    expect(root.querySelector('.msg-meta')?.textContent).toBe(label);
    expect(root.querySelector('img')).toBeNull();
  });

  it('shows a typing indicator while waiting', () => {
    const { content } = buildMessage(document, 'assistant', { typing: true });
    expect(content.querySelectorAll('.typing-indicator .typing-dot')).toHaveLength(3);
  });

  it('showError sets the error text without parsing it', () => {
    const el = container('<p>old</p>');
    showError(el, '<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
