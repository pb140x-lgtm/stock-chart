// Datenbankschema — öffnet stocks.db und legt Tabellen an (idempotent)
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "stocks.db");

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function initSchema() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      symbol     TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      index_name TEXT NOT NULL DEFAULT 'STOXX600'
    );

    CREATE TABLE IF NOT EXISTS ohlcv (
      symbol TEXT NOT NULL,
      date   TEXT NOT NULL,
      open   REAL,
      high   REAL,
      low    REAL,
      close  REAL,
      volume INTEGER,
      PRIMARY KEY (symbol, date)
    );

    CREATE INDEX IF NOT EXISTS idx_ohlcv_sym_date ON ohlcv (symbol, date DESC);

    CREATE TABLE IF NOT EXISTS screener_results (
      run_date       TEXT NOT NULL,
      symbol         TEXT NOT NULL,
      name           TEXT,
      signal_date    TEXT,
      breakout_price REAL,
      lowest_low     REAL,
      gap_pct        REAL,
      sma10          REAL,
      PRIMARY KEY (run_date, symbol)
    );

    CREATE TABLE IF NOT EXISTS update_log (
      run_at           TEXT PRIMARY KEY,
      symbols_updated  INTEGER DEFAULT 0,
      signals_found    INTEGER DEFAULT 0,
      duration_ms      INTEGER DEFAULT 0,
      error            TEXT
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      symbol      TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      signal_date TEXT NOT NULL,
      added_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidates (
      symbol         TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      index_name     TEXT,
      signal_date    TEXT NOT NULL,
      added_at       TEXT NOT NULL,
      breakout_price REAL,
      lowest_low     REAL,
      gap_pct        REAL,
      sma20          REAL,
      close_price    REAL
    );
  `);
  // Migration: sma10 für bestehende DBs ergänzen
  try { db.exec("ALTER TABLE screener_results ADD COLUMN sma10 REAL"); } catch {}
  db.close();
}

module.exports = { openDb, initSchema, DB_PATH };
