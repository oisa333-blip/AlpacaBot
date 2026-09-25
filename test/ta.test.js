'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ta = require('../src/strategy/ta');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma needs a full window and propagates na', () => {
  assert.deepEqual(ta.sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  assert.ok(Number.isNaN(ta.sma([1, 2, 3], 2)[0]));
  assert.ok(Number.isNaN(ta.sma([1, NaN, 3, 4], 2)[2]));
});

test('ema seeds with the first value like Pine', () => {
  const out = ta.ema([10, 20, 30], 3); // alpha 0.5
  assert.deepEqual(out, [10, 15, 22.5]);
  // Leading na: restarts from the first real value.
  const withNa = ta.ema([NaN, NaN, 4, 8], 3);
  assert.ok(Number.isNaN(withNa[1]));
  assert.deepEqual(withNa.slice(2), [4, 6]);
});

test('rma seeds with the SMA of the first window', () => {
  const out = ta.rma([2, 4, 6, 8], 2); // alpha 0.5, seed sma(2,4)=3 at index 1
  assert.ok(Number.isNaN(out[0]));
  assert.deepEqual(out.slice(1), [3, 4.5, 6.25]);
});

test('percentrank counts previous values <= current', () => {
  const out = ta.percentrank([1, 2, 3, 2, 5], 3);
  assert.ok(out.slice(0, 3).every(Number.isNaN));
  close(out[3], (2 / 3) * 100); // previous 3,2,1 vs 2 -> 2 of 3
  close(out[4], 100);
});

test('highest, lowest, sum, cum', () => {
  assert.deepEqual(ta.highest([1, 5, 2, 4], 2).slice(1), [5, 5, 4]);
  assert.deepEqual(ta.lowest([1, 5, 2, 4], 2).slice(1), [1, 2, 2]);
  assert.deepEqual(ta.sum([1, 2, 3], 2).slice(1), [3, 5]);
  assert.deepEqual(ta.cum([1, NaN, 2]), [1, 1, 3]);
});

test('true range and atr', () => {
  const high = [10, 12, 11];
  const low = [8, 9, 7];
  const cls = [9, 11, 8];
  assert.deepEqual(ta.tr(high, low, cls, true), [2, 3, 4]);
  assert.ok(Number.isNaN(ta.tr(high, low, cls, false)[0]));
  assert.deepEqual(ta.atr(high, low, cls, 2).slice(1), [2.5, 3.25]);
});

test('dmi adx stays within 0..100 and rises in a trend', () => {
  const n = 120;
  const high = [];
  const low = [];
  const cls = [];
  for (let i = 0; i < n; i++) {
    const base = i < 60 ? 100 + Math.sin(i) : 100 + (i - 60) * 0.8;
    high.push(base + 1);
    low.push(base - 1);
    cls.push(base);
  }
  const { adx } = ta.dmi(high, low, cls, 14, 14);
  const valid = adx.filter(Number.isFinite);
  assert.ok(valid.length > 50);
  assert.ok(valid.every((v) => v >= 0 && v <= 100));
  assert.ok(adx[n - 1] > adx[59], 'trend should lift ADX above the choppy section');
});
