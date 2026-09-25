'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { parseSignal, SignalError } = require('./signal');

// TradingView's published webhook source IPs.
const TRADINGVIEW_IPS = ['52.89.214.238', '34.212.75.30', '54.218.53.128', '52.32.178.7'];

const MAX_EVENTS = 200;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function createApp({ config, trader, alpaca, log = console, now = Date.now }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  const events = [];
  const seen = new Map();

  function record(event) {
    events.unshift({ time: new Date(now()).toISOString(), ...event });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  }

  function isDuplicate(body) {
    if (!config.dedupeWindowMs) return false;
    const t = now();
    for (const [key, ts] of seen) {
      if (t - ts > config.dedupeWindowMs) seen.delete(key);
    }
    const key = crypto.createHash('sha256').update(body).digest('hex');
    if (seen.has(key)) return true;
    seen.set(key, t);
    return false;
  }

  function requireToken(req, res, next) {
    const token = req.query.token || req.get('x-webhook-token') || '';
    if (!safeEqual(token, config.webhookSecret)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  app.get('/health', (req, res) => {
    res.json({ ok: true, paper: config.alpaca.paper, dryRun: config.dryRun });
  });

  // TradingView posts JSON as text/plain or application/json, so read the raw text either way.
  app.post('/webhook', express.text({ type: () => true, limit: '10kb' }), (req, res) => {
    if (config.tvIpAllowlist && !TRADINGVIEW_IPS.includes(normalizeIp(req.ip))) {
      log.warn(`Rejected webhook from ${req.ip}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const body = typeof req.body === 'string' ? req.body : '';
    let secret = req.query.token || req.get('x-webhook-token');
    if (!secret) {
      try {
        secret = JSON.parse(body).secret;
      } catch {
        // parseSignal reports bad JSON below
      }
    }
    if (!safeEqual(secret || '', config.webhookSecret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let signal;
    try {
      signal = parseSignal(body);
    } catch (err) {
      if (err instanceof SignalError) {
        record({ status: 'invalid', error: err.message });
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    if (isDuplicate(body)) {
      record({ status: 'duplicate', action: signal.action, symbol: signal.orderSymbol });
      return res.status(200).json({ accepted: false, reason: 'duplicate' });
    }

    // Reply right away: TradingView drops webhooks that take more than a few seconds.
    res.status(202).json({ accepted: true, action: signal.action, symbol: signal.orderSymbol });

    log.info(`Signal ${signal.action} ${signal.orderSymbol}`);
    trader
      .enqueue(signal)
      .then((result) => {
        log.info(`Result ${JSON.stringify(result)}`);
        record(result);
      })
      .catch((err) => {
        log.error(`Failed ${signal.action} ${signal.orderSymbol}: ${err.message}`);
        record({ action: signal.action, symbol: signal.orderSymbol, status: 'error', error: err.message });
      });
  });

  app.get('/events', requireToken, (req, res) => {
    res.json(events);
  });

  app.get('/status', requireToken, async (req, res, next) => {
    if (!alpaca) return res.json({ dryRun: true, account: null, positions: [] });
    try {
      const [account, positions] = await Promise.all([alpaca.getAccount(), alpaca.getPositions()]);
      res.json({
        paper: config.alpaca.paper,
        dryRun: config.dryRun,
        account: {
          status: account.status,
          equity: account.equity,
          buying_power: account.buying_power,
          cash: account.cash,
        },
        positions: positions.map((p) => ({
          symbol: p.symbol,
          qty: p.qty,
          side: p.side,
          avg_entry_price: p.avg_entry_price,
          unrealized_pl: p.unrealized_pl,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(err.stack || err.message);
    const status = err.type === 'entity.too.large' ? 413 : 500;
    res.status(status).json({ error: status === 413 ? 'Payload too large' : 'Internal error' });
  });

  return app;
}

module.exports = { createApp, TRADINGVIEW_IPS };
