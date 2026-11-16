"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const fmtEur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const fmtEur0 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 4 });
const fmtPct = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "always" });
const fmtShare = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const eur = v => (v == null ? "–" : fmtEur.format(v));
const pct = v => (v == null ? "–" : fmtPct.format(v) + " %");
const signedEur = v => (v == null ? "" : (v > 0 ? "+" : "") + fmtEur.format(v));
const cls = v => (v == null || Math.abs(v) < 1e-9 ? "" : v > 0 ? "up" : "down");
const arrow = v => (v == null || Math.abs(v) < 1e-9 ? "" : v > 0 ? "▲ " : "▼ ");
const deDate = iso => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}.${m}.${y}`; };
const deDateTime = iso => (iso ? `${deDate(iso)}, ${iso.slice(11, 16)} Uhr` : "–");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

async function api(path, options = {}) {
  if (options.json !== undefined) {
    options.method = options.method || "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch (e) { /* keine JSON-Antwort */ }
  if (!res.ok) {
    let msg = data && data.detail;
    if (Array.isArray(msg)) msg = "Eingabe unvollständig oder ungültig.";
    throw new Error(msg || `Fehler ${res.status}`);
  }
  return data;
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

const state = {
  data: null, sort: { key: "value", asc: false }, tab: "home",
  chartSel: "", range: "1J", charts: {},
};

// ---------- Farbmodus ----------
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function applyThemeLabel() {
  $("#themeBtn").textContent = document.documentElement.dataset.theme === "dark" ? "Heller Modus" : "Dunkler Modus";
}
$("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) { /* ohne Speicher gilt die Wahl nur für diese Sitzung */ }
  applyThemeLabel();
  renderAllocation();
  loadChart();
  runTabHook("theme");
});

// ---------- Tabs ----------
const TITLES = { home: "Start", bye: "Sitzung beendet", watch: "Watchlist", overview: "Übersicht", charts: "Kurse", allocation: "Aufteilung", news: "Nachrichten & Zahlen", calendar: "Kalender", dividends: "Dividenden", plan: "Sparplan", settings: "Einstellungen" };
const TAB_HOOKS = {};   // weitere Tabs (phase2.js) melden hier ihre Ladefunktion an
function runTabHook(reason) { if (TAB_HOOKS[state.tab]) TAB_HOOKS[state.tab](reason); }
function showTab(tab) {
  state.tab = tab;
  $$("#nav button[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab").forEach(s => (s.hidden = s.id !== "tab-" + tab));
  $("#pageTitle").textContent = TITLES[tab];
  if (tab === "charts") loadChart();
  if (tab === "allocation") renderAllocation();
  if (tab === "settings") loadSettings();
  runTabHook("show");
}
$("#nav").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});
document.addEventListener("click", e => {
  const b = e.target.closest("[data-goto]");
  if (b) showTab(b.dataset.goto);
});

// ---------- Übersicht ----------
async function loadOverview(refresh = false) {
  $("#refreshBtn").disabled = true;
  $("#stamp").textContent = state.data ? "Kurse werden aktualisiert …" : "Daten werden geladen …";
  try {
    state.data = await api("/api/overview?refresh=" + (refresh ? 1 : 0));
  } catch (e) {
    toast("Daten konnten nicht geladen werden: " + e.message);
    return;
  } finally {
    $("#refreshBtn").disabled = false;
  }
  renderOverview();
  fillChartSelect();
  if (state.tab === "charts") loadChart();
  if (state.tab === "allocation") renderAllocation();
  runTabHook("data");
  if (typeof renderSession === "function") renderSession();
}

function setDelta(node, value, text) {
  node.textContent = value == null ? "–" : arrow(value) + text;
  node.className = node.className.replace(/\b(up|down)\b/g, "").trim() + " " + cls(value);
}

function renderOverview() {
  const d = state.data, t = d.totals;
  const has = d.positions.length > 0;
  $("#empty").hidden = has;
  $("#overviewBody").hidden = !has;

  const parts = [];
  parts.push("Kurse: " + (d.prices_refreshed ? deDateTime(d.prices_refreshed) : "noch nicht abgerufen"));
  parts.push("Depotbestand: " + (d.last_sync ? deDateTime(d.last_sync) : "noch nicht von comdirect abgerufen"));
  $("#stamp").textContent = parts.join("  ·  ");

  const notes = [];
  if (d.refresh_error) notes.push(d.refresh_error);
  if (d.missing_prices.length) notes.push("Ohne Kurs (nicht im Depotwert enthalten): " + d.missing_prices.join(", ") + ". Bitte in den Einstellungen einen Ticker zuordnen.");
  $("#banner").hidden = notes.length === 0;
  $("#banner").textContent = notes.join(" ");

  $("#kpiValue").textContent = eur(t.value);
  $("#kpiCount").textContent = t.count + (t.count === 1 ? " Position" : " Positionen");
  setDelta($("#kpiDay"), t.day_pct, pct(t.day_pct));
  $("#kpiDayAbs").textContent = signedEur(t.day_abs);
  setDelta($("#kpiPl"), t.pl_pct, pct(t.pl_pct));
  $("#kpiPlAbs").textContent = t.pl_abs == null ? "Kaufwerte unvollständig" : signedEur(t.pl_abs);
  $("#kpiBuy").textContent = eur(t.purchase_value);

  fillSelect($("#fType"), ["Alle", ...new Set(d.positions.map(p => p.type))]);
  fillSelect($("#fSector"), ["Alle", ...new Set(d.positions.map(p => p.sector))]);
  renderTable();
}

function fillSelect(sel, values) {
  const current = sel.value;
  sel.replaceChildren(...values.map(v => el("option", { value: v === "Alle" ? "" : v }, v)));
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

function renderTable() {
  const d = state.data;
  if (!d) return;
  const fType = $("#fType").value, fSector = $("#fSector").value, q = $("#fSearch").value.trim().toLowerCase();
  let rows = d.positions.filter(p =>
    (!fType || p.type === fType) && (!fSector || p.sector === fSector) &&
    (!q || [p.name, p.wkn, p.isin, p.ticker].some(x => (x || "").toLowerCase().includes(q))));
  const { key, asc } = state.sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const r = typeof x === "string" ? x.localeCompare(y, "de") : x - y;
    return asc ? r : -r;
  });
  $$("#posTable th").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    th.classList.toggle("asc", th.dataset.sort === key && asc);
  });
  const sum = rows.reduce((s, p) => s + (p.value || 0), 0);
  $("#fCount").textContent = rows.length === d.positions.length
    ? `${rows.length} Positionen`
    : `${rows.length} von ${d.positions.length} Positionen · ${eur(sum)}`;

  $("#posTable tbody").replaceChildren(...rows.map(p => el("tr", { onclick: () => { state.chartSel = p.isin; $("#cSelect").value = p.isin; showTab("charts"); }, title: p.price_source ? `Kurs: ${p.price_source}${p.price_date ? ", " + deDate(p.price_date) : ""}` : "Kein Kurs verfügbar" },
    el("td", { class: "left" }, el("span", { class: "name" }, p.name), el("span", { class: "ids" }, [p.wkn, p.isin].filter(Boolean).join(" · "))),
    el("td", { class: "left" }, p.type),
    el("td", { class: "left" }, p.sector),
    el("td", {}, fmtNum.format(p.quantity)),
    el("td", {}, eur(p.purchase_price)),
    el("td", {}, eur(p.price)),
    el("td", {}, p.day_pct == null ? "–" : el("span", { class: "chip " + cls(p.day_pct) }, arrow(p.day_pct) + pct(p.day_pct))),
    el("td", {}, eur(p.value)),
    el("td", {}, p.share == null ? "–" : fmtShare.format(p.share) + " %"),
    el("td", { class: "pl " + cls(p.pl_pct) }, p.pl_pct == null ? "–" : arrow(p.pl_pct) + pct(p.pl_pct), p.pl_abs == null ? null : el("small", {}, signedEur(p.pl_abs))),
  )));
}

$("#posTable thead").addEventListener("click", e => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  state.sort = { key, asc: state.sort.key === key ? !state.sort.asc : ["name", "type", "sector"].includes(key) };
  renderTable();
});
["#fType", "#fSector"].forEach(s => $(s).addEventListener("change", renderTable));
$("#fSearch").addEventListener("input", renderTable);
$("#refreshBtn").addEventListener("click", () => loadOverview(true));

// ---------- Kurse ----------
state.watchNames = [];   // Wertpapiere der Watchlist für die Auswahl im Kursdiagramm ("w:TICKER")
async function loadWatchNames() {
  try { state.watchNames = await api("/api/watchlist/names"); } catch (e) { state.watchNames = []; }
  if (state.data) fillChartSelect();
}
function fillChartSelect() {
  const sel = $("#cSelect");
  const depot = [...state.data.positions].sort((a, b) => a.name.localeCompare(b.name, "de")).map(p => el("option", { value: p.isin }, p.name));
  sel.replaceChildren(el("option", { value: "" }, "Gesamtes Depot"),
    el("optgroup", { label: "Depot" }, ...depot),
    ...(state.watchNames.length ? [el("optgroup", { label: "Watchlist" }, ...state.watchNames.map(w => el("option", { value: "w:" + w.ticker }, w.name)))] : []));
  sel.value = [...sel.options].some(o => o.value === state.chartSel) ? state.chartSel : "";
  state.chartSel = sel.value;
}
$("#cSelect").addEventListener("change", e => { state.chartSel = e.target.value; loadChart(); });
$("#cRange").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  state.range = b.dataset.r;
  $$("#cRange button").forEach(x => x.classList.toggle("active", x === b));
  loadChart();
});

// Durchschnittslinien: Auswahl wird gemerkt
state.avg = { ma50: false, ma200: false };
try { Object.assign(state.avg, JSON.parse(localStorage.getItem("avgLines") || "{}")); } catch (e) { /* ohne Speicher: aus */ }
function syncAvgButtons() {
  $$("#cAvg button").forEach(b => { const on = !!state.avg[b.dataset.avg]; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
}
$("#cAvg").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  state.avg[b.dataset.avg] = !state.avg[b.dataset.avg];
  try { localStorage.setItem("avgLines", JSON.stringify(state.avg)); } catch (err) { /* gilt dann nur für diese Sitzung */ }
  syncAvgButtons();
  loadChart();
});
syncAvgButtons();

let chartRequest = 0;
async function loadChart() {
  if (state.tab !== "charts" || !state.data) return;
  const req = ++chartRequest;
  let h;
  try {
    const target = state.chartSel.startsWith("w:") ? "ticker=" + encodeURIComponent(state.chartSel.slice(2)) : "isin=" + encodeURIComponent(state.chartSel);
    h = await api(`/api/history?range=${state.range}&${target}`);
  } catch (e) { toast(e.message); return; }
  if (req !== chartRequest) return;
  const pts = h.points;
  $("#cUnit").textContent = h.unit;
  $("#cEmpty").hidden = pts.length > 0;
  $("#lineChart").hidden = pts.length === 0;
  const note = $("#cNote");
  const notes = [];
  if (h.estimated) notes.push("Der Verlauf ist teilweise zurückgerechnet: Für einen Teil des Bestands liegen keine Kaufumsätze vor, deshalb wird dort der heutige Bestand auch für die Vergangenheit angenommen.");
  if (h.missing && h.missing.length) notes.push("Nicht enthalten (keine Kursdaten): " + h.missing.join(", ") + ".");
  note.hidden = notes.length === 0;
  note.textContent = notes.join(" ");
  if (state.charts.line) { state.charts.line.destroy(); state.charts.line = null; }
  if (!pts.length) { $("#cLast").textContent = "–"; $("#cChange").textContent = "–"; return; }

  const first = pts[0][1], last = pts[pts.length - 1][1];
  $("#cLast").textContent = eur(last);
  const chg = (last / first - 1) * 100;
  setDelta($("#cChange"), chg, `${pct(chg)} (${signedEur(last - first)})`);
  $("#cChange").classList.add("mid");

  const line = cssVar("--s1"), grid = cssVar("--grid"), ink = cssVar("--muted"), surface = cssVar("--surface");
  const ctx = $("#lineChart").getContext("2d");
  const fill = ctx.createLinearGradient(0, 0, 0, 420);
  fill.addColorStop(0, line + "33");
  fill.addColorStop(1, line + "00");
  const datasets = [{ label: state.chartSel ? "Kurs" : "Depotwert", data: pts.map(p => p[1]), borderColor: line, backgroundColor: fill, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: line, pointHoverBorderColor: surface, pointHoverBorderWidth: 2, tension: 0 }];
  // Gleitende Durchschnitte (50 bzw. 200 Handelstage), einzeln zuschaltbar
  const avgNotes = [];
  for (const [key, idx, name, color] of [["ma50", 2, "50-Tage-Linie", cssVar("--s2")], ["ma200", 3, "200-Tage-Linie", cssVar("--s3")]]) {
    if (!state.avg[key]) continue;
    const data = pts.map(p => p[idx]);
    if (data.every(v => v == null)) { avgNotes.push(`Für die ${name} gibt es noch nicht genug Kurshistorie.`); continue; }
    datasets.push({ label: name, data, borderColor: color, backgroundColor: color, fill: false, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: false });
  }
  if (avgNotes.length) { note.hidden = false; note.textContent = [note.textContent, ...avgNotes].filter(Boolean).join(" "); }
  const multi = datasets.length > 1;
  state.charts.line = new Chart(ctx, {
    type: "line",
    data: { labels: pts.map(p => deDate(p[0])), datasets },
    options: {
      maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: multi, position: "top", align: "start", labels: { color: cssVar("--text"), usePointStyle: true, pointStyle: "line", boxWidth: 28 } },
        tooltip: { displayColors: multi, callbacks: { label: c => (multi ? ` ${c.dataset.label}: ` : "") + fmtEur.format(c.parsed.y) } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: cssVar("--axis") }, ticks: { color: ink, maxTicksLimit: 8, maxRotation: 0, autoSkipPadding: 24 } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: ink, callback: v => (Math.abs(v) >= 1000 ? fmtEur0.format(v) : fmtEur.format(v)) } },
      },
    },
    plugins: [{
      id: "crosshair",
      afterDatasetsDraw(chart) {
        const a = chart.tooltip && chart.tooltip.getActiveElements();
        if (!a || !a.length) return;
        const x = a[0].element.x, { top, bottom } = chart.chartArea, c = chart.ctx;
        c.save(); c.strokeStyle = cssVar("--axis"); c.lineWidth = 1;
        c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); c.restore();
      },
    }],
  });
}

// ---------- Aufteilung ----------
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"];
function groupBy(key) {
  const sums = new Map();
  for (const p of state.data.positions) if (p.value) sums.set(p[key], (sums.get(p[key]) || 0) + p.value);
  let items = [...sums].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  if (items.length > SERIES.length + 1) {   // nie mehr als 8 Farben: Rest zusammenfassen
    const rest = items.slice(SERIES.length);
    items = items.slice(0, SERIES.length);
    items.push({ name: `Sonstige (${rest.length})`, value: rest.reduce((s, i) => s + i.value, 0), other: true });
  }
  return items;
}
function renderPie(canvasId, legendId, key) {
  const items = groupBy(key);
  const total = items.reduce((s, i) => s + i.value, 0);
  const colors = items.map((it, i) => cssVar(it.other || i >= SERIES.length ? "--s8" : SERIES[i]));
  if (state.charts[canvasId]) state.charts[canvasId].destroy();
  state.charts[canvasId] = new Chart($("#" + canvasId), {
    type: "doughnut",
    data: { labels: items.map(i => i.name), datasets: [{ data: items.map(i => i.value), backgroundColor: colors, borderColor: cssVar("--surface"), borderWidth: 2, hoverOffset: 4 }] },
    options: {
      maintainAspectRatio: false, animation: false, cutout: "58%",
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${fmtEur.format(c.parsed)} · ${fmtShare.format(c.parsed / total * 100)} %` } },
      },
    },
  });
  $("#" + legendId).replaceChildren(...items.map((it, i) => {
    const sw = el("i"); sw.style.background = colors[i];
    return el("li", {}, sw, el("span", { class: "n", title: it.name }, it.name), el("span", { class: "v" }, eur(it.value)), el("span", { class: "p" }, fmtShare.format(it.value / total * 100) + " %"));
  }));
}
function renderAllocation() {
  if (state.tab !== "allocation" || !state.data || !state.data.positions.length) return;
  renderPie("pieName", "legName", "name");
  renderPie("pieSector", "legSector", "sector");
  renderPie("pieType", "legType", "type");
}

