'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSignal, normalizeTicker, SignalError } = require('../src/signal');

test('parses a strategy alert', () => {
  const s = parseSignal('{"action":"buy","ticker":"AAPL","qty":"12","price":"189.5","position":"long","position_size":"12"}');
  assert.deepEqual(s, {
    action: 'buy',
    orderSymbol: 'AAPL',
    positionSymbol: 'AAPL',
    isCrypto: false,
    qty: 12,
    price: 189.5,
    positionSize: 12,
  });
});

test('accepts aliases and case', () => {
  assert.equal(parseSignal({ action: 'LONG', ticker: 'spy' }).action, 'buy');
  assert.equal(parseSignal({ action: 'short', ticker: 'spy' }).action, 'sell_short');
  assert.equal(parseSignal({ action: 'exit', ticker: 'spy' }).action, 'close_all');
});

test('strips exchange prefix and detects crypto', () => {
  assert.deepEqual(normalizeTicker('NASDAQ:TSLA'), { orderSymbol: 'TSLA', positionSymbol: 'TSLA', isCrypto: false });
  assert.deepEqual(normalizeTicker('COINBASE:BTCUSD'), { orderSymbol: 'BTC/USD', positionSymbol: 'BTCUSD', isCrypto: true });
  assert.deepEqual(normalizeTicker('ETHUSDT'), { orderSymbol: 'ETH/USDT', positionSymbol: 'ETHUSDT', isCrypto: true });
  assert.deepEqual(normalizeTicker('SOL/USD'), { orderSymbol: 'SOL/USD', positionSymbol: 'SOLUSD', isCrypto: true });
  assert.deepEqual(normalizeTicker('BRK.B'), { orderSymbol: 'BRK.B', positionSymbol: 'BRK.B', isCrypto: false });
});

test('unfilled placeholders become null numbers', () => {
  const s = parseSignal({ action: 'sell', ticker: 'AAPL', qty: '{{strategy.order.contracts}}', price: '' });
  assert.equal(s.qty, null);
  assert.equal(s.price, null);
});

test('rejects bad input', () => {
  assert.throws(() => parseSignal('not json'), SignalError);
  assert.throws(() => parseSignal('[]'), SignalError);
  assert.throws(() => parseSignal({ action: 'moon', ticker: 'AAPL' }), SignalError);
  assert.throws(() => parseSignal({ action: 'buy', ticker: 'AA PL' }), SignalError);
  assert.throws(() => parseSignal({ action: 'buy' }), SignalError);
});
