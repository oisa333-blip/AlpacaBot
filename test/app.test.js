'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createTrader } = require('../src/trader');
const { testConfig, fakeAlpaca, silentLog } = require('./helpers');

const SECRET = 'test-secret-0123456789';

async function withServer(options, fn) {
  const config = options.config || testConfig();
  const alpaca = options.alpaca || fakeAlpaca();
  const trader = createTrader({ alpaca, config, sleep: async () => {} });
  const app = createApp({ config, trader, alpaca, log: silentLog });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, alpaca });
  } finally {
    server.close();
  }
}

const post = (url, body, headers = { 'content-type': 'text/plain' }) =>
  fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

const waitFor = async (check) => {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};

test('health is public', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, paper: true, dryRun: false });
  });
});

test('webhook rejects a missing or wrong token', async () => {
  await withServer({}, async ({ base, alpaca }) => {
    const body = { action: 'buy', ticker: 'AAPL', position_size: '1' };
    assert.equal((await post(`${base}/webhook`, body)).status, 401);
    assert.equal((await post(`${base}/webhook?token=wrong`, body)).status, 401);
    assert.equal(alpaca.calls.length, 0);
  });
});

test('webhook accepts token in query, header, or body', async () => {
  await withServer({}, async ({ base }) => {
    const body = { action: 'buy', ticker: 'AAPL', position_size: '1' };
    assert.equal((await post(`${base}/webhook?token=${SECRET}`, body)).status, 202);
    assert.equal((await post(`${base}/webhook`, body, { 'x-webhook-token': SECRET })).status, 202);
    assert.equal((await post(`${base}/webhook`, { ...body, secret: SECRET })).status, 202);
  });
});

test('webhook places the order in the background', async () => {
  await withServer({}, async ({ base, alpaca }) => {
    const res = await post(
      `${base}/webhook?token=${SECRET}`,
      { action: 'buy', ticker: 'NASDAQ:AAPL', qty: '4', price: '100', position_size: '4' },
      { 'content-type': 'application/json' },
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: true, action: 'buy', symbol: 'AAPL' });
    await waitFor(() => alpaca.calls.some((c) => c[0] === 'submitOrder'));
    const order = alpaca.calls.find((c) => c[0] === 'submitOrder')[1];
    assert.equal(order.qty, '4');

    let events = [];
    for (let i = 0; i < 50 && !events.length; i++) {
      events = await (await fetch(`${base}/events?token=${SECRET}`)).json();
    }
    assert.equal(events[0].status, 'ok');
    assert.equal(events[0].symbol, 'AAPL');
  });
});

test('webhook rejects invalid payloads with 400', async () => {
  await withServer({}, async ({ base }) => {
    const res = await post(`${base}/webhook?token=${SECRET}`, 'hello');
    assert.equal(res.status, 400);
    const bad = await post(`${base}/webhook?token=${SECRET}`, { action: 'moon', ticker: 'AAPL' });
    assert.equal(bad.status, 400);
  });
});

test('duplicate alerts inside the window are ignored', async () => {
  await withServer({ config: testConfig({ dedupeWindowMs: 10000 }) }, async ({ base }) => {
    const body = { action: 'buy', ticker: 'AAPL', position_size: '1' };
    assert.equal((await post(`${base}/webhook?token=${SECRET}`, body)).status, 202);
    const dup = await post(`${base}/webhook?token=${SECRET}`, body);
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).reason, 'duplicate');
  });
});

test('IP allowlist blocks non-TradingView sources', async () => {
  await withServer({ config: testConfig({ tvIpAllowlist: true }) }, async ({ base }) => {
    const res = await post(`${base}/webhook?token=${SECRET}`, { action: 'buy', ticker: 'AAPL' });
    assert.equal(res.status, 403);
  });
});

test('status and events need the token', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/events`)).status, 401);
    const status = await (await fetch(`${base}/status?token=${SECRET}`)).json();
    assert.equal(status.account.equity, '10000');
  });
});

test('oversized bodies are rejected', async () => {
  await withServer({}, async ({ base }) => {
    const res = await post(`${base}/webhook?token=${SECRET}`, 'x'.repeat(20000));
    assert.equal(res.status, 413);
  });
});
