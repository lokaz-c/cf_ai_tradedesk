import * as LightweightCharts from 'lightweight-charts';
import { buildLegend, chartTickerFor, createChartPanel } from './chart.js';
import { errorMessage, streamReplyInto } from './chat.js';
import {
  buildAnalysisItem,
  buildGroundingPanel,
  buildMessage,
  buildNotice,
  buildTickerHeader,
  parseGrounding,
  setMarkdown,
  showError,
} from './render.js';

// ── State ──────────────────────────────────────────────────
let sessionId = localStorage.getItem('tradedesk_session') || crypto.randomUUID();
let ticker = 'GBP/USD';
let timeframe = '4H';
let isStreaming = false;
let recognition = null;
let isRecording = false;

localStorage.setItem('tradedesk_session', sessionId);

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

// ── DOM refs ───────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const voiceBtn = document.getElementById('voiceBtn');
const voiceTranscript = document.getElementById('voiceTranscript');
const tickerInput = document.getElementById('tickerInput');
const timeframeSelect = document.getElementById('timeframeSelect');
const startSessionBtn = document.getElementById('startSessionBtn');
const historyList = document.getElementById('historyList');
const contextChip = document.getElementById('contextChip');
const topTicker = document.getElementById('topTicker');
const topTimeframe = document.getElementById('topTimeframe');
const chartBox = document.getElementById('chartBox');
const chartTicker = document.getElementById('chartTicker');
const chartSource = document.getElementById('chartSource');
const chartStatus = document.getElementById('chartStatus');
const chartLegend = document.getElementById('chartLegend');
const symbolSection = document.getElementById('symbolSection');
const symbolChips = document.getElementById('symbolChips');
const symbolList = document.getElementById('symbolList');

const scrollToEnd = () => {
  messagesEl.scrollTop = messagesEl.scrollHeight;
};

// ── Session ────────────────────────────────────────────────
async function startSession() {
  ticker = tickerInput.value.trim().toUpperCase() || 'GBP/USD';
  timeframe = timeframeSelect.value;
  tickerInput.value = ticker;

  let res;
  try {
    res = await fetch(`${WORKER_URL}/api/session/${sessionId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, timeframe, sessionId }),
    });
  } catch {
    showToast('Could not connect to the Worker');
    return;
  }

  if (!res.ok) {
    showToast(await errorMessage(res));
    return;
  }
  contextChip.style.display = 'flex';
  topTicker.textContent = ticker;
  topTimeframe.textContent = timeframe;
  showToast(`Session started: ${ticker} ${timeframe}`);
  loadHistory();
  loadChart(ticker);
  chatInput.placeholder = `Analyze ${ticker} on ${timeframe}...`;
}

// ── Chat ───────────────────────────────────────────────────
async function sendMessage(text) {
  if (!text.trim() || isStreaming) return;

  welcomeEl.style.display = 'none';
  addMessage('user', text);
  chatInput.value = '';
  autoResize();

  isStreaming = true;
  sendBtn.disabled = true;

  const assistantMsgEl = addMessage('assistant', '', true);

  try {
    let res;
    try {
      res = await fetch(`${WORKER_URL}/api/session/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
    } catch {
      showError(assistantMsgEl, 'Connection error. Is the Worker running?');
      return;
    }

    if (!res.ok || !res.body) {
      showError(assistantMsgEl, await errorMessage(res));
      return;
    }

    let report = null;
    const reply = await streamReplyInto(assistantMsgEl, res.body, scrollToEnd, (meta) => {
      report = meta;
    });
    if (!reply) showError(assistantMsgEl, 'The model returned an empty reply.');
    else showGrounding(assistantMsgEl, report);
  } catch {
    showError(assistantMsgEl, 'The reply stream was interrupted.');
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
    scrollToEnd();
  }
}

/**
 * Shows the grounding report (data sources, levels cited, unverified numbers)
 * under an answer, and draws the cited levels on the chart.
 */
