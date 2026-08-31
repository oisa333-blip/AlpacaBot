# Scalping strategies (Pine Script v5)

Three scripts, written for TradingView's Pine Editor. Deploy them there and
run the backtest yourself — TradingView's Strategy Tester has real intraday
history for these instruments; nothing in this repo simulates or fabricates
performance numbers.

| File | Type | Timeframe | Logic |
|---|---|---|---|
| `scalper-1m-ema-vwap-rsi.pine` | `strategy` | 1m | EMA9/EMA21 trend filter, session VWAP side filter, RSI(7) pullback trigger, ATR stop/target |
| `scalper-5m-bb-meanreversion.pine` | `strategy` | 5m | Bollinger Band(20,2) fade on a volume spike + RSI extreme, targets the basis line, ATR hard-stop backstop |
| `scalper-signals-indicator.pine` | `indicator` | 1m/5m | Same trend/VWAP/RSI logic as the 1m strategy, plotted as arrows + `alertcondition()` — for manual trading or driving TradingView alerts without auto-simulated orders |

## Market context these were built against (as of 2026-08-22)

- **QQQ**: rallied from $700.07 (Aug 3) to a $734.58 high (Aug 17), then
  pulled back to a $709–717 range, closing $713.44 on Aug 21. Currently
  consolidating below the recent high.
- **SPY**: same shape — $757.67 → $779.37 high (Aug 13/14) → pulled back to
  $762–770, closed $765.72 Aug 21. Moves in close correlation with QQQ.
- **BTC/USD**: much more volatile right now. Aug 21 ranged $73,011→$79,500
  intraday (~9% high/low spread in one day), closed $78,326. Pulled back to
  a $76,516 low since, trading ~$77,137 (-1.5%) as of this writing. This is
  an active whipsaw regime, not calm chop.

Practical implication baked into the defaults: `atrMultSL`/`atrMultTP` are
ATR-relative, not fixed points, so stops widen automatically on BTC's larger
ranges — but you should still size BTC positions smaller than QQQ/SPY ones
given the current volatility spike. Consider bumping `atrMultSL` on BTC
until the range compresses back down.

## Deploying to TradingView

1. Open TradingView → **Pine Editor** (bottom panel, or tradingview.com/pine).
2. New blank script → paste the file contents → **Save**.
3. **Add to Chart** on the instrument/timeframe you want (BTCUSDT 1m for
   `scalper-1m...`, BTCUSDT 5m or QQQ/SPY 5m for `scalper-5m...`).
4. For the strategies, open the **Strategy Tester** tab (next to Pine
   Editor at the bottom of the chart).

## Backtesting checklist (do this before trusting any strategy)

In Strategy Tester → **Properties**, set:
- Initial capital and position size that match what you'd actually risk.
- Commission (`commission_value` is already wired into the script — match
  it to your actual broker/exchange fee).
- Slippage — the scripts default to 1 tick; raise it for crypto during
  volatile stretches like the current one.

Then read the **Performance Summary** and **List of Trades** tabs. At minimum, check:
- **Profit factor** — gross profit / gross loss. Below ~1.3 is not worth
  running live once real slippage and fees are added.
- **Win rate vs. average win/loss size** — a 35% win rate can still be
  profitable if winners are ~3x losers; a 60% win rate can still lose money
  if losers are bigger than winners.
- **Max drawdown** (both $ and % of equity) — decide up front what you can
  stomach, and don't run a strategy whose historical drawdown exceeds it.
- **Number of trades** in the sample — fewer than ~50-100 trades isn't
  enough to trust the other stats.
- **Performance across the whole date range vs. just recent bars** — a
  strategy that only worked in one regime (e.g. only during the Aug 3-17
  rally) is overfit to that stretch, not robust.

Run each strategy over multiple date ranges (the pullback of the last week,
the rally before it, and a period of chop if you can find one) rather than
just the most recent data — that's the fastest way to catch overfitting.

## Honest limitations

- These are starting points, not tuned/optimized systems. I have not run
  them through TradingView's backtester myself (I don't have execution
  access to it) — the numbers above are real market context, not backtest
  results. Don't treat "profit factor" or "win rate" claims from anyone as
  real until you've seen them come out of Strategy Tester yourself.
- Scalping on 1m/5m charts is fee- and slippage-sensitive. A strategy that
  looks profitable with 0.05% commission can lose money at a worse fee
  tier, or on an exchange with wider spreads.
- Past performance, backtested or live, does not guarantee future results —
  this is doubly true for the current BTC volatility spike, which may not
  persist.
