'use strict';

// Self-running VPM MTF bot: reads Alpaca bars, runs the strategy, trades Alpaca (paper by default).

const { loadBotConfig } = require('./src/live/config');
const { createAlpacaClient } = require('./src/alpaca');
const { createAlpacaData } = require('./src/market/alpacaData');
const { createExecutor } = require('./src/live/executor');
const { createRunner } = require('./src/live/runner');
const { createStatusApp } = require('./src/live/server');

let config;
try {
  config = loadBotConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const log = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

const alpaca = createAlpacaClient(config.alpaca);
const data = createAlpacaData({ ...config.alpaca, feed: config.dataFeed });
const executor = createExecutor({ alpaca, config, log });
const runner = createRunner({ alpaca, data, executor, config, log });

if (!config.alpaca.paper && !config.dryRun) log.warn('LIVE trading with real money is enabled');

createStatusApp({ config, runner, alpaca, log }).listen(config.port, () => {
  log.info(`Status API on :${config.port}${config.statusToken ? '' : ' (set STATUS_TOKEN for /status and /events)'}`);
});
runner.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`${sig} received, stopping (open positions and their stop/target orders stay at Alpaca)`);
    runner.stop();
    process.exit(0);
  });
}
