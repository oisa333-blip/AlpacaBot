'use strict';

const ACTIONS = ['buy', 'sell', 'sell_short', 'buy_to_cover', 'close_all'];

const ALIASES = {
  long: 'buy',
  short: 'sell_short',
  cover: 'buy_to_cover',
  exit: 'close_all',
  close: 'close_all',
  flat: 'close_all',
};

const CRYPTO_QUOTES = ['USDT', 'USDC', 'USD'];

class SignalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignalError';
  }
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// "BINANCE:BTCUSDT" -> { orderSymbol: "BTC/USDT", positionSymbol: "BTCUSDT", isCrypto: true }
// "NASDAQ:AAPL"     -> { orderSymbol: "AAPL",     positionSymbol: "AAPL",    isCrypto: false }
function normalizeTicker(ticker) {
  const raw = String(ticker || '').trim().toUpperCase();
  const symbol = raw.includes(':') ? raw.split(':').pop() : raw;
  if (!/^[A-Z0-9./]{1,15}$/.test(symbol)) {
    throw new SignalError(`Invalid ticker "${ticker}"`);
  }

  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    if (!base || !quote) throw new SignalError(`Invalid ticker "${ticker}"`);
    return { orderSymbol: `${base}/${quote}`, positionSymbol: `${base}${quote}`, isCrypto: true };
  }

  for (const quote of CRYPTO_QUOTES) {
    const base = symbol.slice(0, -quote.length);
    if (symbol.endsWith(quote) && base.length >= 2 && symbol.length >= 6) {
      return { orderSymbol: `${base}/${quote}`, positionSymbol: symbol, isCrypto: true };
    }
  }

  return { orderSymbol: symbol, positionSymbol: symbol, isCrypto: false };
}

// Parses a TradingView alert body produced by the VPM MTF strategy.
function parseSignal(body) {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      throw new SignalError('Body is not valid JSON');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SignalError('Body must be a JSON object');
  }

  const rawAction = String(data.action || '').trim().toLowerCase();
  const action = ALIASES[rawAction] || rawAction;
  if (!ACTIONS.includes(action)) {
    throw new SignalError(`Unknown action "${data.action}". Expected one of: ${ACTIONS.join(', ')}`);
  }

  return {
    action,
    ...normalizeTicker(data.ticker),
    qty: toNumber(data.qty),
    price: toNumber(data.price),
    positionSize: toNumber(data.position_size),
  };
}

module.exports = { parseSignal, normalizeTicker, SignalError, ACTIONS };
