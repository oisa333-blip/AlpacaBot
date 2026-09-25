# AlpacaBot

Trading bot for the **VPM MTF** strategy (Volume Price Momentum with higher-timeframe confirmation) on Alpaca.

| Mode | Command | What it does |
|---|---|---|
| Backtest | `npm run backtest` | Tests the strategy on Alpaca history (or a CSV) and reports profit, win rate, drawdown and every trade |
| Bot | `npm run bot` | Runs the strategy itself on live Alpaca bars and trades Alpaca (paper by default). No TradingView needed |
| Webhook | `npm start` | Receives TradingView strategy alerts and places the orders on Alpaca |

The strategy lives in two places that follow the same rules:
- `pine/vpm_mtf_strategy.pine` / `pine/vpm_mtf.pine` for TradingView charts
- `src/strategy/vpm.js`, a JavaScript port used by the backtester and the bot

## Setup

Requires Node 22.9+.

```bash
npm install
cp .env.example .env   # add your Alpaca PAPER keys (app.alpaca.markets → Paper → API keys)
npm test
```

## Backtest

```bash
npm run backtest -- --symbols SPY --tf 5 --days 60
npm run backtest -- --symbols SPY,QQQ,AAPL --tf 15 --preset Scalp,Swing --days 120
npm run backtest -- --symbols AAPL --tf 5 --start 2025-01-01 --end 2025-06-30 --params '{"exitAtMid":true}' --out results
npm run backtest -- --data mybars.csv --tf 5      # CSV with time,open,high,low,close,volume
npm run backtest -- --synthetic --tf 5            # sample data, only to check the machinery
```

- Signals act on the bar close and fill at the next bar's open, stops and targets fill intrabar, and slippage (1 tick) is charged, the same way TradingView's Strategy Tester works.
- Commission defaults to 0% for stocks (Alpaca is commission-free) and 0.25% for crypto. Override with `--commission`.
- Extra history before `--start` is fetched automatically so indicators are warmed up.
- `--out dir` writes a trades CSV, an equity-curve CSV and a JSON summary per run.
- `--params` takes any strategy input by its Pine name: `preset`, `buyThr`, `sellThr`, `volWeight`, `signedVol`, `exitAtMid`, `htfMode`, `htfManual`, `htfFilter`, `htfEmaLen`, `exitOnHtfLoss`, `rangeMode`, `adxThr`, `chopThr`, `useStop`, `atrMult`, `useTp`, `tpR`, `sizeMode`, `riskPct`, `flatAtClose`, `allowLongs`, `allowShorts`.

Results won't match TradingView to the cent: data vendors differ (the free Alpaca feed is IEX volume only), but the logic is the same.

## Bot (automated paper trading)

```bash
# .env
SYMBOLS=SPY,QQQ
TIMEFRAME=5
STRATEGY_PARAMS={"preset":"Scalp"}
ALPACA_PAPER=true

npm run bot
```

How it trades:
- On start it loads enough history to warm up, works out the strategy's current state, and **does not** act on old signals. It trades only new signals from then on.
- After each bar closes it fetches the bar, runs the strategy, and acts on any signal.
- **Entries** are bracket orders: the ATR stop and take-profit sit at Alpaca, so the position stays protected even if the bot goes down.
- **Exits** (score fade, HTF bias lost, stop/target, end of day) cancel the bracket legs and close the position.
- **Reversals** close first, wait for the fill, then open the other side.
- **Sizing** risks `riskPct` of account equity per trade (default 1%), capped by `MAX_NOTIONAL_USD` and `MAX_QTY`.
- **Safety:** paper by default, `DRY_RUN=true` logs without trading, `MAX_DAILY_LOSS_PCT` stops new entries for the day, and no stock entries while the market is closed.
- **`flatAtClose`:** positions are closed `EOD_BUFFER_SECONDS` before the bell.
- **Crypto** (`BTCUSD`) trades long-only with plain orders; exits come from the strategy's bar-close checks.

Status API (set `STATUS_TOKEN`): `GET /health`, `GET /status?token=…` (account, positions, strategy state per symbol), `GET /events?token=…` (recent signals and actions).

### Running it 24/7

The bot has to keep running to trade. Any always-on Node host works:
- **Railway / Render:** new service from this repo, start command `npm run bot`, add the `.env` values as environment variables.
- **Docker / Fly.io / a VPS:** `docker build -t alpacabot . && docker run --env-file .env alpacabot`

Run it on **paper** for at least a few weeks and compare with the backtest before considering live money.

## TradingView webhook (alternative)

If you'd rather have TradingView generate the signals:

1. Add `pine/vpm_mtf_strategy.pine` to a chart.
2. Create an alert → Condition: the strategy → "Order fills only".
3. Message: `{{strategy.order.alert_message}}`
4. Webhook URL: `https://your-host/webhook?token=<WEBHOOK_SECRET>`
5. Run `npm start` on a public HTTPS host. TradingView only posts to ports 80/443.

Each order sends:

```json
{"action":"buy","ticker":"AAPL","qty":"12","price":"189.5","position":"long","position_size":"12"}
```

| action | Flat | Long | Short |
|---|---|---|---|
| `buy` | open long | skip | close, then open long |
| `sell_short` | open short | close, then open short | skip |
| `sell` | skip | close | skip |
| `buy_to_cover` | skip | skip | close |
| `close_all` | skip | close | close |

- Size comes from `SIZING`: `alert` uses the strategy's `position_size`, `fixed` uses `FIXED_QTY`, `notional` uses `NOTIONAL_USD / price`. `MAX_QTY` and `MAX_NOTIONAL_USD` cap it.
- Stock signals are skipped while the market is closed; identical alerts within `DEDUPE_WINDOW_MS` are ignored.
- Endpoints: `GET /health`, `POST /webhook`, `GET /status`, `GET /events` (token via `?token=`, `X-Webhook-Token`, or a `"secret"` field in the body).
- `TV_IP_ALLOWLIST=true` only accepts TradingView's webhook IPs (set `TRUST_PROXY=true` behind a proxy).

Webhook mode places plain market orders; stops and targets are handled by TradingView's strategy alerts. The bot mode above keeps them at the broker instead.

## Project layout

```
bot.js                 self-running bot
index.js               TradingView webhook server
scripts/backtest.js    backtest CLI
pine/                  TradingView indicator + strategy
src/strategy/          ta.js (Pine built-ins), vpm.js (strategy port)
src/backtest/          broker emulation, stats, report
src/market/            Alpaca data, bar aggregation, NY session time, sample data
src/live/              bot config, runner loop, order executor, status API
src/                   webhook app, signal parsing, Alpaca client
test/                  node:test suites (npm test)
```
