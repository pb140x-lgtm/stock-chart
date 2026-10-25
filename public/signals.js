// Turtle-Signal-Logik. Läuft im Browser (via <script>) und in Node (via require).

function computeSMA(candles, period) {
  const out = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

function computeDonchian(candles, period) {
  const highs = [], lows = [];
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, candles[i - j].high);
      ll = Math.min(ll, candles[i - j].low);
    }
    highs.push({ time: candles[i].time, value: hh });
    lows.push({ time: candles[i].time, value: ll });
  }
  return { highs, lows };
}

// Marker-Signale für den Chart (▲▼ Pfeile)
function computeTurtleSignals(candles, period = 20) {
  const signals = [];
  let lastSignal = null;
  for (let i = period; i < candles.length; i++) {
    let prevHigh = -Infinity, prevLow = Infinity;
    for (let j = i - period; j < i; j++) {
      prevHigh = Math.max(prevHigh, candles[j].high);
      prevLow  = Math.min(prevLow,  candles[j].low);
    }
    if (candles[i].high > prevHigh && lastSignal !== "buy") {
      signals.push({ time: candles[i].time, position: "belowBar", color: "#000000", shape: "arrowUp",   size: 2, text: "" });
      lastSignal = "buy";
    } else if (candles[i].low < prevLow && lastSignal !== "sell") {
      signals.push({ time: candles[i].time, position: "aboveBar", color: "#000000", shape: "arrowDown", size: 2, text: "" });
      lastSignal = "sell";
    }
  }
  return signals;
}

// Vollständige Signalliste mit Typ, Ausbruchspreis und Schlusskurs.
// buy:  price = Low der Ausbruchskerze, breakout = 20-Tage-Hoch
// sell: price = High der Ausbruchskerze, breakout = 20-Tage-Tief
function computeAllTurtleSignals(candles, period = 20) {
  const signals = [];
  let lastSignal = null;
  for (let i = period; i < candles.length; i++) {
    let prevHigh = -Infinity, prevLow = Infinity;
    for (let j = i - period; j < i; j++) {
      prevHigh = Math.max(prevHigh, candles[j].high);
      prevLow  = Math.min(prevLow,  candles[j].low);
    }
    if (candles[i].high > prevHigh && lastSignal !== "buy") {
      signals.push({ time: candles[i].time, type: "buy",  price: candles[i].low,  breakout: prevHigh, close: candles[i].close });
      lastSignal = "buy";
    } else if (candles[i].low < prevLow && lastSignal !== "sell") {
      signals.push({ time: candles[i].time, type: "sell", price: candles[i].high, breakout: prevLow,  close: candles[i].close });
      lastSignal = "sell";
    }
  }
  return signals;
}

if (typeof module !== "undefined") {
  module.exports = { computeSMA, computeDonchian, computeTurtleSignals, computeAllTurtleSignals };
}
