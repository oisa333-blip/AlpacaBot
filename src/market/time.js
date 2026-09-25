'use strict';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;
const RTH_MINUTES = RTH_CLOSE_MIN - RTH_OPEN_MIN;

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
});

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Wall-clock parts of a UTC millisecond timestamp in New York.
function nyParts(ms) {
  const parts = {};
  for (const p of nyFormat.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: WEEKDAYS[parts.weekday],
    minuteOfDay: hour * 60 + minute,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// Chart timeframe ("1", "5", "60", "240", "D", "W", "M") -> minutes, or the unit letter for D/W/M.
function parseTimeframe(tf) {
  const s = String(tf).trim().toUpperCase();
  if (s === 'D' || s === '1D') return { unit: 'D', minutes: 1440 };
  if (s === 'W' || s === '1W') return { unit: 'W', minutes: 10080 };
  if (s === 'M' || s === '1M') return { unit: 'M', minutes: 43200 };
  if (/^\d+$/.test(s) && Number(s) > 0) return { unit: 'min', minutes: Number(s) };
  throw new Error(`Unsupported timeframe "${tf}". Use minutes (1, 5, 15, 60, 240) or D, W, M`);
}

// Mirrors the Pine script's Auto HTF mapping.
function autoHtf(tf) {
  const s = parseTimeframe(tf).minutes * 60;
  if (s <= 60) return '15';
  if (s <= 180) return '30';
  if (s <= 300) return '60';
  if (s <= 3600) return '240';
  if (s <= 14400) return 'D';
  if (s <= 86400) return 'W';
  return 'M';
}

function isRegularSession(ms) {
  const p = nyParts(ms);
  return p.weekday >= 1 && p.weekday <= 5 && p.minuteOfDay >= RTH_OPEN_MIN && p.minuteOfDay < RTH_CLOSE_MIN;
}

// Last bar of the regular session: a bar opening at `ms` whose span reaches 16:00 NY.
function isLastRegularBar(ms, tfMinutes) {
  const p = nyParts(ms);
  return p.minuteOfDay < RTH_CLOSE_MIN && p.minuteOfDay + tfMinutes >= RTH_CLOSE_MIN;
}

module.exports = {
  MINUTE,
  DAY,
  RTH_OPEN_MIN,
  RTH_CLOSE_MIN,
  RTH_MINUTES,
  nyParts,
  parseTimeframe,
  autoHtf,
  isRegularSession,
  isLastRegularBar,
};
