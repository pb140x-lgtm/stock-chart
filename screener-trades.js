"use strict";
const fetch = require("node-fetch");
const fs    = require("fs");
const path  = require("path");

const SMA_PERIOD    = 20;
const EVAL_DAYS     = 600;
const MIN_EVAL_DAYS = 300;

async function fetchCandles(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=5y&interval=1d&includePrePost=false`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      timeout: 10000,
    });
    if (!r.ok) return null;
    const data   = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp;
    const q  = result.indicators.quote[0];
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue;
      candles.push({
        date:  new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close: q.close[i],
      });
    }
    return candles.length >= MIN_EVAL_DAYS ? candles : null;
  } catch {
    return null;
  }
}

function calcSMA(closes, period) {
  const ma  = new Array(closes.length).fill(null);
  let   sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period)     sum -= closes[i - period];
    if (i >= period - 1) ma[i] = sum / period;
  }
  return ma;
}

function detectTrades(candles) {
  const closes = candles.map(c => c.close);
  const ma     = calcSMA(closes, SMA_PERIOD);

  // Auswertungsfenster: letzte 600 Handelstage, mindestens 300
  const evalDays  = candles.length >= EVAL_DAYS
    ? EVAL_DAYS
    : Math.max(MIN_EVAL_DAYS, candles.length);
  const evalStart = candles.length - evalDays;

  // Immer ab dem Anfang tracken (Kontext für 15%-Bedingung)
  let lastDownPrice = null;   // Kurs beim letzten Abwärts-Crossover
  let lastUpPrice   = null;   // Kurs beim letzten Aufwärts-Crossover
  let openTrade     = null;
  const trades      = [];

  for (let i = SMA_PERIOD; i < candles.length; i++) {
    const prev   = closes[i - 1];
    const curr   = closes[i];
    const prevMA = ma[i - 1];
    const currMA = ma[i];
    if (prevMA === null) continue;

    const wasAbove = prev > prevMA;
    const isAbove  = curr > currMA;

    // ── Aufwärts-Crossover (war unter MA, jetzt über MA) ──
    if (!wasAbove && isAbove) {
      // Kaufsignal: letzter Abwärts-Kurs ≥ 15 % über aktuellem Kurs
      const qualifies = lastDownPrice !== null && lastDownPrice >= curr * 1.15;

      if (qualifies && i >= evalStart) {
        if (openTrade) {
          closeOpenTrade(openTrade, candles[i].date, curr, trades);
        }
        openTrade = {
          direction:  "Long",
          entryDate:  candles[i].date,
          entryPrice: +curr.toFixed(4),
          signalDist: +((lastDownPrice - curr) / curr * 100).toFixed(1),
          exitDate:   null,
          exitPrice:  null,
          diffPct:    null,
          open:       true,
        };
      }
      lastUpPrice = curr;   // immer aktualisieren, auch ohne Signal
    }

    // ── Abwärts-Crossover (war über MA, jetzt unter MA) ──
    if (wasAbove && !isAbove) {
      // Verkaufssignal: aktueller Kurs ≥ 15 % über letztem Aufwärts-Kurs
      const qualifies = lastUpPrice !== null && curr >= lastUpPrice * 1.15;

      if (qualifies && i >= evalStart) {
        if (openTrade) {
          closeOpenTrade(openTrade, candles[i].date, curr, trades);
        }
        openTrade = {
          direction:  "Short",
          entryDate:  candles[i].date,
          entryPrice: +curr.toFixed(4),
          signalDist: +((curr - lastUpPrice) / lastUpPrice * 100).toFixed(1),
          exitDate:   null,
          exitPrice:  null,
          diffPct:    null,
          open:       true,
        };
      }
      lastDownPrice = curr;   // immer aktualisieren
    }
  }

  // Offener Trade: letzter Kurs als laufender Stand
  if (openTrade) {
    const last = closes[closes.length - 1];
    openTrade.exitPrice = +last.toFixed(4);
    openTrade.diffPct   = openTrade.direction === "Long"
      ? +((last - openTrade.entryPrice) / openTrade.entryPrice * 100).toFixed(2)
      : +((openTrade.entryPrice - last) / openTrade.entryPrice * 100).toFixed(2);
    trades.push({ ...openTrade });
  }

  return trades;
}

function closeOpenTrade(trade, exitDate, exitPrice, tradesArr) {
  trade.exitDate  = exitDate;
  trade.exitPrice = +exitPrice.toFixed(4);
  trade.diffPct   = trade.direction === "Long"
    ? +((exitPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(2)
    : +((trade.entryPrice - exitPrice) / trade.entryPrice * 100).toFixed(2);
  trade.open = false;
  tradesArr.push({ ...trade });
}

async function runScreener(symbols, outputFile, opts = {}) {
  const list = opts.testMode
    ? [...symbols].sort(() => Math.random() - 0.5).slice(0, 20)
    : symbols;

  console.log(`[Screener] ${list.length} Symbole …`);
  const results = [];

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (i > 0 && i % 50 === 0) console.log(`  ${i}/${list.length}`);

    const candles = await fetchCandles(s.symbol);
    if (!candles) continue;

    const allTrades = detectTrades(candles);
    if (allTrades.length === 0) continue;

    // Symbol nur aufnehmen wenn ein Signal in den letzten 5 Handelstagen (≈ 8 Kalendertage)
    const recentCutoff = new Date();
    recentCutoff.setDate(recentCutoff.getDate() - 8);
    const recentStr = recentCutoff.toISOString().slice(0, 10);
    const hasRecentSignal = allTrades.some(t => t.entryDate >= recentStr);
    if (!hasRecentSignal) continue;

    // Für diese Treffer: Trades des letzten Jahres anzeigen
    const yearCutoff = new Date();
    yearCutoff.setFullYear(yearCutoff.getFullYear() - 1);
    const yearStr = yearCutoff.toISOString().slice(0, 10);
    const trades = allTrades.filter(t => t.entryDate >= yearStr);
    if (trades.length === 0) continue;

    results.push({
      symbol: s.symbol,
      name:   s.name,
      index:  s.index || "",
      trades,
    });

    await new Promise(r => setTimeout(r, 80));
  }

  const out = {
    results,
    updatedAt: new Date().toISOString(),
    found:     results.length,
    total:     list.length,
  };

  const dir = path.dirname(outputFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(out, null, 2));
  console.log(`[Screener] Fertig: ${results.length}/${list.length} Treffer`);
  return out;
}

module.exports = { fetchCandles, detectTrades, runScreener };
