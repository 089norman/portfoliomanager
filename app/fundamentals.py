"""Nachrichten, Kennzahlen, Dividenden und Termine (Yahoo Finance + Google News), lokal zwischengespeichert."""
import json
import logging
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests
import yfinance as yf

from . import db, market

log = logging.getLogger("fundamentals")

db.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, updated REAL, value TEXT)")
db.execute("""CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, isin TEXT, date TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT)""")

HOURS = 3600
TTL_INFO = 12 * HOURS
TTL_EVENTS = 12 * HOURS
TTL_FIN = 24 * HOURS
TTL_NEWS = 0.5 * HOURS


def _cached(key, ttl, loader, force=False):
    """Liefert den gespeicherten Wert, lädt bei Ablauf neu; bei Fehlern bleibt der alte Wert erhalten."""
    rows = db.query("SELECT updated, value FROM cache WHERE key=?", (key,))
    if rows and not force and time.time() - rows[0]["updated"] < ttl:
        return json.loads(rows[0]["value"])
    try:
        value = loader()
    except Exception as e:
        log.warning("Abruf %s fehlgeschlagen: %s", key, e)
        return json.loads(rows[0]["value"]) if rows else None
    db.execute("INSERT INTO cache(key,updated,value) VALUES(?,?,?) "
               "ON CONFLICT(key) DO UPDATE SET updated=excluded.updated, value=excluded.value",
               (key, time.time(), json.dumps(value)))
    return value


def _f(v):
    try:
        v = float(v)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def _d(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, tz=timezone.utc).date().isoformat()
    return str(v)[:10]


def is_fund(ins):
    return (ins.get("yahoo_type") in ("ETF", "MUTUALFUND")
            or market.effective_type(ins) in ("ETF", "Fonds", "ETP/ETC"))


# ---------- Einzelabrufe ----------

INFO_KEYS = ["longName", "shortName", "currency", "financialCurrency", "marketCap", "trailingPE", "forwardPE",
             "trailingEps", "dividendRate", "dividendYield", "payoutRatio", "totalRevenue",
             "netIncomeToCommon", "industry", "website", "fiftyTwoWeekHigh", "fiftyTwoWeekLow"]


def get_info(ticker, force=False):
    def load():
        info = yf.Ticker(ticker).info or {}
        return {k: info.get(k) for k in INFO_KEYS}
    return _cached(f"info:{ticker}", TTL_INFO, load, force) or {}


def get_events(ticker, fund, force=False):
    """Dividendenhistorie sowie (bei Aktien) Ex-Tag, Zahltag und Zahlentermine."""
    def load():
        t = yf.Ticker(ticker)
        out = {"dividends": [], "ex_dividend": None, "dividend_date": None, "earnings": []}
        div = t.dividends
        if div is not None and len(div):
            out["dividends"] = [[d.strftime("%Y-%m-%d"), float(v)] for d, v in div.items() if v and v > 0]
        if not fund:
            try:
                cal = t.calendar or {}
            except Exception:
                cal = {}
            out["ex_dividend"] = _d(cal.get("Ex-Dividend Date"))
            out["dividend_date"] = _d(cal.get("Dividend Date"))
            today = date.today().isoformat()
            seen = {}
            for d in cal.get("Earnings Date") or []:
                # Die Gewinnschätzung des Kalenders gilt nur für einen noch ausstehenden Termin
                est = _f(cal.get("Earnings Average")) if _d(d) >= today else None
                seen[_d(d)] = {"date": _d(d), "estimate": est, "reported": None}
            try:
                ed = t.get_earnings_dates(limit=12)
            except Exception:
                ed = None
            if ed is not None:
                for idx, row in ed.iterrows():
                    try:
                        day = idx.tz_convert("Europe/Berlin").strftime("%Y-%m-%d")
                    except Exception:
                        day = idx.strftime("%Y-%m-%d")
                    # Yahoo führt denselben Termin teils mit einem Tag Abstand - als einen behandeln
                    near = next((k for k in seen if abs((date.fromisoformat(k) - date.fromisoformat(day)).days) <= 2), None)
                    entry = seen.pop(near) if near else {"date": day, "estimate": None, "reported": None}
                    row_est = _f(row.get("EPS Estimate"))
                    entry["estimate"] = row_est if row_est is not None else entry["estimate"]
                    entry["reported"] = _f(row.get("Reported EPS"))
                    seen[entry["date"]] = entry
            out["earnings"] = sorted(seen.values(), key=lambda e: e["date"])
        return out
    return _cached(f"events:{ticker}", TTL_EVENTS, load, force) or {
        "dividends": [], "ex_dividend": None, "dividend_date": None, "earnings": []}


