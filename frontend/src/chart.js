// The chart panel: daily candles from market-data (through the Worker) and a
// price line for each level the latest answer cited.
//
// Charts are drawn with TradingView Lightweight Charts. Its licence asks for
// the attribution notice from its NOTICE file and a link to
// https://www.tradingview.com/ on the page; the notice is:
//
//   TradingView Lightweight Charts™
//   Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
//
// The page shows it under the chart, and the chart keeps the library's
// attribution logo, which links to tradingview.com.
//
// The chart library is passed in rather than imported here, so the logic can
// be tested in jsdom (which has no canvas) with a fake.

const COLORS = {
  resistance: '#ff3d57',
  support: '#00e676',
  pivot: '#00d4ff',
  close: '#e8f1f8',
  bar: '#ffb300',
};

/** What kind of level a citation label names, for its colour and line style. */
export function levelKind(label) {
  if (/^R\d$/.test(label) || /\bhigh$/i.test(label)) return 'resistance';
  if (/^S\d$/.test(label) || /\blow$/i.test(label)) return 'support';
  if (label === 'P') return 'pivot';
  if (label === 'Close' || /\bclose$/i.test(label)) return 'close';
  return 'bar';
}

/** market-data bars as Lightweight Charts candles (time as YYYY-MM-DD business days). */
export function toCandles(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .filter(
      (b) =>
        b &&
        typeof b.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(b.date) &&
        [b.open, b.high, b.low, b.close].every((v) => typeof v === 'number' && Number.isFinite(v)),
    )
    .map((b) => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }));
}

/**
 * The price lines to draw for an answer's citations: levels and bar values
 * (not backtest metrics) for the charted ticker, one line per label and price.
 * `lineStyle` is a Lightweight Charts LineStyle value from `lineStyles`.
 */
export function priceLinesFor(citations, ticker, lineStyles = { Solid: 0, Dotted: 1, Dashed: 2 }) {
  if (!Array.isArray(citations) || !ticker) return [];
  const seen = new Set();
  const lines = [];
  for (const c of citations) {
    if (!c || (c.kind !== 'level' && c.kind !== 'bar')) continue;
    if (c.ticker !== ticker || typeof c.value !== 'number' || !Number.isFinite(c.value)) continue;
    const label = typeof c.label === 'string' ? c.label : '';
    const key = `${label}|${c.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = levelKind(label);
    lines.push({
      price: c.value,
      title: label,
      kind,
      color: COLORS[kind],
      lineStyle: kind === 'pivot' ? lineStyles.Dashed : kind === 'bar' || kind === 'close' ? lineStyles.Solid : lineStyles.Dotted,
    });
  }
  return lines.sort((a, b) => b.price - a.price);
}

/**
 * Which ticker to chart for a set of citations: the one on the chart if any
 * citation is for it, otherwise the ticker of the first level or bar cited.
 * Null when nothing citable was cited.
 */
export function chartTickerFor(citations, current) {
  if (!Array.isArray(citations)) return null;
  const plottable = citations.filter((c) => c && (c.kind === 'level' || c.kind === 'bar') && typeof c.ticker === 'string' && c.ticker);
  if (plottable.length === 0) return null;
  if (current && plottable.some((c) => c.ticker === current)) return current;
  return plottable[0].ticker;
}

/** The legend under the chart: one row per price line, set with textContent. */
export function buildLegend(doc, lines) {
  const list = doc.createElement('ul');
  list.className = 'chart-legend';
  for (const line of lines) {
    const item = doc.createElement('li');
    item.className = `legend-${line.kind}`;
    const swatch = doc.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = line.color;
    const label = doc.createElement('span');
    label.className = 'legend-label';
    label.textContent = line.title;
    const price = doc.createElement('span');
    price.className = 'legend-price';
    price.textContent = String(line.price);
    item.append(swatch, label, price);
    list.append(item);
  }
  return list;
}

/** Chart colours, matching the page's CSS variables. */
const THEME = {
  background: '#0d1117',
  text: '#7a9bb5',
  grid: '#1e2d3d',
  up: '#00e676',
  down: '#ff3d57',
};

/**
 * Creates the chart in `container` and returns the panel's controls.
 * `lib` is the lightweight-charts module (or a fake with the same members:
 * createChart, CandlestickSeries, ColorType, LineStyle).
 */
export function createChartPanel(container, lib) {
  const chart = lib.createChart(container, {
    autoSize: true,
    layout: {
      background: { type: lib.ColorType.Solid, color: THEME.background },
      textColor: THEME.text,
      fontFamily: "'Space Mono', monospace",
      fontSize: 10,
      // The logo links to tradingview.com, as the library's licence asks.
      attributionLogo: true,
    },
    grid: { vertLines: { color: THEME.grid }, horzLines: { color: THEME.grid } },
    rightPriceScale: { borderColor: THEME.grid },
    timeScale: { borderColor: THEME.grid },
  });
  const candles = chart.addSeries(lib.CandlestickSeries, {
    upColor: THEME.up,
    downColor: THEME.down,
    borderUpColor: THEME.up,
    borderDownColor: THEME.down,
    wickUpColor: THEME.up,
    wickDownColor: THEME.down,
  });
  let ticker = null;
  let priceLines = [];
  let drawn = [];

  const clearLines = () => {
    for (const line of priceLines) candles.removePriceLine(line);
    priceLines = [];
    drawn = [];
  };

  return {
    get ticker() {
      return ticker;
    },
    /** Shows `bars` for `newTicker` and removes the previous price lines. */
    setBars(newTicker, bars) {
      clearLines();
      ticker = newTicker;
      candles.setData(toCandles(bars));
      chart.timeScale().fitContent();
    },
    /** Draws the cited levels for the charted ticker; returns the lines drawn. */
    showCitations(citations) {
      clearLines();
      drawn = priceLinesFor(citations, ticker, lib.LineStyle);
      priceLines = drawn.map((line) =>
        candles.createPriceLine({
          price: line.price,
          title: line.title,
          color: line.color,
          lineStyle: line.lineStyle,
          lineWidth: 1,
          axisLabelVisible: true,
        }),
      );
      return drawn;
    },
    /** Removes the candles and the price lines. */
    clear() {
      clearLines();
      ticker = null;
      candles.setData([]);
    },
    destroy() {
      chart.remove();
    },
  };
}
