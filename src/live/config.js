'use strict';

const { normalizeTicker } = require('../signal');
const { resolveParams } = require('../strategy/vpm');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function num(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${value}"`);
  return n;
}

// Settings for the self-running bot (bot.js).
function loadBotConfig(env = process.env) {
  const errors = [];
  const timeframe = env.TIMEFRAME || '5';

  let strategyOverrides = {};
  if (env.STRATEGY_PARAMS) {
    try {
      strategyOverrides = JSON.parse(env.STRATEGY_PARAMS);
    } catch {
      errors.push('STRATEGY_PARAMS must be JSON, e.g. {"preset":"Swing","exitAtMid":true}');
    }
  }

  let params = null;
  try {
    params = resolveParams(strategyOverrides, timeframe);
  } catch (err) {
    errors.push(err.message);
  }

  const symbols = (env.SYMBOLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return normalizeTicker(s);
      } catch (err) {
        errors.push(err.message);
        return null;
      }
    })
    .filter(Boolean);
  if (!symbols.length) errors.push('SYMBOLS must list at least one symbol, e.g. SPY,QQQ');

  const config = {
    symbols,
    timeframe,
    params,
    alpaca: {
      keyId: env.ALPACA_KEY_ID || '',
      secretKey: env.ALPACA_SECRET_KEY || '',
      paper: bool(env.ALPACA_PAPER, true),
    },
    dataFeed: env.ALPACA_DATA_FEED || 'iex',
    dryRun: bool(env.DRY_RUN, false),
    allowShorts: bool(env.ALLOW_SHORTS, true),
    maxQty: num('MAX_QTY', env.MAX_QTY, 0),
    maxNotionalUsd: num('MAX_NOTIONAL_USD', env.MAX_NOTIONAL_USD, 5000),
    maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', env.MAX_DAILY_LOSS_PCT, 3),
    bracketTif: (env.BRACKET_TIF || 'gtc').toLowerCase(),
    pollSeconds: num('POLL_SECONDS', env.POLL_SECONDS, 10),
    barDelaySeconds: num('BAR_DELAY_SECONDS', env.BAR_DELAY_SECONDS, 5),
    eodBufferSeconds: num('EOD_BUFFER_SECONDS', env.EOD_BUFFER_SECONDS, 120),
    closeFillTimeoutMs: num('CLOSE_FILL_TIMEOUT_MS', env.CLOSE_FILL_TIMEOUT_MS, 15000),
    port: num('PORT', env.PORT, 3000),
    statusToken: env.STATUS_TOKEN || env.WEBHOOK_SECRET || '',
  };

  if (!config.alpaca.keyId || !config.alpaca.secretKey) {
    errors.push('ALPACA_KEY_ID and ALPACA_SECRET_KEY are required (market data needs them even in DRY_RUN)');
  }
  if (!['day', 'gtc'].includes(config.bracketTif)) errors.push('BRACKET_TIF must be day or gtc');
  if (config.statusToken && config.statusToken.length < 16) errors.push('STATUS_TOKEN must be at least 16 characters');
  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return config;
}

module.exports = { loadBotConfig };
