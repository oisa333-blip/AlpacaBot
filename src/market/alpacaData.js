'use strict';

const { AlpacaError } = require('../alpaca');
const { parseTimeframe } = require('./time');

const DATA_URL = 'https://data.alpaca.markets';

// Alpaca bar timeframe for a chart timeframe. Stock intraday charts above 30m are built from
// 30Min bars so they can be anchored to the 09:30 open like TradingView (Alpaca's own
// hourly bars start on the clock hour).
function alpacaTimeframe(timeframe, isCrypto) {
  const tf = parseTimeframe(timeframe);
  if (tf.unit === 'D') return { fetch: '1Day', aggregate: null };
  if (tf.unit === 'W') return { fetch: '1Week', aggregate: null };
  if (tf.unit === 'M') return { fetch: '1Month', aggregate: null };
  const m = tf.minutes;
  if (m < 60) return { fetch: `${m}Min`, aggregate: null };
  if (isCrypto) return { fetch: m % 60 === 0 ? `${m / 60}Hour` : `${m}Min`, aggregate: null };
  const base = [30, 15, 5, 1].find((b) => m % b === 0);
  return { fetch: `${base}Min`, aggregate: String(m) };
}

function createAlpacaData({ keyId, secretKey, feed = 'iex', fetchImpl = fetch }) {
  async function get(path, params) {
    const url = new URL(DATA_URL + path);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new AlpacaError(res.status, (data && data.message) || text || res.statusText, data);
    return data;
  }

  // Returns [{ t, o, h, l, c, v }] oldest first. start/end are Date or ISO strings.
  async function getBars(symbol, { timeframe, start, end, isCrypto = false, limit = 10000 }) {
    const iso = (d) => (d == null ? undefined : new Date(d).toISOString());
    const bars = [];
    let pageToken;
    do {
      let page;
      if (isCrypto) {
        const data = await get('/v1beta3/crypto/us/bars', {
          symbols: symbol,
          timeframe,
          start: iso(start),
          end: iso(end),
          limit,
          page_token: pageToken,
        });
        page = (data.bars && data.bars[symbol]) || [];
        pageToken = data.next_page_token;
      } else {
        const data = await get(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
          timeframe,
          start: iso(start),
          end: iso(end),
          limit,
          adjustment: 'split',
          feed,
          page_token: pageToken,
        });
        page = data.bars || [];
        pageToken = data.next_page_token;
      }
      for (const b of page) bars.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    } while (pageToken);
    return bars;
  }

  return { getBars };
}

module.exports = { createAlpacaData, alpacaTimeframe, DATA_URL };
