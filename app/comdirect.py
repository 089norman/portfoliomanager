"""Nur lesende Anbindung an das comdirect REST API.

Ablauf laut Schnittstellenspezifikation (Kapitel 2):
  1. OAuth-Token mit Zugangsnummer + PIN
  2. Session-Objekt abrufen
  3. TAN-Challenge anfordern (validate)
  4. Session-TAN aktivieren (PATCH) - nach Freigabe in der photoTAN-App bzw. mit TAN
  5. cd_secondary-Token holen -> Zugriff auf Depotdaten

Es werden ausschließlich lesende Depot-Schnittstellen verwendet, keine Order-Funktionen.
Zugangsdaten liegen in der Windows-Anmeldeinformationsverwaltung, Tokens nur im Arbeitsspeicher.
"""
import json
import atexit
import secrets
import threading
import time
from datetime import datetime

import keyring
import requests

from . import db

OAUTH_URL = "https://api.comdirect.de/oauth/token"
REVOKE_URL = "https://api.comdirect.de/oauth/revoke"
API = "https://api.comdirect.de/api"
KEYRING_SERVICE = "Portfoliomanager-comdirect"
TIMEOUT = 30

TYPE_LABELS = {
    "SHARE": "Einzelaktie",
    "ETF": "ETF",
    "FUND": "Fonds",
    "BONDS": "Anleihe",
    "CERTIFICATE": "Zertifikat",
    "WARRANT": "Optionsschein",
    "SUBSCRIPTION_RIGHT": "Bezugsrecht",
    "PROFIT_PART_CERTIFICATE": "Genussschein",
}


class ComdirectError(Exception):
    pass


# ---------- Zugangsdaten ----------

def _get(name):
    return keyring.get_password(KEYRING_SERVICE, name)


def save_credentials(client_id, client_secret, username, pin=None):
    keyring.set_password(KEYRING_SERVICE, "client_id", client_id.strip())
    keyring.set_password(KEYRING_SERVICE, "client_secret", client_secret.strip())
    keyring.set_password(KEYRING_SERVICE, "username", username.strip())
    if pin:
        keyring.set_password(KEYRING_SERVICE, "pin", pin)
    else:
        _delete("pin")


def _delete(name):
    try:
        keyring.delete_password(KEYRING_SERVICE, name)
    except Exception:
        pass


def delete_credentials():
    for name in ("client_id", "client_secret", "username", "pin"):
        _delete(name)


def credentials_status():
    return {
        "configured": bool(_get("client_id") and _get("client_secret") and _get("username")),
        "pin_saved": bool(_get("pin")),
    }


# ---------- Sitzung (nur im Arbeitsspeicher) ----------

_state = {
    "session_id": None,      # eigene Client-Session-Id für x-http-request-info
    "access_token": None,
    "refresh_token": None,
    "expires_at": 0,
    "cd_session": None,      # identifier des Session-Objekts
    "challenge": None,       # {"id":..., "typ":...}
    "authenticated": False,
}


def _request_info():
    return json.dumps({
        "clientRequestId": {
            "sessionId": _state["session_id"],
            "requestId": datetime.now().strftime("%H%M%S%f")[:9],
        }
    })


def _headers(extra=None):
    h = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {_state['access_token']}",
        "x-http-request-info": _request_info(),
    }
    if extra:
        h.update(extra)
    return h


def _error_text(resp):
    try:
        data = resp.json()
        if isinstance(data, dict):
            if data.get("error_description"):
                return data["error_description"]
            msgs = data.get("messages") or []
            if msgs:
                return "; ".join(m.get("message", "") for m in msgs if isinstance(m, dict))
            if data.get("code"):
                return str(data["code"])
    except Exception:
        pass
    return f"HTTP {resp.status_code}"


def session_active():
    return bool(_state["authenticated"] and _state["refresh_token"])


def session_expires_at():
    """Zeitpunkt des automatischen Sitzungsendes (Unix-Zeit) oder None."""
    return _state.get("auto_logout_at") if session_active() else None


