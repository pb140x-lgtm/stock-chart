"use strict";
// ─────────────────────────────────────────────────────────────
//  Grün-Bericht: Kandidaten, deren Preisfeld an einem der letzten
//  beiden Tage der Auswertung grün eingefärbt ist
//  (grün = höchster Schlusskurs der 20-Tage-Zeitreihe).
//  Spalten: Tabelle · Datum · Kürzel · Name · Preis
//  Aufruf:  node gruen-bericht.js   oder   GET /gruen-bericht
// ─────────────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");
const { calcStats } = require("./verfolgung");

const DATA_DIR   = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const WINDOW     = 2;                        // letzte 2 Tage (data[0] = neuester)
const NAMESPACES = [
  { ns: "verfolgung", label: "Verfolgung" },
  { ns: "rebound",    label: "Rebound" },
];

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
function fmtDate(s) {
  const [y, m, d] = String(s).split("-");
  return `${d}.${m}.${y}`;
}
function fmtNum(n) {
  return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function collect() {
  const rows = [];
  for (const { ns, label } of NAMESPACES) {
    for (const tbl of readTables(ns).tables) {
      for (const sec of (tbl.securities || [])) {
        const d = sec.data || [];
        if (!d.length) continue;
        const i = calcStats(sec).maxCloseIdx;
        if (i < 0 || i >= WINDOW || !(d[i].close > 0)) continue;
        rows.push({
          page: label, table: tbl.name, date: d[i].date,
          symbol: sec.yahooSymbol, name: sec.displayName,
          price: d[i].close, currency: sec.currency || "",
        });
      }
    }
  }
  return rows;
}

function buildHTML(today) {
  const rows = collect();
  const trs = rows.map(r => `<tr>
      <td class="td-tbl">${esc(r.table)} <span class="pg">${esc(r.page)}</span></td>
      <td class="td-date">${fmtDate(r.date)}</td>
      <td class="td-sym">${esc(r.symbol)}</td>
      <td class="td-name">${esc(r.name)}</td>
      <td class="td-price">${fmtNum(r.price)} <span class="cur">${esc(r.currency)}</span></td>
    </tr>`).join("");

  const body = rows.length
    ? `<table>
        <thead><tr><th>Tabelle</th><th>Datum</th><th>Kürzel</th><th>Name</th><th class="th-price">Preis</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>`
    : `<p class="empty">Kein Papier mit grünem Preisfeld in den letzten ${WINDOW} Tagen.</p>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Grün-Bericht ${fmtDate(today)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#eef1f5;color:#1a1a2e;font-family:'Trebuchet MS',sans-serif;padding:24px 20px 40px}
  h1{font-size:16px;font-weight:700;margin-bottom:4px}
  .sub{font-size:11px;color:#5a6a7e;margin-bottom:14px}
  table{border-collapse:collapse;background:#fff;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);border-radius:6px;overflow:hidden}
  th{background:#f0f4f8;color:#5a6a7e;font-size:10px;font-weight:600;text-align:left;padding:6px 12px;border-bottom:1px solid #d0d7e2}
  td{padding:5px 12px;border-bottom:1px solid #eef1f5;white-space:nowrap}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#f7f9fc}
  .td-tbl,.td-name{color:#3a4a5e}
  .pg,.cur{color:#8a9ab0;font-size:10px}
  .td-date{color:#5a6a7e;font-variant-numeric:tabular-nums}
  .td-sym{font-weight:700;font-size:11px}
  .td-price,.th-price{text-align:right}
  .td-price{background:#d6f0e0;font-variant-numeric:tabular-nums}
  .empty{background:#fff;padding:14px;border-radius:6px;font-size:12px;color:#8a9ab0}
  .print-btn{float:right;background:#fff;border:1px solid #1a56cc;color:#1a56cc;padding:4px 11px;border-radius:4px;cursor:pointer;font:600 12px 'Trebuchet MS',sans-serif}
  .print-btn:hover{background:#e8f0fd}
  @media print{
    .print-btn{display:none}
    body{background:#fff;padding:0}
    table{box-shadow:none;width:100%}
    td{white-space:normal}
    .td-price{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Drucken</button>
  <h1>Grüne Preisfelder — letzte ${WINDOW} Tage der Auswertung</h1>
  <div class="sub">Stand: ${fmtDate(today)} · ${rows.length} Kandidaten · grün = höchster Schlusskurs der 20-Tage-Zeitreihe</div>
  ${body}
</body>
</html>`;
}

function generateGreenReport(dateStr) {
  const today = dateStr || new Date().toISOString().split("T")[0];
  const name  = `gruen_bericht_${today}.html`;
  fs.writeFileSync(path.join(PUBLIC_DIR, name), buildHTML(today));
  console.log(`[Grün-Bericht] erzeugt: ${name}`);
  return { file: name, path: path.join(PUBLIC_DIR, name) };
}

module.exports = { generateGreenReport };

if (require.main === module) generateGreenReport();
