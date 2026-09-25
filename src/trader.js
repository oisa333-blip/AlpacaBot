'use strict';

const crypto = require('node:crypto');

const TERMINAL_FAIL = ['canceled', 'expired', 'rejected', 'suspended'];

function floorTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

function positionSide(position) {
  if (!position) return 'flat';
  const qty = Number(position.qty);
  if (qty > 0) return 'long';
  if (qty < 0) return 'short';
  return 'flat';
}

function createTrader({ alpaca, config, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const queues = new Map();

  function computeQty(signal, side) {
    let qty;
    if (config.sizing === 'fixed') {
      qty = config.fixedQty;
    } else if (config.sizing === 'notional') {
      if (!signal.price) throw new Error('SIZING=notional needs a price in the alert');
      qty = config.notionalUsd / signal.price;
    } else {
      // Strategy position size after the fill, falls back to the order size.
      qty = signal.positionSize ? Math.abs(signal.positionSize) : signal.qty;
      if (!qty) throw new Error('SIZING=alert needs position_size or qty in the alert');
    }

    if (config.maxQty > 0) qty = Math.min(qty, config.maxQty);
    if (config.maxNotionalUsd > 0 && signal.price) qty = Math.min(qty, config.maxNotionalUsd / signal.price);

    // Crypto and fractional long stock orders may be fractional; shorts must be whole shares.
    const fractional = signal.isCrypto || (config.allowFractional && side === 'buy');
    return fractional ? floorTo(qty, 6) : Math.floor(qty);
  }

  async function waitForFill(orderId) {
    const deadline = Date.now() + config.closeFillTimeoutMs;
    while (Date.now() < deadline) {
      const order = await alpaca.getOrder(orderId);
      if (order.status === 'filled') return order;
      if (TERMINAL_FAIL.includes(order.status)) throw new Error(`Close order ${orderId} ${order.status}`);
      await sleep(500);
    }
    throw new Error(`Close order ${orderId} not filled within ${config.closeFillTimeoutMs}ms`);
  }

  async function closePosition(signal, result) {
    if (config.dryRun) {
      result.orders.push({ kind: 'close', symbol: signal.positionSymbol, dryRun: true });
      return;
    }
    const order = await alpaca.closePosition(signal.positionSymbol);
    result.orders.push({ kind: 'close', symbol: signal.positionSymbol, id: order && order.id });
    if (order && order.id) await waitForFill(order.id);
  }

  async function openPosition(signal, side, result) {
    const qty = computeQty(signal, side);
    if (!(qty > 0)) {
      result.notes.push('Order size rounds to zero, nothing opened');
      return;
    }
    const order = {
      symbol: signal.orderSymbol,
      qty: String(qty),
      side,
      type: 'market',
      time_in_force: signal.isCrypto ? 'gtc' : 'day',
      client_order_id: `vpm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    };
    if (config.dryRun) {
      result.orders.push({ kind: 'open', ...order, dryRun: true });
      return;
    }
    const placed = await alpaca.submitOrder(order);
    result.orders.push({ kind: 'open', ...order, id: placed && placed.id, status: placed && placed.status });
  }

  async function execute(signal) {
    const result = { action: signal.action, symbol: signal.orderSymbol, status: 'ok', orders: [], notes: [] };

    if (config.allowedSymbols.length && !config.allowedSymbols.includes(signal.positionSymbol)) {
      return { ...result, status: 'skipped', notes: [`${signal.positionSymbol} is not in ALLOWED_SYMBOLS`] };
    }

    if (alpaca && !signal.isCrypto && config.rejectWhenMarketClosed) {
      const clock = await alpaca.getClock();
      if (!clock.is_open) return { ...result, status: 'skipped', notes: ['Market is closed'] };
    }

    const position = alpaca ? await alpaca.getPosition(signal.positionSymbol) : null;
    const side = positionSide(position);
    result.positionBefore = side;

    switch (signal.action) {
      case 'buy':
        if (side === 'long') return { ...result, status: 'skipped', notes: ['Already long'] };
        if (side === 'short') await closePosition(signal, result);
        await openPosition(signal, 'buy', result);
        break;

      case 'sell_short':
        if (side === 'short') return { ...result, status: 'skipped', notes: ['Already short'] };
        if (side === 'long') await closePosition(signal, result);
        if (signal.isCrypto) {
          result.notes.push('Alpaca does not support shorting crypto, stayed flat');
        } else if (!config.allowShorts) {
          result.notes.push('ALLOW_SHORTS=false, stayed flat');
        } else {
          await openPosition(signal, 'sell', result);
        }
        break;

      case 'sell':
        if (side !== 'long') return { ...result, status: 'skipped', notes: ['No long position to sell'] };
        await closePosition(signal, result);
        break;

      case 'buy_to_cover':
        if (side !== 'short') return { ...result, status: 'skipped', notes: ['No short position to cover'] };
        await closePosition(signal, result);
        break;

      case 'close_all':
        if (side === 'flat') return { ...result, status: 'skipped', notes: ['Already flat'] };
        await closePosition(signal, result);
        break;
    }

    if (config.dryRun) result.status = 'dry_run';
    return result;
  }

  // Signals for the same symbol run one at a time so a reversal can't race itself.
  function enqueue(signal) {
    const key = signal.positionSymbol;
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => execute(signal));
    queues.set(key, next);
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }).catch(() => {});
    return next;
  }

  return { execute, enqueue, computeQty };
}

module.exports = { createTrader, positionSide };
