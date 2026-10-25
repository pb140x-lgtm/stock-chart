# Aktien-Chart (Yahoo Finance + Lightweight Charts)

Eine selbst gebaute Chart-App im TradingView-Stil.
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

---

## Aufbau

```
server.js              Node-Server: Yahoo-Proxy, alle API-Endpunkte, täglicher Scan-Cron
public/
  index.html           Frontend (Chart, Indikatoren, alle Tabs)
  signals.js           Gemeinsame Turtle-Signal-Logik (Browser + Node)
db/
  schema.js            SQLite-Schema und Migrationen
  update.js            Tägliches Update, Screener-Logik, DB-Zugriffsfunktionen
  stocks.db            SQLite-Datenbank (wird automatisch angelegt)
symbols/
  stoxx600.json        522 STOXX-600-Symbole mit Yahoo-Kürzeln und Index
backup/
  screener-vorher.csv  Snapshot vor dem Screener-Umbau (Referenz)
```

---

## Indikatoren

### SMA (Simple Moving Average)

Drei gleitende Durchschnitte, jeweils ein-/ausschaltbar:

| Linie | Farbe | Periode |
|-------|-------|---------|
| SMA 50 | Goldgelb | 50 Tage |
| SMA 100 | Blau | 100 Tage |
| SMA 200 | Lila | 200 Tage |

Alle SMAs werden auf einem größeren Datenfenster (Warmup) berechnet, damit der Wert auch am linken Chartrand korrekt ist.

### MACD

Berechnung: EMA 12 − EMA 26, Signal-EMA 9. Eigener Unterchart (ein-/ausschaltbar).

- **Balken:** Differenz MACD − Signal (grün = positiv, rot = negativ)
- **Blaue Linie:** MACD-Linie · **Orange Linie:** Signal-Linie

### RSI

Berechnung nach Wilder, Periode 14. Eigener Unterchart (ein-/ausschaltbar).

- **Lila Linie:** RSI-Wert · Schwellen bei 70 (überkauft) und 30 (überverkauft)

---

## Turtle-Trading-System (Donchian Channel 20)

Aktivierbar über die Checkbox **„Turtle 20"** in der Kopfzeile.

### Linien

| Linie | Farbe | Berechnung |
|-------|-------|------------|
| Turtle Hoch | Grün gestrichelt | Höchstes Hoch der letzten 20 Perioden |
| Turtle Tief | Rot gestrichelt | Niedrigstes Tief der letzten 20 Perioden |
| Mittellinie | Schwarz gepunktet | SMA 10 der Schlusskurse |

### Signale

Ein Signal wird gesetzt, wenn der Kurs aus dem Donchian-Kanal ausbricht — nur beim **ersten** Breakout einer neuen Richtung. Folgekerzen innerhalb desselben Trends erzeugen kein weiteres Signal.

| Symbol | Bedeutung |
|--------|-----------|
| ▲ schwarz (unterhalb der Kerze) | **Buy-Signal** — Kurs überschreitet das 20-Perioden-Hoch |
| ▼ schwarz (oberhalb der Kerze) | **Sell-Signal** — Kurs unterschreitet das 20-Perioden-Tief |
| ■ klein (Quadrat) | Kurs kreuzt die SMA-10-Mittellinie |

Die Signal-Logik liegt in `public/signals.js` und ist identisch mit der Screener-Logik.

---

## Turtle Screener

Der Screener läuft täglich **Mo–Fr um 23:05 Uhr** (Europe/Berlin) automatisch und prüft alle 522 STOXX-600-Aktien. Manueller Start über den Button „Jetzt aktualisieren".

### Signalregel

Eine Aktie erscheint im Screener, solange ihr **letztes Turtle-Signal ein Kauf** ist — d.h. seit dem letzten Donchian-Ausbruch nach oben ist kein Verkaufssignal aufgetreten. Dieselbe Logik wie die Pfeil-Markierungen im Chart.

### Tabelle

| Spalte | Inhalt |
|--------|--------|
| Signal | Datum des ersten Kaufausbruchs im laufenden Trend |
| Kurs | Letzter verfügbarer Schlusskurs |
| Ausbruch | Aktuelles 20-Tage-Hoch (Donchian-Kanal oben) |
| Tiefstkurs | Tiefstes Tief seit dem vorangegangenen Verkaufssignal |
| Abstand | `(Ausbruch − Tiefstkurs) / Ausbruch` in % |
| SMA 20 | Aktueller SMA-20-Wert · ↑ Kurs darüber, ↓ Kurs darunter |

Signale älter als 2 Tage werden automatisch ausgeblendet.

### Filter

- **Index** — einzelner Index oder alle
- **Signal max. X Tage alt** — Standard: 2
- **SMA 20** — alle / Kurs über / Kurs unter

Filtereinstellungen werden im Browser gespeichert und beim nächsten Öffnen wiederhergestellt.

Klick auf eine Zeile öffnet die Aktie im Chart mit eingeschaltetem Turtle 20.

---

## Kandidaten

Der **+**-Button hinter jeder Screener-Zeile überträgt eine Aktie in die Kandidaten-Datenbank. Dort werden alle Screener-Daten zum Zeitpunkt der Übernahme gespeichert.

Im Tab **„Kandidaten"** stehen:

- Vollständige Screener-Daten (Ausbruch, Tiefstkurs, Abstand, SMA 20)
- **📈** öffnet den Chart mit Turtle 20
- **✕** entfernt den Kandidaten
- **CSV-Export** der gesamten Liste

---

## Merkliste

Über den ☆-Button im Screener können Aktien mit ihrem Signal-Datum gespeichert werden. Im Tab **„Merkliste"** lassen sie sich per Klick direkt im Chart öffnen.

---

## Tabs „Kaufsignale & Trades"

Zeigt alle Turtle-Buy-Signale der aktuell geladenen Aktie als Tabelle mit Einstieg, Ausstieg und Ertrag. Farbige senkrechte Linien im Chart markieren Ein- und Ausstiege.

---

## Claude-Dialog (rechtes Panel)

- **Freie Fragen:** Frag Claude zum aktuellen Chart – Trend, Indikatoren, Einschätzungen.
- **📊 Eintragen:** Claude analysiert den Chart und trägt Preis-Linien und Marker automatisch ein.
- **🗑 Löschen:** Entfernt alle eingetragenen Claude-Annotationen.

Claude kennt immer den aktuellen Chart-Kontext: Symbol, Zeitraum, Schlusskurse, SMA-Werte, MACD, RSI und Turtle-Kanal.