function showGrounding(contentEl, report) {
  const panel = buildGroundingPanel(document, report);
  if (panel) contentEl.after(panel);
  showCitationsOnChart(report).catch(() => {});
}

// ── Chart panel ────────────────────────────────────────────
// Candles come from market-data through the Worker (/api/market/bars), so the
// browser never holds an API key and CORS stays the Worker's allow-list.

let chartPanel = null;
let chartRequest = 0;

/** Created on first use, so a deployment without market data never builds a canvas. */
function chart() {
  chartPanel ??= createChartPanel(chartBox, LightweightCharts);
  return chartPanel;
}

function showLegend(lines) {
  chartLegend.replaceChildren(
    lines.length > 0 ? buildLegend(document, lines) : buildNotice(document, 'chart-empty', 'None yet.'),
  );
}

function showChartSource(data) {
  if (!data) {
    chartSource.hidden = true;
    return;
  }
  chartSource.hidden = false;
  chartSource.className = `chart-source ${data.synthetic ? 'synthetic' : 'real'}`;
  chartSource.textContent = data.synthetic ? 'SYNTHETIC DEMO DATA' : String(data.source ?? '').toUpperCase();
  chartSource.title = String(data.sourceLabel ?? '');
}

/** Loads a year of daily bars for `symbol`. Resolves true when the chart shows it. */
async function loadChart(symbol) {
  const request = ++chartRequest;
  chartTicker.textContent = symbol;
  chartStatus.textContent = 'Loading daily bars...';
  showLegend([]);
  let res;
  try {
    res = await fetch(`${WORKER_URL}/api/market/bars/${encodeURIComponent(symbol)}`);
  } catch {
    if (request === chartRequest) chartStatus.textContent = 'Could not connect to the Worker.';
    return false;
  }
  if (request !== chartRequest) return false;
  if (!res.ok) {
    chartPanel?.clear();
    showChartSource(null);
    chartStatus.textContent = await errorMessage(res);
    return false;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    if (request === chartRequest) chartStatus.textContent = 'The Worker returned bars in an unexpected format.';
    return false;
  }
  if (request !== chartRequest) return false;
  chart().setBars(data.ticker, data.bars);
  chartTicker.textContent = data.ticker;
  showChartSource(data);
  const note = timeframe === 'D' ? '' : ` market-data serves daily bars only, not ${timeframe}.`;
  chartStatus.textContent = `Daily bars, ${data.from} to ${data.to}.${note}`;
  return true;
}

/** Draws an answer's cited levels, loading the cited ticker first if another one is charted. */
async function showCitationsOnChart(report) {
  const parsed = parseGrounding(report);
  if (!parsed) return;
  const target = chartTickerFor(parsed.citations, chartPanel?.ticker ?? null);
  if (!target) return;
  if (chartPanel?.ticker !== target && !(await loadChart(target))) return;
  showLegend(chart().showCitations(parsed.citations));
}

/** Lists market-data's symbols (synthetic S001... on the public demo) as one-click sessions. */
async function loadSymbols() {
  let res;
  try {
    res = await fetch(`${WORKER_URL}/api/market/symbols`);
  } catch {
    return;
  }
  if (!res.ok) {
    if (res.status === 503) chartStatus.textContent = await errorMessage(res);
    return;
  }
  let symbols;
  try {
    ({ symbols } = await res.json());
  } catch {
    return;
  }
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  symbolChips.replaceChildren();
  symbolList.replaceChildren();
  for (const s of symbols) {
    const chip = document.createElement('button');
    chip.className = 'symbol-chip';
    chip.type = 'button';
    chip.textContent = String(s.ticker);
    chip.title = `${s.name ?? s.ticker} (${s.source})`;
    chip.onclick = () => {
      tickerInput.value = String(s.ticker);
      startSession();
    };
    symbolChips.append(chip);
    const option = document.createElement('option');
    option.value = String(s.ticker);
    symbolList.append(option);
  }
  symbolSection.hidden = false;
}

