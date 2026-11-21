"use strict";
// ─────────────────────────────────────────────────────────────
//  Bericht-Generator: rudimentäre Aufstellung
//  Spalten: Tabellenblatt · Kürzel · Name · Punkt (grün/rot)
//  Grün = 20-Tage-Hoch  (Kurs oder Volumen) in den letzten 3 Spalten
//  Rot  = 20-Tage-Tief   (Kurs oder Volumen) in den letzten 3 Spalten
//  (data[0] = neuester Tag → "letzte 3 Tage" = Index 0..2)
// ─────────────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");
const { abrufVermerk, ABRUF_CSS } = require("./abruf-vermerk");
const { calcStats } = require("./verfolgung");

const DATA_DIR   = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const WINDOW     = 3;                        // letzte 3 Handelstage
const NAMESPACES = ["verfolgung", "rebound"];

// ── Helpers ──────────────────────────────────────────────────
function readTables(ns) {
  const f = path.join(DATA_DIR, `${ns}-tables.json`);
  if (!fs.existsSync(f)) return { tables: [] };
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return { tables: [] }; }
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Signale je Papier: Hoch (grün) / Tief (rot) in den letzten 3 Spalten ──
function flags(sec) {
  const d = (sec.data || []);
  if (!d.length) return { high: false, low: false };
  const closes  = d.map(x => x.close);
  const volumes = d.map(x => x.volume);
  const inWin = i => i >= 0 && i < WINDOW;

  const high = inWin(closes.indexOf(Math.max(...closes))) || inWin(volumes.indexOf(Math.max(...volumes)));
  // Tief wie in der Tabelle: Tage ohne Preis zählen nicht als Tief
  const s    = calcStats(sec);
  const low  = inWin(s.minCloseIdx) || inWin(s.minVolIdx);
  return { high, low };
}

function dots(f) {
  let h = "";
  if (f.high) h += `<span class="dot dot-high" title="Hoch"></span>`;
  if (f.low)  h += `<span class="dot dot-low" title="Tief"></span>`;
  return h || "—";
}

// ── Report zusammenbauen ─────────────────────────────────────
function buildHTML(today, abruf) {
  const [y, m, d] = today.split("-");
  const dateDE = `${d}.${m}.${y}`;

  const rows = [];
  for (const ns of NAMESPACES) {
    const db = readTables(ns);
    for (const tbl of db.tables) {
      for (const sec of (tbl.securities || [])) {
        const f = flags(sec);
        if (!f.high && !f.low) continue;
        rows.push(`<tr>
          <td class="td-tbl">${esc(tbl.name)}</td>
          <td class="td-sym">${esc(sec.yahooSymbol)}</td>
          <td class="td-name">${esc(sec.displayName)}</td>
          <td class="td-dot">${dots(f)}</td>
        </tr>`);
      }
    }
  }

  const body = rows.length
    ? `<table>
        <thead><tr><th>Tabellenblatt</th><th>Kürzel</th><th>Name</th><th>Punkt</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`
    : `<p class="empty">Kein Papier mit Hoch oder Tief in den letzten ${WINDOW} Handelstagen.</p>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bericht ${dateDE}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#eef1f5;color:#1a1a2e;font-family:'Trebuchet MS',sans-serif;padding:24px 20px 40px}
  h1{font-size:16px;font-weight:700;margin-bottom:4px}
  .sub{font-size:11px;color:#5a6a7e;margin-bottom:14px}
  .legend{display:flex;gap:16px;font-size:11px;color:#5a6a7e;margin-bottom:14px}
  .legend span{display:inline-flex;align-items:center;gap:5px}
  table{border-collapse:collapse;background:#fff;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);border-radius:6px;overflow:hidden}
  th{background:#f0f4f8;color:#5a6a7e;font-size:10px;font-weight:600;text-align:left;padding:6px 12px;border-bottom:1px solid #d0d7e2}
  td{padding:5px 12px;border-bottom:1px solid #eef1f5;white-space:nowrap}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#f7f9fc}
  .td-tbl{color:#3a4a5e}
  .td-sym{font-weight:700;font-size:11px}
  .td-name{color:#3a4a5e}
  .td-dot{text-align:center}
  .dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin:0 2px;vertical-align:middle}
  .dot-high{background:#1fa667}
  .dot-low{background:#d64545}
  .empty{background:#fff;padding:14px;border-radius:6px;font-size:12px;color:#8a9ab0}
${ABRUF_CSS}</style>
</head>
<body>
  <h1>Aufstellung — Hochs &amp; Tiefs der letzten ${WINDOW} Handelstage</h1>
  <div class="sub">Stand: ${dateDE}</div>
  ${abrufVermerk(abruf)}
  <div class="legend">
    <span><span class="dot dot-high"></span> grün = Hoch (Kurs/Vol)</span>
    <span><span class="dot dot-low"></span> rot = Tief (Kurs/Vol)</span>
  </div>
  ${body}
</body>
</html>`;
}

// ── Öffentliche API ──────────────────────────────────────────
// abruf: "automatisch" (Zeitplan Di–Sa 07:00) | "individuell"
function generateReport(dateStr, abruf = "individuell") {
  const today = dateStr || new Date().toISOString().split("T")[0];
  const html  = buildHTML(today, abruf);
  const file  = path.join(PUBLIC_DIR, `bericht_${today}.html`);
  fs.writeFileSync(file, html);
  console.log(`[Bericht] erzeugt: ${path.basename(file)}`);
  return { file: `bericht_${today}.html`, path: file };
}

module.exports = { generateReport };
