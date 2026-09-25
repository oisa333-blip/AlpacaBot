'use strict';

const crypto = require('node:crypto');
const { positionSide } = require('../trader');

const TERMINAL_FAIL = ['canceled', 'expired', 'rejected', 'suspended'];

function roundPrice(price) {
  const decimals = price >= 1 ? 2 : 4;
  const f = 10 ** decimals;
  return Math.round(price * f) / f;
}

// Turns strategy signals into Alpaca orders. Stock entries go in as bracket orders so the
// stop and target live at the broker; exits cancel those legs and close the position.
function createExecutor({ alpaca, config, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const p = config.params;

  async function waitForFill(orderId) {
    const deadline = Date.now() + config.closeFillTimeoutMs;
    while (Date.now() < deadline) {
      const order = await alpaca.getOrder(orderId);
      if (order.status === 'filled') return order;
      if (TERMINAL_FAIL.includes(order.status)) throw new Error(`Order ${orderId} ${order.status}`);
      await sleep(500);
    }
    throw new Error(`Order ${orderId} not filled within ${config.closeFillTimeoutMs}ms`);
  }

  async function cancelOpenOrders(sym, result) {
    const orders = await alpaca.listOpenOrders(sym.orderSymbol);
    for (const o of orders) {
      if (config.dryRun) {
        result.actions.push(`would cancel order ${o.id}`);
        continue;
      }
      await alpaca.cancelOrder(o.id);
      result.actions.push(`cancelled order ${o.id}`);
    }
    // Give Alpaca a moment to release shares held by cancelled bracket legs.
    if (orders.length && !config.dryRun) await sleep(500);
  }

  // Flattens the position if it is on `side` ('long' | 'short' | 'any').
  async function ensureFlat(sym, side, result) {
    await cancelOpenOrders(sym, result);
    const pos = await alpaca.getPosition(sym.positionSymbol);
    const cur = positionSide(pos);
    if (cur === 'flat' || (side !== 'any' && cur !== side)) return cur;
    if (config.dryRun) {
      result.actions.push(`would close ${cur} ${pos.qty}`);
      return 'flat';
    }
    const order = await alpaca.closePosition(sym.positionSymbol);
    result.actions.push(`closed ${cur} ${pos.qty}`);
    if (order && order.id) await waitForFill(order.id);
    return 'flat';
  }

  function entryQty(sym, account, signal, price) {
    const equity = Number(account.equity);
    let qty;
    if (p.sizeMode === 'Risk %' && p.useStop && signal.riskDst > 0) {
      qty = (equity * p.riskPct) / 100 / signal.riskDst;
    } else {
      qty = equity / price;
    }
    qty = Math.min(qty, equity / price);
    if (config.maxNotionalUsd > 0) qty = Math.min(qty, config.maxNotionalUsd / price);
    if (config.maxQty > 0) qty = Math.min(qty, config.maxQty);
    return sym.isCrypto ? Math.floor(qty * 1e6) / 1e6 : Math.floor(qty);
  }

  async function enter(sym, side, bar, signal, account, result) {
    const qty = entryQty(sym, account, signal, bar.c);
    if (!(qty > 0)) {
      result.notes.push('Size rounds to zero, no entry');
      return;
    }
    const order = {
      symbol: sym.orderSymbol,
      qty: String(qty),
      side: side === 'long' ? 'buy' : 'sell',
      type: 'market',
      time_in_force: sym.isCrypto ? 'gtc' : config.bracketTif,
      client_order_id: `vpm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    };
    // Alpaca brackets are stock-only; crypto exits come from the strategy's bar-close checks.
    if (!sym.isCrypto && p.useStop && Number.isFinite(signal.stopLvl)) {
      order.stop_loss = { stop_price: roundPrice(signal.stopLvl) };
      if (p.tpOn && Number.isFinite(signal.tpLvl)) {
        order.order_class = 'bracket';
        order.take_profit = { limit_price: roundPrice(signal.tpLvl) };
      } else {
        order.order_class = 'oto';
      }
    }

    if (config.dryRun) {
      result.actions.push(`would ${order.side} ${qty} ${order.order_class || 'market'}`);
      result.order = order;
      return;
    }
    try {
      const placed = await alpaca.submitOrder(order);
      result.actions.push(`${order.side} ${qty} ${order.order_class || 'market'} (${placed.id})`);
      result.order = order;
    } catch (err) {
      if (!order.order_class || err.status !== 422) throw err;
      // Bracket rejected (usually price moved through a level): enter plain, strategy exits still apply.
      const { order_class, stop_loss, take_profit, ...plain } = order;
      plain.client_order_id = `${order.client_order_id}-m`;
      const placed = await alpaca.submitOrder(plain);
      result.actions.push(`${plain.side} ${qty} market (${placed.id}); bracket rejected: ${err.message}`);
      result.order = plain;
    }
  }

  async function handle(sym, bar, signal, { marketOpen }) {
    const result = { symbol: sym.orderSymbol, barTime: new Date(bar.t).toISOString(), actions: [], notes: [] };

    const longOut = signal.longExit || signal.stopLong || signal.tpLong;
    const shortOut = signal.shortExit || signal.stopShort || signal.tpShort;
    if (signal.eodExit) await ensureFlat(sym, 'any', result);
    if (longOut) await ensureFlat(sym, 'long', result);
    if (shortOut) await ensureFlat(sym, 'short', result);

    const wantLong = signal.longEntry;
    const wantShort = signal.shortEntry;
    if (!wantLong && !wantShort) return result;

    if (!sym.isCrypto && !marketOpen) {
      result.notes.push('Market closed, entry skipped');
      return result;
    }
    if (wantShort && (sym.isCrypto || !config.allowShorts)) {
      await ensureFlat(sym, 'long', result);
      result.notes.push(sym.isCrypto ? 'No crypto shorts, stayed flat' : 'ALLOW_SHORTS=false, stayed flat');
      return result;
    }

    const account = await alpaca.getAccount();
    const equity = Number(account.equity);
    const lastEquity = Number(account.last_equity);
    if (account.trading_blocked || account.account_blocked) {
      result.notes.push('Account is blocked from trading');
      return result;
    }
    if (config.maxDailyLossPct > 0 && lastEquity > 0 && ((lastEquity - equity) / lastEquity) * 100 >= config.maxDailyLossPct) {
      result.notes.push(`Daily loss limit ${config.maxDailyLossPct}% reached, no new entries today`);
      return result;
    }

    const side = wantLong ? 'long' : 'short';
    const opposite = wantLong ? 'short' : 'long';
    const pos = await alpaca.getPosition(sym.positionSymbol);
    if (positionSide(pos) === side) {
      result.notes.push(`Already ${side}`);
      return result;
    }
    await ensureFlat(sym, opposite, result);
    await enter(sym, side, bar, signal, account, result);
    return result;
  }

  return { handle, ensureFlat, entryQty };
}

module.exports = { createExecutor, roundPrice };
