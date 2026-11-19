"use strict";
const fs    = require("fs");
const path  = require("path");
const fetch = require("node-fetch");

const DATA_DIR = path.join(__dirname, "data");
const MAX_DAYS = 20;

function makeInstance(namespace) {
  const TABLES_FILE = path.join(DATA_DIR, `${namespace}-tables.json`);
  if (!fs.existsSync(TABLES_FILE))
    fs.writeFileSync(TABLES_FILE, JSON.stringify({ tables: [] }, null, 2));

  function readDB()    { return JSON.parse(fs.readFileSync(TABLES_FILE, "utf8")); }
  function writeDB(db) { fs.writeFileSync(TABLES_FILE, JSON.stringify(db, null, 2)); }
  return { readDB, writeDB };
}

// Default instance for backward-compatibility
const { readDB, writeDB } = makeInstance("verfolgung");

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries) throw e; await sleep(2000 * i); }
  }
}

// ── Stats ───────────────────────────────────────────────────

function calcStats(sec) {
  const d = sec.data || [];
  if (!d.length) return { maxClose:0, minClose:0, closeDev:0, maxVol:0, minVol:0, volDev:0, einstandDev:0 };

  const closes  = d.map(x => x.close);
  const volumes = d.map(x => x.volume);
  // Tage ohne Preis (close = 0) sind fehlende Daten, kein Tief:
  // Minimum nur über Tage mit Preis bilden.
  const priced   = d.filter(x => x.close > 0);
  const minBase  = priced.length ? priced : d;
  const maxClose = Math.max(...closes);
  const minClose = Math.min(...minBase.map(x => x.close));
  const maxVol   = Math.max(...volumes);
  const minVol   = Math.min(...minBase.map(x => x.volume));
  const minVolIdx = d.findIndex(x => x.volume === minVol && (!priced.length || x.close > 0));

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
    minVolIdx,
  };
}

// ── Generic factory ──────────────────────────────────────────

function createNamespace(namespace) {
  const { readDB, writeDB } = makeInstance(namespace);
  const label = namespace.charAt(0).toUpperCase() + namespace.slice(1);

  // Holt je Wertpapier die letzten MAX_DAYS Handelstage neu von Yahoo und
  // ersetzt damit die gespeicherten Daten. So werden 0-Platzhalter (fehlgeschlagene
  // Abrufe) und ausgelassene Tage beim nächsten Lauf automatisch repariert.
  let running = null;
  function dailyUpdate() {
    if (!running) running = doUpdate().finally(() => { running = null; });
    return running;
  }

  async function doUpdate() {
    const db    = readDB();
    const today = new Date().toISOString().split("T")[0];
    const cache = new Map();          // gleiches Symbol in mehreren Tabellen nur einmal laden
    let updated = 0, failed = 0;
    for (const table of db.tables) {
      for (const sec of table.securities) {
        try {
          if (!cache.has(sec.yahooSymbol)) {
            cache.set(sec.yahooSymbol, await withRetry(() => yahooHistory(sec.yahooSymbol)));
            await sleep(250);
          }
          const { candles } = cache.get(sec.yahooSymbol);
          if (!candles.length) throw new Error("Keine Kerzen");
          if (JSON.stringify(candles) !== JSON.stringify(sec.data)) updated++;
          sec.data = candles.map(c => ({ ...c }));
        } catch (e) {
          failed++;
          console.error(`[${label}] ${sec.yahooSymbol}: ${e.message}`);
          if (sec.data[0]?.date !== today) {
            sec.data.unshift({ date: today, close: 0, volume: 0 });
            if (sec.data.length > MAX_DAYS) sec.data = sec.data.slice(0, MAX_DAYS);
          }
        }
      }
    }
    db.updatedAt = new Date().toISOString();
    writeDB(db);
    console.log(`[${label}] Daily update: ${updated} Werte aktualisiert, ${failed} Fehler`);
    return updated;
  }

  function lastUpdatedAt() { return readDB().updatedAt || null; }

  function withStats(db) {
    return {
      updatedAt: db.updatedAt || null,
      tables: db.tables.map(t => ({
        ...t,
        securities: t.securities.map(sec => ({ ...sec, stats: calcStats(sec) })),
      })),
    };
  }

  function registerRoutes(app) {
    const base = `/api/${namespace}`;

    app.get(`${base}/tables`, (_req, res) => res.json(withStats(readDB())));

    app.post(`${base}/tables`, (req, res) => {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: "name required" });
      const db = readDB();
      const id = "t" + Date.now();
      db.tables.push({ id, name, securities: [] });
      writeDB(db);
      res.json({ id, name });
    });

    app.put(`${base}/tables/:id`, (req, res) => {
      const db = readDB();
      const t  = db.tables.find(x => x.id === req.params.id);
      if (!t) return res.status(404).json({ error: "not found" });
      t.name = req.body.name || t.name;
      writeDB(db);
      res.json({ ok: true });
    });

    app.delete(`${base}/tables/:id`, (req, res) => {
      const db = readDB();
      db.tables = db.tables.filter(x => x.id !== req.params.id);
      writeDB(db);
      res.json({ ok: true });
    });

    app.post(`${base}/tables/:id/securities`, async (req, res) => {
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

    app.put(`${base}/tables/:id/securities/:sym/einstand`, (req, res) => {
      const db  = readDB();
      const t   = db.tables.find(x => x.id === req.params.id);
      const sec = t?.securities.find(s => s.yahooSymbol === decodeURIComponent(req.params.sym));
      if (!sec) return res.status(404).json({ error: "not found" });
      sec.einstand = parseFloat(req.body.einstand) || 0;
      writeDB(db);
      res.json({ ok: true, stats: calcStats(sec) });
    });

    app.delete(`${base}/tables/:id/securities/:sym`, (req, res) => {
      const db = readDB();
      const t  = db.tables.find(x => x.id === req.params.id);
      if (!t) return res.status(404).json({ error: "not found" });
      t.securities = t.securities.filter(s => s.yahooSymbol !== decodeURIComponent(req.params.sym));
      writeDB(db);
      res.json({ ok: true });
    });

    app.post(`${base}/update`, async (_req, res) => {
      try {
        const n = await dailyUpdate();
        res.json({ ok: true, updated: n });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  return { registerRoutes, dailyUpdate, lastUpdatedAt };
}

// Named exports
const verfolgung = createNamespace("verfolgung");
const rebound    = createNamespace("rebound");

module.exports = {
  registerRoutes: verfolgung.registerRoutes,
  dailyUpdate:    verfolgung.dailyUpdate,
  verfolgung,
  rebound,
  calcStats,
};
