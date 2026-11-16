"""Lokale SQLite-Datenbank: Positionen, Umsätze, Stammdaten, Kurs-Zwischenspeicher."""
import os
import sqlite3
import threading
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
# PORTFOLIO_DATA_DIR erlaubt Testläufe mit einer getrennten Datenbank
DATA_DIR = Path(os.environ.get("PORTFOLIO_DATA_DIR") or BASE_DIR / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "portfolio.db"

_lock = threading.RLock()
_conn = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,              -- comdirect | csv | manual
    isin TEXT NOT NULL,
    wkn TEXT,
    name TEXT,
    quantity REAL NOT NULL,
    purchase_price REAL,               -- Kaufkurs je Stück in EUR
    purchase_value REAL,               -- Kaufwert gesamt in EUR
    bank_price REAL,                   -- letzter Kurs laut Bank (EUR)
    bank_prev_price REAL,              -- Vortageskurs laut Bank (EUR)
    bank_value REAL,                   -- Wert laut Bank (EUR)
    updated TEXT
);
CREATE TABLE IF NOT EXISTS instruments (
    isin TEXT PRIMARY KEY,
    wkn TEXT,
    name TEXT,
    bank_type TEXT,                    -- Produktart laut Bank
    ticker TEXT,                       -- automatisch gefundener Kurs-Ticker
    ticker_manual TEXT,                -- von Hand gesetzter Ticker (hat Vorrang)
    quote_currency TEXT,
    yahoo_type TEXT,
    sector TEXT,
    type_manual TEXT,
    sector_manual TEXT,
    meta_updated TEXT,
    lookup_failed TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    source TEXT,
    isin TEXT,
    date TEXT,                         -- YYYY-MM-DD
    quantity REAL,                     -- Zugang positiv, Abgang negativ
    price REAL,
    value REAL,
    type TEXT
);
CREATE TABLE IF NOT EXISTS prices (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL NOT NULL,
    PRIMARY KEY (ticker, date)
);
CREATE TABLE IF NOT EXISTS watchlist (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    yahoo_type TEXT,
    quote_currency TEXT,
    exchange TEXT,
    added TEXT
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def conn():
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.executescript(SCHEMA)
            # Nachträglich ergänzte Spalten in bestehenden Datenbanken anlegen
            cols = {r["name"] for r in _conn.execute("PRAGMA table_info(watchlist)")}
            if "note" not in cols:
                _conn.execute("ALTER TABLE watchlist ADD COLUMN note TEXT")
            _conn.commit()
        return _conn


def query(sql, params=()):
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def execute(sql, params=()):
    with _lock:
        cur = conn().execute(sql, params)
        conn().commit()
        return cur


def executemany(sql, rows):
    with _lock:
        conn().executemany(sql, rows)
        conn().commit()


def get_kv(key, default=None):
    rows = query("SELECT value FROM kv WHERE key=?", (key,))
    return rows[0]["value"] if rows else default


def set_kv(key, value):
    execute(
        "INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def upsert_instrument(isin, wkn=None, name=None, bank_type=None):
    """Legt ein Wertpapier an oder ergänzt Stammdaten, ohne Handkorrekturen zu überschreiben."""
    execute(
        """INSERT INTO instruments(isin, wkn, name, bank_type) VALUES(?,?,?,?)
           ON CONFLICT(isin) DO UPDATE SET
             wkn=COALESCE(excluded.wkn, instruments.wkn),
             name=COALESCE(excluded.name, instruments.name),
             bank_type=COALESCE(excluded.bank_type, instruments.bank_type)""",
        (isin, wkn, name, bank_type),
    )


def replace_positions(source, rows):
    """Ersetzt alle Positionen einer Quelle durch den neuen Stand."""
    with _lock:
        c = conn()
        c.execute("DELETE FROM positions WHERE source=?", (source,))
        c.executemany(
            """INSERT INTO positions(source, isin, wkn, name, quantity, purchase_price,
                 purchase_value, bank_price, bank_prev_price, bank_value, updated)
               VALUES(:source,:isin,:wkn,:name,:quantity,:purchase_price,
                 :purchase_value,:bank_price,:bank_prev_price,:bank_value,:updated)""",
            rows,
        )
        c.commit()
