'use strict';

const { runStrategy } = require('../strategy/vpm');

const DEFAULT_OPTIONS = {
  initialCapital: 10000,
  commissionPct: 0.05, // per side, % of trade value
  slippageTicks: 1,
  tickSize: 0.01,
  percentOfEquity: 100, // used when sizeMode is "Properties tab" or there is no stop
  fractional: false, // whole shares for stocks, fractional for crypto
  session: 'rth',
  statsFrom: null, // ms: bars before this only warm up the indicators
};

// Replays bars through the VPM strategy with TradingView-style broker emulation:
// signals act on bar close, market orders fill at the next open, stop/target orders
// fill intrabar (open -> nearer extreme -> farther extreme -> close), EOD closes on the close.
function backtest(bars, params, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const rows = runStrategy(bars, params, { session: o.session });

  let cash = o.initialCapital;
  let pos = null; // { side: 1|-1, qty, entryPrice, entryTime, entryBar, stop, tp, risk, commission }
  let pending = null; // { type: 'enter', side, qty, stop, tp, risk } | { type: 'close', reason }
  const trades = [];
  const equityCurve = [];
  let barsInPosition = 0;
  let commissionPaid = 0;

  const slip = o.slippageTicks * o.tickSize;
  const roundQty = (q) => (o.fractional ? Math.floor(q * 1e6) / 1e6 : Math.floor(q));

  function fee(price, qty) {
    const f = (price * qty * o.commissionPct) / 100;
    commissionPaid += f;
    return f;
  }

  function open(side, qty, price, bar, i, stop, tp, risk) {
    const commission = fee(price, qty);
    cash -= commission;
    pos = { side, qty, entryPrice: price, entryTime: bar.t, entryBar: i, stop, tp, risk, commission };
  }

  function close(price, bar, i, reason) {
    const exitFee = fee(price, pos.qty);
    const gross = (price - pos.entryPrice) * pos.qty * pos.side;
    cash += gross - exitFee;
    const pnl = gross - exitFee - pos.commission;
    trades.push({
      side: pos.side === 1 ? 'long' : 'short',
      qty: pos.qty,
      entryTime: new Date(pos.entryTime).toISOString(),
      entryPrice: pos.entryPrice,
      exitTime: new Date(bar.t).toISOString(),
      exitPrice: price,
      reason,
      pnl,
      pnlPct: (pnl / (pos.entryPrice * pos.qty)) * 100,
      rMultiple: pos.risk > 0 ? pnl / (pos.risk * pos.qty) : NaN,
      bars: i - pos.entryBar + 1,
    });
    pos = null;
  }

  const equityAt = (price) => cash + (pos ? (price - pos.entryPrice) * pos.qty * pos.side : 0);

  for (let i = 0; i < rows.length; i++) {
    const { bar, signal } = rows[i];

    // 1. Orders queued on the previous close fill at this open.
    if (pending) {
      if (pending.type === 'close' && pos) {
        close(bar.o - slip * pos.side, bar, i, pending.reason);
      } else if (pending.type === 'enter') {
        if (pos && pos.side !== pending.side) close(bar.o - slip * pos.side, bar, i, 'REVERSE');
        if (!pos) {
          const price = bar.o + slip * pending.side;
          open(pending.side, pending.qty, price, bar, i, pending.stop, pending.tp, pending.risk);
        }
      }
      pending = null;
    }

    // 2. Stop / target orders fill intrabar.
    if (pos) {
      const hit = intrabarExit(bar, pos, slip);
      if (hit) close(hit.price, bar, i, hit.reason);
    }

    // 3. Bar close: act on the strategy's signal.
    if (signal.eodExit && pos) close(bar.c - slip * pos.side, bar, i, 'EOD');

    const equity = equityAt(bar.c);
    if (signal.longEntry || signal.shortEntry) {
      const side = signal.longEntry ? 1 : -1;
      const qty = roundQty(sizeFor(params, o, equity, signal.riskDst, bar.c));
      if (qty > 0) {
        pending = {
          type: 'enter',
          side,
          qty,
          stop: params.useStop ? signal.stopLvl : NaN,
          tp: params.tpOn ? signal.tpLvl : NaN,
          risk: signal.riskDst,
        };
      } else if (pos && pos.side !== side) {
        pending = { type: 'close', reason: 'EXIT' };
      }
    } else if (pos && ((signal.longExit && pos.side === 1) || (signal.shortExit && pos.side === -1))) {
      pending = { type: 'close', reason: 'EXIT' };
    }

    if (o.statsFrom == null || bar.t >= o.statsFrom) {
      if (pos) barsInPosition++;
      equityCurve.push({ t: bar.t, equity: equityAt(bar.c) });
    }
  }

  const statBars = o.statsFrom == null ? bars : bars.filter((b) => b.t >= o.statsFrom);
  const last = bars[bars.length - 1];
  const openTrade = pos
    ? {
        side: pos.side === 1 ? 'long' : 'short',
        qty: pos.qty,
        entryTime: new Date(pos.entryTime).toISOString(),
        entryPrice: pos.entryPrice,
        unrealizedPnl: (last.c - pos.entryPrice) * pos.qty * pos.side,
      }
    : null;

  return {
    stats: computeStats({ trades, equityCurve, bars: statBars, o, barsInPosition, commissionPaid, openTrade }),
    trades,
    openTrade,
    equityCurve,
  };
}

