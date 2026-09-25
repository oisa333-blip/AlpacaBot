'use strict';

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : n === Infinity ? '∞' : '—');
const money = (n) => (Number.isFinite(n) ? `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}` : '—');

function summaryText(title, s) {
  const lines = [
    title,
    `  Period         ${s.from.slice(0, 10)} → ${s.to.slice(0, 10)}  (${s.bars} bars)`,
    `  Net profit     ${money(s.netProfit)}  (${fmt(s.netProfitPct)}%)   buy & hold ${fmt(s.buyHoldPct)}%`,
    `  Final equity   ${money(s.finalEquity)}  from ${money(s.initialCapital)}`,
    `  Trades         ${s.trades}   win rate ${fmt(s.winRate, 1)}%   profit factor ${fmt(s.profitFactor)}`,
    `  Avg trade      ${money(s.avgTrade)}   avg win ${money(s.avgWin)}   avg loss ${money(s.avgLoss)}   avg R ${fmt(s.avgR)}`,
    `  Max drawdown   ${money(s.maxDrawdown)}  (${fmt(s.maxDrawdownPct)}%)`,
    `  Exposure       ${fmt(s.exposurePct, 1)}% of bars   avg hold ${fmt(s.avgBarsHeld, 1)} bars   commission ${money(s.commissionPaid)}`,
    `  Longs          ${s.long.trades} trades, ${fmt(s.long.winRate, 1)}% win, ${money(s.long.netProfit)}`,
    `  Shorts         ${s.short.trades} trades, ${fmt(s.short.winRate, 1)}% win, ${money(s.short.netProfit)}`,
    `  Exits          ${Object.entries(s.exitReasons).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`,
  ];
  if (s.openTrade) {
    lines.push(`  Open trade     ${s.openTrade.side} ${s.openTrade.qty} @ ${fmt(s.openTrade.entryPrice)}, unrealized ${money(s.openTrade.unrealizedPnl)}`);
  }
  return lines.join('\n');
}

function comparisonTable(rows) {
  const header = ['Symbol', 'Preset', 'TF', 'Trades', 'Win %', 'PF', 'Net %', 'Max DD %', 'B&H %'];
  const body = rows.map((r) => [
    r.symbol,
    r.preset,
    r.timeframe,
    String(r.stats.trades),
    fmt(r.stats.winRate, 1),
    fmt(r.stats.profitFactor),
    fmt(r.stats.netProfitPct),
    fmt(r.stats.maxDrawdownPct),
    fmt(r.stats.buyHoldPct),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

function tradesCsv(trades) {
  const cols = ['side', 'qty', 'entryTime', 'entryPrice', 'exitTime', 'exitPrice', 'reason', 'pnl', 'pnlPct', 'rMultiple', 'bars'];
  const cell = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : '') : String(v));
  return [cols.join(','), ...trades.map((t) => cols.map((c) => cell(t[c])).join(','))].join('\n') + '\n';
}

function equityCsv(curve) {
  return ['time,equity', ...curve.map((p) => `${new Date(p.t).toISOString()},${p.equity.toFixed(2)}`)].join('\n') + '\n';
}

module.exports = { summaryText, comparisonTable, tradesCsv, equityCsv };
