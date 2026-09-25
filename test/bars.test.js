'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateBars, filterRegularSession, parseCsvBars } = require('../src/market/bars');
const { nyParts, autoHtf, parseTimeframe, isLastRegularBar } = require('../src/market/time');
const { syntheticStockBars } = require('../src/market/synthetic');

const ny = (ms) => {
  const p = nyParts(ms);
  return `${p.dateKey} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

test('new york time handles daylight saving', () => {
  assert.equal(ny(Date.parse('2025-01-06T14:30:00Z')), '2025-01-06 09:30'); // EST
  assert.equal(ny(Date.parse('2025-07-07T13:30:00Z')), '2025-07-07 09:30'); // EDT
});

test('timeframes and auto HTF match the Pine mapping', () => {
  assert.deepEqual(parseTimeframe('240'), { unit: 'min', minutes: 240 });
  assert.equal(parseTimeframe('D').unit, 'D');
  assert.throws(() => parseTimeframe('5x'));
  assert.deepEqual(['1', '3', '5', '15', '60', '240', 'D', 'W'].map(autoHtf), ['15', '30', '60', '240', '240', 'D', 'W', 'M']);
});

test('synthetic data is regular session only, across a DST change', () => {
  const bars = syntheticStockBars({ startDate: '2025-03-06', days: 6, tfMinutes: 30 });
  assert.equal(bars.length, 6 * 13);
  assert.equal(filterRegularSession(bars).length, bars.length);
  assert.equal(ny(bars[0].t), '2025-03-06 09:30');
  assert.equal(ny(bars[bars.length - 13].t), '2025-03-13 09:30');
});

test('hourly bars are anchored to 09:30 and the last one ends at 16:00', () => {
  const bars = syntheticStockBars({ startDate: '2025-01-06', days: 1, tfMinutes: 30 });
  const hourly = aggregateBars(bars, '60', { session: 'rth' });
  assert.equal(hourly.length, 7);
  assert.deepEqual(hourly.map((b) => ny(b.t)), ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30'].map((t) => `2025-01-06 ${t}`));
  assert.equal(ny(hourly[0].closeTime), '2025-01-06 10:30');
  assert.equal(ny(hourly[6].closeTime), '2025-01-06 16:00');
  const first = bars.slice(0, 2);
  assert.deepEqual(
    { o: hourly[0].o, h: hourly[0].h, l: hourly[0].l, c: hourly[0].c, v: hourly[0].v },
    { o: first[0].o, h: Math.max(first[0].h, first[1].h), l: Math.min(first[0].l, first[1].l), c: first[1].c, v: first[0].v + first[1].v },
  );
});

test('4H and daily buckets', () => {
  const bars = syntheticStockBars({ startDate: '2025-01-06', days: 2, tfMinutes: 30 });
  const h4 = aggregateBars(bars, '240', { session: 'rth' });
  assert.deepEqual(h4.map((b) => ny(b.t).slice(11)), ['09:30', '13:30', '09:30', '13:30']);
  const daily = aggregateBars(bars, 'D', { session: 'rth' });
  assert.equal(daily.length, 2);
  assert.ok(daily[0].closeTime <= bars[13].t, 'day 1 closes before day 2 opens');
  assert.ok(daily[0].closeTime > bars[12].t);
});

test('24h buckets for crypto', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const bars = Array.from({ length: 8 }, (_, i) => ({ t: start + i * 3600000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }));
  const h4 = aggregateBars(bars, '240', { session: '24h' });
  assert.equal(h4.length, 2);
  assert.equal(h4[0].closeTime, start + 4 * 3600000);
});

test('last regular bar detection', () => {
  assert.ok(isLastRegularBar(Date.parse('2025-01-06T20:55:00Z'), 5)); // 15:55 NY
  assert.ok(!isLastRegularBar(Date.parse('2025-01-06T20:50:00Z'), 5));
  assert.ok(isLastRegularBar(Date.parse('2025-01-06T20:30:00Z'), 60)); // 15:30 hourly
});

test('csv parsing accepts iso and unix times in any column order', () => {
  const earlier = Date.parse('2025-01-06T14:30:00Z') / 1000;
  const csv = `Volume,Time,Open,High,Low,Close\n10,2025-01-06T14:35:00Z,2,3,1,2.5\n5,${earlier},1,2,0.5,1.5\n`;
  const bars = parseCsvBars(csv);
  assert.deepEqual(bars, [
    { t: earlier * 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 },
    { t: Date.parse('2025-01-06T14:35:00Z'), o: 2, h: 3, l: 1, c: 2.5, v: 10 },
  ]);
});
