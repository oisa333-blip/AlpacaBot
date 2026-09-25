'use strict';

const { MINUTE, DAY, RTH_OPEN_MIN, RTH_CLOSE_MIN, nyParts } = require('./time');

// Deterministic sample data for tests and demos. NOT market data: a random walk that
// switches between trending and ranging regimes, with a U-shaped intraday volume curve.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Regular-session stock bars (09:30-16:00 NY, weekdays) starting on `startDate` (YYYY-MM-DD).
function syntheticStockBars({ startDate = '2025-01-06', days = 60, tfMinutes = 5, startPrice = 100, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const bars = [];
  let price = startPrice;
  let drift = 0;
  let regimeLeft = 0;

  let dayMs = Date.parse(`${startDate}T12:00:00Z`);
  let produced = 0;
  while (produced < days) {
    const p = nyParts(dayMs);
    if (p.weekday >= 1 && p.weekday <= 5) {
      // 09:30 NY for this date = 12:00Z adjusted by the NY offset at noon UTC.
      const openMs = dayMs + (RTH_OPEN_MIN - p.minuteOfDay) * MINUTE;
      price *= 1 + gaussian(rand) * 0.004; // overnight gap
      for (let m = RTH_OPEN_MIN; m < RTH_CLOSE_MIN; m += tfMinutes) {
        if (regimeLeft <= 0) {
          const trending = rand() < 0.5;
          drift = trending ? (rand() < 0.5 ? -1 : 1) * (0.0004 + rand() * 0.0008) : 0;
          regimeLeft = 20 + Math.floor(rand() * 120);
        }
        regimeLeft--;
        const vol = 0.0015 * Math.sqrt(tfMinutes / 5);
        const o = price;
        const c = o * (1 + drift + gaussian(rand) * vol);
        const h = Math.max(o, c) * (1 + Math.abs(gaussian(rand)) * vol * 0.5);
        const l = Math.min(o, c) * (1 - Math.abs(gaussian(rand)) * vol * 0.5);
        const x = (m - RTH_OPEN_MIN) / (RTH_CLOSE_MIN - RTH_OPEN_MIN);
        const shape = 1 + 2.5 * (x - 0.5) ** 2 * 4;
        const v = Math.round(20000 * shape * (0.5 + rand()) * (1 + Math.abs(c - o) / o / vol));
        const r = (n) => Math.round(n * 100) / 100;
        bars.push({ t: openMs + (m - RTH_OPEN_MIN) * MINUTE, o: r(o), h: r(h), l: r(l), c: r(c), v });
        price = c;
      }
      produced++;
    }
    dayMs += DAY;
  }
  return bars;
}

module.exports = { syntheticStockBars, mulberry32 };
