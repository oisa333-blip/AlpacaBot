'use strict';

const { alpacaTimeframe } = require('./alpacaData');
const { filterRegularSession, aggregateBars } = require('./bars');
const { parseTimeframe, DAY, MINUTE } = require('./time');

// Chart bars for a symbol: fetches from Alpaca, keeps regular-session bars for stocks,
// and builds session-anchored bars for stock timeframes Alpaca can't return directly.
// Every bar gets closeTime so callers can drop the bar that is still forming.
async function loadChartBars(data, { symbol, isCrypto, timeframe, start, end }) {
  const { fetch: fetchTf, aggregate } = alpacaTimeframe(timeframe, isCrypto);
  let bars = await data.getBars(symbol, { timeframe: fetchTf, start, end, isCrypto });
  const tf = parseTimeframe(timeframe);
  if (!isCrypto && tf.unit === 'min') bars = filterRegularSession(bars);
  if (aggregate) return aggregateBars(bars, aggregate, { session: 'rth' });
  return bars.map((b) => ({ ...b, closeTime: b.t + closeOffset(tf, isCrypto) }));
}

// How long after its open time a fetched bar is complete.
function closeOffset(tf, isCrypto) {
  if (tf.unit === 'min') return tf.minutes * MINUTE;
  // Alpaca daily stock bars are stamped at midnight New York; the session ends at 16:00.
  if (tf.unit === 'D') return isCrypto ? DAY : 16 * 60 * MINUTE;
  if (tf.unit === 'W') return 7 * DAY;
  return 31 * DAY;
}

// Calendar days of history that cover `count` chart bars.
function lookbackDays(count, timeframe, isCrypto) {
  const tf = parseTimeframe(timeframe);
  if (tf.unit === 'D') return Math.ceil(count * (isCrypto ? 1 : 1.5)) + 5;
  if (tf.unit === 'W') return count * 7 + 14;
  if (tf.unit === 'M') return count * 31 + 31;
  const perDay = isCrypto ? 1440 / tf.minutes : Math.ceil(390 / tf.minutes);
  return Math.ceil((count / perDay) * (isCrypto ? 1 : 1.5)) + 5;
}

function startForBars(count, timeframe, isCrypto, now = Date.now()) {
  return new Date(now - lookbackDays(count, timeframe, isCrypto) * DAY);
}

module.exports = { loadChartBars, lookbackDays, startForBars };
