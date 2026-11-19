"use strict";
// ─────────────────────────────────────────────────────────────
//  Grün-Bericht: Kandidaten, deren Preisfeld an einem der letzten
//  beiden Tage der Auswertung grün eingefärbt ist
//  (grün = höchster Schlusskurs der 20-Tage-Zeitreihe).
//  Abschnitt 1 Spalten: Quelle · Tabelle · Datum · Kürzel · Name · Preis ·
//           Trend 5 T · Trend 10 T. Abschnitte 2+3 (nebeneinander):
//           alle Werte mit positivem Trend 5 T bzw. 10 T
//  Quellen: Verfolgung + Rebound (verfolgung.html / rebound.html)
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

// Trend über n Handelstage: Schlusskurs heute (data[0]) gegen data[n], in %.
function trend(d, n) {
  const now = d[0] && d[0].close, then = d[n] && d[n].close;
  if (!(now > 0) || !(then > 0)) return null;
  return (now - then) / then * 100;
}
function fmtTrend(t) {
  if (t == null) return `<td class="td-tr na">–</td>`;
  const cls = t > 0 ? "up" : t < 0 ? "dn" : "";
  const arrow = t > 0 ? "▲" : t < 0 ? "▼" : "";
  const txt = (t > 0 ? "+" : "") + t.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `<td class="td-tr ${cls}">${arrow} ${txt} %</td>`;
}

function collect() {
  const all = [];
  for (const { ns, label } of NAMESPACES) {
    for (const tbl of readTables(ns).tables) {
      for (const sec of (tbl.securities || [])) {
        const d = sec.data || [];
        if (!d.length) continue;
        const i = calcStats(sec).maxCloseIdx;
        all.push({
          page: label, table: tbl.name,
          symbol: sec.yahooSymbol, name: sec.displayName, currency: sec.currency || "",
          green: i >= 0 && i < WINDOW && d[i].close > 0,
          date: i >= 0 ? d[i].date : "", price: i >= 0 ? d[i].close : 0,
          lastDate: d[0].date, last: d[0].close,
          t5: trend(d, 5), t10: trend(d, 10),
        });
      }
    }
  }
  return all;
}

function trendSection(all, key, n) {
  const rows = all.filter(r => r[key] > 0).sort((a, b) => b[key] - a[key]);
  const trs = rows.map(r => `<tr>
      <td class="td-src">${esc(r.page)}</td>
      <td class="td-tbl">${esc(r.table)}</td>
      <td class="td-sym${r.green ? " g" : ""}">${esc(r.symbol)}</td>
      <td class="td-name" title="${esc(r.name)}">${esc(r.name)}</td>
      <td class="td-num">${fmtNum(r.last)} <span class="cur">${esc(r.currency)}</span></td>
      ${fmtTrend(r[key])}
    </tr>`).join("");
  const body = rows.length
    ? `<table>
        <thead><tr><th>Quelle</th><th>Tabelle</th><th>Kürzel</th><th>Name</th><th class="th-num">Kurs</th><th class="th-tr">Trend ${n} T</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>`
    : `<p class="empty">Kein Papier mit positivem ${n}-Tage-Trend.</p>`;
  return `<section class="col">
    <h2>Trend ${n} Tage positiv <span class="cnt">${rows.length}</span></h2>
    <div class="sub2">Schlusskurs heute höher als vor ${n} Handelstagen · absteigend sortiert</div>
    ${body}
  </section>`;
}

