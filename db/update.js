// Tägliches Update: lädt OHLCV von Yahoo Finance, ermittelt aktive Turtle-Kaufsignale.
// Logik: identisch mit dem Chart — computeAllTurtleSignals aus signals.js.
// Eine Aktie erscheint, solange ihr letztes Signal ein Kauf ist (kein Folge-Kauf, kein Verkauf).

const { openDb } = require("./schema");
const { computeAllTurtleSignals, computeSMA } = require("../public/signals.js");
const path = require("path");
const fs = require("fs");

const SYMBOLS_FILE = path.join(__dirname, "..", "symbols", "stoxx600.json");
const PERIOD = 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function syncSymbols(db) {
  const data = JSON.parse(fs.readFileSync(SYMBOLS_FILE, "utf8"));
  const insert = db.prepare(
    "INSERT OR IGNORE INTO symbols (symbol, name, index_name) VALUES (?, ?, ?)"
  );
  for (const row of data) insert.run(row.symbol, row.name, row.index);
}

async function fetchYahoo(symbol, range = "1y") {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const result = j.chart?.result?.[0];
  if (!result) throw new Error("Kein Ergebnis");
  const t = result.timestamp || [];
  const q = result.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < t.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue;
    candles.push({
      date:   new Date(t[i] * 1000).toISOString().slice(0, 10),
      open:   q.open[i],
      high:   q.high[i],
      low:    q.low[i],
      close:  q.close[i],
      volume: q.volume[i] || 0,
    });
  }
  return candles;
}

