'use strict';

// Batch versions of the Pine Script built-ins the VPM strategy uses. Arrays hold numbers,
// NaN plays the role of Pine's `na`, and each function follows Pine's documented formula
// (including how it seeds and how `na` propagates) so results line up with TradingView.

const isNa = (x) => typeof x !== 'number' || Number.isNaN(x);

function sma(src, len) {
  const out = new Array(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let sum = 0;
    let ok = true;
    for (let k = i - len + 1; k <= i; k++) {
      if (isNa(src[k])) {
        ok = false;
        break;
      }
      sum += src[k];
    }
    if (ok) out[i] = sum / len;
  }
  return out;
}

// ta.ema: seeded with the first value, restarts after an `na`.
function ema(src, len) {
  const alpha = 2 / (len + 1);
  const out = new Array(src.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    prev = isNa(prev) ? src[i] : alpha * src[i] + (1 - alpha) * prev;
    out[i] = isNa(prev) ? NaN : prev;
  }
  return out;
}

// ta.rma: seeded with the SMA of the first `len` values, restarts after an `na`.
function rma(src, len) {
  const alpha = 1 / len;
  const seed = sma(src, len);
  const out = new Array(src.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    prev = isNa(prev) ? seed[i] : alpha * src[i] + (1 - alpha) * prev;
    out[i] = isNa(prev) ? NaN : prev;
  }
  return out;
}

// ta.percentrank: % of the previous `len` values that are <= the current value.
function percentrank(src, len) {
  const out = new Array(src.length).fill(NaN);
  for (let i = len; i < src.length; i++) {
    if (isNa(src[i])) continue;
    let count = 0;
    let ok = true;
    for (let k = 1; k <= len; k++) {
      const v = src[i - k];
      if (isNa(v)) {
        ok = false;
        break;
      }
      if (v <= src[i]) count++;
    }
    if (ok) out[i] = (count / len) * 100;
  }
  return out;
}

function sum(src, len) {
  const out = new Array(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = i - len + 1; k <= i; k++) {
      if (isNa(src[k])) {
        ok = false;
        break;
      }
      s += src[k];
    }
    if (ok) out[i] = s;
  }
  return out;
}

function highest(src, len) {
  const out = new Array(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let m = -Infinity;
    for (let k = i - len + 1; k <= i; k++) m = Math.max(m, src[k]);
    out[i] = m;
  }
  return out;
}

function lowest(src, len) {
  const out = new Array(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let m = Infinity;
    for (let k = i - len + 1; k <= i; k++) m = Math.min(m, src[k]);
    out[i] = m;
  }
  return out;
}

function cum(src) {
  const out = new Array(src.length);
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    s += isNa(src[i]) ? 0 : src[i];
    out[i] = s;
  }
  return out;
}

// ta.tr(handleNa): true range; the first bar is high - low when handleNa, else na.
function tr(high, low, close, handleNa) {
  return high.map((h, i) => {
    if (i === 0) return handleNa ? h - low[i] : NaN;
    const pc = close[i - 1];
    return Math.max(h - low[i], Math.abs(h - pc), Math.abs(low[i] - pc));
  });
}

function atr(high, low, close, len) {
  return rma(tr(high, low, close, true), len);
}

function fixnan(src) {
  let last = NaN;
  return src.map((v) => {
    if (!isNa(v)) last = v;
    return last;
  });
}

// ta.dmi(diLength, adxSmoothing) -> { plus, minus, adx }
function dmi(high, low, close, diLen, adxLen) {
  const n = high.length;
  const plusDM = new Array(n).fill(NaN);
  const minusDM = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const trur = rma(tr(high, low, close, false), diLen);
  const pRma = rma(plusDM, diLen);
  const mRma = rma(minusDM, diLen);
  const plus = fixnan(pRma.map((v, i) => (100 * v) / trur[i]));
  const minus = fixnan(mRma.map((v, i) => (100 * v) / trur[i]));
  const dx = plus.map((p, i) => {
    const s = p + minus[i];
    return Math.abs(p - minus[i]) / (s === 0 ? 1 : s);
  });
  const adx = rma(dx, adxLen).map((v) => 100 * v);
  return { plus, minus, adx };
}

module.exports = { isNa, sma, ema, rma, percentrank, sum, highest, lowest, cum, tr, atr, fixnan, dmi };
