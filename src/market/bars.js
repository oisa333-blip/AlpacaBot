'use strict';

const { MINUTE, DAY, RTH_OPEN_MIN, RTH_CLOSE_MIN, nyParts, parseTimeframe, isRegularSession } = require('./time');

// Bars are { t, o, h, l, c, v } with t = open time in UTC milliseconds.

function filterRegularSession(bars) {
  return bars.filter((b) => isRegularSession(b.t));
}

// Groups bars into higher-timeframe buckets. Each result carries closeTime: the moment the
// bucket is complete. Stock (session) buckets are anchored to 09:30 NY like TradingView.
function aggregateBars(bars, timeframe, { session = 'rth' } = {}) {
  const tf = parseTimeframe(timeframe);
  const out = [];
  let cur = null;

  for (const b of bars) {
    const { key, closeTime } = bucketOf(b.t, tf, session);
    if (!cur || cur.key !== key) {
      if (cur) out.push(finish(cur));
      cur = { key, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, closeTime };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(finish(cur));
  return out;
}

function finish(cur) {
  const { key, ...bar } = cur;
  return bar;
}

function bucketOf(ms, tf, session) {
  if (tf.unit === 'min') {
    if (session === 'rth') {
      const p = nyParts(ms);
      const idx = Math.floor((p.minuteOfDay - RTH_OPEN_MIN) / tf.minutes);
      const startMin = RTH_OPEN_MIN + idx * tf.minutes;
      // closeTime = bucket end (capped at 16:00), measured from this bar's wall-clock offset.
      const endMin = Math.min(startMin + tf.minutes, RTH_CLOSE_MIN);
      const closeTime = ms + (endMin - p.minuteOfDay) * MINUTE;
      return { key: `${p.dateKey}#${idx}`, closeTime };
    }
    const span = tf.minutes * MINUTE;
    const start = Math.floor(ms / span) * span;
    return { key: String(start), closeTime: start + span };
  }

  if (session !== 'rth' && tf.unit !== 'M') {
    // 24h markets (crypto): UTC days, weeks starting Monday 00:00 UTC.
    const dayStart = Math.floor(ms / DAY) * DAY;
    if (tf.unit === 'D') return { key: String(dayStart), closeTime: dayStart + DAY };
    const weekday = new Date(dayStart).getUTCDay();
    const monday = dayStart - ((weekday + 6) % 7) * DAY;
    return { key: `W${monday}`, closeTime: monday + 7 * DAY };
  }

  const p = nyParts(ms);
  const midnight = ms - (p.minuteOfDay * MINUTE) - (new Date(ms).getUTCSeconds() * 1000);
  if (tf.unit === 'D') return { key: p.dateKey, closeTime: midnight + DAY };
  if (tf.unit === 'W') {
    const monday = midnight - ((p.weekday + 6) % 7) * DAY;
    return { key: `W${nyParts(monday + 12 * 60 * MINUTE).dateKey}`, closeTime: monday + 7 * DAY };
  }
  const nextMonth = p.month === 12 ? Date.UTC(p.year + 1, 0, 1) : Date.UTC(p.year, p.month, 1);
  return { key: `${p.year}-${p.month}`, closeTime: nextMonth };
}

// Parses CSV with a header containing time/open/high/low/close/volume (any order, case-insensitive).
// time may be ISO-8601 or unix seconds/milliseconds.
function parseCsvBars(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(',').map((h) => h.trim().toLowerCase());
  const col = (names) => {
    const i = header.findIndex((h) => names.includes(h));
    if (i < 0) throw new Error(`CSV is missing a ${names[0]} column`);
    return i;
  };
  const ti = col(['time', 'timestamp', 'date', 'datetime', 't']);
  const oi = col(['open', 'o']);
  const hi = col(['high', 'h']);
  const li = col(['low', 'l']);
  const ci = col(['close', 'c']);
  let vi = -1;
  try {
    vi = col(['volume', 'vol', 'v']);
  } catch {
    vi = -1;
  }

  const bars = lines
    .filter((l) => l.trim())
    .map((line) => {
      const f = line.split(',');
      return {
        t: parseTime(f[ti]),
        o: Number(f[oi]),
        h: Number(f[hi]),
        l: Number(f[li]),
        c: Number(f[ci]),
        v: vi >= 0 ? Number(f[vi]) || 0 : 0,
      };
    });
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

function parseTime(value) {
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Bad time value "${value}"`);
  return ms;
}

module.exports = { filterRegularSession, aggregateBars, parseCsvBars };
