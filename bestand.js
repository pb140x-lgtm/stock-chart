"use strict";
// Bestandsentwicklung: Konten (Gruppen) → Wertpapiere → Käufe/Verkäufe,
// Alarm- und Nachkaufpreise, Jahresübersicht.
// Datenmodell: db.accounts = Konten; db.groups = Wertpapier-Positionen mit accountId.
// Gerechnet wird im Browser (public/bestand.html); hier liegen Speicherung,
// aktuelle Kurse und Devisenkurse (Yahoo, Notierung: 1 € = x Fremdwährung).
const fs    = require("fs");
const path  = require("path");
const fetch = require("node-fetch");

const FILE  = path.join(__dirname, "data", "bestand.json");
const YH    = "https://query1.finance.yahoo.com";
const YH_UA = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

const DEFAULT_SETTINGS = {
  minErtrag:   0.06, // Mindestertrag auf die Investitionssumme
  verlust:     0.03, // Verlustgrenze unter dem Ø-Kurs, solange kein Mindestertrag gesichert ist
  abstand1:    0.08, // Kursabstand Erstkauf → 1. Nachkauf
  abstandN:    0.04, // Kursabstand ab dem 2. Nachkauf zum vorherigen Kauf
  maxNachkauf: 10,
};

// Startbestand aus der Vorlage „Bestandsentwicklung“ (Blatt Bayer)
const SEED = {
  settings: DEFAULT_SETTINGS,
  accounts: [{ id: "k1", name: "Konto 1", currency: "EUR" }],
  groups: [{
    id: "g1", accountId: "k1", name: "Bayer", yahooSymbol: "BAYN.DE", currency: "EUR", sale: null,
    buys: [
      { id: "b1", date: "", stueck: 60, kurs: 50.49, fx: 1 },
      { id: "b2", date: "", stueck: 20, kurs: 57.26, fx: 1 },
    ],
  }],
};

function readDB() {
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify(SEED, null, 2));
  const db = JSON.parse(fs.readFileSync(FILE, "utf8"));
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  // Übernahme älterer Daten ohne Konten: alles in „Konto 1“
  if (!Array.isArray(db.accounts) || !db.accounts.length) {
    db.accounts = [{ id: "k1", name: "Konto 1", currency: "EUR" }];
  }
  const ids = new Set(db.accounts.map(a => a.id));
  let changed = false;
  for (const g of db.groups) if (!ids.has(g.accountId)) { g.accountId = db.accounts[0].id; changed = true; }
  if (changed) writeDB(db);
  return db;
}
const writeDB = db => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
const newId   = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const num     = v => (v === "" || v == null || isNaN(+v)) ? null : +v;

// ── Yahoo ───────────────────────────────────────────────────
const cache = new Map(); // symbol → { t, value }
const TTL   = 5 * 60 * 1000;

