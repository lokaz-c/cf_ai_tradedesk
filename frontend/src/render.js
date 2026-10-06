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

// ── Grounding report ──────────────────────────────────────────

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Reads the report the Worker sends after a grounded answer (and stores with
 * saved analyses): `{ data: [...], citations: [...], unverified: [...] }`.
 * Accepts the object or its JSON text; anything malformed is dropped rather
 * than trusted. Returns null when there is nothing to show.
 */
export function parseGrounding(value) {
  let meta = value;
  if (typeof value === 'string') {
    try {
      meta = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isObject(meta)) return null;
  const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
  const data = list(meta.data).map((d) => ({
    service: text(d.service),
    ticker: text(d.ticker),
    status: text(d.status),
    source: text(d.source),
    synthetic: d.synthetic === true,
    asOf: text(d.asOf),
    detail: text(d.detail),
  }));
  const citations = list(meta.citations)
    .filter((c) => finite(c.value))
    .map((c) => ({ label: text(c.label), value: c.value, ticker: text(c.ticker), kind: text(c.kind), source: text(c.source) }));
  const unverified = list(meta.unverified)
    .filter((u) => finite(u.value))
    .map((u) => ({ text: text(u.text) || String(u.value), value: u.value }));
  const backtests = list(meta.backtests).map((b) => ({
    backtestId: finite(b.backtestId) ? b.backtestId : null,
    strategy: text(b.strategy),
    symbol: text(b.symbol),
    startDate: text(b.startDate),
    endDate: text(b.endDate),
    riskProfile: text(b.riskProfile),
    initialCapital: finite(b.initialCapital) ? b.initialCapital : null,
    synthetic: b.synthetic !== false,
    dataFile: text(b.dataFile),
    metrics: Object.fromEntries(
      BACKTEST_METRICS.map(({ key }) => [key, isObject(b.metrics) && finite(b.metrics[key]) ? b.metrics[key] : null]),
    ),
    // quant's reason for each null metric; older saved analyses have none.
    undefinedMetrics: Object.fromEntries(
      BACKTEST_METRICS.flatMap(({ key }) =>
        isObject(b.undefinedMetrics) && text(b.undefinedMetrics[key]) ? [[key, text(b.undefinedMetrics[key])]] : [],
      ),
    ),
    periodNote: text(b.periodNote),
  }));
  if (data.length === 0 && citations.length === 0 && unverified.length === 0 && backtests.length === 0) return null;
  return { data, citations, unverified, backtests };
}

/** quant's metrics, in the order and units the Worker documents (worker/src/backtest.ts). */
export const BACKTEST_METRICS = [
  { key: 'total_return', label: 'Total return', unit: 'percent' },
  { key: 'cagr', label: 'CAGR', unit: 'percent' },
  { key: 'max_drawdown', label: 'Max drawdown', unit: 'percent' },
  { key: 'volatility', label: 'Volatility (annualised)', unit: 'percent' },
  { key: 'sharpe_ratio', label: 'Sharpe ratio', unit: 'ratio' },
  { key: 'win_rate', label: 'Win rate', unit: 'percent' },
  { key: 'avg_win', label: 'Average win', unit: 'currency' },
  { key: 'avg_loss', label: 'Average loss', unit: 'currency' },
  { key: 'num_trades', label: 'Trades', unit: 'count' },
  { key: 'final_equity', label: 'Final equity', unit: 'currency' },
  { key: 'profit_factor', label: 'Profit factor', unit: 'ratio' },
  { key: 'max_consecutive_wins', label: 'Max consecutive wins', unit: 'count' },
  { key: 'max_consecutive_losses', label: 'Max consecutive losses', unit: 'count' },
];

/**
 * A metric as quant returned it, rounded for display. quant sends null for a
 * metric it cannot compute for the run, with the reason; that shows as
 * "n/a (reason)", or "n/a" when no reason was given.
 */
export function formatMetric(value, unit, reason = '') {
  if (!finite(value)) return reason ? `n/a (${reason})` : 'n/a';
  switch (unit) {
    case 'percent':
      return `${value.toFixed(2)}%`;
    case 'currency':
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'count':
      return String(Math.round(value));
    default:
      return value.toFixed(2);
  }
}

const UNAVAILABLE = new Set(['timeout', 'unavailable', 'bad_response']);

/** market-data's badge for a failed call; rate_limited means it asked the Worker to wait (the detail says how long). */
function failureBadge(status, fallback) {
  if (status === 'rate_limited') return 'BUSY';
  return UNAVAILABLE.has(status) ? 'UNAVAILABLE' : fallback;
}

/** One line per ticker and outcome: the data source, or why there was no data. */
function sourceLine(doc, d) {
  if (d.service === 'quant') {
    const ok = d.status === 'ok';
    const line = element(doc, 'div', `grounding-source ${ok ? (d.synthetic ? 'synthetic' : 'real') : 'error'}`);
    line.append(
      element(doc, 'span', 'grounding-ticker', d.ticker),
      element(doc, 'span', 'grounding-badge', ok ? (d.synthetic ? 'BACKTEST · SYNTHETIC DATA' : 'BACKTEST') : 'BACKTEST NOT RUN'),
      element(
        doc,
        'span',
        'grounding-detail',
        ok ? (d.synthetic ? "quant's synthetic dataset; symbol names are labels only, not real prices" : "quant's dataset") : d.detail,
      ),
    );
    return line;
  }
  if (d.status === 'ok') {
    const kind = d.synthetic ? 'synthetic' : 'real';
    const line = element(doc, 'div', `grounding-source ${kind}`);
    line.append(
      element(doc, 'span', 'grounding-ticker', d.ticker),
      element(doc, 'span', 'grounding-badge', d.synthetic ? 'SYNTHETIC DEMO DATA' : d.source.toUpperCase()),
      element(
        doc,
        'span',
        'grounding-detail',
        `${d.synthetic ? 'generated prices, not real market prices' : 'market data'}${d.asOf ? ` · as of ${d.asOf}` : ''}`,
      ),
    );
    return line;
  }
  const line = element(doc, 'div', 'grounding-source error');
  line.append(
    element(doc, 'span', 'grounding-ticker', d.ticker),
    element(doc, 'span', 'grounding-badge', failureBadge(d.status, 'NO DATA')),
    element(doc, 'span', 'grounding-detail', d.detail),
  );
  return line;
}

/**
 * The panel under a grounded answer: where its data came from (synthetic demo
 * data is labelled as such), the levels it cited, and any price-like numbers
 * that matched no provided value. Every value is set with textContent.
 * Returns null when the report is empty or malformed.
 */
export function buildGroundingPanel(doc, value) {
  const report = parseGrounding(value);
  if (!report) return null;
  const root = element(doc, 'div', 'grounding');

  const seen = new Set();
  for (const d of report.data) {
    const key = `${d.ticker}|${d.status}|${d.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    root.append(sourceLine(doc, d));
  }

  const levels = report.citations.filter((c) => c.kind !== 'backtest');
  if (levels.length > 0) {
    const section = element(doc, 'div', 'grounding-section');
    section.append(element(doc, 'div', 'grounding-label', 'Levels cited'));
    const list = element(doc, 'ul', 'grounding-list');
    for (const c of levels) {
      const item = element(doc, 'li', 'grounding-cited');
      item.append(
        element(doc, 'span', 'cited-label', c.label),
        element(doc, 'span', 'cited-value', String(c.value)),
        element(doc, 'span', 'cited-ticker', c.source === 'synthetic' ? `${c.ticker} · synthetic` : c.ticker),
      );
      list.append(item);
    }
    section.append(list);
    root.append(section);
  }

  for (const b of report.backtests) root.append(buildBacktestTable(doc, b));

  if (report.unverified.length > 0) {
    const section = element(doc, 'div', 'grounding-section warn');
    section.append(element(doc, 'div', 'grounding-label', 'Not in the data (unverified)'));
    const list = element(doc, 'ul', 'grounding-list');
    for (const u of report.unverified) list.append(element(doc, 'li', 'grounding-unverified', u.text));
    section.append(list);
    root.append(section);
  }
  return root;
}

/** The metrics of one backtest, as quant returned them, with its data source. */
export function buildBacktestTable(doc, b) {
  const section = element(doc, 'div', 'grounding-section grounding-backtest');
  section.append(
    element(doc, 'div', 'grounding-label', `Backtest${b.backtestId !== null ? ` · quant run ${b.backtestId}` : ''}`),
    element(
      doc,
      'div',
      'backtest-title',
      [
        `${b.strategy} on ${b.symbol}`,
        b.startDate && b.endDate ? `${b.startDate} to ${b.endDate}` : '',
        b.riskProfile,
        b.initialCapital !== null ? `initial capital ${formatMetric(b.initialCapital, 'currency')}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  const table = element(doc, 'table', 'backtest-table');
  const tbody = element(doc, 'tbody');
  for (const { key, label, unit } of BACKTEST_METRICS) {
    const row = element(doc, 'tr');
    const value = b.metrics[key];
    const cell = element(doc, 'td', finite(value) ? '' : 'metric-na', formatMetric(value, unit, b.undefinedMetrics?.[key] ?? ''));
    row.append(element(doc, 'th', '', label), cell);
    tbody.append(row);
  }
  table.append(tbody);
  if (b.periodNote) section.append(element(doc, 'div', 'backtest-note', b.periodNote));
  section.append(
    table,
    element(
      doc,
      'div',
      'backtest-note',
      b.synthetic
        ? `Synthetic data (quant's ${b.dataFile || 'sample dataset'}); symbol names are labels only, not real prices.`
        : `Data: quant's ${b.dataFile}, reported by quant as not synthetic.`,
    ),
  );
  return section;
}