// ---------- Einstellungen ----------
async function loadSettings() {
  try {
    const [st, ins, man] = await Promise.all([api("/api/comdirect/status"), api("/api/instruments"), api("/api/positions/manual")]);
    renderCdStatus(st);
    renderInstruments(ins);
    renderManual(man);
  } catch (e) { toast(e.message); }
}
function renderCdStatus(st) {
  const txt = !st.configured ? "Noch keine Zugangsdaten gespeichert."
    : `Zugangsdaten gespeichert${st.pin_saved ? " (inkl. PIN)" : " (PIN wird bei jedem Abruf abgefragt)"}. ` +
      (st.session_active ? "Sitzung aktiv." : "Keine aktive Sitzung.") +
      (st.last_sync ? ` Letzter Abruf: ${deDateTime(st.last_sync)}.` : "");
  $("#cdStatus").textContent = txt;
  $$("#credForm input").forEach(i => { i.required = !st.configured && i.name !== "pin"; });
}
$("#credForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    renderCdStatus(await api("/api/comdirect/credentials", { json: f }));
    e.target.reset();
    toast("Zugangsdaten gespeichert. Du kannst jetzt oben rechts dein Depot abrufen.");
  } catch (err) { toast(err.message); }
});
$("#cdLogout").addEventListener("click", () => endSession());   // zeigt danach die Abschiedsseite (session.js)
$("#cdDelete").addEventListener("click", async () => {
  if (!confirm("Gespeicherte comdirect-Zugangsdaten wirklich löschen?")) return;
  renderCdStatus(await api("/api/comdirect/credentials", { method: "DELETE" }));
  toast("Zugangsdaten gelöscht.");
});

