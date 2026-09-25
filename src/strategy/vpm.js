'use strict';

// JavaScript port of pine/vpm_mtf_strategy.pine. computeSeries() does the indicator math
// for a whole bar array; the engine then walks bars one at a time through the same state
// machine as the Pine strategy, so the bot and the backtester trade the TradingView rules.

const ta = require('./ta');
const { aggregateBars } = require('../market/bars');
const { parseTimeframe, autoHtf, isLastRegularBar } = require('../market/time');

const PRESETS = {
  Scalp: { volLen: 20, priceLen: 30, smoothLen: 5 },
  Swing: { volLen: 30, priceLen: 50, smoothLen: 10 },
};

const DEFAULT_PARAMS = {
  preset: 'Scalp',
  allowLongs: true,
  allowShorts: true,
  volLen: 30,
  priceLen: 50,
  smoothLen: 10,
  buyThr: 55,
  sellThr: 45,
  volWeight: 0.4,
  signedVol: true,
  exitAtMid: false,
  htfMode: 'Auto',
  htfManual: '60',
  htfFilter: 'Score + EMA',
  htfEmaLen: 50,
  exitOnHtfLoss: true,
  rangeMode: 'ADX',
  adxLen: 14,
  adxThr: 20,
  chopLen: 14,
  chopThr: 61.8,
  useStop: true,
  atrLen: 14,
  atrMult: 2.0,
  useTp: true,
  tpR: 2.0,
  sizeMode: 'Risk %',
  riskPct: 1.0,
  flatAtClose: false,
  startTime: null,
  endTime: null,
};

const HTF_FILTERS = ['Score + EMA', 'Score', 'EMA', 'Off'];
const RANGE_MODES = ['ADX', 'Choppiness', 'Both', 'Off'];

function resolveParams(overrides, timeframe) {
  const p = { ...DEFAULT_PARAMS, ...overrides };
  if (!['Scalp', 'Swing', 'Custom'].includes(p.preset)) throw new Error(`Unknown preset "${p.preset}"`);
  if (!HTF_FILTERS.includes(p.htfFilter)) throw new Error(`htfFilter must be one of: ${HTF_FILTERS.join(', ')}`);
  if (!RANGE_MODES.includes(p.rangeMode)) throw new Error(`rangeMode must be one of: ${RANGE_MODES.join(', ')}`);
  if (!(p.buyThr > 50 && p.buyThr < 100) || !(p.sellThr > 0 && p.sellThr < 50)) {
    throw new Error('buyThr must be 51-99 and sellThr 1-49');
  }
  Object.assign(p, PRESETS[p.preset] || {});

  const chart = parseTimeframe(timeframe);
  p.timeframe = String(timeframe);
  p.tfMinutes = chart.minutes;
  p.htfTf = p.htfMode === 'Auto' ? autoHtf(timeframe) : String(p.htfManual);
  p.htfOn = p.htfFilter !== 'Off';
  if (p.htfOn && parseTimeframe(p.htfTf).minutes <= chart.minutes) {
    throw new Error(`HTF ${p.htfTf} must be higher than the chart timeframe ${timeframe}`);
  }
  p.tpOn = p.useTp && p.useStop;
  return p;
}

// Pine f_score(): directional volume rank blended with price rank, EMA-smoothed. 0..100.
function scoreSeries(bars, p) {
  const close = bars.map((b) => b.c);
  const volume = bars.map((b) => b.v);
  const cumVol = ta.cum(volume);
  const vr = ta.percentrank(volume, p.volLen);
  const pr = ta.percentrank(close, p.priceLen);
  const raw = bars.map((b, i) => {
    const noVol = cumVol[i] === 0;
    if (noVol || ta.isNa(vr[i])) return pr[i];
    const sign = i === 0 ? NaN : Math.sign(close[i] - close[i - 1]);
    const vs = p.signedVol ? 50 + (sign * vr[i]) / 2 : vr[i];
    return p.volWeight * vs + (1 - p.volWeight) * pr[i];
  });
  return ta.ema(raw, p.smoothLen);
}