async function yahooQuote(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.t < TTL) return hit.value;
  const url = `${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const r = await fetch(url, { headers: YH_UA, timeout: 10000 });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const meta = (await r.json())?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error("Kein Kurs");
  const value = {
    price:    meta.regularMarketPrice,
    currency: meta.currency || "",
    name:     meta.longName || meta.shortName || symbol,
    time:     meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
  cache.set(symbol, { t: Date.now(), value });
  return value;
}

// Schlusskurs am Tag `date` (oder letzter Handelstag davor)
async function yahooCloseOn(symbol, date) {
  const end   = Math.floor(new Date(date + "T23:59:59Z").getTime() / 1000);
  const start = end - 10 * 86400;
  const url = `${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`;
  const r = await fetch(url, { headers: YH_UA, timeout: 10000 });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const cl = res?.indicators?.quote?.[0]?.close || [];
  for (let i = ts.length - 1; i >= 0; i--) {
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    if (cl[i] != null && d <= date) return { date: d, close: +cl[i].toFixed(6) };
  }
  throw new Error("Kein Devisenkurs für " + date);
}

const fxSymbol = cur => `EUR${cur}=X`;

async function fxOn(cur, date) {
  if (!cur || cur === "EUR") return { date, close: 1 };
  const today = new Date().toISOString().slice(0, 10);
  if (!date || date >= today) {
    const q = await yahooQuote(fxSymbol(cur));
    return { date: today, close: q.price };
  }
  return yahooCloseOn(fxSymbol(cur), date);
}

// ── Routes ──────────────────────────────────────────────────
function registerRoutes(app) {
  const base = "/api/bestand";

  // Alles inkl. aktueller Kurse und aktueller Devisenkurse
  app.get(base, async (_req, res) => {
    const db = readDB();
    const quotes = {}, fx = { EUR: 1 }, errors = [];
    const syms = [...new Set(db.groups.map(g => g.yahooSymbol).filter(Boolean))];
    const curs = [...new Set(db.groups.map(g => g.currency).filter(c => c && c !== "EUR"))];
    await Promise.all([
      ...syms.map(s => yahooQuote(s).then(q => { quotes[s] = q; }).catch(e => errors.push(`${s}: ${e.message}`))),
      ...curs.map(c => yahooQuote(fxSymbol(c)).then(q => { fx[c] = q.price; }).catch(e => errors.push(`${c}: ${e.message}`))),
    ]);
    res.json({ ...db, quotes, fx, errors, loadedAt: new Date().toISOString() });
  });

  // Devisenkurs zum Kaufdatum (Tageswert), für das Eingabeformular
  app.get(`${base}/fx`, async (req, res) => {
    try { res.json(await fxOn(String(req.query.cur || "EUR").toUpperCase(), String(req.query.date || ""))); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.put(`${base}/settings`, (req, res) => {
    const db = readDB();
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const v = num(req.body[k]);
      if (v != null) db.settings[k] = v;
    }
    writeDB(db);
    res.json(db.settings);
  });

  // ── Konten ──
  const cur3 = v => String(v || "").trim().toUpperCase().slice(0, 3);

  app.post(`${base}/accounts`, (req, res) => {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Kontoname fehlt" });
    const db = readDB();
    const a = { id: newId("k"), name, currency: cur3(req.body.currency) || "EUR" };
    db.accounts.push(a);
    writeDB(db);
    res.json(a);
  });

  app.put(`${base}/accounts/:aid`, (req, res) => {
    const db = readDB();
    const a = db.accounts.find(x => x.id === req.params.aid);
    if (!a) return res.status(404).json({ error: "Konto nicht gefunden" });
    if (req.body.name != null) a.name = String(req.body.name).trim() || a.name;
    if (req.body.currency != null) a.currency = cur3(req.body.currency) || a.currency;
    writeDB(db);
    res.json(a);
  });

  app.delete(`${base}/accounts/:aid`, (req, res) => {
    const db = readDB();
    if (db.groups.some(g => g.accountId === req.params.aid))
      return res.status(400).json({ error: "Konto enthält noch Wertpapiere – erst verschieben oder löschen" });
    db.accounts = db.accounts.filter(a => a.id !== req.params.aid);
    writeDB(db);
    res.json({ ok: true });
  });

  // ── Wertpapiere ──
  app.post(`${base}/groups`, async (req, res) => {
    const yahooSymbol = String(req.body.yahooSymbol || "").trim().toUpperCase();
    if (!yahooSymbol) return res.status(400).json({ error: "Yahoo-Kürzel fehlt" });
    let name = String(req.body.name || "").trim();
    let currency = String(req.body.currency || "").trim().toUpperCase();
    try {
      const q = await yahooQuote(yahooSymbol);
      if (!name) name = q.name;
      if (!currency) currency = q.currency;
    } catch (e) {
      if (!name || !currency) return res.status(502).json({ error: `${yahooSymbol}: ${e.message}` });
    }
    if (currency === "GBp" || currency === "GBX") currency = "GBP"; // Pence-Notierung nicht unterstützt
    const db = readDB();
    const accountId = String(req.body.accountId || "");
    if (!db.accounts.some(a => a.id === accountId)) return res.status(400).json({ error: "Konto fehlt" });
    const g = { id: newId("g"), accountId, name, yahooSymbol, currency, sale: null, buys: [] };
    db.groups.push(g);
    writeDB(db);
    res.json(g);
  });

  const findGroup = (db, id) => db.groups.find(g => g.id === id);

  app.put(`${base}/groups/:id`, async (req, res) => {
    const db = readDB();
    const g = findGroup(db, req.params.id);
    if (!g) return res.status(404).json({ error: "Gruppe nicht gefunden" });
    if (req.body.name != null) g.name = String(req.body.name).trim() || g.name;
    if (req.body.accountId != null) {
      if (!db.accounts.some(a => a.id === req.body.accountId)) return res.status(400).json({ error: "Konto nicht gefunden" });
      g.accountId = req.body.accountId;
    }
    if ("sale" in req.body) {
      const s = req.body.sale;
      if (!s) g.sale = null;
      else {
        const kurs = num(s.kurs);
        if (kurs == null || !s.date) return res.status(400).json({ error: "Verkauf braucht Datum und Kurs" });
        let fx = num(s.fx);
        if (fx == null) {
          try { fx = (await fxOn(g.currency, s.date)).close; }
          catch (e) { return res.status(502).json({ error: e.message }); }
        }
        g.sale = { date: s.date, kurs, fx };
      }
    }
    writeDB(db);
    res.json(g);
  });

  app.delete(`${base}/groups/:id`, (req, res) => {
    const db = readDB();
    db.groups = db.groups.filter(g => g.id !== req.params.id);
    writeDB(db);
    res.json({ ok: true });
  });

  // Kauf anlegen/ändern: ohne Devisenkurs wird der Tageswert zum Kaufdatum geholt
  async function buyFromBody(g, body, old = {}) {
    const stueck = num(body.stueck ?? old.stueck);
    const kurs   = num(body.kurs ?? old.kurs);
    const date   = String(body.date ?? old.date ?? "");
    // Negative Stückzahl = Teilverkauf
    if (!stueck || !(kurs > 0)) throw Object.assign(new Error("Stück (≠ 0) und Kurs (> 0) angeben"), { code: 400 });
    let fx = g.currency === "EUR" ? 1 : num(body.fx);
    if (fx == null) {
      if (old.fx && date === old.date) fx = old.fx;
      else fx = (await fxOn(g.currency, date)).close;
    }
    return { id: old.id || newId("b"), date, stueck, kurs, fx };
  }

  // Bestand darf nie auf 0 oder darunter fallen (ganz verkaufen: „Verkauf …“)
  function checkBestand(buys) {
    let j = 0;
    for (const b of buys) {
      j += b.stueck;
      if (b.stueck < 0 && j <= 0)
        throw Object.assign(new Error(j === 0
          ? "Teilverkauf würde alles verkaufen – dafür „Verkauf …“ nutzen"
          : "Teilverkauf größer als der Bestand"), { code: 400 });
    }
  }

  app.post(`${base}/groups/:id/buys`, async (req, res) => {
    const db = readDB();
    const g = findGroup(db, req.params.id);
    if (!g) return res.status(404).json({ error: "Gruppe nicht gefunden" });
    if (g.sale) return res.status(400).json({ error: "Gruppe ist verkauft" });
    const kaeufe = g.buys.filter(b => b.stueck > 0).length;
    if (num(req.body.stueck) > 0 && kaeufe >= db.settings.maxNachkauf + 1)
      return res.status(400).json({ error: "Keine freien Nachkäufe mehr" });
    try {
      const b = await buyFromBody(g, req.body);
      checkBestand([...g.buys, b]);
      g.buys.push(b);
      writeDB(db);
      res.json(b);
    } catch (e) { res.status(e.code || 502).json({ error: e.message }); }
  });

  app.put(`${base}/groups/:id/buys/:bid`, async (req, res) => {
    const db = readDB();
    const g = findGroup(db, req.params.id);
    const i = g ? g.buys.findIndex(b => b.id === req.params.bid) : -1;
    if (i < 0) return res.status(404).json({ error: "Kauf nicht gefunden" });
    try {
      const b = await buyFromBody(g, req.body, g.buys[i]);
      checkBestand(g.buys.map((x, k) => k === i ? b : x));
      g.buys[i] = b;
      writeDB(db);
      res.json(g.buys[i]);
    } catch (e) { res.status(e.code || 502).json({ error: e.message }); }
  });

  app.delete(`${base}/groups/:id/buys/:bid`, (req, res) => {
    const db = readDB();
    const g = findGroup(db, req.params.id);
    if (!g) return res.status(404).json({ error: "Gruppe nicht gefunden" });
    const rest = g.buys.filter(b => b.id !== req.params.bid);
    try { checkBestand(rest); } catch (e) { return res.status(400).json({ error: e.message }); }
    g.buys = rest;
    writeDB(db);
    res.json({ ok: true });
  });
}

module.exports = { registerRoutes };
