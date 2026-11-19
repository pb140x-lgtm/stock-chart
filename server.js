"use strict";
const express = require("express");
const path    = require("path");
const fs      = require("fs");
const cron    = require("node-cron");
const { runScreener }              = require("./screener-trades");
const { registerRoutes, verfolgung, rebound } = require("./verfolgung");
const { generateReport }           = require("./bericht");
const { generateGreenReport }      = require("./gruen-bericht");
const { generateRedReport, localISO } = require("./rot-bericht");

const app  = express();
const PORT = 3000;

const DATA_DIR               = path.join(__dirname, "data");
const STOXX_FILE             = path.join(DATA_DIR, "stoxx600-results.json");
const WATCHLIST_FILE         = path.join(DATA_DIR, "watchlist.json");
const WATCHLIST_RESULTS_FILE = path.join(DATA_DIR, "watchlist-results.json");

if (!fs.existsSync(DATA_DIR))     fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(WATCHLIST_FILE)) fs.writeFileSync(WATCHLIST_FILE, "[]");

const stoxx600 = JSON.parse(
  fs.readFileSync(path.join(__dirname, "symbols/stoxx600.json"), "utf8")
);

const fetch = require("node-fetch");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Chart History (OHLCV-Proxy) ────────────────────────────
app.get("/api/history", async (req, res) => {
  const { symbol, range = "1y" } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?range=${range}&interval=1d&includePrePost=false`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      timeout: 10000,
    });
    if (!r.ok) return res.status(502).json({ error: `Yahoo ${r.status}` });
    const data   = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: "Keine Daten" });
    const ts = result.timestamp;
    const q  = result.indicators.quote[0];
    const meta = result.meta || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.open[i] == null) continue;
      candles.push({
        time:   ts[i],
        open:   +q.open[i].toFixed(4),
        high:   +q.high[i].toFixed(4),
        low:    +q.low[i].toFixed(4),
        close:  +q.close[i].toFixed(4),
        volume: q.volume[i] || 0,
      });
    }
    res.json({ symbol, name: meta.longName || meta.shortName || symbol, candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function readJSON(file, fallback) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : fallback;
}

// ── STOXX 600 ──────────────────────────────────────────────
let stoxxRunning = false;

app.get("/api/stoxx", (_req, res) =>
  res.json(readJSON(STOXX_FILE, { results: [], updatedAt: null, found: 0, total: stoxx600.length }))
);

app.get("/api/stoxx/status", (_req, res) =>
  res.json({ running: stoxxRunning })
);

app.post("/api/stoxx/run", (req, res) => {
  if (stoxxRunning) return res.json({ status: "läuft bereits" });
  const testMode = req.query.test === "1";
  stoxxRunning = true;
  res.json({ status: "gestartet", testMode });
  runScreener(stoxx600, STOXX_FILE, { testMode })
    .catch(e => console.error("[STOXX]", e))
    .finally(() => { stoxxRunning = false; });
});

// ── Watchlist ──────────────────────────────────────────────
let watchlistRunning = false;

const loadWL = () => readJSON(WATCHLIST_FILE, []);
const saveWL = list => fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));

app.get("/api/watchlist", (_req, res) => res.json(loadWL()));

app.post("/api/watchlist/add", (req, res) => {
  const { symbol, name, index } = req.body;
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const list = loadWL();
  const sym  = symbol.toUpperCase();
  if (!list.find(s => s.symbol === sym)) {
    list.push({ symbol: sym, name: name || sym, index: index || "manuell" });
    saveWL(list);
  }
  res.json({ ok: true });
});

app.delete("/api/watchlist/:symbol", (req, res) => {
  saveWL(loadWL().filter(s => s.symbol !== req.params.symbol));
  res.json({ ok: true });
});

app.get("/api/watchlist/results", (_req, res) =>
  res.json(readJSON(WATCHLIST_RESULTS_FILE, { results: [], updatedAt: null }))
);

app.get("/api/watchlist/status", (_req, res) =>
  res.json({ running: watchlistRunning })
);

app.post("/api/watchlist/run", (_req, res) => {
  if (watchlistRunning) return res.json({ status: "läuft bereits" });
  const list = loadWL();
  if (list.length === 0) return res.json({ status: "Watchlist leer" });
  watchlistRunning = true;
  res.json({ status: "gestartet" });
  runScreener(list, WATCHLIST_RESULTS_FILE, { includeAll: true })
    .catch(e => console.error("[Watchlist]", e))
    .finally(() => { watchlistRunning = false; });
});

// ── Verfolgung ─────────────────────────────────────────────
registerRoutes(app);

// ── Rebound ────────────────────────────────────────────────
rebound.registerRoutes(app);

// ── Bestandsentwicklung ────────────────────────────────────
require("./bestand").registerRoutes(app);

// ── Bericht (rote & grüne Felder, letzte 5 Tage) ───────────
app.post("/api/bericht/generate", (_req, res) => {
  try {
    const r = generateReport();
    res.json({ ok: true, file: r.file, url: "/" + r.file });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bequemer Einstieg: erzeugt (falls nötig) die heutige Datei und öffnet sie.
app.get("/bericht", (_req, res) => {
  try {
    const r = generateReport();
    res.redirect("/" + r.file);
  } catch (e) {
    res.status(500).send("Bericht-Fehler: " + e.message);
  }
});

// Grün-Bericht: grüne Preisfelder der letzten 2 Tage (erzeugt die heutige Datei und öffnet sie)
app.get("/gruen-bericht", (_req, res) => {
  try {
    const r = generateGreenReport();
    res.redirect("/" + r.file);
  } catch (e) {
    res.status(500).send("Bericht-Fehler: " + e.message);
  }
});

// Rot-Bericht: rote Preisfelder (20-T-Minimum in den ersten 10 Tagen) der Verfolgung
app.get("/rot-bericht", (_req, res) => {
  try {
    const r = generateRedReport();
    res.redirect("/" + r.file);
  } catch (e) {
    res.status(500).send("Bericht-Fehler: " + e.message);
  }
});

// ── Cron-Scheduling ────────────────────────────────────────
// STOXX 600: Dienstag (2) + Freitag (5) um 20:00
cron.schedule("0 20 * * 2,5", () => {
  if (stoxxRunning) return;
  console.log("[Cron] STOXX 600 Scan startet …");
  stoxxRunning = true;
  runScreener(stoxx600, STOXX_FILE)
    .catch(e => console.error("[Cron STOXX]", e))
    .finally(() => { stoxxRunning = false; });
});

// Verfolgung + Rebound: automatisch nach 23:05 (Mo–Fr).
// Läuft der Server um 23:05 nicht (Rechner im Ruhezustand), wird der Abruf
// beim Start bzw. bei der nächsten Viertelstunden-Prüfung nachgeholt.
function lastSlot(now = new Date()) {
  const d = new Date(now);
  d.setHours(23, 5, 0, 0);
  if (d > now) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

let kursUpdateRunning = false;
async function kursUpdateIfDue() {
  if (kursUpdateRunning) return;
  const slot = lastSlot();
  const due = [["Verfolgung", verfolgung], ["Rebound", rebound]]
    .filter(([, ns]) => { const u = ns.lastUpdatedAt(); return !u || new Date(u) < slot; });
  if (!due.length) return;
  kursUpdateRunning = true;
  try {
    for (const [name, ns] of due) {
      console.log(`[Auto] ${name} Kurs-Update …`);
      await ns.dailyUpdate().catch(e => console.error(`[Auto ${name}]`, e));
    }
  } finally { kursUpdateRunning = false; }
}

// Rot-Bericht: automatisch nach 23:30 (Mo–Fr), nach dem Kurs-Update.
// Verpasste Läufe (Ruhezustand) werden beim Start bzw. viertelstündlich nachgeholt.
function lastRotSlot(now = new Date()) {
  const d = new Date(now);
  d.setHours(23, 30, 0, 0);
  if (d > now) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}
function rotBerichtIfDue() {
  if (kursUpdateRunning) return;              // erst nach dem Kurs-Update
  const slot = lastRotSlot();
  const day  = localISO(slot);
  const file = path.join(__dirname, "public", `rot_bericht_${day}.html`);
  // Datei vor 23:30 manuell erzeugt? → zum Termin neu schreiben
  if (fs.existsSync(file) && fs.statSync(file).mtime >= slot) return;
  console.log("[Auto] Rot-Bericht …");
  try { generateRedReport(day); }
  catch (e) { console.error("[Auto Rot-Bericht]", e); }
}

cron.schedule("5 23 * * 1-5", () => { kursUpdateIfDue(); });
cron.schedule("30 23 * * 1-5", () => { rotBerichtIfDue(); });
cron.schedule("*/15 * * * *", async () => { await kursUpdateIfDue(); rotBerichtIfDue(); });
setTimeout(async () => { await kursUpdateIfDue(); rotBerichtIfDue(); }, 5000);

// Bericht (rote & grüne Felder): Di–Sa um 07:00
// (Di–Sa = Handelstage-Morgen nach dem Update vom Vorabend Mo–Fr 23:05)
cron.schedule("0 7 * * 2-6", () => {
  console.log("[Cron] Bericht rote/grüne Felder …");
  try { generateReport(); }
  catch (e) { console.error("[Cron Bericht]", e); }
});

app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));
