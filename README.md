# AlpacaBot

TradingView → Alpaca order bridge. The `VPM MTF Strategy` (in `pine/`) sends a JSON alert on every order; this Express server receives it and places the matching order on Alpaca.

## Setup

Requires Node 22.9+.

```bash
npm install
cp .env.example .env   # fill in your Alpaca paper keys and a long WEBHOOK_SECRET
npm start
npm test
```

TradingView only sends webhooks to ports 80/443 over a public URL, so run this behind HTTPS (a host such as Render, Railway or Fly.io, or a tunnel like ngrok while testing).

## TradingView alert

1. Add `pine/vpm_mtf_strategy.pine` to a chart.
2. Create an alert → Condition: the strategy → "Order fills only".
3. Message: `{{strategy.order.alert_message}}`
4. Webhook URL: `https://your-host/webhook?token=<WEBHOOK_SECRET>`

Each order sends:

```json
{"action":"buy","ticker":"AAPL","qty":"12","price":"189.5","position":"long","position_size":"12"}
```

## How signals map to orders

| action | Flat | Long | Short |
|---|---|---|---|
| `buy` | open long | skip | close, then open long |
| `sell_short` | open short | close, then open short | skip |
| `sell` | skip | close | skip |
| `buy_to_cover` | skip | skip | close |
| `close_all` | skip | close | close |

- Size comes from `SIZING`: `alert` uses the strategy's `position_size`, `fixed` uses `FIXED_QTY`, `notional` uses `NOTIONAL_USD / price`. `MAX_QTY` and `MAX_NOTIONAL_USD` cap it.
- Orders are market orders (`day` for stocks, `gtc` for crypto). Shorts are whole shares; crypto is never shorted.
- A reversal waits for the close to fill before opening the other side.
- Stock signals are skipped while the market is closed (`REJECT_WHEN_MARKET_CLOSED`).
- Identical alerts within `DEDUPE_WINDOW_MS` are ignored.
- The server replies `202` immediately and places orders in the background.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness, paper / dry-run flags |
| `POST /webhook` | token | TradingView alerts |
| `GET /status` | token | Account equity and open positions |
| `GET /events` | token | Last 200 signals and what was done |

Token: `?token=`, `X-Webhook-Token` header, or a `"secret"` field in the JSON body.

## Safety

- `ALPACA_PAPER=true` is the default. Live trading needs `ALPACA_PAPER=false` and live keys.
- `DRY_RUN=true` logs orders without sending them.
- `TV_IP_ALLOWLIST=true` only accepts TradingView's webhook IPs (set `TRUST_PROXY=true` behind a proxy).