function buildHTML(today) {
  const all  = collect();
  const rows = all.filter(r => r.green);
  const trs = rows.map(r => `<tr>
      <td class="td-src">${esc(r.page)}</td>
      <td class="td-tbl">${esc(r.table)}</td>
      <td class="td-date">${fmtDate(r.date)}</td>
      <td class="td-sym">${esc(r.symbol)}</td>
      <td class="td-name">${esc(r.name)}</td>
      <td class="td-price">${fmtNum(r.price)} <span class="cur">${esc(r.currency)}</span></td>
      ${fmtTrend(r.t5)}
      ${fmtTrend(r.t10)}
    </tr>`).join("");

  const body = rows.length
    ? `<table>
        <thead><tr><th>Quelle</th><th>Tabelle</th><th>Datum</th><th>Kürzel</th><th>Name</th><th class="th-price">Preis</th><th class="th-tr">Trend 5 T</th><th class="th-tr">Trend 10 T</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>`
    : `<p class="empty">Kein Papier mit grünem Preisfeld in den letzten ${WINDOW} Tagen.</p>`;

  const lastDate = all.reduce((m, r) => r.lastDate > m ? r.lastDate : m, "");

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
  h2{font-size:14px;font-weight:700;margin-bottom:2px}
  .cnt{font-size:11px;font-weight:600;color:#fff;background:#1e7a3c;border-radius:9px;padding:1px 7px;vertical-align:2px}
  .sub{font-size:11px;color:#5a6a7e;margin-bottom:14px}
  .sub2{font-size:11px;color:#5a6a7e;margin-bottom:8px}
  .block{margin-bottom:28px}
  .cols{display:grid;grid-template-columns:repeat(2,minmax(0,max-content));gap:24px;align-items:start}
  .col{min-width:0}
  .col .td-name{max-width:220px;overflow:hidden;text-overflow:ellipsis}
  .col td,.col th{padding-left:9px;padding-right:9px}
  @media (max-width:900px){.cols{grid-template-columns:minmax(0,1fr)}}
  table{border-collapse:collapse;background:#fff;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);border-radius:6px;overflow:hidden}
  th{background:#f0f4f8;color:#5a6a7e;font-size:10px;font-weight:600;text-align:left;padding:6px 12px;border-bottom:1px solid #d0d7e2}
  td{padding:5px 12px;border-bottom:1px solid #eef1f5;white-space:nowrap}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#f7f9fc}
  .td-tbl,.td-name{color:#3a4a5e}
  .cur{color:#8a9ab0;font-size:10px}
  .td-date{color:#5a6a7e;font-variant-numeric:tabular-nums}
  .td-sym{font-weight:700;font-size:11px}
  .td-sym.g{color:#1e7a3c}
  .td-price,.th-price,.td-num,.th-num{text-align:right;font-variant-numeric:tabular-nums}
  .td-price{background:#d6f0e0}
  .td-src{font-size:11px;color:#5a6a7e}
  .td-tr,.th-tr{text-align:right;font-variant-numeric:tabular-nums}
  .td-tr.up{color:#1e7a3c;font-weight:600}
  .td-tr.dn{color:#c0392b}
  .td-tr.na{color:#b0bccb}
  .empty{background:#fff;padding:14px;border-radius:6px;font-size:12px;color:#8a9ab0}
  .print-btn{float:right;background:#fff;border:1px solid #1a56cc;color:#1a56cc;padding:4px 11px;border-radius:4px;cursor:pointer;font:600 12px 'Trebuchet MS',sans-serif}
  .print-btn:hover{background:#e8f0fd}
  @media print{
    .print-btn{display:none}
    body{background:#fff;padding:0}
    table{box-shadow:none}
    .td-price,.cnt{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Drucken</button>
  <h1>Grün-Bericht — Verfolgung + Rebound</h1>
  <div class="sub">Stand: ${fmtDate(today)} · letzter Kurstag ${lastDate ? fmtDate(lastDate) : "–"} · ${all.length} Werte ausgewertet · Trend = Veränderung Schlusskurs gegenüber vor 5 bzw. 10 Handelstagen</div>

  <section class="block">
    <h2>Grüne Preisfelder — letzter und vorletzter Tag <span class="cnt">${rows.length}</span></h2>
    <div class="sub2">grün = höchster Schlusskurs der 20-Tage-Zeitreihe</div>
    ${body}
  </section>

  <div class="cols">
    ${trendSection(all, "t5", 5)}
    ${trendSection(all, "t10", 10)}
  </div>
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
