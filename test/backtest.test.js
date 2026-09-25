'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backtest, intrabarExit } = require('../src/backtest/backtest');
const { resolveParams } = require('../src/strategy/vpm');
const { syntheticStockBars } = require('../src/market/synthetic');

test('intrabar exits follow the nearer extreme first', () => {
  const long = { side: 1, stop: 95, tp: 105 };
  // Open nearer the low: low first -> stop.
  assert.deepEqual(intrabarExit({ o: 96, h: 106, l: 94, c: 100 }, long, 0), { price: 95, reason: 'STOP' });
  // Open nearer the high: high first -> target.
  assert.deepEqual(intrabarExit({ o: 104, h: 106, l: 94, c: 100 }, long, 0), { price: 105, reason: 'TP' });
  // Gap through the stop fills at the open, with slippage.
  assert.deepEqual(intrabarExit({ o: 90, h: 91, l: 89, c: 90 }, long, 0.01), { price: 89.99, reason: 'STOP' });
  assert.equal(intrabarExit({ o: 100, h: 101, l: 99, c: 100 }, long, 0), null);

  const short = { side: -1, stop: 105, tp: 95 };
  assert.deepEqual(intrabarExit({ o: 104, h: 106, l: 94, c: 100 }, short, 0.01), { price: 105.01, reason: 'STOP' });
  assert.deepEqual(intrabarExit({ o: 96, h: 106, l: 94, c: 100 }, short, 0), { price: 95, reason: 'TP' });
});

test('trades fill at the next open and stats add up', () => {
  const bars = syntheticStockBars({ days: 40, tfMinutes: 5, seed: 5 });
  const p = resolveParams({}, '5');
  const { stats, trades, equityCurve } = backtest(bars, p, { commissionPct: 0.05, slippageTicks: 1 });
  assert.ok(trades.length > 5);

  const byTime = new Map(bars.map((b, i) => [new Date(b.t).toISOString(), i]));
  for (const t of trades) {
    const i = byTime.get(t.entryTime);
    const expected = bars[i].o + (t.side === 'long' ? 0.01 : -0.01);
    assert.ok(Math.abs(t.entryPrice - expected) < 1e-9, 'entry at next open plus slippage');
    assert.ok(t.qty >= 1 && Number.isInteger(t.qty));
  }

  const sum = trades.reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(sum - stats.netProfit) < 1e-6);
  assert.equal(stats.trades, trades.length);
  assert.ok(stats.commissionPaid > 0);
  assert.equal(equityCurve.length, bars.length);
  if (!stats.openTrade) assert.ok(Math.abs(stats.finalEquity - (10000 + stats.netProfit)) < 1e-6);
});

test('risk sizing caps loss per trade near riskPct', () => {
  const bars = syntheticStockBars({ days: 40, tfMinutes: 5, seed: 9 });
  const p = resolveParams({ riskPct: 1 }, '5');
  const { trades } = backtest(bars, p, { commissionPct: 0, slippageTicks: 0 });
  for (const t of trades.filter((x) => x.reason === 'STOP')) {
    // Stops that don't gap lose about 1R ≈ 1% of equity.
    if (t.rMultiple > -1.3) assert.ok(t.pnl > -10000 * 0.02, `stop loss ${t.pnl} too big`);
  }
});

test('flat at close leaves no position overnight', () => {
  const bars = syntheticStockBars({ days: 20, tfMinutes: 5, seed: 2 });
  const p = resolveParams({ flatAtClose: true }, '5');
  const { trades } = backtest(bars, p);
  for (const t of trades) assert.equal(t.entryTime.slice(0, 10), t.exitTime.slice(0, 10), 'same-day exit');
  assert.ok(trades.some((t) => t.reason === 'EOD'));
});

test('statsFrom limits the reported period', () => {
  const bars = syntheticStockBars({ days: 20, tfMinutes: 5, seed: 4 });
  const from = bars[1000].t;
  const { stats, equityCurve } = backtest(bars, resolveParams({ startTime: from }, '5'), { statsFrom: from });
  assert.equal(equityCurve.length, bars.length - 1000);
  assert.equal(stats.from, new Date(from).toISOString());
});