// Indicator values for every bar. `session` is 'rth' for stocks, '24h' for crypto.
function computeSeries(bars, p, { session = 'rth' } = {}) {
  const n = bars.length;
  const high = bars.map((b) => b.h);
  const low = bars.map((b) => b.l);
  const close = bars.map((b) => b.c);

  const score = scoreSeries(bars, p);

  // Higher timeframe: values from the last HTF bar that closed before this bar opened.
  const htfScore = new Array(n).fill(NaN);
  const htfClose = new Array(n).fill(NaN);
  const htfEma = new Array(n).fill(NaN);
  if (p.htfOn) {
    const htfBars = aggregateBars(bars, p.htfTf, { session });
    const hScore = scoreSeries(htfBars, p);
    const hEma = ta.ema(htfBars.map((b) => b.c), p.htfEmaLen);
    let j = -1;
    for (let i = 0; i < n; i++) {
      while (j + 1 < htfBars.length && htfBars[j + 1].closeTime <= bars[i].t) j++;
      if (j >= 0) {
        htfScore[i] = hScore[j];
        htfClose[i] = htfBars[j].c;
        htfEma[i] = hEma[j];
      }
    }
  }

  const adx = ta.dmi(high, low, close, p.adxLen, p.adxLen).adx;
  const trSum = ta.sum(ta.tr(high, low, close, true), p.chopLen);
  const hh = ta.highest(high, p.chopLen);
  const ll = ta.lowest(low, p.chopLen);
  const chop = trSum.map((s, i) => {
    const hiLo = hh[i] - ll[i];
    return hiLo > 0 ? (100 * Math.log10(s / hiLo)) / Math.log10(p.chopLen) : NaN;
  });

  const atr = ta.atr(high, low, close, p.atrLen);

  return bars.map((b, i) => {
    const hs = htfScore[i];
    const hc = htfClose[i];
    const he = htfEma[i];
    // NaN comparisons are false, matching Pine's na handling.
    let htfBull = true;
    let htfBear = true;
    if (p.htfFilter === 'Score + EMA') {
      htfBull = hs >= 50 && hc > he;
      htfBear = hs < 50 && hc < he;
    } else if (p.htfFilter === 'Score') {
      htfBull = hs >= 50;
      htfBear = hs < 50;
    } else if (p.htfFilter === 'EMA') {
      htfBull = hc > he;
      htfBear = hc < he;
    }

    const adxRange = adx[i] < p.adxThr;
    const chopRange = chop[i] > p.chopThr;
    let inRange = false;
    if (p.rangeMode === 'ADX') inRange = adxRange;
    else if (p.rangeMode === 'Choppiness') inRange = chopRange;
    else if (p.rangeMode === 'Both') inRange = adxRange && chopRange;

    return {
      score: score[i],
      htfScore: hs,
      htfBull,
      htfBear,
      inRange,
      adx: adx[i],
      chop: chop[i],
      atr: atr[i],
      eodBar: p.flatAtClose && session === 'rth' && isLastRegularBar(b.t, p.tfMinutes),
    };
  });
}

