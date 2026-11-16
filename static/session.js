"use strict";
/* Startbildschirm, Sitzungsanzeige und Abschiedsseite. Nutzt die Helfer aus app.js. */

const sess = { active: null, configured: false, expiresAt: null, ending: false };
const clock = ts => new Date(ts * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Gute Nacht" : h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
}

function renderSession() {
  const on = !!sess.active;
  const until = on && sess.expiresAt ? ` bis ca. ${clock(sess.expiresAt)} Uhr` : "";
  // Seitenleiste
  $("#sessBadge").className = "sess " + (on ? "on" : "off");
  $("#sessText").textContent = on ? `Sitzung aktiv${until}` : "Keine Sitzung aktiv";
  $("#sessEndBtn").disabled = !on;
  // Startbildschirm
  $("#homeHello").textContent = greeting() + "!";
  $("#homeStatus").className = "hero-status " + (on ? "on" : "off");
  if (on) {
    $("#homeStatusTitle").textContent = "comdirect-Sitzung aktiv";
    $("#homeStatusText").textContent = `Du bist angemeldet. Die Sitzung endet automatisch${until ? " um ca. " + clock(sess.expiresAt) + " Uhr" : ""} oder wenn du sie beendest.`;
    $("#homeLogin").textContent = "Depot neu abrufen";
  } else if (!sess.configured) {
    $("#homeStatusTitle").textContent = "Keine comdirect-Sitzung aktiv";
    $("#homeStatusText").textContent = "Es sind noch keine Zugangsdaten gespeichert. Trage sie zuerst in den Einstellungen ein.";
    $("#homeLogin").textContent = "Zugangsdaten eintragen";
  } else {
    $("#homeStatusTitle").textContent = "Keine comdirect-Sitzung aktiv";
    $("#homeStatusText").textContent = "Du bist nicht bei comdirect angemeldet. Mit dem Knopf unten kannst du dich einloggen.";
    $("#homeLogin").textContent = "Bei comdirect anmelden";
  }
  const d = state.data;
  $("#homeFacts").textContent = d && d.positions.length
    ? `Gespeicherter Stand: ${d.totals.count} Positionen, Depotwert ${eur(d.totals.value)}. Letzter Abruf bei comdirect: ${d.last_sync ? deDateTime(d.last_sync) : "noch nie"}.`
    : "";
}

async function refreshSession() {
  let st;
  try { st = await api("/api/comdirect/status"); } catch (e) { return; }
  const wasActive = sess.active;
  sess.active = st.session_active; sess.configured = st.configured; sess.expiresAt = st.session_expires_at;
  renderSession();
  // Sitzung ist ohne Zutun abgelaufen (automatisches Ende nach 10 Minuten)
  if (wasActive === true && !sess.active && !sess.ending) showBye("auto");
}

function showBye(reason) {
  $("#byeReason").textContent = reason === "auto"
    ? "Die Sitzung wurde automatisch beendet, weil seit dem letzten Depot-Abruf 10 Minuten vergangen sind."
    : "Du hast die Sitzung beendet. Die Verbindung zu comdirect wurde getrennt.";
  showTab("bye");
  window.scrollTo(0, 0);
}

async function endSession() {
  sess.ending = true;
  try {
    await api("/api/comdirect/logout", { method: "POST" });
    sess.active = false; sess.expiresAt = null;
    renderSession();
    showBye("manual");
  } catch (e) { toast("Sitzung konnte nicht beendet werden: " + e.message); }
  finally { sess.ending = false; }
}

function farewellAndQuit() {
  if (!confirm("Portfoliomanager beenden?")) return;
  api("/api/shutdown", { method: "POST" }).catch(() => {});
  document.body.replaceChildren(el("div", { class: "hero", style: "margin-top:22vh" },
    el("h2", { class: "hero-title" }, "Auf Wiedersehen!"),
    el("p", { class: "hero-sub" }, "Der Portfoliomanager wurde beendet und die comdirect-Sitzung getrennt. Du kannst dieses Fenster schließen.")));
}

$("#sessEndBtn").addEventListener("click", endSession);
$("#homeLogin").addEventListener("click", () => {
  if (!sess.configured) { showTab("settings"); return; }
  $("#syncBtn").click();
});
$("#byeLogin").addEventListener("click", () => $("#syncBtn").click());
$("#byeQuit").addEventListener("click", farewellAndQuit);

// ---------- Versionsabgleich: läuft noch der Server-Stand von vor einer Aktualisierung? ----------
let updateMode = null;   // "restart" = Neustart per Knopf möglich, "manual" = alter Stand ohne Neustart-Funktion
async function checkVersion() {
  let mode = null;
  try {
    const res = await fetch("/api/version");
    if (res.status === 404) mode = "manual";
    else if (res.ok) { const v = await res.json(); if (v.current > v.started + 1) mode = "restart"; }
  } catch (e) { return; }
  updateMode = mode;
  $("#updateBar").hidden = !mode;
  if (mode === "manual") {
    $("#updateText").textContent = "Damit alle Funktionen arbeiten, muss es einmal beendet und über die Desktop-Verknüpfung neu gestartet werden.";
    $("#updateBtn").textContent = "Programm beenden";
  }
}
$("#updateBtn").addEventListener("click", async () => {
  if (updateMode === "manual") { farewellAndQuit(); return; }
  const btn = $("#updateBtn");
  btn.disabled = true; btn.textContent = "Startet neu …";
  try { await api("/api/restart", { method: "POST" }); } catch (e) { /* Server beendet sich gerade */ }
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const res = await fetch("/api/version"); if (res.ok) { const v = await res.json(); if (v.current <= v.started + 1) { location.reload(); return; } } } catch (e) { /* noch nicht wieder da */ }
  }
  btn.disabled = false; btn.textContent = "Jetzt neu starten";
  toast("Der Neustart hat nicht geklappt. Bitte das Programm über die Desktop-Verknüpfung starten.");
});
checkVersion();
setInterval(checkVersion, 60000);

TAB_HOOKS.home = () => renderSession();
renderSession();
refreshSession();
setInterval(refreshSession, 20000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshSession(); checkVersion(); } });
