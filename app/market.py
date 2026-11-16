"""Kurs- und Stammdaten aus Yahoo Finance (kostenlos, ohne API-Schlüssel), lokal zwischengespeichert."""
import logging
import threading
import time
from datetime import date, datetime, timedelta

import yfinance as yf

from . import db

log = logging.getLogger("market")
_refresh_lock = threading.Lock()

REFRESH_MINUTES = 10
META_MAX_AGE_DAYS = 30

SECTOR_DE = {
    "Technology": "Technologie",
    "Financial Services": "Finanzen",
    "Healthcare": "Gesundheit",
    "Consumer Cyclical": "Zyklischer Konsum",
    "Consumer Defensive": "Basiskonsum",
    "Industrials": "Industrie",
    "Energy": "Energie",
    "Utilities": "Versorger",
    "Basic Materials": "Grundstoffe",
    "Real Estate": "Immobilien",
    "Communication Services": "Kommunikation",
}
YAHOO_TYPE_DE = {
    "EQUITY": "Einzelaktie",
    "ETF": "ETF",
    "MUTUALFUND": "Fonds",
}
PRODUCT_TYPES = ["Einzelaktie", "ETF", "ETP/ETC", "Fonds", "Anleihe", "Zertifikat",
                 "Optionsschein", "Sonstiges"]


def effective_ticker(ins):
    return (ins.get("ticker_manual") or ins.get("ticker") or "").strip() or None


def effective_type(ins):
    return (ins.get("type_manual") or ins.get("bank_type")
            or YAHOO_TYPE_DE.get(ins.get("yahoo_type") or "") or "Sonstiges")


def effective_sector(ins):
    if ins.get("sector_manual"):
        return ins["sector_manual"]
    if ins.get("sector"):
        return ins["sector"]
    typ = effective_type(ins)
    if typ in ("ETF", "Fonds", "ETP/ETC"):
        return typ + " (gemischt)"
    return "Nicht zugeordnet"


# ---------- Stammdaten ----------

def resolve_instrument(isin, force=False):
    """Sucht zum Wertpapier den Kurs-Ticker sowie Branche, Währung und Art."""
    rows = db.query("SELECT * FROM instruments WHERE isin=?", (isin,))
    if not rows:
        return
    ins = rows[0]
    today = date.today().isoformat()

    if not ins.get("ticker_manual") and (force or not ins.get("ticker")):
        if force or ins.get("lookup_failed") != today:
            try:
                quotes = yf.Search(isin, max_results=10, news_count=0).quotes
            except Exception as e:  # Netzwerk o. Ä.
                log.warning("Ticker-Suche %s fehlgeschlagen: %s", isin, e)
                quotes = []
            if quotes:
                q = quotes[0]
                db.execute("UPDATE instruments SET ticker=?, yahoo_type=?, lookup_failed=NULL WHERE isin=?",
                           (q.get("symbol"), q.get("quoteType"), isin))
                ins["ticker"] = q.get("symbol")
                if not ins.get("name"):
                    db.execute("UPDATE instruments SET name=? WHERE isin=?",
                               (q.get("longname") or q.get("shortname"), isin))
            else:
                db.execute("UPDATE instruments SET lookup_failed=? WHERE isin=?", (today, isin))

    ticker = effective_ticker(ins)
    if not ticker:
        return
    stale = True
    if ins.get("meta_updated") and not force:
        try:
            stale = (date.today() - date.fromisoformat(ins["meta_updated"])).days > META_MAX_AGE_DAYS
        except ValueError:
            stale = True
    if stale or not ins.get("quote_currency"):
        try:
            info = yf.Ticker(ticker).info or {}
        except Exception as e:
            log.warning("Stammdaten %s fehlgeschlagen: %s", ticker, e)
            return
        currency = info.get("currency")
        if not currency:
            return
        sector = SECTOR_DE.get(info.get("sector") or "", info.get("sector"))
        db.execute(
            "UPDATE instruments SET quote_currency=?, sector=?, yahoo_type=COALESCE(?, yahoo_type), "
            "meta_updated=? WHERE isin=?",
            (currency, sector, info.get("quoteType"), today, isin))


# ---------- Kurse ----------

def _fx_ticker(currency):
    cur = "GBP" if currency == "GBp" else currency
    return None if cur in (None, "", "EUR") else f"EUR{cur}=X"


def _store(ticker, closes):
    rows = [(ticker, d.strftime("%Y-%m-%d"), float(v)) for d, v in closes.items() if v == v and v > 0]
    if rows:
        db.executemany("INSERT OR REPLACE INTO prices(ticker,date,close) VALUES(?,?,?)", rows)
    return len(rows)


def _download(tickers, **kwargs):
    if not tickers:
        return
    try:
        data = yf.download(tickers, auto_adjust=False, progress=False, group_by="ticker",
                           threads=True, **kwargs)
    except Exception as e:
        log.warning("Kursabruf fehlgeschlagen: %s", e)
        return
    for t in tickers:
        try:
            closes = data[t]["Close"].dropna()
        except Exception:
            continue
        _store(t, closes)


