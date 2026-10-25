# Aktien-Chart (Yahoo Finance + Lightweight Charts)

Eine einfache, selbst gebaute Chart-App im TradingView-Stil.
Kursdaten kommen von der **öffentlichen Yahoo-Finance-Schnittstelle** (kein API-Key, kein Konto).
Darstellung mit **Lightweight Charts** (Open Source von TradingView).

## Starten

```bash
cd ~/stock-chart
node server.js
```

Für den **Dialog mit Claude** (rechtes Panel) wird ein Anthropic-API-Key benötigt:

```bash
ANTHROPIC_API_KEY=sk-ant-… node server.js
# optional ein anderes Modell wählen:
ANTHROPIC_MODEL=claude-opus-4-8 ANTHROPIC_API_KEY=sk-ant-… node server.js
```

Dann im Browser öffnen: http://localhost:3000

> Voraussetzung: Node.js (bereits installiert). Es werden **keine** npm-Pakete benötigt.
> Der Chart funktioniert auch ohne Key – nur der Claude-Dialog braucht ihn.

## Aufbau

- `server.js` — kleiner Node-Server: Yahoo-Proxy (`/api/history`) + liefert das Frontend aus
- `public/index.html` — das komplette Frontend (Chart + Bedienung + Indikatoren)

---

## Indikatoren

### SMA (Simple Moving Average)

Drei gleitende Durchschnitte, jeweils ein-/ausschaltbar:

| Linie | Farbe | Bedeutung |
|-------|-------|-----------|
| SMA 50 | Goldgelb | Kurzfristiger Trend |
| SMA 100 | Blau | Mittelfristiger Trend |
| SMA 200 | Lila | Langfristiger Trend |

Alle SMAs werden auf einem größeren Datenfenster (Warmup) berechnet, damit der Wert auch am linken Chartrand korrekt ist.

### MACD (Moving Average Convergence Divergence)

Berechnung: EMA 12 − EMA 26, Signal-EMA 9.

- **Balken (Histogramm):** Differenz MACD − Signal (grün = positiv, rot = negativ)
- **Blaue Linie:** MACD-Linie
- **Orange Linie:** Signal-Linie

Wird im eigenen Unterchart unterhalb des Hauptcharts angezeigt (ein-/ausschaltbar).

### RSI (Relative Strength Index)

Berechnung nach Wilder, Periode 14.

- **Lila Linie:** RSI-Wert
- **Rote gestrichelte Linie:** Überkauft-Schwelle (70)
- **Grüne gestrichelte Linie:** Überverkauft-Schwelle (30)

Wird im eigenen Unterchart unterhalb des MACD angezeigt (ein-/ausschaltbar).

---

## Turtle-Trading-System (Donchian Channel 20)

Aktivierbar über die Checkbox **„Turtle 20"** in der Kopfzeile. Zeigt drei Linien und zwei Typen von Markierungen auf dem Hauptchart.

### Linien

| Linie | Farbe | Berechnung |
|-------|-------|------------|
| Turtle Hoch | Grün gestrichelt | Höchstes Hoch der letzten 20 Perioden (oberer Donchian-Kanal) |
| Turtle Tief | Rot gestrichelt | Niedrigstes Tief der letzten 20 Perioden (unterer Donchian-Kanal) |
| Mittellinie (SMA 10) | Schwarz gepunktet | Einfacher 10-Perioden-Durchschnitt der Schlusskurse |

### Buy- und Sell-Signale (Pfeile)

Ein Signal wird gesetzt, wenn der Kurs aus dem Donchian-Kanal ausbricht — aber nur beim **ersten** Breakout einer neuen Richtung. Folgekerzen innerhalb desselben Trends erzeugen kein weiteres Signal.

| Symbol | Bedeutung | Position |
|--------|-----------|----------|
| ▲ (schwarzer Pfeil nach oben) | **Buy-Signal** — Kurs überschreitet das 20-Perioden-Hoch | Unterhalb der Kerze |
| ▼ (schwarzer Pfeil nach unten) | **Sell-Signal** — Kurs unterschreitet das 20-Perioden-Tief | Oberhalb der Kerze |

Nach einem Buy-Signal erscheint der nächste Pfeil erst, wenn ein Sell-Breakout auftritt (und umgekehrt).

### SMA-10-Kreuzungen (Quadrat-Marker)

Zusätzlich wird jede Kreuzung des Schlusskurses mit der schwarzen SMA-10-Mittellinie markiert:

| Symbol | Bedeutung | Position |
|--------|-----------|----------|
| ■ (kleines schwarzes Quadrat) | Kurs kreuzt SMA 10 von unten nach oben | Unterhalb der Kerze |
| ■ (kleines schwarzes Quadrat) | Kurs kreuzt SMA 10 von oben nach unten | Oberhalb der Kerze |

Diese Kreuzungen zeigen potenzielle Trendwechsel innerhalb des Kanals und können als Filter oder Einstiegshilfe dienen.

---

## Claude-Dialog (rechtes Panel)

- **Freie Fragen:** Frag Claude zum aktuellen Chart – Trend, Indikatoren, Einschätzungen.
- **📊 Eintragen:** Claude analysiert den Chart und trägt Preis-Linien und Marker automatisch ein.
- **🗑 Löschen:** Entfernt alle eingetragenen Claude-Annotationen.

Claude kennt dabei immer den aktuellen Chart-Kontext: Symbol, Zeitraum, Schlusskurse, SMA-Werte, MACD, RSI und Turtle-Kanal.
