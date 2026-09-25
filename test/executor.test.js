'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExecutor, roundPrice } = require('../src/live/executor');
const { loadBotConfig } = require('../src/live/config');
const { normalizeTicker } = require('../src/signal');
const { fakeAlpaca, silentLog } = require('./helpers');

function botConfig(env = {}) {
  return loadBotConfig({ SYMBOLS: 'AAPL', ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', MAX_NOTIONAL_USD: '0', ...env });
}

function setup({ env, ...fake } = {}) {
  const alpaca = fakeAlpaca(fake);
  const config = botConfig(env);
  const executor = createExecutor({ alpaca, config, log: silentLog, sleep: async () => {} });
  return { alpaca, config, executor };
}

const sym = (s = 'AAPL') => normalizeTicker(s);
const bar = { t: Date.parse('2025-01-06T15:00:00Z'), o: 100, h: 101, l: 99, c: 100, v: 1000 };
const longSignal = { longEntry: true, stopLvl: 98, tpLvl: 104, riskDst: 2 };
const orders = (a) => a.calls.filter((c) => c[0] === 'submitOrder').map((c) => c[1]);

test('long entry is a bracket order sized by risk', async () => {
  const { alpaca, executor } = setup();
  const result = await executor.handle(sym(), bar, longSignal, { marketOpen: true });
  const [order] = orders(alpaca);
  // 1% of $10,000 = $100 risk / $2 stop distance = 50 shares
  assert.equal(order.qty, '50');
  assert.equal(order.side, 'buy');
  assert.equal(order.order_class, 'bracket');
  assert.deepEqual(order.stop_loss, { stop_price: 98 });
  assert.deepEqual(order.take_profit, { limit_price: 104 });
  assert.equal(order.time_in_force, 'gtc');
  assert.match(result.actions[0], /buy 50 bracket/);
});

test('size is capped by MAX_NOTIONAL_USD and MAX_QTY', async () => {
  let s = setup({ env: { MAX_NOTIONAL_USD: '1000' } });
  await s.executor.handle(sym(), bar, longSignal, { marketOpen: true });
  assert.equal(orders(s.alpaca)[0].qty, '10');
  s = setup({ env: { MAX_QTY: '3' } });
  await s.executor.handle(sym(), bar, longSignal, { marketOpen: true });
  assert.equal(orders(s.alpaca)[0].qty, '3');
});

test('reversal cancels bracket legs and closes before entering', async () => {
  const { alpaca, executor } = setup({ position: { qty: '-20' }, openOrders: [{ id: 'leg-1' }] });
  await executor.handle(sym(), bar, longSignal, { marketOpen: true });
  const names = alpaca.calls.map((c) => c[0]);
  assert.ok(names.indexOf('cancelOrder') < names.indexOf('closePosition'));
  assert.ok(names.indexOf('closePosition') < names.indexOf('submitOrder'));
});

test('exit signals flatten the matching side only', async () => {
  let s = setup({ position: { qty: '10' }, openOrders: [{ id: 'leg-1' }] });
  await s.executor.handle(sym(), bar, { longExit: true }, { marketOpen: true });
  assert.ok(s.alpaca.calls.some((c) => c[0] === 'closePosition'));

  s = setup({ position: { qty: '-10' } });
  await s.executor.handle(sym(), bar, { longExit: true }, { marketOpen: true });
  assert.ok(!s.alpaca.calls.some((c) => c[0] === 'closePosition'));
});

test('already filled stop: exit just tidies up', async () => {
  const { alpaca, executor } = setup({ position: null, openOrders: [{ id: 'tp-leg' }] });
  await executor.handle(sym(), bar, { stopLong: true }, { marketOpen: true });
  assert.deepEqual(alpaca.calls.filter((c) => c[0] === 'cancelOrder'), [['cancelOrder', 'tp-leg']]);
  assert.ok(!alpaca.calls.some((c) => c[0] === 'closePosition'));
});

test('rejected bracket falls back to a plain market order', async () => {
  const { alpaca, executor } = setup({ rejectBrackets: true });
  const result = await executor.handle(sym(), bar, longSignal, { marketOpen: true });
  const sent = orders(alpaca);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].order_class, undefined);
  assert.match(result.actions[0], /bracket rejected/);
});

test('daily loss limit blocks new entries', async () => {
  const { alpaca, executor } = setup({ account: { equity: '9600', last_equity: '10000' } });
  const result = await executor.handle(sym(), bar, longSignal, { marketOpen: true });
  assert.equal(orders(alpaca).length, 0);
  assert.match(result.notes[0], /Daily loss limit/);
});

test('market closed blocks stock entries', async () => {
  const { alpaca, executor } = setup();
  const result = await executor.handle(sym(), bar, longSignal, { marketOpen: false });
  assert.equal(orders(alpaca).length, 0);
  assert.match(result.notes[0], /Market closed/);
});

test('shorts disabled: short signal only closes a long', async () => {
  const { alpaca, executor } = setup({ position: { qty: '5' }, env: { ALLOW_SHORTS: 'false' } });
  await executor.handle(sym(), bar, { shortEntry: true, stopLvl: 102, tpLvl: 96, riskDst: 2 }, { marketOpen: true });
  assert.ok(alpaca.calls.some((c) => c[0] === 'closePosition'));
  assert.equal(orders(alpaca).length, 0);
});

test('crypto: fractional market order, no bracket, trades when stock market is closed', async () => {
  const { alpaca, executor } = setup({ env: { SYMBOLS: 'BTCUSD' } });
  const btcBar = { ...bar, c: 60000 };
  await executor.handle(sym('BTCUSD'), btcBar, { longEntry: true, stopLvl: 59000, tpLvl: 62000, riskDst: 1000 }, { marketOpen: false });
  const [order] = orders(alpaca);
  assert.equal(order.symbol, 'BTC/USD');
  assert.equal(order.qty, '0.1'); // $100 risk / $1000
  assert.equal(order.order_class, undefined);
  assert.equal(order.time_in_force, 'gtc');
});

test('dry run sends nothing', async () => {
  const { alpaca, executor } = setup({ position: { qty: '-3' }, env: { DRY_RUN: 'true' } });
  const result = await executor.handle(sym(), bar, longSignal, { marketOpen: true });
  assert.equal(orders(alpaca).length, 0);
  assert.ok(!alpaca.calls.some((c) => c[0] === 'closePosition'));
  assert.ok(result.actions.some((a) => a.startsWith('would buy')));
});

test('price rounding for bracket levels', () => {
  assert.equal(roundPrice(98.123), 98.12);
  assert.equal(roundPrice(0.123456), 0.1235);
});

test('bot config validation', () => {
  assert.throws(() => loadBotConfig({}), /SYMBOLS/);
  assert.throws(() => loadBotConfig({ SYMBOLS: 'SPY', ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', STRATEGY_PARAMS: '{bad' }), /JSON/);
  const c = botConfig({ TIMEFRAME: '15', STRATEGY_PARAMS: '{"preset":"Swing","exitAtMid":true}' });
  assert.equal(c.params.preset, 'Swing');
  assert.equal(c.params.htfTf, '240');
  assert.equal(c.params.exitAtMid, true);
});
