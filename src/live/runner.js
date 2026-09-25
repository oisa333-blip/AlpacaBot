'use strict';

const { computeSeries, createEngine, warmupBars } = require('../strategy/vpm');
const { loadChartBars, startForBars } = require('../market/history');
const { parseTimeframe, MINUTE } = require('../market/time');

const MAX_EVENTS = 300;

// Runs the VPM strategy on live Alpaca bars for each symbol and trades its signals.
function createRunner({ alpaca, data, executor, config, log = console, now = Date.now }) {
  const p = config.params;
  const tfMs = parseTimeframe(config.timeframe).minutes * MINUTE;
  const events = [];
  const symbols = config.symbols.map((s) => ({
    ...s,
    session: s.isCrypto ? '24h' : 'rth',
    bars: [],
    engine: createEngine(p),
    nextCheck: 0,
    lastSignal: null,
  }));
  let clock = { is_open: false, next_close: null, fetchedAt: 0 };
  let eodDoneFor = null;
  let running = false;
  let timer = null;

  function record(event) {
    events.unshift({ time: new Date(now()).toISOString(), ...event });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    log.info(`[${event.symbol || 'bot'}] ${event.type}${event.message ? `: ${event.message}` : ''}`);
  }

  async function refreshClock() {
    if (now() - clock.fetchedAt < 30000) return clock;
    const c = await alpaca.getClock();
    clock = { is_open: c.is_open, next_close: c.next_close ? Date.parse(c.next_close) : null, fetchedAt: now() };
    return clock;
  }

  async function fetchComplete(sym, start) {
    const bars = await loadChartBars(data, {
      symbol: sym.orderSymbol,
      isCrypto: sym.isCrypto,
      timeframe: config.timeframe,
      start,
      end: new Date(now()),
    });
    return bars.filter((b) => b.closeTime <= now());
  }

  async function warmup(sym) {
    const need = Math.ceil(warmupBars(p, sym.session) * 1.2);
    const bars = await fetchComplete(sym, startForBars(need, config.timeframe, sym.isCrypto, now()));
    sym.bars = bars;
    const series = computeSeries(bars, p, { session: sym.session });
    for (let i = 0; i < bars.length; i++) {
      const signal = sym.engine.step(bars[i], series[i]);
      sym.lastSignal = { ...signal, score: series[i].score, htfScore: series[i].htfScore, inRange: series[i].inRange, barTime: bars[i].t };
    }
    sym.maxBars = Math.max(need * 2, 500);
    sym.nextCheck = bars.length ? bars[bars.length - 1].closeTime + tfMs : now();

    const pos = await alpaca.getPosition(sym.positionSymbol);
    const state = { 1: 'long', '-1': 'short', 0: 'flat' }[sym.engine.state.sig];
    const held = pos ? `${Number(pos.qty) > 0 ? 'long' : 'short'} ${pos.qty}` : 'flat';
    record({
      symbol: sym.orderSymbol,
      type: 'ready',
      message: `${bars.length} bars warmed up, strategy ${state}, account ${held}`,
    });
    if (bars.length < warmupBars(p, sym.session)) {
      record({ symbol: sym.orderSymbol, type: 'warning', message: `only ${bars.length} bars of history; early signals may be unreliable` });
    }
  }

  async function processSymbol(sym, marketOpen) {
    if (now() < sym.nextCheck + config.barDelaySeconds * 1000) return;
    const last = sym.bars[sym.bars.length - 1];
    const start = last ? new Date(last.closeTime) : startForBars(warmupBars(p, sym.session), config.timeframe, sym.isCrypto, now());
    const fresh = (await fetchComplete(sym, start)).filter((b) => !last || b.t > last.t);
    if (!fresh.length) {
      // Nothing new yet (market closed, or the provider is behind): look again next poll after a bar.
      sym.nextCheck = Math.max(sym.nextCheck, now() - config.barDelaySeconds * 1000) + Math.min(tfMs, 60000);
      return;
    }

    for (const bar of fresh) {
      sym.bars.push(bar);
      if (sym.bars.length > sym.maxBars) sym.bars.splice(0, sym.bars.length - sym.maxBars);
      const series = computeSeries(sym.bars, p, { session: sym.session });
      const s = series[series.length - 1];
      const signal = sym.engine.step(bar, s);
      sym.lastSignal = { ...signal, score: s.score, htfScore: s.htfScore, inRange: s.inRange, barTime: bar.t };

      const acted = ['longEntry', 'shortEntry', 'longExit', 'shortExit', 'stopLong', 'stopShort', 'tpLong', 'tpShort', 'eodExit'].filter(
        (k) => signal[k],
      );
      if (!acted.length) continue;

      // Only trade the newest bars; older ones (catch-up after downtime) just update state.
      if (bar.closeTime < now() - 2 * tfMs) {
        record({ symbol: sym.orderSymbol, type: 'stale', message: `${acted.join(', ')} on ${new Date(bar.t).toISOString()} not traded` });
        continue;
      }
      try {
        const result = await executor.handle(sym, bar, signal, { marketOpen });
        record({ symbol: sym.orderSymbol, type: 'signal', message: `${acted.join(', ')} → ${[...result.actions, ...result.notes].join('; ') || 'no action'}`, result });
      } catch (err) {
        record({ symbol: sym.orderSymbol, type: 'error', message: `${acted.join(', ')}: ${err.message}` });
      }
    }
    sym.nextCheck = sym.bars[sym.bars.length - 1].closeTime + tfMs;
  }

  // Intraday stock mode: flatten shortly before the close (bars arrive after the bell).
  async function maybeFlattenBeforeClose(c) {
    if (!p.flatAtClose || !c.is_open || !c.next_close) return;
    const today = new Date(c.next_close).toISOString().slice(0, 10);
    if (eodDoneFor === today || now() < c.next_close - config.eodBufferSeconds * 1000) return;
    eodDoneFor = today;
    for (const sym of symbols.filter((s) => !s.isCrypto)) {
      const result = { actions: [], notes: [] };
      try {
        await executor.ensureFlat(sym, 'any', result);
        sym.engine.state.sig = 0;
        record({ symbol: sym.orderSymbol, type: 'eod', message: result.actions.join('; ') || 'already flat' });
      } catch (err) {
        record({ symbol: sym.orderSymbol, type: 'error', message: `EOD flatten: ${err.message}` });
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const c = await refreshClock();
      await maybeFlattenBeforeClose(c);
      for (const sym of symbols) {
        try {
          if (!sym.bars.length) await warmup(sym);
          else await processSymbol(sym, c.is_open);
        } catch (err) {
          record({ symbol: sym.orderSymbol, type: 'error', message: err.message });
        }
      }
    } catch (err) {
      record({ type: 'error', message: err.message });
    } finally {
      running = false;
    }
  }

  function start() {
    record({
      type: 'start',
      message: `${symbols.map((s) => s.orderSymbol).join(', ')} on ${config.timeframe} (${p.preset}, HTF ${p.htfOn ? p.htfTf : 'off'})${config.dryRun ? ' DRY RUN' : ''}`,
    });
    tick();
    timer = setInterval(tick, config.pollSeconds * 1000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function snapshot() {
    return symbols.map((s) => {
      const last = s.bars[s.bars.length - 1];
      const sig = s.lastSignal;
      return {
        symbol: s.orderSymbol,
        bars: s.bars.length,
        lastBar: last ? new Date(last.t).toISOString() : null,
        strategy: { 1: 'long', '-1': 'short', 0: 'flat' }[s.engine.state.sig],
        score: sig && Number.isFinite(sig.score) ? Math.round(sig.score * 10) / 10 : null,
        htfScore: sig && Number.isFinite(sig.htfScore) ? Math.round(sig.htfScore * 10) / 10 : null,
        inRange: sig ? sig.inRange : null,
        stop: Number.isFinite(s.engine.state.stopLvl) && s.engine.state.sig ? s.engine.state.stopLvl : null,
        target: Number.isFinite(s.engine.state.tpLvl) && s.engine.state.sig ? s.engine.state.tpLvl : null,
      };
    });
  }

  return { start, stop, tick, snapshot, events, symbols };
}

module.exports = { createRunner };
