'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunner } = require('../src/live/runner');
const { loadBotConfig } = require('../src/live/config');
const { runStrategy } = require('../src/strategy/vpm');
const { syntheticStockBars } = require('../src/market/synthetic');
const { fakeAlpaca, silentLog } = require('./helpers');

const MIN = 60000;
const SIGNAL_KEYS = ['longEntry', 'shortEntry', 'longExit', 'shortExit', 'stopLong', 'stopShort', 'tpLong', 'tpShort', 'eodExit'];

function fakeData(allBars, calls) {
  return {
    async getBars(symbol, { timeframe, start, end }) {
      calls.push({ symbol, timeframe, start: new Date(start).getTime(), end: new Date(end).getTime() });
      return allBars.filter((b) => b.t >= new Date(start).getTime() && b.t + 5 * MIN <= new Date(end).getTime());
    },
  };
}

function setup(allBars, env = {}) {
  const config = loadBotConfig({ SYMBOLS: 'SPY', TIMEFRAME: '5', ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', ...env });
  const handled = [];
  const dataCalls = [];
  const clock = { now: 0 };
  const executor = {
    async handle(sym, bar, signal) {
      handled.push({ t: bar.t, signal });
      return { actions: ['ok'], notes: [] };
    },
    async ensureFlat() {},
  };
  const runner = createRunner({
    alpaca: fakeAlpaca(),
    data: fakeData(allBars, dataCalls),
    executor,
    config,
    log: silentLog,
    now: () => clock.now,
  });
  return { runner, handled, dataCalls, clock, config };
}

test('live runner trades exactly the signals the backtest sees', async () => {
  const all = syntheticStockBars({ days: 40, tfMinutes: 5, seed: 21 });
  const liveFrom = 2000; // bars before this are history at startup
  const { runner, handled, clock, config } = setup(all);

  clock.now = all[liveFrom - 1].t + 5 * MIN + 10000;
  await runner.tick(); // warmup only
  assert.equal(handled.length, 0, 'no trades during warmup');
  const warmBars = runner.symbols[0].bars.length;
  assert.ok(warmBars > 500);

  // Step the clock bar by bar through the rest of the data.
  for (let i = liveFrom; i < all.length; i++) {
    clock.now = all[i].t + 5 * MIN + 10000;
    await runner.tick();
  }

  // Same bars through the batch strategy (starting where the live buffer started).
  const batch = runStrategy(all.slice(liveFrom - warmBars), config.params);
  const expected = batch
    .filter((r) => r.bar.t >= all[liveFrom].t && SIGNAL_KEYS.some((k) => r.signal[k]))
    .map((r) => ({ t: r.bar.t, keys: SIGNAL_KEYS.filter((k) => r.signal[k]) }));
  const actual = handled.map((h) => ({ t: h.t, keys: SIGNAL_KEYS.filter((k) => h.signal[k]) }));

  assert.ok(expected.length > 5, `expected some live signals, got ${expected.length}`);
  assert.deepEqual(actual, expected);
});

test('catch-up bars after downtime are not traded', async () => {
  const all = syntheticStockBars({ days: 30, tfMinutes: 5, seed: 8 });
  const { runner, handled, clock } = setup(all);
  clock.now = all[1500].t + 5 * MIN + 10000;
  await runner.tick();
  // Jump a full day ahead: everything in between is stale.
  clock.now = all[1600].t + 5 * MIN + 10000;
  await runner.tick();
  // Only bars that closed within the last two bar lengths may trade.
  assert.ok(handled.every((h) => h.t >= all[1599].t), 'stale bars were traded');
  assert.equal(runner.symbols[0].bars[runner.symbols[0].bars.length - 1].t, all[1600].t, 'state caught up');
});

test('no fetch until the next bar has closed', async () => {
  const all = syntheticStockBars({ days: 25, tfMinutes: 5, seed: 1 });
  const { runner, dataCalls, clock } = setup(all);
  clock.now = all[1200].t + 5 * MIN + 10000;
  await runner.tick();
  const after = dataCalls.length;
  clock.now += 60000; // mid-bar
  await runner.tick();
  assert.equal(dataCalls.length, after);
  clock.now = all[1201].t + 5 * MIN + 6000;
  await runner.tick();
  assert.equal(dataCalls.length, after + 1);
  assert.equal(runner.symbols[0].bars[runner.symbols[0].bars.length - 1].t, all[1201].t);
});

test('snapshot reports strategy state', async () => {
  const all = syntheticStockBars({ days: 25, tfMinutes: 5, seed: 1 });
  const { runner, clock } = setup(all);
  clock.now = all[1300].t + 5 * MIN + 10000;
  await runner.tick();
  const [snap] = runner.snapshot();
  assert.equal(snap.symbol, 'SPY');
  assert.ok(['long', 'short', 'flat'].includes(snap.strategy));
  assert.ok(Number.isFinite(snap.score));
});
