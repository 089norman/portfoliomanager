"""Startet den Portfoliomanager und öffnet ihn im Browser.

Läuft das Programm bereits, wird nur die Oberfläche im Browser geöffnet.
"""
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

BASE = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORTFOLIO_PORT") or 8765)  # abweichender Port nur für Testläufe
URL = f"http://127.0.0.1:{PORT}/"


def already_running():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def main():
    if "--wait" in sys.argv:
        # Neustart aus dem Programm heraus: warten, bis der alte Prozess den Port freigegeben hat
        for _ in range(60):
            if not already_running():
                break
            time.sleep(0.25)
    if already_running():
        webbrowser.open(URL)
        return
    # Ohne Konsolenfenster (pythonw) gibt es keine Ausgabe - Meldungen in eine Protokolldatei schreiben.
    (BASE / "data").mkdir(exist_ok=True)
    if sys.stdout is None or sys.stderr is None:
        log = open(BASE / "data" / "portfoliomanager.log", "w", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log

    import uvicorn
    if "--no-browser" not in sys.argv:
        def open_when_ready():
            # Der erste Start kann einige Sekunden dauern - Browser erst öffnen, wenn der Server antwortet.
            for _ in range(240):
                if already_running():
                    break
                time.sleep(0.25)
            webbrowser.open(URL)
        threading.Thread(target=open_when_ready, daemon=True).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT, log_level="warning", access_log=False)


if __name__ == "__main__":
    sys.path.insert(0, str(BASE))
    main()