def get_financials(ticker, force=False):
    def table(df, limit):
        rows = []
        if df is None or df.empty:
            return rows
        def pick(col, *names):
            for n in names:
                if n in df.index:
                    v = _f(df.loc[n, col])
                    if v is not None:
                        return v
            return None
        for col in list(df.columns)[:limit]:
            row = {"period": str(col)[:10], "revenue": pick(col, "Total Revenue", "Operating Revenue"),
                   "operating_income": pick(col, "Operating Income", "EBIT"),
                   "net_income": pick(col, "Net Income", "Net Income Common Stockholders"),
                   "eps": pick(col, "Diluted EPS", "Basic EPS")}
            if any(row[k] is not None for k in ("revenue", "net_income", "eps")):
                rows.append(row)
        return rows

    def load():
        t = yf.Ticker(ticker)
        return {"annual": table(t.income_stmt, 4), "quarterly": table(t.quarterly_income_stmt, 5)}
    return _cached(f"fin:{ticker}", TTL_FIN, load, force) or {"annual": [], "quarterly": []}


def _google_news(query):
    r = requests.get("https://news.google.com/rss/search", timeout=15,
                     params={"q": query, "hl": "de", "gl": "DE", "ceid": "DE:de"},
                     headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    items = []
    for it in ET.fromstring(r.content).iter("item"):
        title = (it.findtext("title") or "").strip()
        source = (it.findtext("source") or "").strip()
        if source and title.endswith(" - " + source):
            title = title[: -len(source) - 3]
        try:
            published = parsedate_to_datetime(it.findtext("pubDate")).astimezone().isoformat(timespec="minutes")
        except Exception:
            continue
        link = (it.findtext("link") or "").strip()
        if title and link.startswith("https://"):
            items.append({"title": title, "source": source or "Google News", "date": published,
                          "url": link, "lang": "de"})
    return items[:15]


def _yahoo_news(ticker):
    items = []
    for n in yf.Ticker(ticker).news or []:
        c = n.get("content") or {}
        url = ((c.get("canonicalUrl") or {}).get("url") or (c.get("clickThroughUrl") or {}).get("url") or "")
        if not (c.get("title") and url.startswith("https://") and c.get("pubDate")):
            continue
        try:
            published = datetime.fromisoformat(c["pubDate"].replace("Z", "+00:00")).astimezone().isoformat(timespec="minutes")
        except ValueError:
            continue
        items.append({"title": c["title"], "source": (c.get("provider") or {}).get("displayName") or "Yahoo Finance",
                      "date": published, "url": url, "lang": "en"})
    return items


def get_news(ins, force=False):
    ticker = market.effective_ticker(ins)
    if not ticker:
        return []

    def load():
        items = []
        if not is_fund(ins):
            name = get_info(ticker).get("longName") or ins.get("name") or ""
            if name:
                try:
                    items += _google_news(f'"{name}" Aktie')
                except Exception as e:
                    log.warning("Google News %s: %s", name, e)
        try:
            items += _yahoo_news(ticker)
        except Exception as e:
            log.warning("Yahoo News %s: %s", ticker, e)
        if not items:
            raise RuntimeError("keine Nachrichten geliefert")
        return sorted(items, key=lambda i: i["date"], reverse=True)
    return _cached(f"news:{ticker}", TTL_NEWS, load, force) or []


# ---------- Hilfen ----------

def _held():
    """Gehaltene Wertpapiere mit Ticker: [(Bestand, Stammdaten)]."""
    instruments = {i["isin"]: i for i in db.query("SELECT * FROM instruments")}
    out = {}
    for p in db.query("SELECT isin, name, quantity, purchase_value FROM positions"):
        h = out.setdefault(p["isin"], {"isin": p["isin"], "name": p["name"], "quantity": 0.0,
                                       "purchase_value": 0.0, "pv_known": True})
        h["quantity"] += p["quantity"]
        if p["purchase_value"] is None:
            h["pv_known"] = False
        else:
            h["purchase_value"] += p["purchase_value"]
    return [(h, instruments.get(h["isin"], {"isin": h["isin"]})) for h in out.values()]


def _parallel(fn, items):
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(fn, items))


def _fx_to_eur(ins):
    """Faktor Kurswährung -> EUR (aktuell); None, wenn kein Wechselkurs vorliegt."""
    currency = ins.get("quote_currency") or "EUR"
    factor = 0.01 if currency == "GBp" else 1.0
    fx_ticker = market._fx_ticker(currency)
    if not fx_ticker:
        return factor
    rows = db.query("SELECT close FROM prices WHERE ticker=? ORDER BY date DESC LIMIT 1", (fx_ticker,))
    return factor / rows[0]["close"] if rows else None


