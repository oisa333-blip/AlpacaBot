'use strict';

const { loadConfig } = require('../src/config');

function testConfig(overrides = {}) {
  return {
    ...loadConfig({
      WEBHOOK_SECRET: 'test-secret-0123456789',
      ALPACA_KEY_ID: 'key',
      ALPACA_SECRET_KEY: 'secret',
      MAX_NOTIONAL_USD: '0',
      DEDUPE_WINDOW_MS: '0',
    }),
    ...overrides,
  };
}

// In-memory stand-in for the Alpaca client.
function fakeAlpaca({ position = null, isOpen = true, fillStatus = 'filled' } = {}) {
  const calls = [];
  let current = position;
  return {
    calls,
    async getClock() {
      calls.push(['getClock']);
      return { is_open: isOpen };
    },
    async getPosition(symbol) {
      calls.push(['getPosition', symbol]);
      return current;
    },
    async closePosition(symbol) {
      calls.push(['closePosition', symbol]);
      current = null;
      return { id: 'close-1', status: 'accepted' };
    },
    async getOrder(id) {
      calls.push(['getOrder', id]);
      return { id, status: fillStatus };
    },
    async submitOrder(order) {
      calls.push(['submitOrder', order]);
      return { id: 'open-1', status: 'accepted' };
    },
    async getAccount() {
      return { status: 'ACTIVE', equity: '10000', buying_power: '20000', cash: '10000' };
    },
    async getPositions() {
      return current ? [current] : [];
    },
  };
}

const silentLog = { info() {}, warn() {}, error() {} };

module.exports = { testConfig, fakeAlpaca, silentLog };
