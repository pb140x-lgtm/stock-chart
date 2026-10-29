// Manueller Screener-Lauf — Aufruf: node scan.js
const fetch = require("node-fetch");
const path  = require("path");
const fs    = require("fs");

const DATA_DIR    = path.join(__dirname, "data");
const RESULTS_FILE = path.join(DATA_DIR, "screener-results.json");
const stoxx600    = JSON.parse(fs.readFileSync(path.join(__dirname, "symbols/stoxx600.json"), "utf8"));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

async function fetchCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp;
    const q  = result.indicators.quote[0];
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] == null || q.close[i] == null) continue;
      candles.push({ time: ts[i], high: q.high[i], low: q.low[i], close: q.close[i] });
    }
    return candles.length >= 40 ? candles : null;
  } catch { return null; }
}

function calcActiveSignal(candles, period = 20) {
  let lastSPrice = null, lastSTime = null;
  let activeK = null;
  let pos = 0;

  for (let i = period; i < candles.length; i++) {
    let prevHigh = -Infinity, prevLow = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > prevHigh) prevHigh = candles[j].high;
      if (candles[j].low  < prevLow)  prevLow  = candles[j].low;
    }
    const close = candles[i].close;

    if (pos <= 0 && close > prevHigh) {
      if (lastSPrice !== null && (lastSPrice - close) / lastSPrice >= 0.15) {
        activeK = { time: candles[i].time, price: close, lastSPrice, lastSTime };
      } else {
        activeK = null;
      }
      pos = 1;
    } else if (pos >= 0 && close < prevLow) {
      lastSPrice = close;
      lastSTime  = candles[i].time;
      activeK    = null;
      pos = -1;
    }
  }
  return activeK;
}

async function runScreener() {
  console.log(`[Screener] Starte Scan (${stoxx600.length} Werte) …`);
  const results = [];

  for (let i = 0; i < stoxx600.length; i++) {
    const stock = stoxx600[i];
    if (i > 0 && i % 50 === 0) console.log(`[Screener] ${i}/${stoxx600.length} …`);

    const candles = await fetchCandles(stock.symbol);
    if (!candles) continue;

    const activeK = calcActiveSignal(candles);
    if (!activeK) continue;

    const last      = candles[candles.length - 1];
    const returnPct = (last.close - activeK.price) / activeK.price * 100;
    const daysSince = Math.round((last.time - activeK.time) / 86400);
    const distFromS = (activeK.price - activeK.lastSPrice) / activeK.lastSPrice * 100;

    results.push({
      symbol:       stock.symbol,
      name:         stock.name,
      index:        stock.index,
      entryDate:    new Date(activeK.time * 1000).toISOString().slice(0, 10),
      entryPrice:   +activeK.price.toFixed(2),
      currentPrice: +last.close.toFixed(2),
      returnPct:    +returnPct.toFixed(2),
      daysSince,
      distFromS:    +distFromS.toFixed(1),
    });

    await new Promise(r => setTimeout(r, 80));
  }

  results.sort((a, b) => b.returnPct - a.returnPct);
  const out = { results, updatedAt: new Date().toISOString(), found: results.length, total: stoxx600.length };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
  console.log(`[Screener] Fertig: ${results.length} aktive Turtle-Signale`);
}

runScreener();