function createEngine(p) {
  const state = {
    sig: 0, // 1 long, -1 short, 0 flat
    stopLvl: NaN,
    tpLvl: NaN,
    longReady: true,
    shortReady: true,
  };

  // One bar close. `s` is that bar's computeSeries() entry.
  function step(bar, s) {
    const ev = {
      longEntry: false,
      shortEntry: false,
      longExit: false,
      shortExit: false,
      stopLong: false,
      stopShort: false,
      tpLong: false,
      tpShort: false,
      eodExit: false,
    };

    const riskDst = s.atr * p.atrMult;
    const inWindow = (p.startTime == null || bar.t >= p.startTime) && (p.endTime == null || bar.t <= p.endTime);
    const longCond = p.allowLongs && s.score >= p.buyThr && s.htfBull && !s.inRange && inWindow && !s.eodBar;
    const shortCond = p.allowShorts && s.score <= p.sellThr && s.htfBear && !s.inRange && inWindow && !s.eodBar;
    const longExitLvl = p.exitAtMid ? 50 : p.sellThr;
    const shortExitLvl = p.exitAtMid ? 50 : p.buyThr;

    // Stops / targets (conservative: stop wins if both are touched on one bar)
    if (state.sig === 1) {
      if (p.useStop && bar.l <= state.stopLvl) {
        state.sig = 0;
        ev.stopLong = true;
        state.longReady = false;
      } else if (p.tpOn && bar.h >= state.tpLvl) {
        state.sig = 0;
        ev.tpLong = true;
        state.longReady = false;
      }
    } else if (state.sig === -1) {
      if (p.useStop && bar.h >= state.stopLvl) {
        state.sig = 0;
        ev.stopShort = true;
        state.shortReady = false;
      } else if (p.tpOn && bar.l <= state.tpLvl) {
        state.sig = 0;
        ev.tpShort = true;
        state.shortReady = false;
      }
    }

    if (s.eodBar && state.sig !== 0) {
      state.sig = 0;
      ev.eodExit = true;
    }

    if (s.score < p.buyThr) state.longReady = true;
    if (s.score > p.sellThr) state.shortReady = true;

    if (!(ev.stopLong || ev.stopShort || ev.tpLong || ev.tpShort || ev.eodExit)) {
      if (state.sig !== 1 && longCond && state.longReady) {
        state.sig = 1;
        state.stopLvl = bar.c - riskDst;
        state.tpLvl = bar.c + riskDst * p.tpR;
        ev.longEntry = true;
      } else if (state.sig !== -1 && shortCond && state.shortReady) {
        state.sig = -1;
        state.stopLvl = bar.c + riskDst;
        state.tpLvl = bar.c - riskDst * p.tpR;
        ev.shortEntry = true;
      } else if (state.sig === 1 && (s.score < longExitLvl || (p.exitOnHtfLoss && p.htfOn && !s.htfBull))) {
        state.sig = 0;
        ev.longExit = true;
      } else if (state.sig === -1 && (s.score > shortExitLvl || (p.exitOnHtfLoss && p.htfOn && !s.htfBear))) {
        state.sig = 0;
        ev.shortExit = true;
      }
    }

    return { ...ev, sig: state.sig, stopLvl: state.stopLvl, tpLvl: state.tpLvl, riskDst };
  }

  return { state, step };
}

// Runs the strategy over a full bar array. Returns per-bar { bar, series, signal }.
function runStrategy(bars, params, { session = 'rth' } = {}) {
  const series = computeSeries(bars, params, { session });
  const engine = createEngine(params);
  return bars.map((bar, i) => ({ bar, series: series[i], signal: engine.step(bar, series[i]) }));
}

// Bars of history the indicators need before signals are trustworthy.
function warmupBars(p, session = 'rth') {
  const ltfNeed = Math.max(p.volLen, p.priceLen, p.adxLen * 3, p.atrLen * 3, p.chopLen) + p.smoothLen * 4;
  if (!p.htfOn) return ltfNeed + 50;
  const htfMin = parseTimeframe(p.htfTf).minutes;
  const sessionMin = session === 'rth' ? 390 : 1440;
  const perHtf = htfMin >= 1440 ? (sessionMin / Math.min(p.tfMinutes, sessionMin)) * (htfMin / 1440) : htfMin / p.tfMinutes;
  const htfNeed = Math.max(p.htfEmaLen, p.volLen, p.priceLen) + p.smoothLen * 4;
  return Math.ceil(Math.max(ltfNeed, perHtf * htfNeed)) + 50;
}

module.exports = { DEFAULT_PARAMS, PRESETS, resolveParams, scoreSeries, computeSeries, createEngine, runStrategy, warmupBars };
