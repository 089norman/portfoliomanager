"use strict";
/* Watchlist: Wertpapiere beobachten, die nicht im Depot liegen. Nutzt die Helfer aus app.js. */

const TYPE_DE = { EQUITY: "Einzelaktie", ETF: "ETF", MUTUALFUND: "Fonds", INDEX: "Index" };
let watchReq = 0;

// Notizfeld einer Karte: speichert von selbst kurz nach dem Tippen und beim Verlassen des Feldes
function noteBox(w) {
  const status = el("span", { class: "note-status muted" }, w.note ? "Gespeichert" : "");
  const area = el("textarea", { class: "wnote", rows: "3", maxlength: "5000", placeholder: "Eigene Notiz, z. B. warum du den Wert beobachtest oder bei welchem Kurs du kaufen würdest", "aria-label": `Notiz zu ${w.name}` });
  area.value = w.note || "";
  let timer = null, saved = area.value;
  const save = async () => {
    clearTimeout(timer); timer = null;
    if (area.value === saved) return;
    const text = area.value;
    status.textContent = "Speichert …";
    try {
      await api("/api/watchlist/note", { method: "PUT", json: { symbol: w.ticker, note: text } });
      saved = text; w.note = text;
      status.textContent = area.value === text ? "Gespeichert" : "Speichert …";
    } catch (e) { status.textContent = "Nicht gespeichert: " + e.message; }
  };
  area.addEventListener("input", () => { status.textContent = "…"; clearTimeout(timer); timer = setTimeout(save, 800); });
  area.addEventListener("blur", save);
  return el("div", { class: "wnote-box" }, el("div", { class: "wnote-head" }, el("span", { class: "label" }, "Notiz"), status), area);
}

async function loadWatch(reason, force = false) {
  if (reason === "theme") return;
  // Während du eine Notiz schreibst, wird die Liste nicht im Hintergrund neu aufgebaut
  if (reason === "data" && document.activeElement && document.activeElement.classList.contains("wnote")) return;
  const req = ++watchReq;
  let data;
  try { data = await api("/api/watchlist?refresh=" + (force ? 1 : 0)); } catch (e) { toast("Watchlist konnte nicht geladen werden: " + e.message); return; }
  if (req !== watchReq) return;
  $("#wEmpty").hidden = data.items.length > 0;
  const delta = v => el("b", { class: cls(v) }, v == null ? "–" : arrow(v) + pct(v));
  $("#wList").replaceChildren(...data.items.map(w => el("div", { class: "wcard" },
    el("div", { class: "wcard-head" },
      el("div", {}, el("h3", {}, w.name), el("span", { class: "ids" }, [w.ticker, w.exchange, w.type].filter(Boolean).join(" · "))),
      w.day_pct == null ? null : el("span", { class: "chip " + cls(w.day_pct), title: "Veränderung zum Vortag" }, arrow(w.day_pct) + pct(w.day_pct))),
    el("div", { class: "wcard-price" },
      el("span", { class: "big" }, eur(w.price)),
      el("span", { class: "sub" }, w.price_date ? `Stand ${deDate(w.price_date)}` + (w.currency && w.currency !== "EUR" ? `, umgerechnet aus ${w.currency}` : "") : "kein Kurs verfügbar")),
    el("div", { class: "wstats" },
      el("div", {}, el("span", {}, "1 Monat"), delta(w.changes["1M"])),
      el("div", {}, el("span", {}, "6 Monate"), delta(w.changes["6M"])),
      el("div", {}, el("span", {}, "1 Jahr"), delta(w.changes["1J"])),
      el("div", {}, el("span", {}, `Seit Aufnahme (${w.added ? deDate(w.added) : "–"})`), delta(w.since_added))),
    el("div", { class: "sub" }, w.high52 == null ? "" : `52-Wochen-Spanne: ${eur(w.low52)} bis ${eur(w.high52)}`),
    noteBox(w),
    el("ul", { class: "news" }, ...(w.news.length
      ? w.news.map(n => el("li", {},
          el("a", { href: n.url, target: "_blank", rel: "noopener noreferrer" }, n.title),
          el("div", { class: "meta" }, `${n.source} · ${deDateTime(n.date)}${n.lang === "en" ? " · englisch" : ""}`)))
      : [el("li", { class: "muted" }, "Keine aktuellen Nachrichten gefunden.")])),
    el("div", { class: "wcard-actions" },
      el("button", { class: "ghost", type: "button", onclick: () => { state.chartSel = "w:" + w.ticker; $("#cSelect").value = state.chartSel; showTab("charts"); } }, "Kursverlauf"),
      el("button", { class: "ghost danger", type: "button", onclick: async () => {
        if (!confirm(`„${w.name}“ von der Watchlist entfernen?`)) return;
        try { await api("/api/watchlist/" + encodeURIComponent(w.ticker), { method: "DELETE" }); } catch (e) { toast(e.message); return; }
        await loadWatchNames();
        loadWatch("show");
      } }, "Entfernen")))));
}

$("#wSearchForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("button", e.target);
  btn.disabled = true; btn.textContent = "Sucht …";
  try {
    const r = await api("/api/watchlist/search?q=" + encodeURIComponent($("#wQuery").value.trim()));
    $("#wResults").hidden = false;
    $("#wResultTable tbody").replaceChildren(...(r.results.length ? r.results.map(x => {
      const add = el("button", { class: "primary", type: "button", onclick: async () => {
        add.disabled = true; add.textContent = "Wird hinzugefügt …";
        try {
          await api("/api/watchlist", { json: { symbol: x.symbol, name: x.name, type: x.type } });
          toast(`„${x.name}“ steht jetzt auf der Watchlist.`);
          $("#wResults").hidden = true; $("#wQuery").value = "";
          await loadWatchNames();
          loadWatch("show");
        } catch (err) { toast(err.message); add.disabled = false; add.textContent = "Hinzufügen"; }
      } }, "Hinzufügen");
      return el("tr", {}, el("td", { class: "left" }, el("span", { class: "name" }, x.name)), el("td", { class: "left" }, x.symbol),
        el("td", { class: "left" }, x.exchange), el("td", { class: "left" }, TYPE_DE[x.type] || x.type), el("td", {}, add));
    }) : [el("tr", {}, el("td", { class: "left muted", colspan: 5 }, "Nichts gefunden. Versuche es mit der ISIN oder einem anderen Namen."))]));
  } catch (err) { toast("Suche fehlgeschlagen: " + err.message); }
  finally { btn.disabled = false; btn.textContent = "Suchen"; }
});

TAB_HOOKS.watch = loadWatch;
