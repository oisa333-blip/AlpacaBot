'use strict';

const crypto = require('node:crypto');
const express = require('express');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Read-only status API for the bot. Without STATUS_TOKEN only /health is served.
function createStatusApp({ config, runner, alpaca, log = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    res.json({ ok: true, mode: 'bot', paper: config.alpaca.paper, dryRun: config.dryRun });
  });

  if (!config.statusToken) return app;

  app.use((req, res, next) => {
    const token = req.query.token || req.get('x-status-token') || '';
    if (!safeEqual(token, config.statusToken)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  app.get('/status', async (req, res) => {
    try {
      const [account, positions] = await Promise.all([alpaca.getAccount(), alpaca.getPositions()]);
      res.json({
        paper: config.alpaca.paper,
        dryRun: config.dryRun,
        timeframe: config.timeframe,
        preset: config.params.preset,
        account: {
          equity: account.equity,
          last_equity: account.last_equity,
          buying_power: account.buying_power,
          cash: account.cash,
        },
        positions: positions.map((p) => ({
          symbol: p.symbol,
          qty: p.qty,
          avg_entry_price: p.avg_entry_price,
          unrealized_pl: p.unrealized_pl,
        })),
        symbols: runner.snapshot(),
      });
    } catch (err) {
      log.error(err.message);
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/events', (req, res) => res.json(runner.events));

  return app;
}

module.exports = { createStatusApp };
