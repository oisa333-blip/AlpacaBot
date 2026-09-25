'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrader } = require('../src/trader');
const { parseSignal } = require('../src/signal');
const { testConfig, fakeAlpaca } = require('./helpers');

const noSleep = async () => {};

function run({ alpaca, config = testConfig(), signal }) {
  const trader = createTrader({ alpaca, config, sleep: noSleep });
  return trader.execute(parseSignal(signal));
}

const opened = (alpaca) => alpaca.calls.filter((c) => c[0] === 'submitOrder').map((c) => c[1]);
const closed = (alpaca) => alpaca.calls.filter((c) => c[0] === 'closePosition').map((c) => c[1]);

test('buy when flat opens a long sized from position_size', async () => {
  const alpaca = fakeAlpaca();
  const result = await run({ alpaca, signal: { action: 'buy', ticker: 'AAPL', qty: '12', price: '100', position_size: '12' } });
  assert.equal(result.status, 'ok');
  const [order] = opened(alpaca);
  assert.equal(order.symbol, 'AAPL');
  assert.equal(order.side, 'buy');
  assert.equal(order.qty, '12');
  assert.equal(order.type, 'market');
  assert.equal(order.time_in_force, 'day');
  assert.match(order.client_order_id, /^vpm-/);
});

test('buy when short closes, waits for fill, then opens long', async () => {
  const alpaca = fakeAlpaca({ position: { qty: '-5', side: 'short' } });
  // On a reversal TradingView reports contracts = close + open, position_size = new position.
  await run({ alpaca, signal: { action: 'buy', ticker: 'AAPL', qty: '15', price: '100', position_size: '10' } });
  const names = alpaca.calls.map((c) => c[0]);
  assert.deepEqual(names, ['getClock', 'getPosition', 'closePosition', 'getOrder', 'submitOrder']);
  assert.equal(opened(alpaca)[0].qty, '10');
});

test('buy when already long is skipped', async () => {
  const alpaca = fakeAlpaca({ position: { qty: '3', side: 'long' } });
  const result = await run({ alpaca, signal: { action: 'buy', ticker: 'AAPL', position_size: '3' } });
  assert.equal(result.status, 'skipped');
  assert.equal(opened(alpaca).length, 0);
});

test('sell closes a long and ignores a short', async () => {
  const long = fakeAlpaca({ position: { qty: '3', side: 'long' } });
  await run({ alpaca: long, signal: { action: 'sell', ticker: 'AAPL' } });
  assert.deepEqual(closed(long), ['AAPL']);

  const short = fakeAlpaca({ position: { qty: '-3', side: 'short' } });
  const result = await run({ alpaca: short, signal: { action: 'sell', ticker: 'AAPL' } });
  assert.equal(result.status, 'skipped');
  assert.equal(closed(short).length, 0);
});

test('sell_short with shorts disabled only closes the long', async () => {
  const alpaca = fakeAlpaca({ position: { qty: '3', side: 'long' } });
  const result = await run({
    alpaca,
    config: testConfig({ allowShorts: false }),
    signal: { action: 'sell_short', ticker: 'AAPL', position_size: '-3' },
  });
  assert.deepEqual(closed(alpaca), ['AAPL']);
  assert.equal(opened(alpaca).length, 0);
  assert.match(result.notes.join(), /ALLOW_SHORTS/);
});

test('sell_short opens whole-share short', async () => {
  const alpaca = fakeAlpaca();
  await run({
    alpaca,
    config: testConfig({ allowFractional: true }),
    signal: { action: 'sell_short', ticker: 'AAPL', price: '100', position_size: '-7.8' },
  });
  const [order] = opened(alpaca);
  assert.equal(order.side, 'sell');
  assert.equal(order.qty, '7');
});

