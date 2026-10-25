// Minimaler Chart-Server — ohne externe Abhängigkeiten (nur Node-Bordmittel).
// Holt Kursdaten von der öffentlichen Yahoo-Finance-Schnittstelle (kein API-Key nötig)
// und liefert das Frontend aus. Der Proxy umgeht das CORS-Problem des Browsers.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { initSchema } = require("./db/schema");
const { runUpdate, getLatestReport, getWatchlist, addToWatchlist, removeFromWatchlist, getCandidates, addCandidate, removeCandidate } = require("./db/update");

// --- Datenbank initialisieren ---
initSchema();

// --- Cron-Job: täglich Mo–Fr um 23:05 Uhr Europe/Berlin ---
// Kein npm-Paket nötig — findet exakten UTC-Zeitstempel via Intl
(function scheduleDailyUpdate() {
  function msUntilNext2305Berlin() {
    const now = new Date();
    // Suche den nächsten Werktag-23:05 Berlin innerhalb der nächsten 7 Tage
    for (let dayAdd = 0; dayAdd <= 7; dayAdd++) {
      const base = new Date(now);
      base.setUTCDate(base.getUTCDate() + dayAdd);
      base.setUTCHours(0, 0, 0, 0);
      // Berlin ist UTC+1 (CET) oder UTC+2 (CEST) → 23:05 Berlin liegt zwischen UTC 20:00 und 23:00
      for (let utcH = 20; utcH <= 23; utcH++) {
        const candidate = new Date(base.getTime() + utcH * 3600000 + 5 * 60000);
        const bt = candidate.toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour12: false });
        if (bt.startsWith("23:05")) {
          const ms = candidate.getTime() - now.getTime();
          if (ms < 30000) continue; // zu knapp (< 30s)
          const wd = candidate.toLocaleDateString("en-US", { timeZone: "Europe/Berlin", weekday: "short" });
          if (wd === "Sat" || wd === "Sun") break; // diesen UTC-Tag überspringen, nächsten suchen
          return ms;
        }
      }
    }
    return 24 * 3600000; // Fallback
  }

  function scheduleNext() {
    const ms = msUntilNext2305Berlin();
    const fireAt = new Date(Date.now() + ms).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
    console.log(`[Screener] Nächstes Update geplant: ${fireAt} (in ${Math.round(ms / 60000)} Min.)`);
    setTimeout(async () => {
      console.log("[Screener] Starte tägliches Update …");
      try { await runUpdate(); } catch (e) { console.error("[Screener] Fehler:", e.message); }
      scheduleNext(); // nächsten Tag einplanen
    }, ms);
  }
  scheduleNext();
}());

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- API: Kursverlauf von Yahoo Finance holen ---
  if (url.pathname === "/api/history") {
    try {
      const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase();
      const range = url.searchParams.get("range") || "1y";
      const interval = url.searchParams.get("interval") || "1d";

      const yahoo =
        `https://query1.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;

      const r = await fetch(yahoo, { headers: { "User-Agent": "Mozilla/5.0" } });
      const j = await r.json();
      const result = j.chart && j.chart.result && j.chart.result[0];

      if (!result) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: `Symbol "${symbol}" nicht gefunden` }));
      }

      const t = result.timestamp || [];
      const q = result.indicators.quote[0];
      const candles = [];
      for (let i = 0; i < t.length; i++) {
        if (q.open[i] == null || q.close[i] == null) continue; // Lücken überspringen
        candles.push({
          time: t[i], // UNIX-Sekunden
          open: q.open[i],
          high: q.high[i],
          low: q.low[i],
          close: q.close[i],
          volume: q.volume[i] || 0,
        });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          symbol: result.meta.symbol,
          name: result.meta.longName || result.meta.shortName || "",
          currency: result.meta.currency,
          candles,
        })
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Dialog mit Claude (Anthropic Messages API) ---
  if (url.pathname === "/api/chat" && req.method === "POST") {
    try {
      // Key pro Anfrage lesen: Umgebungsvariable oder lokale Datei .anthropic-key
      // (so kann der Key auch nach dem Start eingetragen werden – ohne Neustart)
      let apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        try {
          apiKey = fs.readFileSync(path.join(__dirname, ".anthropic-key"), "utf8").trim();
        } catch {}
      }
      if (!apiKey) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error:
              "Kein API-Key gefunden. Trage den Key in die Datei .anthropic-key ein " +
              "oder starte den Server mit ANTHROPIC_API_KEY=sk-ant-… node server.js",
          })
        );
      }

      // Request-Body (JSON) einlesen
      const body = await new Promise((resolve, reject) => {
        let buf = "";
        req.on("data", (c) => {
          buf += c;
          if (buf.length > 1e6) reject(new Error("Anfrage zu groß")); // einfacher Schutz
        });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
      });
      const { messages = [], context = {} } = JSON.parse(body || "{}");

      // Systemprompt: Claude kennt den aktuellen Chart-Kontext
      const system =
        "Du bist ein hilfreicher Assistent für Aktien-Charttechnik, eingebettet in eine " +
        "Chart-App. Antworte knapp, sachlich und auf Deutsch. Du gibst keine Anlageberatung, " +
        "sondern erklärst Chartmuster, Indikatoren und mögliche Szenarien.\n\n" +
        "Aktueller Chart-Kontext:\n" +
        (context.summary || "(kein Kontext verfügbar)");

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
          max_tokens: 1024,
          system,
          messages, // [{ role: "user"|"assistant", content: "…" }]
        }),
      });

      const j = await r.json();
      if (!r.ok) {
        res.writeHead(r.status, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: (j.error && j.error.message) || "Claude-Fehler" })
        );
      }

      const text = (j.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ reply: text }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Strukturierte Chart-Analyse mit Annotationen ---
  if (url.pathname === "/api/analyze" && req.method === "POST") {
    try {
      let apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        try { apiKey = fs.readFileSync(path.join(__dirname, ".anthropic-key"), "utf8").trim(); } catch {}
      }
      if (!apiKey) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Kein API-Key gefunden." }));
      }

      const body = await new Promise((resolve, reject) => {
        let buf = "";
        req.on("data", (c) => { buf += c; if (buf.length > 2e6) reject(new Error("Anfrage zu groß")); });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
      });
      const { candles = [], summary = "" } = JSON.parse(body || "{}");

      const slice = candles.slice(-200);
      const candleJson = JSON.stringify(
        slice.map(c => ({ t: c.time, o: +c.open.toFixed(2), h: +c.high.toFixed(2), l: +c.low.toFixed(2), c: +c.close.toFixed(2) }))
      );

      const system = [
        "Du bist ein Experte für technische Chartanalyse. Antworte AUSSCHLIESSLICH mit einem",
        "gültigen JSON-Objekt – kein Markdown, keine Erklärung davor oder danach.",
        "",
        'Struktur: { "priceLines": [ { "price": <Zahl>, "color": "<hex>", "title": "<max 12 Zeichen>", "style": "dashed"|"solid"|"dotted" } ], "markers": [ { "time": <unix-timestamp>, "position": "aboveBar"|"belowBar", "color": "<hex>", "shape": "arrowUp"|"arrowDown"|"circle"|"square", "text": "<max 20 Zeichen>" } ] }',
        "",
        "Regeln:",
        "- priceLines: 2–4 wichtige Niveaus (grün=#26a69a für Support, rot=#ef5350 für Widerstand)",
        "- markers: 1–3 markante Punkte – timestamps MÜSSEN exakt aus den gelieferten Candles stammen",
        "- Nur das JSON zurückgeben, sonst nichts",
      ].join("\n");

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
          max_tokens: 512,
          system,
          messages: [{ role: "user", content: `Chart-Kontext:\n${summary}\n\nCandle-Daten (t=unix-sek):\n${candleJson}` }],
        }),
      });

      const j = await r.json();
      if (!r.ok) {
        res.writeHead(r.status, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: (j.error && j.error.message) || "Claude-Fehler" }));
      }

      const raw = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      let parsed;
      try {
        const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        parsed = JSON.parse(m ? m[1] : raw);
      } catch {
        parsed = { priceLines: [], markers: [] };
      }

      const validTimes = new Set(slice.map(c => c.time));
      parsed.markers = (parsed.markers || []).filter(m => validTimes.has(m.time));
      parsed.priceLines = parsed.priceLines || [];

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(parsed));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Screener-Report lesen ---
  if (url.pathname === "/api/screen") {
    try {
      const report = getLatestReport();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(report));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Update manuell anstoßen ---
  if (url.pathname === "/api/screen/update" && req.method === "POST") {
    // Falls bereits ein Update läuft, nicht doppelt starten
    if (global._screenerRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Update läuft bereits" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    global._screenerRunning = true;
    runUpdate((done, total, sigs) => {
      if (done % 20 === 0) console.log(`[Screener] ${done}/${total} (${sigs} Signale)`);
    }).catch(e => console.error("[Screener]", e.message))
      .finally(() => { global._screenerRunning = false; });
    return;
  }

  // --- API: Merkliste lesen ---
  if (url.pathname === "/api/watchlist" && req.method === "GET") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(getWatchlist()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Eintrag zur Merkliste hinzufügen ---
  if (url.pathname === "/api/watchlist" && req.method === "POST") {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d)); req.on("error", reject);
      });
      const { symbol, name, signal_date } = JSON.parse(body);
      if (!symbol || !name || !signal_date) throw new Error("symbol, name und signal_date erforderlich");
      addToWatchlist(symbol.toUpperCase(), name, signal_date);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Eintrag aus Merkliste entfernen ---
  if (url.pathname.startsWith("/api/watchlist/") && req.method === "DELETE") {
    try {
      const symbol = decodeURIComponent(url.pathname.slice("/api/watchlist/".length)).toUpperCase();
      removeFromWatchlist(symbol);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Kandidaten lesen ---
  if (url.pathname === "/api/candidates" && req.method === "GET") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(getCandidates()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Kandidat hinzufügen ---
  if (url.pathname === "/api/candidates" && req.method === "POST") {
    try {
      const body = await new Promise((resolve, reject) => {
        let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d)); req.on("error", reject);
      });
      const c = JSON.parse(body);
      if (!c.symbol || !c.name || !c.signal_date) throw new Error("symbol, name und signal_date erforderlich");
      addCandidate({ ...c, symbol: c.symbol.toUpperCase() });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- API: Kandidat entfernen ---
  if (url.pathname.startsWith("/api/candidates/") && req.method === "DELETE") {
    try {
      const symbol = decodeURIComponent(url.pathname.slice("/api/candidates/".length)).toUpperCase();
      removeCandidate(symbol);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- Statische Dateien aus /public ---
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    const ext = path.extname(file);
    const headers = { "Content-Type": types[ext] || "application/octet-stream" };
    if (ext === ".html") headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Chart-App läuft auf http://localhost:${PORT}`);
});
