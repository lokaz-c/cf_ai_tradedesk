import { describe, expect, it } from 'vitest';
import * as LightweightCharts from 'lightweight-charts';
import {
  buildLegend,
  chartTickerFor,
  createChartPanel,
  levelKind,
  priceLinesFor,
  toCandles,
} from '../src/chart.js';
import { expectInert, PAYLOADS } from './helpers.js';

const CITATIONS = [
  { text: '101.14', value: 101.1367, label: 'P', ticker: 'S001', kind: 'level', source: 'synthetic' },
  { text: '102.49', value: 102.4933, label: 'R1', ticker: 'S001', kind: 'level', source: 'synthetic' },
  { text: '99.87', value: 99.8733, label: 'S1', ticker: 'S001', kind: 'level', source: 'synthetic' },
  { text: '105.2', value: 105.2, label: '20D high', ticker: 'S001', kind: 'level', source: 'synthetic' },
  { text: '101.25', value: 101.25, label: '2026-10-02 close', ticker: 'S001', kind: 'bar', source: 'synthetic' },
  // Not drawn: a backtest metric, and a level for another ticker.
  { text: '3.21', value: -3.2117, label: 'Total return', ticker: 'S001', kind: 'backtest', source: 'synthetic' },
  { text: '55.5', value: 55.5, label: 'P', ticker: 'S002', kind: 'level', source: 'synthetic' },
];

/** A stand-in for lightweight-charts that records calls (jsdom has no canvas). */
function fakeLib() {
  const calls = { createChart: [], setData: [], createPriceLine: [], removePriceLine: [], fitContent: 0, remove: 0 };
  let nextLine = 0;
  const series = {
    setData: (data) => calls.setData.push(data),
    createPriceLine: (options) => {
      calls.createPriceLine.push(options);
      return { id: nextLine++, options };
    },
    removePriceLine: (line) => calls.removePriceLine.push(line.id),
  };
  const lib = {
    ColorType: LightweightCharts.ColorType,
    LineStyle: LightweightCharts.LineStyle,
    CandlestickSeries: LightweightCharts.CandlestickSeries,
    createChart: (container, options) => {
      calls.createChart.push({ container, options });
      return {
        addSeries: (type, seriesOptions) => {
          calls.series = { type, seriesOptions };
          return series;
        },
        timeScale: () => ({ fitContent: () => calls.fitContent++ }),
        remove: () => calls.remove++,
      };
    },
  };
  return { lib, calls };
}