test('crypto buy is fractional, GTC, and skips the market clock', async () => {
  const alpaca = fakeAlpaca({ isOpen: false });
  await run({ alpaca, signal: { action: 'buy', ticker: 'BTCUSD', price: '60000', position_size: '0.0123456789' } });
  const [order] = opened(alpaca);
  assert.equal(order.symbol, 'BTC/USD');
  assert.equal(order.qty, '0.012345');
  assert.equal(order.time_in_force, 'gtc');
  assert.ok(!alpaca.calls.some((c) => c[0] === 'getClock'));
});

test('crypto sell_short never opens a short', async () => {
  const alpaca = fakeAlpaca();
  const result = await run({ alpaca, signal: { action: 'sell_short', ticker: 'ETHUSD', position_size: '-1' } });
  assert.equal(opened(alpaca).length, 0);
  assert.match(result.notes.join(), /crypto/);
});

test('market closed skips stock signals', async () => {
  const alpaca = fakeAlpaca({ isOpen: false });
  const result = await run({ alpaca, signal: { action: 'buy', ticker: 'AAPL', position_size: '1' } });
  assert.equal(result.status, 'skipped');
  assert.equal(opened(alpaca).length, 0);
});

test('symbols outside ALLOWED_SYMBOLS are skipped', async () => {
  const alpaca = fakeAlpaca();
  const result = await run({
    alpaca,
    config: testConfig({ allowedSymbols: ['SPY'] }),
    signal: { action: 'buy', ticker: 'AAPL', position_size: '1' },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(alpaca.calls.length, 0);
});

test('sizing modes and caps', () => {
  const trader = (overrides) => createTrader({ alpaca: null, config: testConfig(overrides) });
  const sig = parseSignal({ action: 'buy', ticker: 'AAPL', price: '50', position_size: '40', qty: '40' });

  assert.equal(trader({}).computeQty(sig, 'buy'), 40);
  assert.equal(trader({ sizing: 'fixed', fixedQty: 3 }).computeQty(sig, 'buy'), 3);
  assert.equal(trader({ sizing: 'notional', notionalUsd: 1000 }).computeQty(sig, 'buy'), 20);
  assert.equal(trader({ maxQty: 25 }).computeQty(sig, 'buy'), 25);
  assert.equal(trader({ maxNotionalUsd: 1225 }).computeQty(sig, 'buy'), 24);
  assert.equal(trader({ maxNotionalUsd: 1225, allowFractional: true }).computeQty(sig, 'buy'), 24.5);

  const noPrice = parseSignal({ action: 'buy', ticker: 'AAPL' });
  assert.throws(() => trader({ sizing: 'notional' }).computeQty(noPrice, 'buy'), /price/);
  assert.throws(() => trader({}).computeQty(noPrice, 'buy'), /position_size/);
});

test('failed close order stops the reversal', async () => {
  const alpaca = fakeAlpaca({ position: { qty: '-5', side: 'short' }, fillStatus: 'rejected' });
  await assert.rejects(
    run({ alpaca, signal: { action: 'buy', ticker: 'AAPL', position_size: '5' } }),
    /rejected/,
  );
  assert.equal(opened(alpaca).length, 0);
});

test('dry run places no orders', async () => {
  const alpaca = fakeAlpaca({ position: { qty: '-5', side: 'short' } });
  const result = await run({
    alpaca,
    config: testConfig({ dryRun: true }),
    signal: { action: 'buy', ticker: 'AAPL', position_size: '5' },
  });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.orders.length, 2);
  assert.equal(opened(alpaca).length + closed(alpaca).length, 0);
});

test('signals for one symbol run in order', async () => {
  const alpaca = fakeAlpaca();
  const trader = createTrader({ alpaca, config: testConfig(), sleep: noSleep });
  const a = trader.enqueue(parseSignal({ action: 'buy', ticker: 'AAPL', position_size: '2' }));
  const b = trader.enqueue(parseSignal({ action: 'buy', ticker: 'AAPL', position_size: '2' }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 'ok');
  // Fake position is still null after an open, so the second buy also opens; order is what matters.
  assert.equal(rb.status, 'ok');
  assert.equal(opened(alpaca).length, 2);
});
