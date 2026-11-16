"""Lokaler Webserver des Portfoliomanagers (nur von diesem Rechner erreichbar)."""
import csv
import io
import json
import os
import subprocess
import sys
import threading
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import comdirect, db, fundamentals, market

PORT = int(os.environ.get("PORTFOLIO_PORT") or 8765)
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
STATIC_DIR = db.BASE_DIR / "static"

app = FastAPI(title="Portfoliomanager", docs_url=None, redoc_url=None)


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Lässt nur Aufrufe der eigenen Oberfläche zu (Schutz vor fremden Webseiten)."""
    if request.headers.get("host") not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "Nicht erlaubt"}, status_code=403)
    origin = request.headers.get("origin")
    if origin and origin.split("://", 1)[-1] not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "Nicht erlaubt"}, status_code=403)
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(comdirect.ComdirectError)
async def comdirect_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ---------- Depot-Berechnung ----------

def _holdings():
    """Positionen je Wertpapier zusammengefasst (über alle Quellen)."""
    merged = {}
    for p in db.query("SELECT * FROM positions ORDER BY name"):
        h = merged.setdefault(p["isin"], {
            "isin": p["isin"], "wkn": p["wkn"], "name": p["name"], "quantity": 0.0,
            "purchase_value": 0.0, "pv_known": True, "bank_price": p["bank_price"],
            "bank_prev_price": p["bank_prev_price"], "sources": [], "ids": [],
        })
        h["quantity"] += p["quantity"]
        if p["purchase_value"] is None:
            h["pv_known"] = False
        else:
            h["purchase_value"] += p["purchase_value"]
        h["sources"].append(p["source"])
        h["ids"].append(p["id"])
    return merged


def _instruments():
    return {i["isin"]: i for i in db.query("SELECT * FROM instruments")}


def build_overview():
    instruments = _instruments()
    rows, total, total_prev, total_purchase, purchase_complete = [], 0.0, 0.0, 0.0, True
    missing_prices = []
    for h in _holdings().values():
        ins = instruments.get(h["isin"], {})
        series = market.eur_series(ins)
        price = prev = None
        price_date, price_source = None, None
        if series:
            price_date, price = series[-1]
            prev = series[-2][1] if len(series) > 1 else None
            price_source = "Yahoo Finance"
        elif h["bank_price"] is not None:
            price, prev, price_source = h["bank_price"], h["bank_prev_price"], "comdirect (Stand letzter Abruf)"
        else:
            missing_prices.append(h["name"] or h["isin"])
        qty = h["quantity"]
        value = qty * price if price is not None else None
        prev_value = qty * prev if prev is not None else None
        pv = h["purchase_value"] if h["pv_known"] else None
        row = {
            "isin": h["isin"], "wkn": h["wkn"] or ins.get("wkn"),
            "name": h["name"] or ins.get("name") or h["isin"],
            "ticker": market.effective_ticker(ins),
            "type": market.effective_type(ins), "sector": market.effective_sector(ins),
            "quantity": qty, "purchase_price": (pv / qty) if (pv is not None and qty) else None,
            "purchase_value": pv, "price": price, "prev_price": prev, "value": value,
            "day_abs": (value - prev_value) if (value is not None and prev_value is not None) else None,
            "day_pct": ((price / prev - 1) * 100) if (price and prev) else None,
            "pl_abs": (value - pv) if (value is not None and pv is not None) else None,
            "pl_pct": ((value / pv - 1) * 100) if (value is not None and pv) else None,
            "price_date": price_date, "price_source": price_source,
            "sources": sorted(set(h["sources"])),
        }
        rows.append(row)
        if value is not None:
            total += value
            total_prev += prev_value if prev_value is not None else value
            if pv is None:
                purchase_complete = False
            else:
                total_purchase += pv
    for r in rows:
        r["share"] = (r["value"] / total * 100) if (r["value"] is not None and total) else None
    rows.sort(key=lambda r: -(r["value"] or 0))
    return {
        "positions": rows,
        "totals": {
            "value": total,
            "day_abs": total - total_prev,
            "day_pct": ((total / total_prev - 1) * 100) if total_prev else None,
            "purchase_value": total_purchase if purchase_complete else None,
            "pl_abs": (total - total_purchase) if (purchase_complete and rows) else None,
            "pl_pct": ((total / total_purchase - 1) * 100) if (purchase_complete and total_purchase) else None,
            "count": len(rows),
        },
        "missing_prices": missing_prices,
        "prices_refreshed": db.get_kv("prices_refreshed"),
        "last_sync": db.get_kv("comdirect_last_sync"),
        "product_types": market.PRODUCT_TYPES,
    }


RANGES = {"1W": 7, "1M": 31, "6M": 183, "1J": 366, "5J": 5 * 366, "MAX": None}


def _with_averages(series, start, digits):
    """[(datum, wert)] -> [[datum, wert, Ø50, Ø200]] ab start; Durchschnitte über 50 bzw. 200 Handelstage."""
    out, sums, values = [], {50: 0.0, 200: 0.0}, []
    for i, (d, v) in enumerate(series):
        values.append(v)
        row = [d, round(v, digits)]
        for n in (50, 200):
            sums[n] += v
            if i >= n:
                sums[n] -= values[i - n]
            row.append(round(sums[n] / n, digits) if i >= n - 1 else None)
        if d >= start:
            out.append(row)
    return out


def build_history(isin: Optional[str], range_key: str, ticker: Optional[str] = None):
    days = RANGES.get(range_key, 366)
    start = (date.today() - timedelta(days=days)).isoformat() if days else "0000-00-00"
    # Für die 200-Tage-Linie werden Werte vor dem gewählten Zeitraum gebraucht
    calc_start = (date.today() - timedelta(days=days + 320)).isoformat() if days else "0000-00-00"
    instruments = _instruments()
    holdings = _holdings()

    if ticker:  # Wertpapier der Watchlist
        rows = db.query("SELECT * FROM watchlist WHERE ticker=?", (ticker,))
        if not rows:
            raise HTTPException(404, "Wertpapier nicht in der Watchlist")
        pts = _with_averages(market.eur_series(market.watch_ins(rows[0])), start, 4)
        return {"points": pts, "unit": "Kurs je Stück in EUR", "estimated": False}

    if isin:  # Kursverlauf einer einzelnen Position (Kurs je Stück)
        ins = instruments.get(isin)
        if not ins:
            raise HTTPException(404, "Wertpapier nicht gefunden")
        pts = _with_averages(market.eur_series(ins), start, 4)
        return {"points": pts, "unit": "Kurs je Stück in EUR", "estimated": False}

    # Depotverlauf: Bestand je Tag = heutiger Bestand minus spätere Umsätze
    txs = {}
    for t in db.query("SELECT isin, date, quantity FROM transactions ORDER BY date"):
        txs.setdefault(t["isin"], []).append((t["date"], t["quantity"]))
    items, all_dates, estimated = [], set(), False
    for h in holdings.values():
        series = market.eur_series(instruments.get(h["isin"], {}))
        if not series:
            continue
        tx = txs.get(h["isin"], [])
        before_first = h["quantity"] - sum(q for _, q in tx)
        if before_first > 1e-6:
            estimated = True
        items.append((h, series, tx))
        all_dates.update(d for d, _ in series if d >= calc_start)
    points = []
    cursors = [{"i": 0, "price": None} for _ in items]
    for d in sorted(all_dates):
        total, complete = 0.0, True
        for (h, series, tx), cur in zip(items, cursors):
            while cur["i"] < len(series) and series[cur["i"]][0] <= d:
                cur["price"] = series[cur["i"]][1]
                cur["i"] += 1
            qty = max(0.0, h["quantity"] - sum(q for td, q in tx if td > d))
            if qty <= 1e-9:
                continue
            if cur["price"] is None:
                complete = False
                break
            total += qty * cur["price"]
        if complete and total > 0:
            points.append((d, total))
    points = _with_averages(points, start, 2)
    return {"points": points, "unit": "Depotwert in EUR", "estimated": estimated,
            "missing": [h["name"] for h in holdings.values()
                        if not market.eur_series(instruments.get(h["isin"], {}))]}


# ---------- API: Depot ----------

@app.get("/api/overview")
def api_overview(refresh: int = 0):
    error = None
    try:
        market.refresh(force=bool(refresh))
    except Exception as e:  # ohne Netz mit den letzten gespeicherten Kursen weiterarbeiten
        error = f"Kurse konnten nicht aktualisiert werden ({e}). Es werden die zuletzt gespeicherten Daten gezeigt."
    data = build_overview()
    data["refresh_error"] = error
    return data


@app.get("/api/history")
def api_history(isin: Optional[str] = None, range: str = "1J", ticker: Optional[str] = None):
    return build_history(isin or None, range, ticker or None)


# ---------- API: Watchlist ----------

class WatchBody(BaseModel):
    symbol: str
    name: Optional[str] = None
    type: Optional[str] = None


@app.get("/api/watchlist/search")
def api_watch_search(q: str):
    return {"results": market.search(q)}


@app.get("/api/watchlist/names")
def api_watch_names():
    return db.query("SELECT ticker, name FROM watchlist ORDER BY name COLLATE NOCASE")


@app.get("/api/watchlist")
def api_watchlist(refresh: int = 0):
    try:
        market.refresh(force=bool(refresh))
    except Exception:
        pass  # ohne Netz mit gespeicherten Kursen weiterarbeiten
    return fundamentals.build_watchlist(bool(refresh))


@app.post("/api/watchlist")
def api_watch_add(body: WatchBody):
    symbol = body.symbol.strip()
    if not symbol:
        raise HTTPException(400, "Bitte ein Wertpapier auswählen.")
    if db.query("SELECT 1 FROM watchlist WHERE ticker=?", (symbol,)):
        raise HTTPException(400, "Dieses Wertpapier steht schon auf der Watchlist.")
    if not market.add_watch(symbol, body.name, body.type):
        raise HTTPException(400, "Zu diesem Wertpapier liefert Yahoo Finance keine Kursdaten.")
    return {"ok": True}


class WatchNote(BaseModel):
    symbol: str
    note: Optional[str] = None


@app.put("/api/watchlist/note")
def api_watch_note(body: WatchNote):
    cur = db.execute("UPDATE watchlist SET note=? WHERE ticker=?",
                     ((body.note or "").strip()[:5000] or None, body.symbol))
    if cur.rowcount == 0:
        raise HTTPException(404, "Wertpapier nicht in der Watchlist")
    return {"ok": True}


@app.delete("/api/watchlist/{symbol}")
def api_watch_delete(symbol: str):
    db.execute("DELETE FROM watchlist WHERE ticker=?", (symbol,))
    return {"ok": True}


# ---------- API: Nachrichten, Zahlen, Dividenden, Kalender ----------

@app.get("/api/news")
def api_news(isin: Optional[str] = None, refresh: int = 0):
    return fundamentals.build_news(isin or None, bool(refresh))


@app.get("/api/fundamentals")
def api_fundamentals(isin: str, refresh: int = 0):
    data = fundamentals.build_fundamentals(isin, bool(refresh))
    if data is None:
        raise HTTPException(404, "Wertpapier nicht gefunden")
    return data


@app.get("/api/dividends")
def api_dividends():
    return fundamentals.build_dividends()


@app.get("/api/calendar")
def api_calendar():
    return fundamentals.build_calendar()


class EventBody(BaseModel):
    isin: Optional[str] = None
    date: str
    kind: str
    title: Optional[str] = None


@app.post("/api/events")
def api_event_add(body: EventBody):
    try:
        day = date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(400, "Bitte ein gültiges Datum angeben.")
    if body.kind not in fundamentals.KIND_LABEL:
        raise HTTPException(400, "Unbekannte Terminart.")
    db.execute("INSERT INTO events(isin,date,kind,title) VALUES(?,?,?,?)",
               ((body.isin or "").strip() or None, day.isoformat(), body.kind, (body.title or "").strip() or None))
    return {"ok": True}


@app.delete("/api/events/{event_id}")
def api_event_delete(event_id: int):
    db.execute("DELETE FROM events WHERE id=?", (event_id,))
    return {"ok": True}


# ---------- API: Annahmen für Simulationen und Sparplan ----------

SIM_DEFAULTS = {
    "scenarios": {
        "vorsichtig": {"price": 3.0, "dividend": 1.0},
        "mittel": {"price": 6.0, "dividend": 3.0},
        "optimistisch": {"price": 8.0, "dividend": 5.0},
    },
    "inflation_on": False, "inflation": 2.0,
    "tax_on": False, "tax_rate": 26.375, "allowance": 1000.0, "fund_exemption_on": True,
}
PLAN_DEFAULTS = {"rate": 200.0, "years": 15, "dynamic": 0.0, "include_depot": True, "reinvest": True,
                 "growth_mode": "scenario", "scenario": "mittel", "shares": {}}


def _load_json(key, defaults):
    try:
        stored = json.loads(db.get_kv(key) or "{}")
    except ValueError:
        stored = {}
    merged = {**defaults, **{k: v for k, v in stored.items() if k in defaults}}
    if "scenarios" in defaults:
        merged["scenarios"] = {name: {**vals, **(stored.get("scenarios", {}).get(name) or {})}
                               for name, vals in defaults["scenarios"].items()}
    return merged


@app.get("/api/sim")
def api_sim_get():
    return {"settings": _load_json("sim_settings", SIM_DEFAULTS), "plan": _load_json("sparplan", PLAN_DEFAULTS)}


@app.put("/api/sim/settings")
def api_sim_settings(body: dict):
    db.set_kv("sim_settings", json.dumps({k: body[k] for k in SIM_DEFAULTS if k in body}))
    return _load_json("sim_settings", SIM_DEFAULTS)


@app.put("/api/sim/plan")
def api_sim_plan(body: dict):
    db.set_kv("sparplan", json.dumps({k: body[k] for k in PLAN_DEFAULTS if k in body}))
    return _load_json("sparplan", PLAN_DEFAULTS)


# ---------- API: comdirect ----------

class Credentials(BaseModel):
    client_id: str
    client_secret: str
    username: str
    pin: Optional[str] = None


class LoginBody(BaseModel):
    pin: Optional[str] = None


class TanBody(BaseModel):
    tan: Optional[str] = None


@app.get("/api/comdirect/status")
def cd_status():
    s = comdirect.credentials_status()
    s["session_active"] = comdirect.session_active()
    s["session_expires_at"] = comdirect.session_expires_at()
    s["last_sync"] = db.get_kv("comdirect_last_sync")
    return s


@app.post("/api/comdirect/credentials")
def cd_credentials(body: Credentials):
    if not (body.client_id.strip() and body.client_secret.strip() and body.username.strip()):
        raise HTTPException(400, "Bitte client_id, client_secret und Zugangsnummer ausfüllen.")
    comdirect.save_credentials(body.client_id, body.client_secret, body.username, body.pin or None)
    return cd_status()


@app.delete("/api/comdirect/credentials")
def cd_credentials_delete():
    comdirect.logout()
    comdirect.delete_credentials()
    return cd_status()


@app.post("/api/comdirect/login")
def cd_login(body: LoginBody):
    return comdirect.start_login(body.pin or None)


@app.post("/api/comdirect/confirm")
def cd_confirm(body: TanBody):
    if not comdirect.session_active():
        comdirect.confirm_login(body.tan or None)
    return comdirect.sync()


@app.post("/api/comdirect/sync")
def cd_sync():
    return comdirect.sync()


@app.post("/api/comdirect/logout")
def cd_logout():
    comdirect.logout()
    return cd_status()


# ---------- API: Einstellungen ----------

class InstrumentPatch(BaseModel):
    ticker_manual: Optional[str] = None
    type_manual: Optional[str] = None
    sector_manual: Optional[str] = None


@app.get("/api/instruments")
def api_instruments():
    rows = db.query("SELECT * FROM instruments WHERE isin IN (SELECT isin FROM positions) ORDER BY name")
    for r in rows:
        r["effective_ticker"] = market.effective_ticker(r)
        r["effective_type"] = market.effective_type(r)
        r["effective_sector"] = market.effective_sector(r)
    return {"instruments": rows, "product_types": market.PRODUCT_TYPES,
            "sectors": sorted(set(market.SECTOR_DE.values()))}


@app.put("/api/instruments/{isin}")
def api_instrument_update(isin: str, body: InstrumentPatch):
    rows = db.query("SELECT * FROM instruments WHERE isin=?", (isin,))
    if not rows:
        raise HTTPException(404, "Wertpapier nicht gefunden")
    clean = lambda v: (v or "").strip() or None
    ticker_changed = clean(body.ticker_manual) != rows[0].get("ticker_manual")
    db.execute("UPDATE instruments SET ticker_manual=?, type_manual=?, sector_manual=? WHERE isin=?",
               (clean(body.ticker_manual), clean(body.type_manual), clean(body.sector_manual), isin))
    if ticker_changed:
        db.execute("UPDATE instruments SET quote_currency=NULL, meta_updated=NULL WHERE isin=?", (isin,))
        market.resolve_instrument(isin, force=not clean(body.ticker_manual))
        market.refresh(force=True)
    return {"ok": True}


class ManualPosition(BaseModel):
    isin: str
    name: Optional[str] = None
    quantity: float
    purchase_price: Optional[float] = None


@app.post("/api/positions")
def api_position_add(body: ManualPosition):
    isin = body.isin.strip().upper()
    if not isin or body.quantity <= 0:
        raise HTTPException(400, "Bitte ISIN und eine Stückzahl größer 0 angeben.")
    db.upsert_instrument(isin, None, (body.name or "").strip() or None, None)
    pv = body.purchase_price * body.quantity if body.purchase_price else None
    db.execute(
        "INSERT INTO positions(source,isin,name,quantity,purchase_price,purchase_value,updated) "
        "VALUES('manual',?,?,?,?,?,?)",
        (isin, (body.name or "").strip() or isin, body.quantity, body.purchase_price, pv,
         datetime.now().isoformat(timespec="seconds")))
    market.resolve_instrument(isin)
    ins = db.query("SELECT * FROM instruments WHERE isin=?", (isin,))[0]
    if not (body.name or "").strip() and ins.get("name"):
        db.execute("UPDATE positions SET name=? WHERE isin=? AND source='manual'", (ins["name"], isin))
    return {"ok": True, "ticker_found": bool(market.effective_ticker(ins))}


@app.get("/api/positions/manual")
def api_positions_manual():
    return db.query("SELECT * FROM positions WHERE source IN ('manual','csv') ORDER BY name")


@app.delete("/api/positions/{pos_id}")
def api_position_delete(pos_id: int):
    db.execute("DELETE FROM positions WHERE id=? AND source IN ('manual','csv')", (pos_id,))
    return {"ok": True}


# ---------- API: CSV-Import (Ausweichweg) ----------

def _de_num(text):
    text = (text or "").strip().replace("\xa0", "").replace("EUR", "").replace("%", "").strip()
    if not text or text in ("-", "--"):
        return None
    try:
        return float(text.replace(".", "").replace(",", "."))
    except ValueError:
        return None


def _col(header, *needles):
    for i, h in enumerate(header):
        hl = h.lower()
        if any(n in hl for n in needles):
            return i
    return None


@app.post("/api/import/csv")
async def api_import_csv(file: UploadFile = File(...)):
    raw = await file.read()
    for enc in ("utf-8-sig", "cp1252"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    lines = list(csv.reader(io.StringIO(text), delimiter=";", quotechar='"'))
    head_idx = next((i for i, l in enumerate(lines)
                     if any(c.strip().lower() in ("wkn", "isin") for c in l)), None)
    if head_idx is None:
        raise HTTPException(400, "In der Datei wurde keine Kopfzeile mit WKN oder ISIN gefunden.")
    header = [c.strip() for c in lines[head_idx]]
    c_isin, c_wkn = _col(header, "isin"), _col(header, "wkn")
    c_name = _col(header, "bezeichnung", "name", "wertpapier")
    c_qty = _col(header, "stück", "stueck", "stk", "nominal", "bestand", "anzahl")
    c_buy = _col(header, "kaufkurs", "einstandskurs", "einstiegskurs")
    c_buyval = _col(header, "kaufwert", "einstandswert")
    c_price = _col(header, "akt. kurs", "aktueller kurs", "kurs")
    if c_qty is None:
        raise HTTPException(400, f"Keine Spalte mit der Stückzahl gefunden. Spalten: {', '.join(header)}")
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    get = lambda l, i: l[i].strip() if (i is not None and i < len(l)) else ""
    for l in lines[head_idx + 1:]:
        key = get(l, c_isin) or get(l, c_wkn)
        qty = _de_num(get(l, c_qty))
        if not key or not qty:
            continue
        buy = _de_num(get(l, c_buy))
        buyval = _de_num(get(l, c_buyval)) or (buy * qty if buy else None)
        price = _de_num(get(l, c_price)) if c_price not in (c_buy, None) else None
        db.upsert_instrument(key, get(l, c_wkn) or None, get(l, c_name) or None, None)
        rows.append({"source": "csv", "isin": key, "wkn": get(l, c_wkn) or None,
                     "name": get(l, c_name) or key, "quantity": qty,
                     "purchase_price": buy or (buyval / qty if buyval else None),
                     "purchase_value": buyval, "bank_price": price, "bank_prev_price": None,
                     "bank_value": price * qty if price else None, "updated": now})
    if not rows:
        raise HTTPException(400, "Die Datei enthält keine lesbaren Positionen.")
    db.replace_positions("csv", rows)
    return {"positions": len(rows), "columns": header}


# ---------- Versionsabgleich und Neustart ----------
# Die Oberfläche wird bei jedem Laden frisch gelesen, der Server-Teil nur beim Start.
# Nach einer Aktualisierung des Programms merkt die Oberfläche so, dass ein Neustart nötig ist.

def _build_stamp():
    return max(p.stat().st_mtime for p in (db.BASE_DIR / "app").glob("*.py"))


STARTED_BUILD = _build_stamp()


@app.get("/api/version")
def api_version():
    return {"started": STARTED_BUILD, "current": _build_stamp()}


@app.post("/api/restart")
def api_restart():
    comdirect.logout()
    # Neuer Prozess wartet, bis dieser beendet ist, und übernimmt dann den Port
    subprocess.Popen([sys.executable, str(db.BASE_DIR / "run.py"), "--no-browser", "--wait"],
                     cwd=str(db.BASE_DIR), close_fds=True,
                     creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
                     | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return {"ok": True}


# ---------- Programm beenden / Oberfläche ----------

@app.post("/api/shutdown")
def api_shutdown():
    comdirect.logout()
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