describe('toCandles', () => {
  it('maps market-data bars to candles and drops malformed rows', () => {
    expect(
      toCandles([
        { date: '2026-10-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { date: '2026-10-02', open: '1', high: 2, low: 0.5, close: 1.5 },
        { date: 'yesterday', open: 1, high: 2, low: 0.5, close: 1.5 },
        null,
      ]),
    ).toEqual([{ time: '2026-10-01', open: 1, high: 2, low: 0.5, close: 1.5 }]);
    expect(toCandles(undefined)).toEqual([]);
  });
});

describe('priceLinesFor', () => {
  it('draws levels and bar values for the charted ticker only, highest first, with the library line styles', () => {
    const { LineStyle } = LightweightCharts;
    expect(priceLinesFor(CITATIONS, 'S001', LineStyle)).toEqual([
      { price: 105.2, title: '20D high', kind: 'resistance', color: '#ff3d57', lineStyle: LineStyle.Dotted },
      { price: 102.4933, title: 'R1', kind: 'resistance', color: '#ff3d57', lineStyle: LineStyle.Dotted },
      { price: 101.25, title: '2026-10-02 close', kind: 'close', color: '#e8f1f8', lineStyle: LineStyle.Solid },
      { price: 101.1367, title: 'P', kind: 'pivot', color: '#00d4ff', lineStyle: LineStyle.Dashed },
      { price: 99.8733, title: 'S1', kind: 'support', color: '#00e676', lineStyle: LineStyle.Dotted },
    ]);
  });

  it('draws one line per label and price, and nothing without a ticker or citations', () => {
    expect(priceLinesFor([CITATIONS[0], CITATIONS[0]], 'S001')).toHaveLength(1);
    expect(priceLinesFor(CITATIONS, null)).toEqual([]);
    expect(priceLinesFor(undefined, 'S001')).toEqual([]);
    expect(priceLinesFor([{ ...CITATIONS[0], value: '101' }], 'S001')).toEqual([]);
  });

  it('classifies labels', () => {
    expect(['R3', 'S2', 'P', 'Close', '52W low', '20-session high', '2026-10-02 open'].map(levelKind)).toEqual([
      'resistance',
      'support',
      'pivot',
      'close',
      'support',
      'resistance',
      'bar',
    ]);
  });
});

describe('chartTickerFor', () => {
  it('keeps the charted ticker when the answer cites it, otherwise picks the first cited ticker', () => {
    expect(chartTickerFor(CITATIONS, 'S001')).toBe('S001');
    expect(chartTickerFor(CITATIONS, 'S002')).toBe('S002');
    expect(chartTickerFor(CITATIONS, 'S050')).toBe('S001');
    expect(chartTickerFor(CITATIONS, null)).toBe('S001');
  });

  it('is null when only backtest numbers, or nothing, were cited', () => {
    expect(chartTickerFor([CITATIONS[5]], 'S001')).toBeNull();
    expect(chartTickerFor([], 'S001')).toBeNull();
    expect(chartTickerFor(null, 'S001')).toBeNull();
  });
});

describe('createChartPanel', () => {
  const BARS = [
    { date: '2026-10-01', open: 100, high: 102, low: 99, close: 101, volume: 1 },
    { date: '2026-10-02', open: 101, high: 103, low: 100, close: 101.25, volume: 1 },
  ];

  it('creates one candlestick chart in the page theme, with the TradingView attribution logo', () => {
    const { lib, calls } = fakeLib();
    const box = document.createElement('div');
    createChartPanel(box, lib);
    expect(calls.createChart).toHaveLength(1);
    const { container, options } = calls.createChart[0];
    expect(container).toBe(box);
    expect(options.autoSize).toBe(true);
    expect(options.layout.attributionLogo).toBe(true);
    expect(options.layout.background).toEqual({ type: LightweightCharts.ColorType.Solid, color: '#0d1117' });
    expect(calls.series.type).toBe(LightweightCharts.CandlestickSeries);
  });

  it('shows bars, then draws the cited levels as labelled price lines', () => {
    const { lib, calls } = fakeLib();
    const panel = createChartPanel(document.createElement('div'), lib);
    panel.setBars('S001', BARS);
    expect(panel.ticker).toBe('S001');
    expect(calls.setData.at(-1)).toEqual([
      { time: '2026-10-01', open: 100, high: 102, low: 99, close: 101 },
      { time: '2026-10-02', open: 101, high: 103, low: 100, close: 101.25 },
    ]);
    expect(calls.fitContent).toBe(1);

    const drawn = panel.showCitations(CITATIONS);
    expect(drawn.map((l) => l.title)).toEqual(['20D high', 'R1', '2026-10-02 close', 'P', 'S1']);
    expect(calls.createPriceLine).toEqual(
      drawn.map((l) => ({
        price: l.price,
        title: l.title,
        color: l.color,
        lineStyle: l.lineStyle,
        lineWidth: 1,
        axisLabelVisible: true,
      })),
    );
  });

  it("replaces the previous answer's lines, and clears them with new bars", () => {
    const { lib, calls } = fakeLib();
    const panel = createChartPanel(document.createElement('div'), lib);
    panel.setBars('S001', BARS);
    panel.showCitations(CITATIONS.slice(0, 2));
    panel.showCitations(CITATIONS.slice(2, 3));
    expect(calls.removePriceLine).toEqual([0, 1]);
    expect(calls.createPriceLine.map((o) => o.title)).toEqual(['R1', 'P', 'S1']);

    panel.setBars('S002', BARS);
    expect(calls.removePriceLine).toEqual([0, 1, 2]);
    expect(panel.showCitations(CITATIONS).map((l) => l.title)).toEqual(['P']);
  });

  it('draws nothing for citations of another ticker, and clear() empties the chart', () => {
    const { lib, calls } = fakeLib();
    const panel = createChartPanel(document.createElement('div'), lib);
    panel.setBars('S050', BARS);
    expect(panel.showCitations(CITATIONS)).toEqual([]);
    expect(calls.createPriceLine).toEqual([]);
    panel.clear();
    expect(panel.ticker).toBeNull();
    expect(calls.setData.at(-1)).toEqual([]);
  });
});

describe('buildLegend', () => {
  it('lists each line with its label and price', () => {
    const legend = buildLegend(document, priceLinesFor(CITATIONS, 'S001'));
    expect([...legend.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '20D high105.2',
      'R1102.4933',
      '2026-10-02 close101.25',
      'P101.1367',
      'S199.8733',
    ]);
  });

  it.each(PAYLOADS)('sets labels as text: %s', (payload) => {
    const legend = buildLegend(document, priceLinesFor([{ ...CITATIONS[0], label: payload }], 'S001'));
    document.body.append(legend);
    expectInert(expect, legend);
    expect(legend.querySelector('.legend-label').textContent).toBe(payload);
  });
});