def _add_business_days(day, n):
    step = 1 if n > 0 else -1
    while n:
        day += timedelta(days=step)
        if day.weekday() < 5:
            n -= step
    return day


def _plus_years(day, years):
    """Schiebt einen Termin um Jahre weiter und behält den Wochentag bei (52 Wochen je Jahr)."""
    return day + timedelta(weeks=52 * years)


def _is_german_share(ins):
    return ins.get("isin", "").startswith("DE") and not is_fund(ins)


# ---------- Dividenden ----------

def _dividend_plan(h, ins, ev, today):
    """Erwartete Zahlungen der nächsten 12 Monate auf Basis der Zahlungen der letzten 12 Monate."""
    fx = _fx_to_eur(ins)
    hist = [(date.fromisoformat(d), a) for d, a in ev["dividends"]]
    last12 = [(d, a) for d, a in hist if today - timedelta(days=365) < d <= today]
    german = _is_german_share(ins)
    known_ex = date.fromisoformat(ev["ex_dividend"]) if ev.get("ex_dividend") else None
    known_pay = date.fromisoformat(ev["dividend_date"]) if ev.get("dividend_date") else None

    payments = []
    for d, amount in last12:
        ex = _plus_years(d, 1)
        status = "erwartet"
        if known_ex and known_ex > today and abs((known_ex - ex).days) <= 45:
            ex, status = known_ex, "angekündigt"
        pay, pay_est = None, False
        if status == "angekündigt" and known_pay and known_pay >= ex:
            pay = known_pay
        elif german:
            pay, pay_est = _add_business_days(ex, 2), True
        payments.append({"ex_date": ex.isoformat(), "pay_date": pay.isoformat() if pay else None,
                         "pay_estimated": pay_est, "status": status, "per_share": amount})
    # Bereits gezahlt, aber Zahltag steht noch aus (Ex-Tag gerade vorbei)
    if known_pay and known_pay >= today and known_ex and known_ex <= today:
        amount = next((a for d, a in reversed(hist) if abs((d - known_ex).days) <= 5), None)
        if amount:
            payments.append({"ex_date": known_ex.isoformat(), "pay_date": known_pay.isoformat(),
                             "pay_estimated": False, "status": "angekündigt", "per_share": amount,
                             "extra": True})

    # Wachstum: jährliche Steigerung der Dividende über die letzten 5 vollen Kalenderjahre
    by_year = {}
    for d, a in hist:
        by_year[d.year] = by_year.get(d.year, 0.0) + a
    growth = None
    y1, y0 = today.year - 1, today.year - 6
    if by_year.get(y1) and by_year.get(y0):
        growth = ((by_year[y1] / by_year[y0]) ** (1 / 5) - 1) * 100

    dps = sum(a for _, a in last12)
    return {"fx": fx, "payments": payments, "dps": dps, "count": len(last12), "growth5": growth}


