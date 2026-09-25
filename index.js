'use strict';

const { loadConfig } = require('./src/config');
const { createAlpacaClient } = require('./src/alpaca');
const { createTrader } = require('./src/trader');
const { createApp } = require('./src/app');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const hasKeys = Boolean(config.alpaca.keyId && config.alpaca.secretKey);
const alpaca = hasKeys ? createAlpacaClient(config.alpaca) : null;
const trader = createTrader({ alpaca, config });
const app = createApp({ config, trader, alpaca });

app.listen(config.port, () => {
  const mode = config.alpaca.paper ? 'PAPER' : 'LIVE';
  console.log(`AlpacaBot listening on :${config.port} (${mode}${config.dryRun ? ', DRY RUN' : ''}, sizing=${config.sizing})`);
  if (!config.alpaca.paper && !config.dryRun) console.warn('WARNING: live trading is enabled');
});