function addMessage(role, content, streaming = false) {
  const label = role === 'user' ? 'You' : `TradeDesk AI · ${ticker || 'General'}`;
  const { root, content: contentEl } = buildMessage(document, role, {
    label,
    text: content,
    typing: streaming,
  });
  messagesEl.appendChild(root);
  scrollToEnd();
  return contentEl;
}

// ── History ────────────────────────────────────────────────
async function loadHistory() {
  try {
    const tickersRes = await fetch(`${WORKER_URL}/api/tickers`);
    const { results } = await tickersRes.json();

    if (!results || results.length === 0) {
      historyList.replaceChildren(buildNotice(document, 'history-empty', 'No analyses yet.'));
      return;
    }

    historyList.replaceChildren();
    for (const row of results) {
      const group = document.createElement('div');
      group.className = 'ticker-group';

      const header = buildTickerHeader(document, row);
      const analyses = document.createElement('div');
      analyses.className = 'ticker-analyses';

      header.onclick = async () => {
        const isOpen = analyses.classList.contains('open');
        if (!isOpen && analyses.children.length === 0) {
          try {
            const res = await fetch(`${WORKER_URL}/api/history/${encodeURIComponent(row.ticker)}`);
            if (!res.ok) return;
            const { results: items } = await res.json();
            for (const item of items ?? []) {
              const a = buildAnalysisItem(document, item);
              a.onclick = (e) => {
                e.stopPropagation();
                welcomeEl.style.display = 'none';
                addMessage('user', item.user_query);
                const el = addMessage('assistant', '');
                setMarkdown(el, item.ai_response);
                showGrounding(el, item.grounding);
              };
              analyses.appendChild(a);
            }
          } catch {
            return;
          }
        }
        analyses.classList.toggle('open');
      };

      group.appendChild(header);
      group.appendChild(analyses);
      historyList.appendChild(group);
    }
  } catch {}
}

// ── Voice input ────────────────────────────────────────────
function initVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceBtn.title = 'Voice not supported in this browser';
    voiceBtn.style.opacity = '0.4';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results)
      .map((r) => r[0].transcript)
      .join('');
    voiceTranscript.textContent = transcript;
    if (e.results[e.results.length - 1].isFinal) {
      chatInput.value = transcript;
      voiceTranscript.textContent = '';
      autoResize();
    }
  };

  recognition.onend = () => {
    isRecording = false;
    voiceBtn.classList.remove('recording');
  };
}

voiceBtn.addEventListener('click', () => {
  if (!recognition) return;
  if (isRecording) {
    recognition.stop();
  } else {
    recognition.start();
    isRecording = true;
    voiceBtn.classList.add('recording');
    voiceTranscript.textContent = 'Listening...';
  }
});

// ── Textarea auto-resize ───────────────────────────────────
function autoResize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

chatInput.addEventListener('input', autoResize);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

// Ctrl+K to clear
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    clearChat();
  }
});

sendBtn.addEventListener('click', () => sendMessage(chatInput.value));
startSessionBtn.addEventListener('click', startSession);

// ── Quick prompts ──────────────────────────────────────────
// Buttons and chips carry their prompt in a data-prompt attribute.
document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target.closest('[data-prompt]') : null;
  if (!target) return;
  const text = target.getAttribute('data-prompt');
  chatInput.value = text;
  autoResize();
  sendMessage(text);
});

// ── Clear chat ─────────────────────────────────────────────
async function clearChat() {
  try {
    await fetch(`${WORKER_URL}/api/session/${sessionId}/clear`, { method: 'DELETE' });
  } catch {}
  messagesEl.replaceChildren(welcomeEl);
  welcomeEl.style.display = 'flex';
  showToast('Chat cleared');
}

// ── Toast ──────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── Init ───────────────────────────────────────────────────
initVoice();
loadHistory();
loadSymbols();