def build_dividends():
    today = date.today()
    held = [(h, ins) for h, ins in _held() if market.effective_ticker(ins)]
    events = _parallel(lambda x: get_events(market.effective_ticker(x[1]), is_fund(x[1])), held)
    positions, upcoming, total_annual, total_value, total_cost, cost_known = [], [], 0.0, 0.0, 0.0, True
    for (h, ins), ev in zip(held, events):
        plan = _dividend_plan(h, ins, ev, today)
        series = market.eur_series(ins)
        price = series[-1][1] if series else None
        value = price * h["quantity"] if price else None
        fx = plan["fx"]
        dps_eur = plan["dps"] * fx if fx is not None else None
        annual = dps_eur * h["quantity"] if dps_eur is not None else None
        pv = h["purchase_value"] if h["pv_known"] and h["purchase_value"] else None
        # Durchschnittliches Kurswachstum pro Jahr über bis zu 10 Jahre (mindestens 3 Jahre Historie)
        price_growth = growth_years = None
        if series:
            cutoff = (today - timedelta(days=3652)).isoformat()
            first = next(((d, c) for d, c in series if d >= cutoff), None)
            if first and first[1] > 0:
                span = (today - date.fromisoformat(first[0])).days / 365.25
                if span >= 3:
                    price_growth = ((series[-1][1] / first[1]) ** (1 / span) - 1) * 100
                    growth_years = round(span, 1)
        positions.append({
            "isin": h["isin"], "name": h["name"], "quantity": h["quantity"],
            "value": value, "purchase_value": pv, "is_fund": is_fund(ins),
            "price_growth": price_growth, "price_growth_years": growth_years,
            "currency": ins.get("quote_currency"), "dps_eur": dps_eur, "annual_eur": annual,
            "payments_per_year": plan["count"], "growth5": plan["growth5"],
            "yield_current": (annual / value * 100) if (annual is not None and value) else None,
            "yield_cost": (annual / pv * 100) if (annual is not None and pv) else None,
            "fx_missing": fx is None and plan["dps"] > 0,
        })
        if value:
            total_value += value
            if pv is None:
                cost_known = False
            else:
                total_cost += pv
        if annual:
            total_annual += annual
        if fx is None:
            continue
        for p in plan["payments"]:
            upcoming.append({"isin": h["isin"], "name": h["name"], **p,
                             "per_share_eur": p["per_share"] * fx,
                             "amount_eur": p["per_share"] * fx * h["quantity"]})
    upcoming.sort(key=lambda u: u["pay_date"] or u["ex_date"])

    months = []
    for i in range(12):
        m = (today.month - 1 + i) % 12 + 1
        y = today.year + (today.month - 1 + i) // 12
        months.append({"month": f"{y}-{m:02d}", "total": 0.0, "items": []})
    index = {m["month"]: m for m in months}
    for u in upcoming:
        key = (u["pay_date"] or u["ex_date"])[:7]
        if key in index:
            index[key]["total"] += u["amount_eur"]
            index[key]["items"].append({"name": u["name"], "amount": u["amount_eur"]})

    positions.sort(key=lambda p: -(p["annual_eur"] or 0))
    return {
        "positions": positions, "upcoming": upcoming, "months": months,
        "total_annual": total_annual,
        "yield_current": (total_annual / total_value * 100) if total_value else None,
        "yield_cost": (total_annual / total_cost * 100) if (cost_known and total_cost) else None,
    }


# ---------- Kalender ----------

KIND_LABEL = {"earnings": "Zahlen", "hv": "Hauptversammlung", "ex": "Ex-Dividende",
              "pay": "Dividendenzahlung", "other": "Sonstiges"}


def build_calendar():
    today = date.today()
    start, end = today - timedelta(days=365), today + timedelta(days=550)
    held = [(h, ins) for h, ins in _held() if market.effective_ticker(ins)]
    events_raw = _parallel(lambda x: get_events(market.effective_ticker(x[1]), is_fund(x[1])), held)
    manual = db.query("SELECT * FROM events ORDER BY date")
    manual_hv = {(m["isin"], m["date"][:4]) for m in manual if m["kind"] == "hv"}
    names = {h["isin"]: h["name"] for h, _ in _held()}
    out = []

    def add(day, kind, isin, name, detail=None, estimated=False, manual_id=None, title=None):
        if isinstance(day, str):
            day = date.fromisoformat(day)
        if start <= day <= end:
            out.append({"date": day.isoformat(), "kind": kind, "label": KIND_LABEL[kind], "isin": isin,
                        "name": name, "detail": detail, "estimated": estimated, "manual_id": manual_id,
                        "title": title})

    for (h, ins), ev in zip(held, events_raw):
        isin, name = h["isin"], h["name"]
        for e in ev["earnings"]:
            if e["reported"] is not None:
                detail = f"Gewinn je Aktie {e['reported']:.2f}".replace(".", ",")
                if e["estimate"] is not None:
                    detail += f" (erwartet {e['estimate']:.2f})".replace(".", ",")
            elif e["estimate"] is not None:
                detail = f"Erwarteter Gewinn je Aktie {e['estimate']:.2f}".replace(".", ",")
            else:
                detail = None
            add(e["date"], "earnings", isin, name, detail)

        german = _is_german_share(ins)
        hist = [date.fromisoformat(d) for d, _ in ev["dividends"]]
        known_ex = date.fromisoformat(ev["ex_dividend"]) if ev.get("ex_dividend") else None
        ex_dates = {d: False for d in hist if d >= start}
        if known_ex:
            ex_dates[known_ex] = False
        # Erwartete Ex-Tage: Termine der letzten 12 Monate ein Jahr weitergeschoben
        for d in [d for d in hist if today - timedelta(days=365) < d <= today]:
            nxt = _plus_years(d, 1)
            if not any(abs((nxt - k).days) <= 45 for k in ex_dates if k > today):
                ex_dates[nxt] = True
        for d, est in sorted(ex_dates.items()):
            add(d, "ex", isin, name, "aus dem Vorjahr fortgeschrieben" if est else None, est)
            if german:
                # Deutsche Aktien: HV in der Regel am Handelstag vor dem Ex-Tag, Zahlung zwei Handelstage danach
                add(_add_business_days(d, 2), "pay", isin, name, "geschätzt: 2 Handelstage nach Ex-Tag", True)
                hv = _add_business_days(d, -1)
                if (isin, str(hv.year)) not in manual_hv:
                    add(hv, "hv", isin, name,
                        "geschätzt: Handelstag vor dem Ex-Tag" + (" (aus dem Vorjahr fortgeschrieben)" if est else ""), True)
        if ev.get("dividend_date") and not german:
            add(ev["dividend_date"], "pay", isin, name)

    for m in manual:
        add(m["date"], m["kind"] if m["kind"] in KIND_LABEL else "other", m["isin"],
            names.get(m["isin"]) or "Allgemein", "von Hand eingetragen", False, m["id"], m["title"])
    out.sort(key=lambda e: (e["date"], e["name"]))
    return {"events": out, "today": today.isoformat(),
            "positions": sorted(({"isin": h["isin"], "name": h["name"]} for h, _ in _held()), key=lambda p: p["name"])}


