# Portfoliomanager

Lokales Programm für dein comdirect-Depot. Es läuft nur auf diesem Rechner und öffnet sich im Browser unter `http://127.0.0.1:8765/`.

## Starten und beenden

- **Starten:** Doppelklick auf die Desktop-Verknüpfung „Portfoliomanager“ (oder auf `Portfoliomanager starten.bat` in diesem Ordner).
- Das Programm läuft im Hintergrund weiter, auch wenn der Browser geschlossen wird. Ein erneuter Doppelklick öffnet nur die Oberfläche.
- **Beenden:** Einstellungen → „Programm beenden“.

## Startbildschirm und Sitzung

- Beim Öffnen erscheint der Startbildschirm. Er zeigt, ob eine comdirect-Sitzung aktiv ist, und führt zur Anmeldung. Ein Klick auf „Portfoliomanager“ oben links bringt dich jederzeit dorthin zurück.
- Unten links steht der Sitzungsstatus, darunter der Knopf „Sitzung beenden“.
- Endet die Sitzung (von Hand oder automatisch nach 10 Minuten), erscheint eine Abschiedsseite. Das Programm und deine gespeicherten Daten bleiben dabei verfügbar.

## Depot von comdirect abrufen

1. Einstellungen → „comdirect-Zugang“: `client_id`, `client_secret` und Zugangsnummer eintragen und speichern. Die PIN kannst du mitspeichern oder bei jedem Abruf eingeben.
2. Oben rechts „Depot abrufen“ klicken und die Anmeldung in der photoTAN-App freigeben.
3. Solange das Programm läuft, bleibt die Sitzung eine Weile aktiv; danach ist beim nächsten Abruf wieder eine Freigabe nötig.

Die Zugangsdaten liegen in der Windows-Anmeldeinformationsverwaltung (Eintrag „Portfoliomanager-comdirect“), nicht in diesem Ordner. Das Programm nutzt nur lesende Depot-Schnittstellen und kann keine Orders aufgeben.

Wichtig: comdirect sperrt den Zugang nach drei falschen TAN-Eingaben bzw. nach fünf angeforderten, aber nicht bestätigten TAN-Freigaben. Deshalb eine angefangene Anmeldung bitte abschließen und nicht mehrfach hintereinander neu starten.

## Kurse

Kurse, Branchen und Produktarten kommen kostenlos von Yahoo Finance und werden lokal zwischengespeichert. Passt eine automatische Zuordnung nicht, lässt sie sich unter Einstellungen → „Wertpapier-Zuordnung“ überschreiben. Fremdwährungskurse werden in Euro umgerechnet. Die Kurse können zeitverzögert sein.

## Daten und Sicherung

- Alle Daten liegen in `data\portfolio.db`. Für eine Sicherung diese Datei kopieren (Programm vorher beenden).
- `data\portfoliomanager.log` enthält Fehlermeldungen des letzten Starts.

## Stand

Phase 1: Übersicht, Kurse, Aufteilung, comdirect-Abruf, heller/dunkler Modus.
Phase 2: Nachrichten und Zahlen, Kalender, Dividenden.
Phase 3: Sparplan-Simulator, Zukunftssimulation für Dividenden, einstellbare Annahmen.

## Watchlist und Durchschnittslinien

- Im Tab „Watchlist“ beobachtest du Wertpapiere, die nicht im Depot liegen. Suche nach Name, ISIN, WKN oder Ticker; deutsche Handelsplätze stehen in den Treffern vorn. Je Wertpapier werden Kurs, Entwicklung und die drei neuesten Nachrichten gezeigt.
- Watchlist-Werte lassen sich auch im Tab „Kurse“ auswählen.
- Im Tab „Kurse“ schaltest du die 50- und die 200-Tage-Linie einzeln zu und ab (Durchschnitt der Schlusskurse der letzten 50 bzw. 200 Handelstage). Die Auswahl wird gemerkt.

## Hinweise zu Phase 3

- Sparplan und Dividendenrechner sind Hochrechnungen mit gleichmäßigem Wachstum, keine Prognosen.
- Die Sätze der drei Szenarien sowie Steuer und Inflation stehen unter Einstellungen → „Annahmen für Simulationen“.
- Steuer ist eine Näherung: ein Steuersatz, Sparerpauschbetrag pro Jahr, optional 30 % Teilfreistellung für ETFs und Fonds. Vorabpauschale, Verlustverrechnung und Quellensteuer sind nicht enthalten.
- „Wie bisher, je Position“ nimmt das durchschnittliche Kurswachstum der letzten bis zu 10 Jahre (begrenzt auf 0 bis 12 % pro Jahr).

## Hinweise zu Phase 2

- Nachrichten kommen von Google News (deutsch) und Yahoo Finance (englisch), Kennzahlen und Termine von Yahoo Finance. Sie werden zwischengespeichert (Nachrichten 30 Minuten, Termine und Dividenden 12 Stunden, Geschäftszahlen 24 Stunden); „Neu laden“ im Tab holt sie sofort neu.
- Dividenden sind Hochrechnungen aus den Zahlungen der letzten 12 Monate, brutto und zum aktuellen Wechselkurs.
- Hauptversammlungen sind geschätzt (deutsche Aktien: Handelstag vor dem Ex-Dividenden-Tag). Ein von Hand eingetragener HV-Termin ersetzt die Schätzung für das jeweilige Jahr.
- Die comdirect-Sitzung endet automatisch 10 Minuten nach dem letzten Depot-Abruf und beim Beenden des Programms.
