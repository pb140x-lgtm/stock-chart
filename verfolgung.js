"use strict";
const fs    = require("fs");
const path  = require("path");
const fetch = require("node-fetch");

const DATA_DIR   = path.join(__dirname, "data");
const TABLES_FILE = path.join(DATA_DIR, "verfolgung-tables.json");
const MAX_DAYS   = 20;

if (!fs.existsSync(TABLES_FILE))
  fs.writeFileSync(TABLES_FILE, JSON.stringify({ tables: [] }, null, 2));

function readDB()    { return JSON.parse(fs.readFileSync(TABLES_FILE, "utf8")); }
function writeDB(db) { fs.writeFileSync(TABLES_FILE, JSON.stringify(db, null, 2)); }

// ── Helpers ─────────────────────────────────────────────────

const YH    = "https://query1.finance.yahoo.com";
const YH_UA = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

async function yahooHistory(symbol) {
  const url = `${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2mo&interval=1d&includePrePost=false`;
  const r = await fetch(url, { headers: YH_UA, timeout: 10000 });
  if (!r.ok) throw new Error(`Yahoo history ${r.status}`);
  const json = await r.json();
  const res  = json?.chart?.result?.[0];
  if (!res) throw new Error("Keine Daten");
  const name     = res.meta?.longName || res.meta?.shortName || symbol;
  const currency = res.meta?.currency || "";
  const ts = res.timestamp;
  const q  = res.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    candles.push({
      date:   new Date(ts[i] * 1000).toISOString().split("T")[0],
      close:  q.close[i]  != null ? +q.close[i].toFixed(4)  : 0,
      volume: q.volume[i] != null ? q.volume[i] : 0,
    });
  }
  return { name, currency, candles: candles.slice(-MAX_DAYS).reverse() };
}

