"use strict";
// ─────────────────────────────────────────────────────────────
//  Rot-Bericht: Positionen der Verfolgung, deren 20-Tage-Minimum
//  des Schlusskurses in den ersten 10 Datumsspalten liegt
//  (= rotes Preisfeld). Je Tabelle ein Abschnitt.
//  Spalten: Kürzel · Name · Währung · Datum des Minimums ·
//           Tiefstkurs · Einstand · Abw. % (Tiefstkurs ggü. Einstand)
//  Druckfertig (A4 hochkant).
//  NUR automatisch: Mo–Fr 23:30 (server.js); GET /rot-bericht zeigt
//  nur den letzten automatisch erzeugten Bericht.
// ─────────────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");
const { calcStats } = require("./verfolgung");
const { abrufVermerk, ABRUF_CSS } = require("./abruf-vermerk");

const DATA_DIR   = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const WINDOW     = 10;                       // erste 10 Datumsspalten (data[0] = neuester)

function readTables() {
  const f = path.join(DATA_DIR, "verfolgung-tables.json");
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
function fmtShort(s) {
  const [, m, d] = String(s).split("-");
  return `${d}.${m}.`;
}
function fmtNum(n) {
  return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function fmtDev(v) {
  if (v == null) return `<td class="td-dev dev-none">—</td>`;
  const cls  = v >= 0 ? "dev-pos" : "dev-neg";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const txt  = Math.abs(v).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<td class="td-dev ${cls}">${sign}${txt} %</td>`;
}
function localISO(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function collect() {
  const sections = [];
  let firstDate = "", lastDate = "";
  for (const tbl of readTables().tables) {
    const rows = [];
    for (const sec of (tbl.securities || [])) {
      const d = sec.data || [];
      if (!d.length) continue;
      if (d[0].date > firstDate) firstDate = d[0].date;
      const lastCol = d[Math.min(WINDOW, d.length) - 1];
      if (lastCol && (!lastDate || lastCol.date < lastDate)) lastDate = lastCol.date;
      const i = calcStats(sec).minCloseIdx;
      if (!(i >= 0 && i < WINDOW && d[i].close > 0)) continue;
      const low = d[i].close;
      const ein = sec.einstand > 0 ? sec.einstand : null;
      rows.push({
        symbol: sec.yahooSymbol, name: sec.displayName, currency: sec.currency || "",
        idx: i, date: d[i].date, low, einstand: ein,
        dev: ein ? (low - ein) / ein * 100 : null,
      });
    }
    // jüngste Minima zuerst, dann nach Kürzel
    rows.sort((a, b) => a.idx - b.idx || a.symbol.localeCompare(b.symbol));
    sections.push({ name: tbl.name, rows });
  }
  return { sections, firstDate, lastDate };
}

function sectionHTML(s) {
  const n = s.rows.length;
  const badge = `<span class="badge${n ? "" : " none"}">${n} Position${n === 1 ? "" : "en"}</span>`;
  if (!n) {
    return `<section>
  <div class="section-header">${esc(s.name)} ${badge}</div>
  <div class="empty-msg">Keine Position hat ihr 20-Tage-Minimum in den ersten ${WINDOW} Handelstagen — alle Tiefs liegen weiter zurück.</div>
</section>`;
  }
  const trs = s.rows.map(r => {
    const cls = r.idx === 0 ? "today" : "recent";
    return `<tr class="${cls}">
        <td class="td-sym"><span class="dot dot-${cls}"></span>${esc(r.symbol)}</td>
        <td class="td-name" title="${esc(r.name)}">${esc(r.name)}</td>
        <td class="td-curr">${esc(r.currency)}</td>
        <td class="td-date">${fmtDate(r.date)}</td>
        <td class="td-close">${fmtNum(r.low)}</td>
        <td class="td-einstand">${r.einstand ? fmtNum(r.einstand) : "—"}</td>
        ${fmtDev(r.dev)}
      </tr>`;
  }).join("\n      ");
  return `<section>
  <div class="section-header">${esc(s.name)} ${badge}</div>
  <table>
    <colgroup>
      <col class="c-sym"><col class="c-name"><col class="c-curr">
      <col class="c-date"><col class="c-low"><col class="c-ein"><col class="c-dev">
    </colgroup>
    <thead>
      <tr>
        <th>Kürzel</th><th>Name</th><th>Whg.</th>
        <th class="r">Datum Min.</th><th class="r">Tiefstkurs</th>
        <th class="r">Einstand</th><th class="r">Abw. %</th>
      </tr>
    </thead>
    <tbody>
      ${trs}
    </tbody>
  </table>
</section>`;
}

function buildHTML(today, abruf) {
  const { sections, firstDate, lastDate } = collect();
  const range = firstDate ? `${fmtShort(firstDate)} – ${fmtShort(lastDate)}` : "–";
  const todayLbl = firstDate ? ` (${fmtShort(firstDate)})` : "";

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verfolgung – Rote Kursfelder | ${fmtDate(today)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#eef1f5;color:#1a1a2e;font-family:'Trebuchet MS',sans-serif;padding:28px 20px 48px;min-height:100vh}
  header{margin-bottom:28px}
  header h1{font-size:18px;font-weight:700}
  header p{font-size:12px;color:#5a6a7e;margin-top:5px;max-width:680px;line-height:1.6}
  .legend{display:flex;gap:18px;margin-top:10px;flex-wrap:wrap}
  .legend-item{display:flex;align-items:center;gap:6px;font-size:11px;color:#5a6a7e}
  .swatch{width:14px;height:14px;border-radius:3px;flex-shrink:0}
  .swatch-today{background:#f8a8a8;border:1px solid #e07070}
  .swatch-recent{background:#fde8e8;border:1px solid #e0a8a8}
  section{margin-bottom:28px}
  .section-header{background:#d8dfe9;padding:7px 14px;border-radius:6px 6px 0 0;font-size:12px;font-weight:700;display:flex;align-items:center;gap:8px;border-bottom:2px solid #c4cdd8}
  .badge{background:#1a56cc;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px}
  .badge.none{background:#8a9ab0}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:0 0 6px 6px;overflow:hidden;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);table-layout:fixed}
  col.c-sym{width:16%} col.c-name{width:34%} col.c-curr{width:7%}
  col.c-date{width:14%} col.c-low{width:10%} col.c-ein{width:10%} col.c-dev{width:9%}
  thead th{background:#f0f4f8;color:#5a6a7e;font-size:10px;font-weight:600;text-align:left;padding:6px 10px;border-bottom:1px solid #d0d7e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  thead th.r{text-align:right}
  tbody tr{border-bottom:1px solid #eef1f5}
  tbody tr:last-child{border-bottom:none}
  tbody tr:hover{background:#f7f9fc}
  td{padding:7px 10px;vertical-align:middle}
  .td-sym{font-weight:700;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .td-name{color:#3a4a5e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .td-curr{font-size:10px;font-weight:700;color:#1a56cc;text-align:center}
  .td-date,.td-close,.td-einstand,.td-dev{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .td-einstand{color:#5a6a7e}
  .td-dev{font-weight:700}
  .dev-pos{color:#1a7a5e} .dev-neg{color:#c0392b} .dev-none{color:#8a9ab0}
  tr.today{background:#fff0f0}
  tr.recent{background:#fffafa}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
  .dot-today{background:#e03030} .dot-recent{background:#e07070}
  .empty-msg{background:#fff;border-radius:0 0 6px 6px;padding:16px 14px;font-size:12px;color:#8a9ab0;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  footer{margin-top:36px;font-size:10px;color:#a0aab8;border-top:1px solid #d0d7e2;padding-top:12px}
  .print-btn{float:right;margin-left:12px;background:#1a56cc;color:#fff;border:none;border-radius:6px;padding:6px 14px;font:700 12px 'Trebuchet MS',sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15)}
  .print-btn:hover{background:#1446a8}

  /* ── Druck ── */
  @page{size:A4 portrait;margin:12mm 10mm 14mm}
  @media print{
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .print-btn{display:none}
    body{background:#fff;padding:0;min-height:0;font-size:10px}
    header{margin-bottom:14px}
    header h1{font-size:15px}
    header p{max-width:none;font-size:10px}
    .legend-item{font-size:9px}
    section{margin-bottom:14px}
    .section-header{break-after:avoid;page-break-after:avoid;border-radius:0}
    table,.empty-msg{box-shadow:none;border:1px solid #c4cdd8;border-radius:0;font-size:10px}
    thead{display:table-header-group}
    thead th{font-size:9px;padding:4px 6px}
    td{padding:4px 6px}
    .td-sym{font-size:10px}
    tr{break-inside:avoid;page-break-inside:avoid}
    tbody tr{border-bottom:1px solid #dde3ea}
    tbody tr:hover{background:inherit}
    footer{margin-top:18px;font-size:9px}
  }
${ABRUF_CSS}</style>
</head>
<body>

<button class="print-btn" onclick="window.print()">🖨 Drucken</button>

<header>
  <h1>Verfolgung — Rote Kursfelder in den ersten ${WINDOW} Handelstagen</h1>
  ${abrufVermerk(abruf)}
  <p>Stand: ${fmtDate(today)} &nbsp;·&nbsp; Zeigt alle Positionen, bei denen das 20-Tage-Minimum des Schlusskurses in den <strong>ersten ${WINDOW} Datumsspalten</strong> (${range}) liegt (= das rote Feld in der Preisreihe). Abw. % = Tiefstkurs gegenüber Einstand.</p>
  <div class="legend">
    <div class="legend-item"><div class="swatch swatch-today"></div> Minimum am letzten Kurstag${todayLbl}</div>
    <div class="legend-item"><div class="swatch swatch-recent"></div> Minimum vor 1–${WINDOW - 1} Tagen</div>
  </div>
</header>

${sections.map(sectionHTML).join("\n\n")}

<footer>
  Erstellt am ${fmtDate(today)} &nbsp;·&nbsp; Verfolgung-App &nbsp;·&nbsp; Rot = 20-Tage-Minimum des Schlusskurses liegt in den ersten ${WINDOW} Datumsspalten (${range})
</footer>

</body>
</html>`;
}

// abruf: "automatisch" (Zeitplan Mo–Fr 23:30) | "individuell"
function generateRedReport(dateStr, abruf = "individuell") {
  const today = dateStr || localISO();
  const name  = `rot_bericht_${today}.html`;
  fs.writeFileSync(path.join(PUBLIC_DIR, name), buildHTML(today, abruf));
  console.log(`[Rot-Bericht] erzeugt: ${name}`);
  return { file: name, path: path.join(PUBLIC_DIR, name) };
}

module.exports = { generateRedReport, localISO };

if (require.main === module) generateRedReport();
