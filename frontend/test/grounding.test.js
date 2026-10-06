import { describe, expect, it } from 'vitest';
import { streamReplyInto } from '../src/chat.js';
import { buildGroundingPanel, formatMetric, parseGrounding } from '../src/render.js';
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

const BACKTEST = {
  backtestId: 42,
  strategy: 'Moving Average Crossover',
  symbol: 'AAPL',
  startDate: '2023-01-01',
  endDate: '2024-12-31',
  riskProfile: 'Conservative',
  initialCapital: 100000,
  synthetic: true,
  dataFile: 'data/sample_data.csv',
  dataDescription: 'Synthetic daily bars.',
  metrics: {
    total_return: -3.2117,
    cagr: -1.6234,
    max_drawdown: 12.4871,
    volatility: 9.8812,
    sharpe_ratio: -0.2156,
    win_rate: 41.6667,
    avg_win: 812.43,
    avg_loss: -655.1,
    num_trades: 12,
    final_equity: 96788.3,
    profit_factor: null,
    max_consecutive_wins: 2,
    max_consecutive_losses: 4,
  },
};

describe('backtest results', () => {
  const report = {
    data: [{ tool: 'run_backtest', service: 'quant', ticker: 'AAPL', status: 'ok', source: 'synthetic', synthetic: true }],
    citations: [{ text: '3.21', value: -3.2117, label: 'Total return', ticker: 'AAPL', kind: 'backtest', source: 'synthetic' }],
    unverified: [],
    backtests: [BACKTEST],
  };

  it('shows the metrics quant returned in a table, labelled as synthetic', () => {
    const panel = buildGroundingPanel(document, report);
    expect(panel.querySelector('.grounding-source').textContent).toBe(
      "AAPLBACKTEST · SYNTHETIC DATAquant's synthetic dataset; symbol names are labels only, not real prices",
    );
    expect(panel.querySelector('.backtest-title').textContent).toBe(
      'Moving Average Crossover on AAPL · 2023-01-01 to 2024-12-31 · Conservative · initial capital 100,000.00',
    );
    const rows = [...panel.querySelectorAll('.backtest-table tr')].map((tr) => [
      tr.querySelector('th').textContent,
      tr.querySelector('td').textContent,
    ]);
    expect(rows).toEqual([
      ['Total return', '-3.21%'],
      ['CAGR', '-1.62%'],
      ['Max drawdown', '12.49%'],
      ['Volatility (annualised)', '9.88%'],
      ['Sharpe ratio', '-0.22'],
      ['Win rate', '41.67%'],
      ['Average win', '812.43'],
      ['Average loss', '-655.10'],
      ['Trades', '12'],
      ['Final equity', '96,788.30'],
      ['Profit factor', 'not finite'],
      ['Max consecutive wins', '2'],
      ['Max consecutive losses', '4'],
    ]);
    expect(panel.querySelector('.backtest-note').textContent).toBe(
      "Synthetic data (quant's data/sample_data.csv); symbol names are labels only, not real prices.",
    );
    // Backtest numbers are in the table, not in the "Levels cited" list.
    expect(panel.querySelector('.grounding-cited')).toBeNull();
  });

  it('says when quant reports real data, and when a backtest did not run', () => {
    const real = buildGroundingPanel(document, { backtests: [{ ...BACKTEST, synthetic: false, dataFile: 'data/real.csv' }] });
    expect(real.querySelector('.backtest-note').textContent).toBe("Data: quant's data/real.csv, reported by quant as not synthetic.");
    const failed = buildGroundingPanel(document, {
      data: [{ service: 'quant', ticker: 'AAPL', status: 'rate_limited', detail: 'Too many backtests from your network; try again in a minute.' }],
    });
    expect(failed.querySelector('.grounding-source').textContent).toBe(
      'AAPLBACKTEST NOT RUNToo many backtests from your network; try again in a minute.',
    );
  });

  it('drops metrics that are not numbers', () => {
    const parsed = parseGrounding({ backtests: [{ ...BACKTEST, metrics: { total_return: '12', cagr: 5 } }] });
    expect(parsed.backtests[0].metrics.total_return).toBeNull();
    expect(parsed.backtests[0].metrics.cagr).toBe(5);
  });

  it('formats each unit', () => {
    expect([formatMetric(1.005, 'percent'), formatMetric(1234.5, 'currency'), formatMetric(2.4, 'count'), formatMetric(0.123, 'ratio'), formatMetric(null, 'ratio')]).toEqual(
      ['1.00%', '1,234.50', '2', '0.12', 'not finite'],
    );
  });

  it.each(PAYLOADS)('sets every backtest field as text: %s', (payload) => {
    const panel = buildGroundingPanel(document, {
      data: [{ service: 'quant', ticker: payload, status: payload, detail: payload }],
      backtests: [{ ...BACKTEST, strategy: payload, symbol: payload, riskProfile: payload, dataFile: payload }],
    });
    document.body.append(panel);
    expectInert(expect, panel);
    expect(panel.querySelector('img, a, details, script')).toBeNull();
    expect(panel.querySelector('.backtest-title').textContent).toContain(payload);
  });
});