async function yahooLatest(symbol) {
  const url = `${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
  const r = await fetch(url, { headers: YH_UA, timeout: 10000 });
  if (!r.ok) throw new Error(`Yahoo latest ${r.status}`);
  const json = await r.json();
  const res  = json?.chart?.result?.[0];
  if (!res || !res.timestamp?.length) return null;
  const i = res.timestamp.length - 1;
  const q = res.indicators.quote[0];
  return {
    date:   new Date(res.timestamp[i] * 1000).toISOString().split("T")[0],
    close:  q.close[i]  != null ? +q.close[i].toFixed(4)  : 0,
    volume: q.volume[i] != null ? q.volume[i] : 0,
  };
}

// ── Stats ───────────────────────────────────────────────────

function calcStats(sec) {
  const d = sec.data || [];
  if (!d.length) return { maxClose:0, minClose:0, closeDev:0, maxVol:0, minVol:0, volDev:0, einstandDev:0 };

  const closes  = d.map(x => x.close);
  const volumes = d.map(x => x.volume);
  const maxClose = Math.max(...closes);
  const minClose = Math.min(...closes);
  const maxVol   = Math.max(...volumes);
  const minVol   = Math.min(...volumes);

  const closeDev   = maxClose !== 0 ? +((minClose - maxClose) / maxClose * 100).toFixed(1) : 0;
  const volDev     = maxVol   !== 0 ? +((minVol   - maxVol)   / maxVol   * 100).toFixed(1) : 0;
  const einstandDev = (sec.einstand && sec.einstand > 0 && closes[0] > 0)
    ? +((closes[0] - sec.einstand) / sec.einstand * 100).toFixed(1)
    : 0;

  return {
    maxClose, minClose, closeDev,
    maxVol, minVol, volDev, einstandDev,
    maxCloseIdx: closes.indexOf(maxClose),
    minCloseIdx: closes.indexOf(minClose),
    maxVolIdx:   volumes.indexOf(maxVol),
    minVolIdx:   volumes.indexOf(minVol),
  };
}

// ── Daily update (cron) ─────────────────────────────────────

async function dailyUpdate() {
  const db   = readDB();
  const today = new Date().toISOString().split("T")[0];
  let updated = 0;

  for (const table of db.tables) {
    for (const sec of table.securities) {
      try {
        let entry = await yahooLatest(sec.yahooSymbol);
        if (!entry) entry = { date: today, close: 0, volume: 0 };
        const newestDate = sec.data[0]?.date;
        if (entry.date === newestDate) continue;
        sec.data.unshift(entry);
        if (sec.data.length > MAX_DAYS) sec.data = sec.data.slice(0, MAX_DAYS);
        updated++;
      } catch {
        const newestDate = sec.data[0]?.date;
        if (today !== newestDate) {
          sec.data.unshift({ date: today, close: 0, volume: 0 });
          if (sec.data.length > MAX_DAYS) sec.data = sec.data.slice(0, MAX_DAYS);
          updated++;
        }
      }
    }
  }
  writeDB(db);
  console.log(`[Verfolgung] Daily update: ${updated} Einträge aktualisiert`);
  return updated;
}

// ── Route handlers ──────────────────────────────────────────

function withStats(db) {
  return {
    tables: db.tables.map(t => ({
      ...t,
      securities: t.securities.map(sec => ({ ...sec, stats: calcStats(sec) })),
    })),
  };
}

function registerRoutes(app) {
  // Get all tables
  app.get("/api/verfolgung/tables", (_req, res) => res.json(withStats(readDB())));

  // Create table
  app.post("/api/verfolgung/tables", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const db = readDB();
    const id = "t" + Date.now();
    db.tables.push({ id, name, securities: [] });
    writeDB(db);
    res.json({ id, name });
  });

  // Rename table
  app.put("/api/verfolgung/tables/:id", (req, res) => {
    const db = readDB();
    const t  = db.tables.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    t.name = req.body.name || t.name;
    writeDB(db);
    res.json({ ok: true });
  });

  // Delete table
  app.delete("/api/verfolgung/tables/:id", (req, res) => {
    const db = readDB();
    db.tables = db.tables.filter(x => x.id !== req.params.id);
    writeDB(db);
    res.json({ ok: true });
  });

  // Add security (loads 20-day history)
  // Body: { yahooSymbol: "PGHN.SW" }
  app.post("/api/verfolgung/tables/:id/securities", async (req, res) => {
    const yahooSymbol = (req.body.yahooSymbol || "").trim().toUpperCase();
    if (!yahooSymbol) return res.status(400).json({ error: "yahooSymbol required" });

    const db = readDB();
    const t  = db.tables.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "table not found" });
    if (t.securities.find(s => s.yahooSymbol === yahooSymbol))
      return res.status(409).json({ error: "already exists" });
    try {
      const { name, currency, candles } = await yahooHistory(yahooSymbol);
      t.securities.push({ yahooSymbol, displayName: name, currency, einstand: 0, data: candles });
      writeDB(db);
      res.json({ ok: true, yahooSymbol, displayName: name });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Set Einstandswert
  app.put("/api/verfolgung/tables/:id/securities/:sym/einstand", (req, res) => {
    const db  = readDB();
    const t   = db.tables.find(x => x.id === req.params.id);
    const sec = t?.securities.find(s => s.yahooSymbol === decodeURIComponent(req.params.sym));
    if (!sec) return res.status(404).json({ error: "not found" });
    sec.einstand = parseFloat(req.body.einstand) || 0;
    writeDB(db);
    res.json({ ok: true, stats: calcStats(sec) });
  });

  // Remove security
  app.delete("/api/verfolgung/tables/:id/securities/:sym", (req, res) => {
    const db = readDB();
    const t  = db.tables.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "not found" });
    t.securities = t.securities.filter(s => s.yahooSymbol !== decodeURIComponent(req.params.sym));
    writeDB(db);
    res.json({ ok: true });
  });

  // Manual trigger for daily update
  app.post("/api/verfolgung/update", async (_req, res) => {
    try {
      const n = await dailyUpdate();
      res.json({ ok: true, updated: n });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerRoutes, dailyUpdate };