function storeCandles(db, symbol, candles) {
  const ins = db.prepare(
    "INSERT OR REPLACE INTO ohlcv (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const c of candles) ins.run(symbol, c.date, c.open, c.high, c.low, c.close, c.volume);
}

function hasData(db, symbol) {
  return db.prepare("SELECT 1 FROM ohlcv WHERE symbol = ? LIMIT 1").get(symbol) != null;
}

// Prüft ob das letzte Turtle-Signal für dieses Symbol ein Kauf ist.
// Identische Logik zum Chart: computeAllTurtleSignals aus signals.js.
// Gibt Signal-Datum, Ausbruchskurs und aktuellen SMA 10 zurück, oder null.
function checkCurrentSignal(db, symbol) {
  const rows = db.prepare(
    "SELECT date, high, low, close FROM ohlcv WHERE symbol = ? ORDER BY date ASC"
  ).all(symbol);

  if (rows.length <= PERIOD) return null;

  const candles = rows.map(r => ({ time: r.date, high: r.high, low: r.low, close: r.close }));
  const signals = computeAllTurtleSignals(candles, PERIOD);
  if (!signals.length) return null;

  const last = signals[signals.length - 1];
  if (last.type !== "buy") return null;

  const sma10arr = computeSMA(candles, 10);
  const sma10 = sma10arr.length ? sma10arr[sma10arr.length - 1].value : null;

  return { date: last.time, breakoutPrice: last.breakout, sma10 };
}

async function runUpdate(onProgress) {
  const db = openDb();
  const t0 = Date.now();
  let symbolsUpdated = 0, signalsFound = 0, errors = 0;

  try {
    syncSymbols(db);
    const symbols = db.prepare("SELECT symbol, name FROM symbols ORDER BY symbol").all();
    const total = symbols.length;
    const today = new Date().toISOString().slice(0, 10);
    const results = [];

    for (let i = 0; i < symbols.length; i++) {
      const { symbol, name } = symbols[i];
      try {
        const firstRun = !hasData(db, symbol);
        const candles = await fetchYahoo(symbol, firstRun ? "1y" : "2d");
        storeCandles(db, symbol, candles);
        symbolsUpdated++;

        const sig = checkCurrentSignal(db, symbol);
        if (sig) { results.push({ symbol, name, ...sig }); signalsFound++; }
      } catch (err) {
        errors++;
        console.warn(`[Screener] ${symbol}: ${err.message}`);
      }

      if (onProgress) onProgress(i + 1, total, signalsFound);
      // 5 gleichzeitig, dann 1s Pause (Yahoo Rate-Limiting)
      if ((i + 1) % 5 === 0) await sleep(1000);
    }

    // Ergebnisse in DB schreiben
    db.exec(`DELETE FROM screener_results WHERE run_date = '${today}'`);
    const ins = db.prepare(
      "INSERT INTO screener_results (run_date, symbol, name, signal_date, breakout_price, sma10) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const r of results) ins.run(today, r.symbol, r.name, r.date, r.breakoutPrice, r.sma10 ?? null);

    const duration = Date.now() - t0;
    db.prepare(
      "INSERT OR REPLACE INTO update_log (run_at, symbols_updated, signals_found, duration_ms) VALUES (?, ?, ?, ?)"
    ).run(new Date().toISOString(), symbolsUpdated, signalsFound, duration);

    console.log(`[Screener] Fertig: ${symbolsUpdated} aktualisiert, ${signalsFound} Signale, ${errors} Fehler, ${(duration / 1000).toFixed(1)}s`);
    return { symbolsUpdated, signalsFound, errors, duration };
  } catch (err) {
    db.prepare("INSERT OR REPLACE INTO update_log (run_at, error) VALUES (?, ?)").run(new Date().toISOString(), err.message);
    throw err;
  } finally {
    db.close();
  }
}

// Report aus DB lesen — zeigt Signale der letzten 5 Kalendertage (pro Symbol nur den neuesten)
function getLatestReport() {
  const db = openDb();
  try {
    const logRow = db.prepare("SELECT * FROM update_log ORDER BY run_at DESC LIMIT 1").get();
    if (!logRow) return { runAt: null, results: [] };

    const allRows = db.prepare(
      `SELECT sr.symbol, sr.name, sr.signal_date, sr.breakout_price, sr.sma10,
              sr.run_date, o.close AS close_price,
              s.index_name
       FROM screener_results sr
       LEFT JOIN ohlcv o   ON o.symbol = sr.symbol
                           AND o.date = (SELECT MAX(date) FROM ohlcv WHERE symbol = sr.symbol)
       LEFT JOIN symbols s ON s.symbol = sr.symbol
       WHERE sr.run_date = (SELECT MAX(run_date) FROM screener_results)
       ORDER BY sr.signal_date DESC, sr.symbol ASC`
    ).all();

    // Pro Symbol nur den jüngsten Eintrag behalten
    const seen = new Set();
    const results = allRows.filter(r => {
      if (seen.has(r.symbol)) return false;
      seen.add(r.symbol);
      return true;
    });

    return {
      runAt: logRow.run_at,
      runDate: logRow.run_at.slice(0, 10),
      symbolsUpdated: logRow.symbols_updated,
      signalsFound: logRow.signals_found,
      durationMs: logRow.duration_ms,
      results,
    };
  } finally {
    db.close();
  }
}

function getWatchlist() {
  const db = openDb();
  try {
    return db.prepare(
      "SELECT symbol, name, signal_date, added_at FROM watchlist ORDER BY added_at DESC"
    ).all();
  } finally { db.close(); }
}

function addToWatchlist(symbol, name, signalDate) {
  const db = openDb();
  try {
    db.prepare(
      "INSERT OR REPLACE INTO watchlist (symbol, name, signal_date, added_at) VALUES (?, ?, ?, ?)"
    ).run(symbol, name, signalDate, new Date().toISOString());
  } finally { db.close(); }
}

function removeFromWatchlist(symbol) {
  const db = openDb();
  try {
    db.prepare("DELETE FROM watchlist WHERE symbol = ?").run(symbol);
  } finally { db.close(); }
}

module.exports = { runUpdate, getLatestReport, getWatchlist, addToWatchlist, removeFromWatchlist };