function renderInstruments(data) {
  const opt = (values, current, auto) => [el("option", { value: "" }, `Automatisch (${auto})`), ...values.map(v => el("option", { value: v, selected: v === current }, v))];
  $("#insTable tbody").replaceChildren(...data.instruments.map(i => {
    const ticker = el("input", { value: i.ticker_manual || "", placeholder: "z. B. SAP.DE" });
    const type = el("select", {}, ...opt(data.product_types, i.type_manual, i.bank_type || "unbekannt"));
    const sectors = [...new Set([...data.sectors, i.sector_manual].filter(Boolean))];
    const sector = el("select", {}, ...opt(sectors, i.sector_manual, i.sector || "unbekannt"));
    const save = el("button", { class: "ghost", type: "button", onclick: async () => {
      save.disabled = true;
      try {
        await api("/api/instruments/" + encodeURIComponent(i.isin), { method: "PUT", json: { ticker_manual: ticker.value, type_manual: type.value, sector_manual: sector.value } });
        toast("Gespeichert.");
        await loadOverview();
        await loadSettings();
      } catch (err) { toast(err.message); save.disabled = false; }
    } }, "Speichern");
    return el("tr", {},
      el("td", { class: "left" }, el("span", { class: "name" }, i.name || i.isin), el("span", { class: "ids" }, i.isin)),
      el("td", { class: "left" }, i.ticker || "nicht gefunden"),
      el("td", { class: "left" }, ticker), el("td", { class: "left" }, type), el("td", { class: "left" }, sector), el("td", {}, save));
  }));
  if (!data.instruments.length) $("#insTable tbody").replaceChildren(el("tr", {}, el("td", { class: "left muted", colspan: 6 }, "Noch keine Wertpapiere vorhanden.")));
}