def start_login(pin=None):
    """Schritte 1-3. Gibt Art der TAN-Freigabe zurück."""
    client_id, client_secret, username = _get("client_id"), _get("client_secret"), _get("username")
    pin = pin or _get("pin")
    if not (client_id and client_secret and username):
        raise ComdirectError("Zugangsdaten fehlen. Bitte zuerst in den Einstellungen eintragen.")
    if not pin:
        raise ComdirectError("PIN fehlt.")

    _state.update(session_id=secrets.token_hex(16), authenticated=False, challenge=None)

    r = requests.post(OAUTH_URL, timeout=TIMEOUT, headers={"Accept": "application/json"}, data={
        "client_id": client_id, "client_secret": client_secret,
        "grant_type": "password", "username": username, "password": pin,
    })
    if r.status_code != 200:
        raise ComdirectError(f"Anmeldung abgelehnt: {_error_text(r)}. Bitte Zugangsnummer, PIN, "
                             "client_id und client_secret prüfen.")
    tok = r.json()
    _state["access_token"] = tok["access_token"]
    _state["refresh_token"] = tok.get("refresh_token")

    r = requests.get(f"{API}/session/clients/user/v1/sessions", headers=_headers(), timeout=TIMEOUT)
    if r.status_code != 200:
        raise ComdirectError(f"Session konnte nicht abgerufen werden: {_error_text(r)}")
    _state["cd_session"] = r.json()[0]["identifier"]

    body = {"identifier": _state["cd_session"], "sessionTanActive": True, "activated2FA": True}
    r = requests.post(f"{API}/session/clients/user/v1/sessions/{_state['cd_session']}/validate",
                      headers=_headers(), json=body, timeout=TIMEOUT)
    if r.status_code not in (200, 201):
        raise ComdirectError(f"TAN-Anforderung fehlgeschlagen: {_error_text(r)}")
    info = json.loads(r.headers.get("x-once-authentication-info", "{}"))
    if not info.get("id"):
        raise ComdirectError("Die Bank hat keine TAN-Anforderung geliefert.")
    _state["challenge"] = {"id": info["id"], "typ": info.get("typ")}
    return {
        "tan_type": info.get("typ"),                       # P_TAN_PUSH | P_TAN | M_TAN
        "challenge": info.get("challenge"),                # PNG (Base64) bei P_TAN, Telefonnr. bei M_TAN
    }


def confirm_login(tan=None):
    """Schritte 4-5. Bei photoTAN-Push ohne TAN, sonst mit eingegebener TAN."""
    ch = _state.get("challenge")
    if not ch:
        raise ComdirectError("Keine offene TAN-Anforderung. Bitte Anmeldung neu starten.")
    extra = {"x-once-authentication-info": json.dumps({"id": ch["id"]})}
    if ch["typ"] != "P_TAN_PUSH":
        if not tan:
            raise ComdirectError("Bitte die TAN eingeben.")
        extra["x-once-authentication"] = tan.strip()
    body = {"identifier": _state["cd_session"], "sessionTanActive": True, "activated2FA": True}
    r = requests.patch(f"{API}/session/clients/user/v1/sessions/{_state['cd_session']}",
                       headers=_headers(extra), json=body, timeout=TIMEOUT)
    if r.status_code != 200:
        if ch["typ"] == "P_TAN_PUSH":
            raise ComdirectError(f"Freigabe noch nicht bestätigt: {_error_text(r)}. Bitte erst in der "
                                 "photoTAN-App freigeben und dann erneut bestätigen.")
        _state["challenge"] = None  # eine eingegebene TAN ist verbraucht - kein zweiter Versuch damit
        raise ComdirectError(f"TAN nicht akzeptiert: {_error_text(r)}. Bitte die Anmeldung neu starten.")
    _state["challenge"] = None

    r = requests.post(OAUTH_URL, timeout=TIMEOUT, headers={"Accept": "application/json"}, data={
        "client_id": _get("client_id"), "client_secret": _get("client_secret"),
        "grant_type": "cd_secondary", "token": _state["access_token"],
    })
    if r.status_code != 200:
        raise ComdirectError(f"Depot-Zugriff nicht erteilt: {_error_text(r)}")
    _store_token(r.json())
    _state["authenticated"] = True
    _schedule_auto_logout()


def _store_token(tok):
    _state["access_token"] = tok["access_token"]
    _state["refresh_token"] = tok.get("refresh_token")
    _state["expires_at"] = time.time() + int(tok.get("expires_in", 599)) - 30


def _ensure_token():
    if not session_active():
        raise ComdirectError("Nicht angemeldet.")
    if time.time() < _state["expires_at"]:
        return
    r = requests.post(OAUTH_URL, timeout=TIMEOUT, headers={"Accept": "application/json"}, data={
        "client_id": _get("client_id"), "client_secret": _get("client_secret"),
        "grant_type": "refresh_token", "refresh_token": _state["refresh_token"],
    })
    if r.status_code != 200:
        _state.update(authenticated=False, access_token=None, refresh_token=None)
        raise ComdirectError("Die Sitzung ist abgelaufen. Bitte neu anmelden.")
    _store_token(r.json())


AUTO_LOGOUT_MINUTES = 10
_logout_timer = None


def _schedule_auto_logout():
    """Beendet die Sitzung von selbst, wenn sie eine Weile nicht mehr gebraucht wurde."""
    global _logout_timer
    if _logout_timer:
        _logout_timer.cancel()
    _state["auto_logout_at"] = time.time() + AUTO_LOGOUT_MINUTES * 60
    _logout_timer = threading.Timer(AUTO_LOGOUT_MINUTES * 60, logout)
    _logout_timer.daemon = True
    _logout_timer.start()


def logout():
    global _logout_timer
    if _logout_timer:
        _logout_timer.cancel()
        _logout_timer = None
    if _state.get("access_token"):
        try:
            requests.delete(REVOKE_URL, timeout=TIMEOUT, headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {_state['access_token']}",
            })
        except Exception:
            pass
    _state.update(access_token=None, refresh_token=None, authenticated=False, challenge=None)


