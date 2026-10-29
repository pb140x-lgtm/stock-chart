const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, "data");
const RESULTS_FILE = path.join(DATA_DIR, "screener-results.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const stoxx600 = JSON.parse(fs.readFileSync(path.join(__dirname, "symbols/stoxx600.json"), "utf8"));

// ── Yahoo Finance Proxy ──────────────────────────────────────
app.get("/api/history", async (req, res) => {
  const { symbol, range = "1y", interval = "1d" } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: "Keine Daten" });
    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] == null || q.close[i] == null) continue;
      candles.push({ time: ts[i], open: +q.open[i].toFixed(4), high: +q.high[i].toFixed(4), low: +q.low[i].toFixed(4), close: +q.close[i].toFixed(4), volume: q.volume[i] || 0 });
    }
    res.json({ symbol, candles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Symbole ─────────────────────────────────────────────────
app.get("/api/symbols", (_req, res) => res.json(stoxx600));

// ── Screener Ergebnisse ──────────────────────────────────────
app.get("/api/screener", (_req, res) => {
  if (fs.existsSync(RESULTS_FILE)) return res.json(JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")));
  res.json({ results: [], updatedAt: null, found: 0, total: stoxx600.length });
});

app.post("/api/screener/run", (_req, res) => {
  res.json({ status: "gestartet" });
  runScreener();
});

// ── Trades speichern / laden ─────────────────────────────────
const TRADES_DIR = path.join(DATA_DIR, "trades");
if (!fs.existsSync(TRADES_DIR)) fs.mkdirSync(TRADES_DIR);

app.get("/api/trades/:symbol", (req, res) => {
  const file = path.join(TRADES_DIR, `${req.params.symbol.replace(/[^a-zA-Z0-9._-]/g,"_")}.json`);
  if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, "utf8")));
  res.json(null);
});

app.post("/api/trades/:symbol", (req, res) => {
  const file = path.join(TRADES_DIR, `${req.params.symbol.replace(/[^a-zA-Z0-9._-]/g,"_")}.json`);
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// ── Claude Proxy ─────────────────────────────────────────────
app.post("/api/claude", async (req, res) => {
  const { apiKey, messages, system } = req.body;
  if (!apiKey) return res.status(400).json({ error: "API Key fehlt" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, system, messages }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ text: data.content?.[0]?.text || "", usage: data.usage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Screener-Logik (server-seitig) ───────────────────────────
async function fetchCandles(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp;
    const q = result.indicators.quote[0];
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
      // Long Entry (K) — gültig wenn ≥15% unter letztem Short Entry (S)
      if (lastSPrice !== null && (lastSPrice - close) / lastSPrice >= 0.15) {
        activeK = { time: candles[i].time, price: close, lastSPrice, lastSTime };
      } else {
        activeK = null; // kein gültiges Signal
      }
      pos = 1;
    } else if (pos >= 0 && close < prevLow) {
      // Short Entry (S)
      lastSPrice = close;
      lastSTime = candles[i].time;
      activeK = null;
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

    const last = candles[candles.length - 1];
    const returnPct = (last.close - activeK.price) / activeK.price * 100;
    const daysSince = Math.round((last.time - activeK.time) / 86400);
    const distFromS = (activeK.price - activeK.lastSPrice) / activeK.lastSPrice * 100;

    results.push({
      symbol: stock.symbol,
      name: stock.name,
      index: stock.index,
      entryDate: new Date(activeK.time * 1000).toISOString().slice(0, 10),
      entryPrice: +activeK.price.toFixed(2),
      currentPrice: +last.close.toFixed(2),
      returnPct: +returnPct.toFixed(2),
      daysSince,
      distFromS: +distFromS.toFixed(1),
    });

    await new Promise(r => setTimeout(r, 80)); // Rate-Limit
  }

  results.sort((a, b) => b.returnPct - a.returnPct);
  const out = { results, updatedAt: new Date().toISOString(), found: results.length, total: stoxx600.length };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
  console.log(`[Screener] Fertig: ${results.length} aktive Turtle-Signale`);
}

// ── Scheduler: Mo–Fr 23:05 Berlin ────────────────────────────
(function scheduleDailyScreener() {
  function msUntilNext2305Berlin() {
    const now = new Date();
    for (let dayAdd = 0; dayAdd <= 7; dayAdd++) {
      const base = new Date(now);
      base.setUTCDate(base.getUTCDate() + dayAdd);
      base.setUTCHours(0, 0, 0, 0);
      for (let utcH = 20; utcH <= 23; utcH++) {
        const candidate = new Date(base.getTime() + utcH * 3600000 + 5 * 60000);
        const bt = candidate.toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour12: false });
        if (!bt.startsWith("23:05")) continue;
        const ms = candidate.getTime() - now.getTime();
        if (ms < 30000) continue;
        const wd = candidate.toLocaleDateString("en-US", { timeZone: "Europe/Berlin", weekday: "short" });
        if (wd === "Sat" || wd === "Sun") break;
        return ms;
      }
    }
    return 24 * 3600000;
  }
  function scheduleNext() {
    const ms = msUntilNext2305Berlin();
    const at = new Date(Date.now() + ms).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
    console.log(`[Screener] Nächster Lauf: ${at}`);
    setTimeout(async () => { await runScreener(); scheduleNext(); }, ms);
  }
  scheduleNext();
})();

app.listen(PORT, () => console.log(`Chart-Server: http://localhost:${PORT}`));
