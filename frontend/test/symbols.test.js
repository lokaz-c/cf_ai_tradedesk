import { describe, expect, it, vi } from 'vitest';
import {
  buildSymbolChips,
  buildSymbolOptions,
  defaultTicker,
  FALLBACK_TICKER,
  fetchSymbols,
  suggestTicker,
} from '../src/symbols.js';
import { expectInert, PAYLOADS } from './helpers.js';

const SYMBOLS = [
  { ticker: 'S001', name: 'Synthetic 001', source: 'synthetic', lastBar: '2026-10-02', feed: null, lastIngestedAt: null },
  { ticker: 'S002', name: null, source: 'synthetic', lastBar: '2026-10-02', feed: null, lastIngestedAt: null },
];

/** A fetch stub that answers every request with `response` and records the URLs. */
function stubFetch(response) {
  return vi.fn(async () => (typeof response === 'function' ? response() : response));
}

function problem(status, detail, headers = {}) {
  return new Response(JSON.stringify({ title: 'Error', status, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
  });
}

describe('fetchSymbols', () => {
  it("reads the Worker's symbol list and keeps feed labels", async () => {
    const fetch = stubFetch(Response.json({ symbols: [...SYMBOLS, { ticker: 'AAPL', name: 'Apple', source: 'alpaca', feed: 'iex' }] }));
    expect(await fetchSymbols('https://worker.test', fetch)).toEqual({
      symbols: [
        { ticker: 'S001', name: 'Synthetic 001', source: 'synthetic', feed: null },
        { ticker: 'S002', name: null, source: 'synthetic', feed: null },
        { ticker: 'AAPL', name: 'Apple', source: 'alpaca', feed: 'iex' },
      ],
    });
    expect(fetch).toHaveBeenCalledWith('https://worker.test/api/market/symbols');
  });

  it('drops entries without a valid ticker', async () => {
    const fetch = stubFetch(Response.json({ symbols: [{ ticker: 'GBP/USD' }, { ticker: '<b>' }, null, { name: 'x' }, { ticker: 'S003' }] }));
    const { symbols } = await fetchSymbols('', fetch);
    expect(symbols.map((s) => s.ticker)).toEqual(['S003']);
  });

  it("returns the Worker's problem detail, including market-data's retry advice", async () => {
    const busy = stubFetch(problem(503, 'market-data is busy (rate limit reached); retry in 12 s.', { 'Retry-After': '12' }));
    expect(await fetchSymbols('', busy)).toEqual({
      error: 'market-data is busy (rate limit reached); retry in 12 s.',
      status: 503,
    });
    const off = stubFetch(problem(503, 'Market data is not connected on this deployment.'));
    expect(await fetchSymbols('', off)).toEqual({ error: 'Market data is not connected on this deployment.', status: 503 });
  });

  it('reports a connection failure and a body that is not JSON', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchSymbols('', down)).toEqual({ error: 'Could not connect to the Worker.', status: 0 });
    expect(await fetchSymbols('', stubFetch(new Response('<html>', { status: 200 })))).toEqual({
      error: 'The Worker returned symbols in an unexpected format.',
      status: 200,
    });
  });
});

describe('defaultTicker and suggestTicker', () => {
  it("defaults to market-data's first symbol, or GBP/USD when it lists none", () => {
    expect(defaultTicker(SYMBOLS)).toBe('S001');
    expect(defaultTicker([])).toBe(FALLBACK_TICKER);
    expect(defaultTicker(undefined)).toBe('GBP/USD');
  });

  function input(value) {
    const el = document.createElement('input');
    el.value = value;
    el.placeholder = 'GBP/USD';
    return el;
  }

  it('replaces the untouched GBP/USD default with the first symbol', () => {
    const el = input('GBP/USD');
    expect(suggestTicker(el, SYMBOLS)).toBe('S001');
    expect([el.value, el.placeholder]).toEqual(['S001', 'S001']);
  });

  it('keeps what the user typed, and the ticker of a started session', () => {
    const typed = input('GBP/USD');
    expect(suggestTicker(typed, SYMBOLS, { edited: true })).toBe('GBP/USD');
    expect(typed.value).toBe('GBP/USD');

    const started = input('GBP/USD');
    expect(suggestTicker(started, SYMBOLS, { started: true })).toBe('GBP/USD');

    const other = input('aapl');
    expect(suggestTicker(other, SYMBOLS)).toBe('AAPL');
    expect(other.value).toBe('aapl');
  });

  it('suggests the default when the input is empty', () => {
    const el = input('');
    expect(suggestTicker(el, SYMBOLS)).toBe('S001');
    expect([el.value, el.placeholder]).toEqual(['', 'S001']);
  });

  it('leaves GBP/USD in place when market-data lists nothing', () => {
    const el = input('GBP/USD');
    expect(suggestTicker(el, [])).toBe('GBP/USD');
    expect(el.value).toBe('GBP/USD');
  });
});

describe('buildSymbolChips and buildSymbolOptions', () => {
  it('makes one button per symbol that starts a session on click', () => {
    const picked = [];
    const chips = buildSymbolChips(document, [...SYMBOLS, { ticker: 'AAPL', name: 'Apple', source: 'alpaca', feed: 'iex' }], (t) =>
      picked.push(t),
    );
    expect(chips.map((c) => [c.tagName, c.type, c.textContent, c.title])).toEqual([
      ['BUTTON', 'button', 'S001', 'Synthetic 001 (synthetic)'],
      ['BUTTON', 'button', 'S002', 'S002 (synthetic)'],
      ['BUTTON', 'button', 'AAPL', 'Apple (alpaca, IEX feed)'],
    ]);
    chips[1].click();
    expect(picked).toEqual(['S002']);
  });

  it('fills the datalist', () => {
    expect(buildSymbolOptions(document, SYMBOLS).map((o) => o.value)).toEqual(['S001', 'S002']);
  });

  it.each(PAYLOADS)('sets symbol names as text: %s', (payload) => {
    const root = document.createElement('div');
    root.append(...buildSymbolChips(document, [{ ticker: 'S001', name: payload, source: payload, feed: null }], () => {}));
    expectInert(expect, root);
    expect(root.firstChild.title).toContain(payload);
  });
});