atexit.register(logout)  # auch bei anderem regulären Programmende die Sitzung bei der Bank beenden


def _api_get(path, params=None):
    _ensure_token()
    r = requests.get(f"{API}{path}", headers=_headers(), params=params, timeout=TIMEOUT)
    if r.status_code != 200:
        raise ComdirectError(f"Abruf fehlgeschlagen ({path.split('/')[-1]}): {_error_text(r)}")
    return r.json()


def _api_get_all(path, params=None):
    """Liest alle Seiten einer Listen-Ressource."""
    params = dict(params or {})
    values, index = [], 0
    while True:
        params.update({"paging-first": index, "paging-count": 500})
        data = _api_get(path, params)
        page = data.get("values") or []
        values.extend(page)
        matches = (data.get("paging") or {}).get("matches", len(values))
        index += len(page)
        if not page or index >= matches:
            return values


# ---------- Depot einlesen ----------

def _num(amount):
    """AmountValue {"value": "12.5", "unit": "EUR"} -> float oder None."""
    try:
        return float(amount["value"])
    except Exception:
        return None


def _price(p):
    try:
        return float(p["price"]["value"])
    except Exception:
        return None


def sync():
    """Liest Positionen und Umsätze aller Depots und speichert sie lokal."""
    depots = _api_get("/brokerage/clients/user/v3/depots").get("values") or []
    if not depots:
        raise ComdirectError("Kein Depot gefunden.")
    now = datetime.now().isoformat(timespec="seconds")
    merged = {}
    tx_rows = []
    tx_note = None

    for depot in depots:
        depot_id = depot["depotId"]
        for p in _api_get_all(f"/brokerage/v3/depots/{depot_id}/positions", {"with-attr": "instrument"}):
            ins = p.get("instrument") or {}
            isin = ins.get("isin") or p.get("wkn")
            if not isin:
                continue
            static = ins.get("staticData") or {}
            db.upsert_instrument(isin, ins.get("wkn") or p.get("wkn"), ins.get("name") or ins.get("shortName"),
                                 TYPE_LABELS.get(static.get("instrumentType")))
            qty = _num(p.get("quantity")) or 0.0
            row = merged.setdefault(isin, {
                "source": "comdirect", "isin": isin, "wkn": ins.get("wkn") or p.get("wkn"),
                "name": ins.get("name") or ins.get("shortName") or isin,
                "quantity": 0.0, "purchase_value": 0.0, "bank_value": 0.0,
                "bank_price": _price(p.get("currentPrice")),
                "bank_prev_price": _price(p.get("prevDayPrice")),
                "purchase_price": None, "updated": now, "_pv_ok": True,
            })
            row["quantity"] += qty
            pv = _num(p.get("purchaseValue"))
            if pv is None:
                row["_pv_ok"] = False
            else:
                row["purchase_value"] += pv
            row["bank_value"] += _num(p.get("currentValue")) or 0.0

        # Umsätze: möglichst weit zurück; die Bank liefert ggf. nur einen begrenzten Zeitraum.
        txs = None
        for min_date in ("2000-01-01", "-3650d", None):
            try:
                params = {"min-bookingDate": min_date} if min_date else {}
                txs = _api_get_all(f"/brokerage/v3/depots/{depot_id}/transactions", params)
                break
            except ComdirectError as e:
                tx_note = str(e)
        for t in txs or []:
            if t.get("bookingStatus") == "NOTBOOKED":
                continue
            ins = t.get("instrument") or {}
            isin = ins.get("isin")
            qty = _num(t.get("quantity"))
            date = (t.get("businessDate") or t.get("bookingDate") or "")[:10]
            if not (isin and qty and date):
                continue
            direction = t.get("transactionDirection")
            ttype = t.get("transactionType")
            sign = -1 if (direction == "OUT" or ttype in ("SELL", "TRANSFER_OUT")) else 1
            tx_rows.append((t.get("transactionId") or f"{isin}-{date}-{qty}-{ttype}", "comdirect", isin, date,
                            sign * abs(qty), _num(t.get("executionPrice")), _num(t.get("transactionValue")), ttype))

    rows = []
    for row in merged.values():
        if row.pop("_pv_ok") and row["quantity"]:
            row["purchase_price"] = row["purchase_value"] / row["quantity"]
        else:
            row["purchase_value"] = None
        rows.append(row)
    db.replace_positions("comdirect", rows)
    db.execute("DELETE FROM transactions WHERE source='comdirect'")
    db.executemany("INSERT OR REPLACE INTO transactions(id,source,isin,date,quantity,price,value,type) "
                   "VALUES(?,?,?,?,?,?,?,?)", tx_rows)
    db.set_kv("comdirect_last_sync", now)
    _schedule_auto_logout()
    return {"positions": len(rows), "transactions": len(tx_rows), "note": tx_note if txs is None else None}
