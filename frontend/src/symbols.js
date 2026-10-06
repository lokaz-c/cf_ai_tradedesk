// The symbols market-data serves (through the Worker's /api/market/symbols),
// offered as one-click sessions and as the default instrument.
//
// market-data covers US equities and its synthetic S001... series, not forex,
// so when it is connected a new session starts on the first symbol it lists
// instead of GBP/USD. GBP/USD still works: the answer just has no grounding.

import { errorMessage } from './chat.js';

/** The instrument a new session uses when market-data lists nothing. */
export const FALLBACK_TICKER = 'GBP/USD';

const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

/**
 * Fetches the symbol list. Resolves `{ symbols }` (possibly empty) or
 * `{ error, status }`, never throws; entries without a valid ticker are dropped.
 */
export async function fetchSymbols(workerUrl, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(`${workerUrl}/api/market/symbols`);
  } catch {
    return { error: 'Could not connect to the Worker.', status: 0 };
  }
  if (!res.ok) return { error: await errorMessage(res), status: res.status };
  let body;
  try {
    body = await res.json();
  } catch {
    return { error: 'The Worker returned symbols in an unexpected format.', status: res.status };
  }
  const list = body && Array.isArray(body.symbols) ? body.symbols : [];
  const symbols = list
    .filter((s) => s && typeof s.ticker === 'string' && TICKER.test(s.ticker))
    .map((s) => ({
      ticker: s.ticker,
      name: typeof s.name === 'string' ? s.name : null,
      source: typeof s.source === 'string' ? s.source : '',
      feed: typeof s.feed === 'string' ? s.feed : null,
    }));
  return { symbols };
}

/** The first listed symbol, or the fallback when there is none. */
export function defaultTicker(symbols, fallback = FALLBACK_TICKER) {
  return Array.isArray(symbols) && symbols.length > 0 ? symbols[0].ticker : fallback;
}

/**
 * Points the instrument input at market-data's first symbol, unless the user
 * has typed something else or a session has started. Returns the ticker the
 * input now suggests.
 */
export function suggestTicker(input, symbols, { edited = false, started = false } = {}) {
  const ticker = defaultTicker(symbols);
  input.placeholder = ticker;
  if (!edited && !started && input.value.trim().toUpperCase() === FALLBACK_TICKER) input.value = ticker;
  return input.value.trim().toUpperCase() || ticker;
}

/** One button per symbol, labelled with textContent; `onPick(ticker)` runs on click. */
export function buildSymbolChips(doc, symbols, onPick) {
  return symbols.map((s) => {
    const chip = doc.createElement('button');
    chip.className = 'symbol-chip';
    chip.type = 'button';
    chip.textContent = s.ticker;
    chip.title = `${s.name ?? s.ticker} (${[s.source, s.feed ? `${s.feed.toUpperCase()} feed` : ''].filter(Boolean).join(', ')})`;
    chip.addEventListener('click', () => onPick(s.ticker));
    return chip;
  });
}

/** `<option>`s for the instrument input's datalist. */
export function buildSymbolOptions(doc, symbols) {
  return symbols.map((s) => {
    const option = doc.createElement('option');
    option.value = s.ticker;
    return option;
  });
}
