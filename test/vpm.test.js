'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveParams, computeSeries, createEngine, runStrategy, warmupBars } = require('../src/strategy/vpm');
const { syntheticStockBars } = require('../src/market/synthetic');

test('presets and auto HTF resolve like the Pine inputs', () => {
  const scalp = resolveParams({}, '5');
  assert.deepEqual([scalp.volLen, scalp.priceLen, scalp.smoothLen, scalp.htfTf], [20, 30, 5, '60']);
  const swing = resolveParams({ preset: 'Swing' }, '15');
  assert.deepEqual([swing.volLen, swing.priceLen, swing.smoothLen, swing.htfTf], [30, 50, 10, '240']);
  const custom = resolveParams({ preset: 'Custom', volLen: 7 }, '5');
  assert.equal(custom.volLen, 7);
  assert.equal(resolveParams({ useTp: true, useStop: false }, '5').tpOn, false);
});

test('bad params are rejected', () => {
  assert.throws(() => resolveParams({ htfMode: 'Manual', htfManual: '5' }, '15'), /higher/);
  assert.throws(() => resolveParams({ buyThr: 50 }, '5'), /buyThr/);
  assert.throws(() => resolveParams({ htfFilter: 'Nope' }, '5'), /htfFilter/);
  assert.doesNotThrow(() => resolveParams({ htfFilter: 'Off', htfMode: 'Manual', htfManual: '1' }, '5'));
});

test('series never look ahead (including the higher timeframe)', () => {
  const bars = syntheticStockBars({ days: 25, tfMinutes: 5, seed: 7 });
  const p = resolveParams({}, '5');
  const full = computeSeries(bars, p);
  // Scramble everything after bar k; values up to k must not change.
  for (const k of [400, 900, 1500]) {
    const tampered = bars.map((b, i) => (i <= k ? b : { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 3, c: b.c * 3, v: b.v * 9 }));
    const partial = computeSeries(tampered, p);
    for (let i = 0; i <= k; i++) {
      for (const key of ['score', 'htfScore', 'adx', 'atr', 'chop']) {
        const a = full[i][key];
        const b = partial[i][key];
        assert.ok((Number.isNaN(a) && Number.isNaN(b)) || a === b, `${key} changed at bar ${i} after tampering past ${k}`);
      }
      assert.equal(full[i].htfBull, partial[i].htfBull);
      assert.equal(full[i].inRange, partial[i].inRange);
    }
  }
});

test('htf values only change when an HTF bar closes', () => {
  const bars = syntheticStockBars({ days: 10, tfMinutes: 5, seed: 3 });
  const series = computeSeries(bars, resolveParams({}, '5')); // HTF 60 = 12 bars
  let changes = 0;
  for (let i = 1; i < bars.length; i++) {
    const a = series[i - 1].htfScore;
    const b = series[i].htfScore;
    if (Number.isFinite(a) && a !== b) {
      changes++;
      const minuteNy = new Date(bars[i].t).getUTCMinutes();
      assert.equal(minuteNy % 60, 30, 'hourly HTF updates on the :30 bar');
    }
  }
  assert.ok(changes > 20);
});

// Drives the state machine with hand-made series values.
function makeSeries(overrides = {}) {
  return { score: 50, htfBull: true, htfBear: true, inRange: false, atr: 1, eodBar: false, ...overrides };
}
const bar = (c, extra = {}) => ({ t: 0, o: c, h: c + 0.1, l: c - 0.1, c, v: 1, ...extra });

test('engine: long entry sets stop and target from ATR', () => {
  const p = resolveParams({ atrMult: 2, tpR: 1.5 }, '5');
  const e = createEngine(p);
  const r = e.step(bar(100), makeSeries({ score: 60 }));
  assert.ok(r.longEntry);
  assert.equal(r.sig, 1);
  assert.equal(r.stopLvl, 98);
  assert.equal(r.tpLvl, 103);
});

test('engine: HTF and range filters block entries', () => {
  const p = resolveParams({}, '5');
  assert.ok(!createEngine(p).step(bar(100), makeSeries({ score: 60, htfBull: false })).longEntry);
  assert.ok(!createEngine(p).step(bar(100), makeSeries({ score: 60, inRange: true })).longEntry);
  assert.ok(!createEngine({ ...p, allowShorts: false }).step(bar(100), makeSeries({ score: 40 })).shortEntry);
  assert.ok(createEngine(p).step(bar(100), makeSeries({ score: 40 })).shortEntry);
});

test('engine: stop exit, then no re-entry until the score resets', () => {
  const p = resolveParams({}, '5');
  const e = createEngine(p);
  e.step(bar(100), makeSeries({ score: 60 })); // stop 98
  const stopped = e.step(bar(99, { l: 97.5 }), makeSeries({ score: 62 }));
  assert.ok(stopped.stopLong);
  assert.equal(stopped.sig, 0);
  assert.ok(!e.step(bar(99), makeSeries({ score: 63 })).longEntry, 'still disarmed');
  e.step(bar(99), makeSeries({ score: 52 })); // dips below buyThr -> re-armed
  assert.ok(e.step(bar(99), makeSeries({ score: 58 })).longEntry);
});

test('engine: take profit, score exit, HTF-loss exit, EOD', () => {
  const p = resolveParams({}, '5');
  let e = createEngine(p);
  e.step(bar(100), makeSeries({ score: 60 })); // tp 104
  assert.ok(e.step(bar(103, { h: 104.2 }), makeSeries({ score: 60 })).tpLong);

  e = createEngine({ ...p, allowShorts: false });
  e.step(bar(100), makeSeries({ score: 60 }));
  assert.ok(e.step(bar(100), makeSeries({ score: 44 })).longExit);

  e = createEngine(p);
  e.step(bar(100), makeSeries({ score: 60 }));
  assert.ok(e.step(bar(100), makeSeries({ score: 58, htfBull: false })).longExit);

  e = createEngine(p);
  e.step(bar(100), makeSeries({ score: 60 }));
  const eod = e.step(bar(100), makeSeries({ score: 60, eodBar: true }));
  assert.ok(eod.eodExit);
  assert.ok(!eod.longEntry, 'no entry on the EOD bar');
});

test('engine: reversal from long to short', () => {
  const p = resolveParams({}, '5');
  const e = createEngine(p);
  e.step(bar(100), makeSeries({ score: 60 }));
  const r = e.step(bar(100), makeSeries({ score: 40 }));
  assert.ok(r.shortEntry);
  assert.equal(r.sig, -1);
  assert.equal(r.stopLvl, 102);
});

test('runStrategy produces trades on sample data and warmup is sane', () => {
  const bars = syntheticStockBars({ days: 30, tfMinutes: 5, seed: 11 });
  const p = resolveParams({}, '5');
  const rows = runStrategy(bars, p);
  const entries = rows.filter((r) => r.signal.longEntry || r.signal.shortEntry).length;
  assert.ok(entries > 5, `expected some entries, got ${entries}`);
  const w = warmupBars(p);
  assert.ok(w > 100 && w < 3000, `warmup ${w}`);
});