def needed_tickers():
    rows = db.query("SELECT i.* FROM instruments i WHERE i.isin IN (SELECT isin FROM positions)")
    tickers = set()
    for ins in rows:
        t = effective_ticker(ins)
        if t:
            tickers.add(t)
            fx = _fx_ticker(ins.get("quote_currency"))
            if fx:
                tickers.add(fx)
    for w in db.query("SELECT ticker, quote_currency FROM watchlist"):
        tickers.add(w["ticker"])
        fx = _fx_ticker(w.get("quote_currency"))
        if fx:
            tickers.add(fx)
    return sorted(tickers)


# ---------- Watchlist ----------

GERMAN_EXCHANGES = {"GER": 0, "FRA": 1, "STU": 2, "MUN": 3, "HAM": 3, "BER": 3, "DUS": 3}


def watch_ins(row):
    """Watchlist-Zeile in der Form der Stammdaten, damit Kurs- und Nachrichtenfunktionen sie verarbeiten."""
    return {"isin": "", "ticker": row["ticker"], "name": row.get("name"),
            "yahoo_type": row.get("yahoo_type"), "quote_currency": row.get("quote_currency")}


def search(text):
    """Sucht Wertpapiere nach Name, ISIN, WKN oder Ticker. Deutsche Handelsplätze stehen vorn."""
    text = (text or "").strip()
    if len(text) < 2:
        return []
    try:
        quotes = yf.Search(text, max_results=15, news_count=0).quotes
    except Exception as e:
        log.warning("Suche '%s' fehlgeschlagen: %s", text, e)
        return []
    out = []
    for q in quotes:
        if not q.get("symbol") or q.get("quoteType") not in ("EQUITY", "ETF", "MUTUALFUND", "INDEX"):
            continue
        out.append({"symbol": q["symbol"], "name": q.get("longname") or q.get("shortname") or q["symbol"],
                    "exchange": q.get("exchDisp") or q.get("exchange") or "", "exchange_code": q.get("exchange"),
                    "type": q.get("quoteType")})
    out.sort(key=lambda r: GERMAN_EXCHANGES.get(r["exchange_code"], 9))
    return out[:10]


def add_watch(symbol, name=None, yahoo_type=None):
    """Nimmt ein Wertpapier in die Watchlist auf und lädt seine Kurse. False, wenn es keine Kurse gibt."""
    try:
        info = yf.Ticker(symbol).info or {}
    except Exception as e:
        log.warning("Stammdaten %s fehlgeschlagen: %s", symbol, e)
        info = {}
    currency = info.get("currency")
    if not currency:
        return False
    _download([symbol], period="max")
    fx = _fx_ticker(currency)
    if fx:
        _download([fx], period="max")
    if not db.query("SELECT 1 FROM prices WHERE ticker=? LIMIT 1", (symbol,)):
        return False
    db.execute(
        "INSERT OR REPLACE INTO watchlist(ticker, name, yahoo_type, quote_currency, exchange, added) VALUES(?,?,?,?,?,?)",
        (symbol, name or info.get("longName") or info.get("shortName") or symbol,
         yahoo_type or info.get("quoteType"), currency, info.get("fullExchangeName") or info.get("exchange"),
         datetime.now().isoformat(timespec="seconds")))
    return True


def refresh(force=False):
    """Aktualisiert Stammdaten und Kurse; höchstens alle REFRESH_MINUTES, außer force."""
    with _refresh_lock:
        last = float(db.get_kv("prices_refreshed_ts", "0") or 0)
        for row in db.query("SELECT DISTINCT isin FROM positions"):
            resolve_instrument(row["isin"])
        tickers = needed_tickers()
        have = {r["ticker"]: r["last"] for r in
                db.query("SELECT ticker, MAX(date) AS last FROM prices GROUP BY ticker")}
        new = [t for t in tickers if t not in have]
        old = [t for t in tickers if t in have]
        if new:
            _download(new, period="max")
        if old and (force or time.time() - last > REFRESH_MINUTES * 60):
            start = min(have[t] for t in old)
            start = (date.fromisoformat(start) - timedelta(days=7)).isoformat()
            _download(old, start=start)
            db.set_kv("prices_refreshed_ts", str(time.time()))
        elif new and not old:
            db.set_kv("prices_refreshed_ts", str(time.time()))
        db.set_kv("prices_refreshed", datetime.now().isoformat(timespec="seconds"))


def _series(ticker):
    return {r["date"]: r["close"] for r in
            db.query("SELECT date, close FROM prices WHERE ticker=? ORDER BY date", (ticker,))}


def eur_series(ins):
    """Tagesschlusskurse in EUR als sortierte Liste [(datum, kurs)]. Leer, wenn keine Kurse da sind."""
    ticker = effective_ticker(ins)
    if not ticker:
        return []
    raw = _series(ticker)
    if not raw:
        return []
    currency = ins.get("quote_currency") or "EUR"
    factor = 0.01 if currency == "GBp" else 1.0
    fx_ticker = _fx_ticker(currency)
    if not fx_ticker:
        return sorted((d, c * factor) for d, c in raw.items())
    fx = _series(fx_ticker)
    if not fx:
        return []
    fx_dates = sorted(fx)
    out, i, rate = [], 0, None
    for d in sorted(raw):
        while i < len(fx_dates) and fx_dates[i] <= d:
            rate = fx[fx_dates[i]]
            i += 1
        if rate is None:
            rate = fx[fx_dates[0]]
        out.append((d, raw[d] * factor / rate))
    return out
