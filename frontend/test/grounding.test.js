import { describe, expect, it } from 'vitest';
import { streamReplyInto } from '../src/chat.js';
import { buildGroundingPanel, parseGrounding } from '../src/render.js';
import { chunkedStream, expectInert, PAYLOADS, sseBody } from './helpers.js';

const REPORT = {
  data: [
    { tool: 'get_levels', service: 'market-data', ticker: 'S001', status: 'ok', source: 'synthetic', synthetic: true, asOf: '2026-10-02' },
    { tool: 'get_levels', service: 'market-data', ticker: 'S999', status: 'not_found', detail: 'Unknown ticker: S999' },
    { tool: 'get_levels', service: 'market-data', ticker: 'S002', status: 'timeout', detail: 'market-data did not answer within 4 s.' },
  ],
  citations: [
    { text: '101.14', value: 101.1367, label: 'P', ticker: 'S001', kind: 'level', source: 'synthetic' },
    { text: '102.49', value: 102.4933, label: 'R1', ticker: 'S001', kind: 'level', source: 'synthetic' },
  ],
  unverified: [{ text: '110.40', value: 110.4 }],
};

describe('streamReplyInto with a grounding report', () => {
  it.each([1, 7, 4096])('passes the report to onMeta and keeps it out of the text (%i-byte reads)', async (size) => {
    const body =
      sseBody(['Pivot ', '101.14']).replace('data: [DONE]\n\n', '') +
      `data: ${JSON.stringify({ tradedesk: REPORT })}\n\ndata: [DONE]\n\n`;
    const el = document.createElement('div');
    const metas = [];
    const text = await streamReplyInto(el, chunkedStream(body, size), () => {}, (m) => metas.push(m));
    expect(text).toBe('Pivot 101.14');
    expect(el.textContent.trim()).toBe('Pivot 101.14');
    expect(metas).toEqual([REPORT]);
  });

  it('ignores a tradedesk field that is not an object', async () => {
    const el = document.createElement('div');
    const metas = [];
    const body = 'data: {"tradedesk":"x"}\n\ndata: {"tradedesk":null,"response":"ok"}\n\n';
    expect(await streamReplyInto(el, chunkedStream(body, 3), () => {}, (m) => metas.push(m))).toBe('ok');
    expect(metas).toEqual([]);
  });
});

describe('parseGrounding', () => {
  it('accepts the object or its JSON text (as stored with saved analyses)', () => {
    expect(parseGrounding(REPORT)).toEqual(parseGrounding(JSON.stringify(REPORT)));
    expect(parseGrounding(REPORT).citations).toHaveLength(2);
  });

  it('returns null for empty, malformed or missing reports', () => {
    expect(parseGrounding(null)).toBeNull();
    expect(parseGrounding('not json')).toBeNull();
    expect(parseGrounding('[]')).toBeNull();
    expect(parseGrounding({ data: [], citations: [], unverified: [] })).toBeNull();
  });

  it('drops entries whose numbers are not numbers', () => {
    const parsed = parseGrounding({
      citations: [{ label: 'P', value: '101', ticker: 'S001' }, { label: 'R1', value: 102.5, ticker: 'S001' }],
      unverified: [{ text: 'x', value: null }],
    });
    expect(parsed.citations.map((c) => c.label)).toEqual(['R1']);
    expect(parsed.unverified).toEqual([]);
  });
});

describe('buildGroundingPanel', () => {
  it('labels synthetic data, explains missing data, and lists cited and unverified numbers', () => {
    const panel = buildGroundingPanel(document, REPORT);
    const sources = [...panel.querySelectorAll('.grounding-source')];
    expect(sources.map((s) => [s.className, s.textContent])).toEqual([
      ['grounding-source synthetic', 'S001SYNTHETIC DEMO DATAgenerated prices, not real market prices · as of 2026-10-02'],
      ['grounding-source error', 'S999NO DATAUnknown ticker: S999'],
      ['grounding-source error', 'S002UNAVAILABLEmarket-data did not answer within 4 s.'],
    ]);
    expect([...panel.querySelectorAll('.grounding-cited')].map((li) => li.textContent)).toEqual([
      'P101.1367S001 · synthetic',
      'R1102.4933S001 · synthetic',
    ]);
    expect([...panel.querySelectorAll('.grounding-unverified')].map((li) => li.textContent)).toEqual(['110.40']);
  });

  it('shows a real source by name, without the synthetic label', () => {
    const panel = buildGroundingPanel(document, {
      data: [{ ticker: 'AAPL', status: 'ok', source: 'alpaca', synthetic: false, asOf: '2026-10-02' }],
    });
    expect(panel.querySelector('.grounding-source').className).toBe('grounding-source real');
    expect(panel.textContent).toContain('ALPACA');
    expect(panel.textContent).not.toContain('SYNTHETIC');
  });

  it('shows one line per ticker and outcome', () => {
    const ok = REPORT.data[0];
    const panel = buildGroundingPanel(document, { data: [ok, ok, { ...ok, tool: 'get_recent_bars' }] });
    expect(panel.querySelectorAll('.grounding-source')).toHaveLength(1);
  });

  it('returns null when there is nothing to show', () => {
    expect(buildGroundingPanel(document, { data: [], citations: [], unverified: [] })).toBeNull();
    expect(buildGroundingPanel(document, undefined)).toBeNull();
  });

  it.each(PAYLOADS)('sets every field as text: %s', (payload) => {
    const panel = buildGroundingPanel(document, {
      data: [
        { ticker: payload, status: 'ok', source: payload, synthetic: false, asOf: payload },
        { ticker: payload, status: payload, detail: payload },
      ],
      citations: [{ label: payload, value: 1, ticker: payload, source: payload }],
      unverified: [{ text: payload, value: 2 }],
    });
    document.body.append(panel);
    expectInert(expect, panel);
    expect(panel.querySelector('img, a, details, script')).toBeNull();
    expect(panel.querySelector('.cited-label').textContent).toBe(payload);
    expect(panel.querySelector('.grounding-unverified').textContent).toBe(payload);
  });
});
