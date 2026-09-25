#!/usr/bin/env node
'use strict';

// Backtest the VPM MTF strategy.
//
//   npm run backtest -- --symbols SPY,QQQ --tf 5 --days 60
//   npm run backtest -- --symbols AAPL --tf 15 --preset Swing --start 2025-01-01 --end 2025-06-30
//   npm run backtest -- --data bars.csv --tf 5
//   npm run backtest -- --synthetic --tf 5
//
// Alpaca data needs ALPACA_KEY_ID / ALPACA_SECRET_KEY (in .env or the environment).

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { resolveParams, warmupBars } = require('../src/strategy/vpm');
const { backtest } = require('../src/backtest/backtest');
const { summaryText, comparisonTable, tradesCsv, equityCsv } = require('../src/backtest/report');
const { parseCsvBars } = require('../src/market/bars');
const { syntheticStockBars } = require('../src/market/synthetic');
const { createAlpacaData } = require('../src/market/alpacaData');
const { loadChartBars, startForBars } = require('../src/market/history');
const { normalizeTicker } = require('../src/signal');
const { DAY } = require('../src/market/time');

const { values: args } = parseArgs({
  options: {
    symbols: { type: 'string', default: 'SPY' },
    tf: { type: 'string', default: '5' },
    preset: { type: 'string', default: 'Scalp' },
    start: { type: 'string' },
    end: { type: 'string' },
    days: { type: 'string', default: '60' },
    data: { type: 'string' },
    synthetic: { type: 'boolean', default: false },
    params: { type: 'string', default: '{}' },
    capital: { type: 'string', default: '10000' },
    commission: { type: 'string' },
    slippage: { type: 'string', default: '1' },
    feed: { type: 'string', default: process.env.ALPACA_DATA_FEED || 'iex' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

async function main() {
  const overrides = JSON.parse(args.params);
  const presets = args.preset.split(',').map((s) => s.trim());
  const symbols = args.symbols.split(',').map((s) => s.trim()).filter(Boolean);
  const tf = args.tf;
  const endMs = args.end ? Date.parse(args.end) : Date.now();
  const startMs = args.start ? Date.parse(args.start) : endMs - Number(args.days) * DAY;

  const sources = [];
  if (args.data) {
    sources.push({ symbol: path.basename(args.data), isCrypto: false, bars: parseCsvBars(fs.readFileSync(args.data, 'utf8')) });
  } else if (args.synthetic) {
    console.log('Using SYNTHETIC sample data (a random walk, not a market). Results say nothing about real performance.\n');
    const tfMinutes = Number(tf);
    sources.push({ symbol: 'SYNTH', isCrypto: false, bars: syntheticStockBars({ days: Number(args.days), tfMinutes }) });
  } else {
    const keyId = process.env.ALPACA_KEY_ID;
    const secretKey = process.env.ALPACA_SECRET_KEY;
    if (!keyId || !secretKey) {
      throw new Error('Set ALPACA_KEY_ID and ALPACA_SECRET_KEY (or use --data file.csv / --synthetic)');
    }
    const data = createAlpacaData({ keyId, secretKey, feed: args.feed });
    for (const raw of symbols) {
      const { orderSymbol, isCrypto } = normalizeTicker(raw);
      // Extra history before the start date so indicators are warmed up on the first test bar.
      const warm = Math.max(...presets.map((pr) => warmupBars(resolveParams({ ...overrides, preset: pr }, tf), isCrypto ? '24h' : 'rth')));
      const fetchStart = startForBars(warm, tf, isCrypto, startMs);
      process.stdout.write(`Fetching ${orderSymbol} ${tf} bars… `);
      const bars = await loadChartBars(data, { symbol: orderSymbol, isCrypto, timeframe: tf, start: fetchStart, end: new Date(endMs) });
      console.log(`${bars.length} bars`);
      sources.push({ symbol: orderSymbol, isCrypto, bars });
    }
  }

  const options = {
    initialCapital: Number(args.capital),
    slippageTicks: Number(args.slippage),
  };
  if (args.commission != null) options.commissionPct = Number(args.commission);

  const results = [];
  for (const src of sources) {
    if (src.bars.length < 50) {
      console.log(`${src.symbol}: only ${src.bars.length} bars, skipped`);
      continue;
    }
    for (const preset of presets) {
      const params = resolveParams({ ...overrides, preset, startTime: args.data || args.synthetic ? null : startMs }, tf);
      const session = src.isCrypto ? '24h' : 'rth';
      const commissionPct = options.commissionPct ?? (src.isCrypto ? 0.25 : 0);
      const statsFrom = args.data || args.synthetic ? null : startMs;
      const run = backtest(src.bars, params, { ...options, commissionPct, session, fractional: src.isCrypto, statsFrom });
      results.push({ symbol: src.symbol, preset, timeframe: tf, params, ...run });
    }
  }

  if (!results.length) return;
  if (results.length === 1) {
    const r = results[0];
    console.log(`\n${summaryText(`${r.symbol} · ${r.timeframe} · ${r.preset} (HTF ${r.params.htfOn ? r.params.htfTf : 'off'})`, r.stats)}\n`);
  } else {
    console.log(`\n${comparisonTable(results)}\n`);
  }

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    for (const r of results) {
      const base = path.join(args.out, `${r.symbol.replace(/\W/g, '')}_${r.timeframe}_${r.preset}`);
      fs.writeFileSync(`${base}_trades.csv`, tradesCsv(r.trades));
      fs.writeFileSync(`${base}_equity.csv`, equityCsv(r.equityCurve));
      fs.writeFileSync(`${base}_summary.json`, JSON.stringify({ params: r.params, stats: r.stats }, null, 2));
    }
    console.log(`Wrote trades, equity curve and summary files to ${args.out}/`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
