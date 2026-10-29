"use strict";
const express = require("express");
const path    = require("path");
const fs      = require("fs");
const cron    = require("node-cron");
const { runScreener } = require("./screener-trades");

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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
  runScreener(list, WATCHLIST_RESULTS_FILE)
    .catch(e => console.error("[Watchlist]", e))
    .finally(() => { watchlistRunning = false; });
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

app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));