function sizeFor(params, o, equity, riskDst, price) {
  if (equity <= 0 || !(price > 0)) return 0;
  if (params.sizeMode === 'Risk %' && params.useStop && riskDst > 0) {
    return Math.min((equity * params.riskPct) / 100 / riskDst, equity / price);
  }
  return (equity * o.percentOfEquity) / 100 / price;
}

// TradingView's intrabar assumption: if the open is nearer the high, price goes
// open -> high -> low -> close, otherwise open -> low -> high -> close.
function intrabarExit(bar, pos, slip) {
  const { stop, tp, side } = pos;
  const hasStop = Number.isFinite(stop);
  const hasTp = Number.isFinite(tp);
  if (!hasStop && !hasTp) return null;

  // Gap through a level at the open fills at the open.
  if (side === 1) {
    if (hasStop && bar.o <= stop) return { price: bar.o - slip, reason: 'STOP' };
    if (hasTp && bar.o >= tp) return { price: bar.o, reason: 'TP' };
  } else {
    if (hasStop && bar.o >= stop) return { price: bar.o + slip, reason: 'STOP' };
    if (hasTp && bar.o <= tp) return { price: bar.o, reason: 'TP' };
  }

  const highFirst = bar.h - bar.o < bar.o - bar.l;
  const legs = highFirst ? ['h', 'l'] : ['l', 'h'];
  for (const leg of legs) {
    if (leg === 'h') {
      if (side === 1 && hasTp && bar.h >= tp) return { price: tp, reason: 'TP' };
      if (side === -1 && hasStop && bar.h >= stop) return { price: stop + slip, reason: 'STOP' };
    } else {
      if (side === 1 && hasStop && bar.l <= stop) return { price: stop - slip, reason: 'STOP' };
      if (side === -1 && hasTp && bar.l <= tp) return { price: tp, reason: 'TP' };
    }
  }
  return null;
}

function computeStats({ trades, equityCurve, bars, o, barsInPosition, commissionPaid, openTrade }) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const netProfit = grossProfit - grossLoss;

  let peak = o.initialCapital;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const { equity } of equityCurve) {
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    maxDdPct = Math.max(maxDdPct, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }

  const rs = trades.map((t) => t.rMultiple).filter(Number.isFinite);
  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  const side = (s) => {
    const list = trades.filter((t) => t.side === s);
    return {
      trades: list.length,
      winRate: list.length ? (list.filter((t) => t.pnl > 0).length / list.length) * 100 : NaN,
      netProfit: list.reduce((a, t) => a + t.pnl, 0),
    };
  };

  const first = bars[0];
  const last = bars[bars.length - 1];
  return {
    from: new Date(first.t).toISOString(),
    to: new Date(last.t).toISOString(),
    bars: bars.length,
    initialCapital: o.initialCapital,
    finalEquity: equityCurve.length ? equityCurve[equityCurve.length - 1].equity : o.initialCapital,
    netProfit,
    netProfitPct: (netProfit / o.initialCapital) * 100,
    buyHoldPct: ((last.c - first.o) / first.o) * 100,
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : NaN,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : NaN,
    avgTrade: trades.length ? netProfit / trades.length : NaN,
    avgWin: wins.length ? grossProfit / wins.length : NaN,
    avgLoss: losses.length ? -grossLoss / losses.length : NaN,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : NaN,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : NaN,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    exposurePct: bars.length ? (barsInPosition / bars.length) * 100 : 0,
    avgBarsHeld: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : NaN,
    commissionPaid,
    exitReasons: byReason,
    long: side('long'),
    short: side('short'),
    openTrade,
  };
}

module.exports = { backtest, intrabarExit, DEFAULT_OPTIONS };
