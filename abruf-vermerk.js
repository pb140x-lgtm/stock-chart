"use strict";
// ─────────────────────────────────────────────────────────────
//  Generelle Regel: Jeder Bericht vermerkt im Kopf, ob er
//  automatisch (Zeitplan) oder individuell (Einzelabruf) erzeugt
//  wurde – mit Datum und Uhrzeit der Erstellung.
//  Automatisch gestellte Berichte bleiben NUR automatisch.
// ─────────────────────────────────────────────────────────────

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// abruf: "automatisch" | "individuell"
function abrufVermerk(abruf = "individuell", d = new Date()) {
  const auto = abruf === "automatisch";
  const cls  = auto ? "abruf-auto" : "abruf-indiv";
  const lbl  = auto ? "Automatisch" : "Individuell";
  return `<div class="abruf-vermerk"><span class="abruf ${cls}">${lbl}</span> ${stamp(d)}</div>`;
}

const ABRUF_CSS = `
  .abruf-vermerk{margin:4px 0 10px;font:600 12px 'Trebuchet MS',sans-serif;color:#5a6a7e}
  .abruf{display:inline-block;padding:1px 9px;border-radius:999px;font-weight:700;margin-right:4px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .abruf-auto{background:#e8f0fe;color:#1a4fb8;border:1px solid #b8cdf5}
  .abruf-indiv{background:#fdf3e3;color:#9a5b00;border:1px solid #f0d4a3}
`;

module.exports = { abrufVermerk, ABRUF_CSS };