function renderManual(rows) {
  $("#manList").replaceChildren(...rows.map(p => el("li", {},
    el("span", {}, `${p.name} · ${fmtNum.format(p.quantity)} Stück${p.purchase_price ? " · Kaufkurs " + eur(p.purchase_price) : ""} · ${p.source === "csv" ? "CSV" : "von Hand"}`),
    el("button", { class: "ghost danger", type: "button", onclick: async () => { await api("/api/positions/" + p.id, { method: "DELETE" }); await loadOverview(); loadSettings(); } }, "Entfernen"))));
}
const deFloat = s => { s = (s || "").trim(); if (!s) return null; const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s); return Number.isFinite(n) ? n : NaN; };
$("#manForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const quantity = deFloat(f.quantity), price = deFloat(f.purchase_price);
  if (!(quantity > 0) || Number.isNaN(price)) { toast("Bitte Stückzahl und Kaufkurs als Zahl eingeben."); return; }
  const btn = $("button", e.target); btn.disabled = true;
  try {
    const r = await api("/api/positions", { json: { isin: f.isin, name: f.name, quantity, purchase_price: price } });
    e.target.reset();
    toast(r.ticker_found ? "Position angelegt." : "Position angelegt, aber kein Kurs-Ticker gefunden – bitte unten zuordnen.");
    await loadOverview();
    loadSettings();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});