# ---------- Nachrichten & Zahlen ----------

def build_news(isin=None, force=False):
    held = [(h, ins) for h, ins in _held() if market.effective_ticker(ins) and (not isin or h["isin"] == isin)]
    lists = _parallel(lambda x: get_news(x[1], force), held)
    items, seen = [], set()
    for (h, _), news in zip(held, lists):
        for n in news[: (40 if isin else 8)]:
            if n["url"] in seen:
                continue
            seen.add(n["url"])
            items.append({**n, "isin": h["isin"], "name": h["name"]})
    items.sort(key=lambda n: n["date"], reverse=True)
    return {"items": items[:120]}


def build_watchlist(force=False):
    """Watchlist mit Kurs, Veränderungen und den neuesten Nachrichten je Wertpapier."""
    rows = db.query("SELECT * FROM watchlist ORDER BY name COLLATE NOCASE")
    inss = [market.watch_ins(r) for r in rows]
    news_lists = _parallel(lambda ins: get_news(ins, force), inss)
    today = date.today()
    items = []
    for row, ins, news in zip(rows, inss, news_lists):
        series = market.eur_series(ins)
        item = {"ticker": row["ticker"], "name": row["name"], "exchange": row["exchange"],
                "type": market.YAHOO_TYPE_DE.get(row["yahoo_type"] or "", "Sonstiges"),
                "currency": row["quote_currency"], "added": row["added"], "note": row.get("note") or "",
                "price": None, "price_date": None, "day_pct": None, "changes": {}, "high52": None, "low52": None,
                "since_added": None, "news": news[:3]}
        if series:
            last_date, last = series[-1]
            item["price"], item["price_date"] = last, last_date
            if len(series) > 1 and series[-2][1]:
                item["day_pct"] = (last / series[-2][1] - 1) * 100

            def change_since(day):
                ref = None
                for d, c in series:
                    if d > day:
                        break
                    ref = c
                return (last / ref - 1) * 100 if ref else None
            item["changes"] = {"1M": change_since((today - timedelta(days=30)).isoformat()),
                               "6M": change_since((today - timedelta(days=182)).isoformat()),
                               "1J": change_since((today - timedelta(days=365)).isoformat())}
            year = [c for d, c in series if d >= (today - timedelta(days=365)).isoformat()]
            if year:
                item["high52"], item["low52"] = max(year), min(year)
            if row["added"]:
                item["since_added"] = change_since(row["added"][:10])
        items.append(item)
    return {"items": items, "prices_refreshed": db.get_kv("prices_refreshed")}


def build_fundamentals(isin, force=False):
    held = {h["isin"]: (h, ins) for h, ins in _held()}
    if isin not in held:
        return None
    h, ins = held[isin]
    ticker = market.effective_ticker(ins)
    if not ticker:
        return {"name": h["name"], "available": False, "reason": "Kein Kurs-Ticker zugeordnet."}
    info = get_info(ticker, force)
    if is_fund(ins):
        return {"name": h["name"], "available": False, "info": info,
                "reason": "Für ETFs und Fonds gibt es keine Unternehmenszahlen."}
    fin = get_financials(ticker, force)
    ev = get_events(ticker, False, force)
    today = date.today().isoformat()
    return {
        "name": h["name"], "available": True, "info": info,
        "currency": info.get("financialCurrency") or info.get("currency"),
        "annual": fin["annual"], "quarterly": fin["quarterly"],
        "next_earnings": next((e for e in ev["earnings"] if e["date"] >= today), None),
        "last_earnings": next((e for e in reversed(ev["earnings"]) if e["date"] < today and e["reported"] is not None), None),
    }
