"use strict";
// ─────────────────────────────────────────────────────────────
//  Bericht-Generator: Rote & grüne Felder der letzten 5 Tage
//  Erzeugt eine datierte HTML-Datei in public/ (bericht_YYYY-MM-DD.html)
//  Grün  = 20-Tage-Hoch  (Kurs oder Volumen) in den letzten 5 Spalten
//  Rot   = 20-Tage-Tief   (Kurs oder Volumen) in den letzten 5 Spalten
//  (data[0] = neuester Tag → "letzte 5 Tage" = Index 0..4)
// ─────────────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const WINDOW     = 3;                       // letzte 3 Handelstage
const NAMESPACES = ["verfolgung", "rebound"];

// ── Helpers ──────────────────────────────────────────────────
function readTables(ns) {
  const f = path.join(DATA_DIR, `${ns}-tables.json`);
  if (!fs.existsSync(f)) return { tables: [] };
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return { tables: [] }; }
}

function fmtNum(n) {
  if (n == null || n === 0) return "0";
  return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function fmtVol(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + " M";
  if (n >= 1e3) return (n / 1e3).toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + " k";
  return n.toLocaleString("de-DE");
}
function fmtDate(s) {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  return `${d}.${m}.`;
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Signale je Papier ermitteln ──────────────────────────────
// Repliziert die Färb-Logik der Verfolgungstabelle (calcStats):
//   grün = Index des Maximums, rot = Index des Minimums (über alle 20 Werte).
// Ein Signal zählt, wenn dieser Index in die letzten 5 Spalten (0..4) fällt.
function signalsFor(sec) {
  const d = (sec.data || []);
  if (!d.length) return [];
  const closes  = d.map(x => x.close);
  const volumes = d.map(x => x.volume);

  const maxCloseIdx = closes.indexOf(Math.max(...closes));
  const minCloseIdx = closes.indexOf(Math.min(...closes));
  const maxVolIdx   = volumes.indexOf(Math.max(...volumes));
  const minVolIdx   = volumes.indexOf(Math.min(...volumes));

  const sig = [];
  const inWin = i => i >= 0 && i < WINDOW;
  if (inWin(maxCloseIdx)) sig.push({ kind: "high", field: "Kurs", idx: maxCloseIdx, date: d[maxCloseIdx].date, value: fmtNum(d[maxCloseIdx].close) });
  if (inWin(maxVolIdx))   sig.push({ kind: "high", field: "Vol",  idx: maxVolIdx,   date: d[maxVolIdx].date,   value: fmtVol(d[maxVolIdx].volume) });
  if (inWin(minCloseIdx)) sig.push({ kind: "low",  field: "Kurs", idx: minCloseIdx, date: d[minCloseIdx].date, value: fmtNum(d[minCloseIdx].close) });
  if (inWin(minVolIdx))   sig.push({ kind: "low",  field: "Vol",  idx: minVolIdx,   date: d[minVolIdx].date,   value: fmtVol(d[minVolIdx].volume) });
  return sig;
}

function einstandDev(sec) {
  const cur = sec.data?.[0]?.close;
  if (sec.einstand > 0 && cur > 0)
    return +((cur - sec.einstand) / sec.einstand * 100).toFixed(1);
  return null;
}

// ── HTML-Bausteine ───────────────────────────────────────────
function chip(sig) {
  const arrow = sig.kind === "high" ? "▲" : "▼";
  const cls   = sig.kind === "high" ? "chip-high" : "chip-low";
  return `<span class="chip ${cls}">${sig.field} ${arrow} ${fmtDate(sig.date)} · ${esc(sig.value)}</span>`;
}

function rowFor(sec, sigs) {
  const cur     = sec.data?.[0]?.close;
  const dev     = einstandDev(sec);
  const devCls  = dev == null ? "dev-none" : dev > 0 ? "dev-pos" : dev < 0 ? "dev-neg" : "dev-none";
  const devTxt  = dev == null ? "—" : `${dev > 0 ? "+" : ""}${dev.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  const einTxt  = sec.einstand > 0 ? fmtNum(sec.einstand) : "—";
  const today   = sigs.some(s => s.idx === 0);
  const hasHigh = sigs.some(s => s.kind === "high");
  const hasLow  = sigs.some(s => s.kind === "low");
  const rowCls  = today ? (hasHigh && !hasLow ? "today-high" : hasLow && !hasHigh ? "today-low" : "today-mix") : "";
  const chips   = sigs.sort((a, b) => a.idx - b.idx).map(chip).join(" ");

  return `<tr class="${rowCls}">
    <td class="td-sym">${esc(sec.yahooSymbol)}</td>
    <td class="td-name">${esc(sec.displayName)}</td>
    <td class="td-curr">${esc(sec.currency || "")}</td>
    <td class="td-sig">${chips}</td>
    <td class="td-close">${cur ? fmtNum(cur) : "—"}</td>
    <td class="td-einstand">${einTxt}</td>
    <td class="td-dev ${devCls}">${devTxt}</td>
  </tr>`;
}

function tableSection(nsLabel, tbl, entries) {
  const head = `<div class="section-header">
      <span class="ns-tag">${esc(nsLabel)}</span> ${esc(tbl.name)}
      <span class="badge">${entries.length} ${entries.length === 1 ? "Position" : "Positionen"}</span>
    </div>`;
  const rows = entries.map(e => rowFor(e.sec, e.sigs)).join("");
  return `<section>
    ${head}
    <table>
      <colgroup>
        <col class="c-sym"><col class="c-name"><col class="c-curr">
        <col class="c-sig"><col class="c-close"><col class="c-ein"><col class="c-dev">
      </colgroup>
      <thead>
        <tr>
          <th>Kürzel</th><th>Name</th><th>Whg</th>
          <th>Felder (letzte ${WINDOW} Tage)</th>
          <th class="r">Akt. Kurs</th><th class="r">Einstand</th><th class="r">Abw. %</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

// ── Report zusammenbauen ─────────────────────────────────────
function buildHTML(today) {
  const [y, m, d] = today.split("-");
  const dateDE = `${d}.${m}.${y}`;

  let sectionsHTML = "";
  let totalPos = 0, totalHigh = 0, totalLow = 0;

  for (const ns of NAMESPACES) {
    const nsLabel = ns.charAt(0).toUpperCase() + ns.slice(1);
    const db = readTables(ns);
    for (const tbl of db.tables) {
      const entries = [];
      for (const sec of (tbl.securities || [])) {
        const sigs = signalsFor(sec);
        if (sigs.length) {
          entries.push({ sec, sigs });
          totalPos++;
          if (sigs.some(s => s.kind === "high")) totalHigh++;
          if (sigs.some(s => s.kind === "low"))  totalLow++;
        }
      }
      if (entries.length) {
        // Hochs oben, dann gemischt, dann reine Tiefs
        entries.sort((a, b) => {
          const rank = e => {
            const hi = e.sigs.some(s => s.kind === "high");
            const lo = e.sigs.some(s => s.kind === "low");
            return hi && !lo ? 0 : hi && lo ? 1 : 2;
          };
          const r = rank(a) - rank(b);
          if (r) return r;
          return Math.min(...a.sigs.map(s => s.idx)) - Math.min(...b.sigs.map(s => s.idx));
        });
        sectionsHTML += tableSection(nsLabel, tbl, entries);
      }
    }
  }

  if (!sectionsHTML) {
    sectionsHTML = `<div class="empty-msg">Kein Papier hat in den letzten ${WINDOW} Handelstagen ein 20-Tage-Hoch oder -Tief (Kurs oder Volumen).</div>`;
  }

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verfolgung &amp; Rebound – Rote &amp; grüne Felder | ${dateDE}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#eef1f5;color:#1a1a2e;font-family:'Trebuchet MS',sans-serif;padding:28px 20px 48px;min-height:100vh}
  header{margin-bottom:24px}
  header h1{font-size:18px;font-weight:700}
  header p{font-size:12px;color:#5a6a7e;margin-top:5px;max-width:720px;line-height:1.6}
  .summary{display:flex;gap:14px;margin-top:12px;flex-wrap:wrap}
  .stat{background:#fff;border:1px solid #d0d7e2;border-radius:6px;padding:8px 14px;font-size:12px}
  .stat b{font-size:16px;display:block}
  .stat.hi b{color:#1a7a5e}
  .stat.lo b{color:#c0392b}
  .legend{display:flex;gap:18px;margin-top:12px;flex-wrap:wrap}
  .legend-item{display:flex;align-items:center;gap:6px;font-size:11px;color:#5a6a7e}
  .swatch{width:14px;height:14px;border-radius:3px;flex-shrink:0}
  .swatch-high{background:#d6f0e0;border:1px solid #7cc79e}
  .swatch-low{background:#fde8e8;border:1px solid #e0a8a8}
  section{margin-bottom:22px}
  .section-header{background:#d8dfe9;padding:7px 14px;border-radius:6px 6px 0 0;font-size:12px;font-weight:700;display:flex;align-items:center;gap:8px;border-bottom:2px solid #c4cdd8}
  .ns-tag{background:#1a56cc;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px}
  .badge{background:#5a6a7e;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;margin-left:auto}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:0 0 6px 6px;overflow:hidden;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);table-layout:fixed}
  col.c-sym{width:12%}col.c-name{width:26%}col.c-curr{width:5%}col.c-sig{width:35%}col.c-close{width:8%}col.c-ein{width:8%}col.c-dev{width:6%}
  thead th{background:#f0f4f8;color:#5a6a7e;font-size:10px;font-weight:600;text-align:left;padding:6px 10px;border-bottom:1px solid #d0d7e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  thead th.r{text-align:right}
  tbody tr{border-bottom:1px solid #eef1f5}
  tbody tr:last-child{border-bottom:none}
  tbody tr:hover{background:#f7f9fc}
  tbody tr.today-high{background:#eafaf0}
  tbody tr.today-low{background:#fdeeee}
  tbody tr.today-mix{background:#f3f6ea}
  td{padding:7px 10px;vertical-align:middle}
  .td-sym{font-weight:700;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .td-name{color:#3a4a5e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .td-curr{font-size:10px;font-weight:700;color:#1a56cc;text-align:center}
  .td-sig{white-space:normal;line-height:1.7}
  .td-close,.td-einstand,.td-dev{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .td-einstand{color:#5a6a7e}
  .td-dev{font-weight:700}
  .dev-pos{color:#1a7a5e}.dev-neg{color:#c0392b}.dev-none{color:#8a9ab0}
  .chip{display:inline-block;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;white-space:nowrap}
  .chip-high{background:#d6f0e0;color:#1a7a5e;border:1px solid #9fd8b8}
  .chip-low{background:#fde8e8;color:#c0392b;border:1px solid #efb8b8}
  .empty-msg{background:#fff;border-radius:6px;padding:16px 14px;font-size:12px;color:#8a9ab0;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  footer{margin-top:32px;font-size:10px;color:#a0aab8;border-top:1px solid #d0d7e2;padding-top:12px;line-height:1.6}
</style>
</head>
<body>
<header>
  <h1>Verfolgung &amp; Rebound — rote &amp; grüne Felder der letzten ${WINDOW} Handelstage</h1>
  <p>Stand: ${dateDE}. Listet alle Positionen, deren 20-Tage-<strong>Hoch</strong> (grün) oder 20-Tage-<strong>Tief</strong> (rot) bei Kurs oder Volumen in den <strong>letzten ${WINDOW} Datumsspalten</strong> liegt — also das farbige Feld in der Zeile. ▲ = Hoch, ▼ = Tief; jeder Chip zeigt Feld, Datum und Wert.</p>
  <div class="summary">
    <div class="stat"><b>${totalPos}</b> Positionen mit Signal</div>
    <div class="stat hi"><b>${totalHigh}</b> mit Hoch (grün)</div>
    <div class="stat lo"><b>${totalLow}</b> mit Tief (rot)</div>
  </div>
  <div class="legend">
    <div class="legend-item"><div class="swatch swatch-high"></div> Hoch in den letzten ${WINDOW} Tagen</div>
    <div class="legend-item"><div class="swatch swatch-low"></div> Tief in den letzten ${WINDOW} Tagen</div>
  </div>
</header>
${sectionsHTML}
<footer>
  Automatisch erzeugt am ${dateDE} · Verfolgung-App · Fenster: 20-Tage-Hoch/-Tief (Kurs &amp; Volumen) in den letzten ${WINDOW} Handelstagen · Datengrundlage: tägliches Update Mo–Fr 23:05
</footer>
</body>
</html>`;
}

// ── Öffentliche API ──────────────────────────────────────────
function generateReport(dateStr) {
  const today = dateStr || new Date().toISOString().split("T")[0];
  const html  = buildHTML(today);
  const file  = path.join(PUBLIC_DIR, `bericht_${today}.html`);
  fs.writeFileSync(file, html);
  console.log(`[Bericht] erzeugt: ${path.basename(file)}`);
  return { file: `bericht_${today}.html`, path: file };
}

module.exports = { generateReport };
