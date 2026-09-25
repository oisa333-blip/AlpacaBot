'use strict';

const SIZING_MODES = ['alert', 'fixed', 'notional'];

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

function list(value) {
  if (!value) return [];
  return value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const config = {
    port: num('PORT', env.PORT, 3000),
    webhookSecret: env.WEBHOOK_SECRET || '',
    alpaca: {
      keyId: env.ALPACA_KEY_ID || '',
      secretKey: env.ALPACA_SECRET_KEY || '',
      paper: bool(env.ALPACA_PAPER, true),
    },
    dryRun: bool(env.DRY_RUN, false),
    sizing: (env.SIZING || 'alert').toLowerCase(),
    fixedQty: num('FIXED_QTY', env.FIXED_QTY, 1),
    notionalUsd: num('NOTIONAL_USD', env.NOTIONAL_USD, 1000),
    maxQty: num('MAX_QTY', env.MAX_QTY, 0),
    maxNotionalUsd: num('MAX_NOTIONAL_USD', env.MAX_NOTIONAL_USD, 5000),
    allowShorts: bool(env.ALLOW_SHORTS, true),
    allowFractional: bool(env.ALLOW_FRACTIONAL, false),
    allowedSymbols: list(env.ALLOWED_SYMBOLS),
    rejectWhenMarketClosed: bool(env.REJECT_WHEN_MARKET_CLOSED, true),
    dedupeWindowMs: num('DEDUPE_WINDOW_MS', env.DEDUPE_WINDOW_MS, 10000),
    closeFillTimeoutMs: num('CLOSE_FILL_TIMEOUT_MS', env.CLOSE_FILL_TIMEOUT_MS, 15000),
    tvIpAllowlist: bool(env.TV_IP_ALLOWLIST, false),
    trustProxy: bool(env.TRUST_PROXY, false),
  };

  const errors = [];
  if (config.webhookSecret.length < 16) {
    errors.push('WEBHOOK_SECRET must be set and at least 16 characters long');
  }
  if (!config.dryRun && (!config.alpaca.keyId || !config.alpaca.secretKey)) {
    errors.push('ALPACA_KEY_ID and ALPACA_SECRET_KEY are required unless DRY_RUN=true');
  }
  if (!SIZING_MODES.includes(config.sizing)) {
    errors.push(`SIZING must be one of: ${SIZING_MODES.join(', ')}`);
  }
  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);

  return config;
}

module.exports = { loadConfig, SIZING_MODES };