$("#csvForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const r = await api("/api/import/csv", { method: "POST", body: new FormData(e.target) });
    e.target.reset();
    toast(`${r.positions} Positionen importiert.`);
    await loadOverview();
    loadSettings();
  } catch (err) { toast(err.message); }
});
$("#quitBtn").addEventListener("click", () => farewellAndQuit());   // Abschiedsseite in session.js

// ---------- comdirect-Abruf ----------
const dlg = $("#loginDlg");
let loginStep = "pin";
function loginError(msg) { $("#loginErr").hidden = !msg; $("#loginErr").textContent = msg || ""; }

async function syncDone(r) {
  toast(`Depot abgerufen: ${r.positions} Positionen, ${r.transactions} Umsätze.` + (r.note ? " Umsätze nicht verfügbar." : ""));
  await loadOverview(true);
  refreshSession();
  if (state.tab === "settings") loadSettings();
  if (state.tab === "home" || state.tab === "bye") showTab("overview");
}

$("#syncBtn").addEventListener("click", async () => {
  const btn = $("#syncBtn");
  btn.disabled = true;
  try {
    const st = await api("/api/comdirect/status");
    if (!st.configured) { showTab("settings"); toast("Bitte zuerst die comdirect-Zugangsdaten eintragen."); return; }
    if (st.session_active) {
      try { await syncDone(await api("/api/comdirect/sync", { method: "POST" })); return; }
      catch (e) { /* Sitzung abgelaufen: neu anmelden */ }
    }
    loginStep = "pin";
    loginError("");
    $("#stepPin").hidden = false; $("#stepTan").hidden = true;
    $("#pinLabel").hidden = st.pin_saved;
    $("#pinInput").value = ""; $("#tanInput").value = "";
    $("#loginNext").textContent = "Anmelden"; $("#loginNext").disabled = false;
    dlg.showModal();
  } catch (e) { toast(e.message); } finally { btn.disabled = false; }
});
$("#loginCancel").addEventListener("click", () => dlg.close());
$("#loginForm").addEventListener("submit", e => e.preventDefault());
$("#loginNext").addEventListener("click", async () => {
  const btn = $("#loginNext");
  btn.disabled = true;
  loginError("");
  try {
    if (loginStep === "pin") {
      const r = await api("/api/comdirect/login", { json: { pin: $("#pinInput").value || null } });
      $("#pinInput").value = "";
      loginStep = "tan";
      $("#stepPin").hidden = true; $("#stepTan").hidden = false;
      const push = r.tan_type === "P_TAN_PUSH", photo = r.tan_type === "P_TAN";
      $("#tanImg").hidden = !photo;
      if (photo) $("#tanImg").src = "data:image/png;base64," + r.challenge;
      $("#tanLabel").hidden = push;
      $("#tanText").textContent = push ? "Bitte gib die Anmeldung jetzt in der comdirect photoTAN-App frei. Klicke erst danach auf „Freigabe bestätigt“."
        : photo ? "Scanne die Grafik mit der photoTAN-App und gib die angezeigte TAN ein."
        : `Gib die TAN ein, die per SMS an ${r.challenge || "dein Handy"} gesendet wurde.`;
      btn.textContent = push ? "Freigabe bestätigt" : "TAN bestätigen";
    } else {
      const r = await api("/api/comdirect/confirm", { json: { tan: $("#tanInput").value || null } });
      dlg.close();
      await syncDone(r);
    }
  } catch (e) {
    loginError(e.message);
  } finally { btn.disabled = false; }
});

// ---------- Start ----------
applyThemeLabel();
loadOverview();
loadWatchNames();
