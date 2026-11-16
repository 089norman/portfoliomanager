"use strict";
/* Phase 2: Nachrichten & Zahlen, Kalender, Dividenden. Nutzt die Helfer aus app.js. */

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MONTHS_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const fmtBig = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctPlain = v => (v == null ? "–" : fmt2.format(v) + " %");

function bigMoney(v, currency) {
  if (v == null) return "–";
  const a = Math.abs(v), cur = currency ? " " + currency : "";
  if (a >= 1e12) return fmtBig.format(v / 1e12) + " Bio." + cur;
  if (a >= 1e9) return fmtBig.format(v / 1e9) + " Mrd." + cur;
  if (a >= 1e6) return fmtBig.format(v / 1e6) + " Mio." + cur;
  return fmtBig.format(v) + cur;
}
function positionOptions(firstLabel) {
  const opts = firstLabel ? [el("option", { value: "" }, firstLabel)] : [];
  const list = state.data ? [...state.data.positions].sort((a, b) => a.name.localeCompare(b.name, "de")) : [];
  return [...opts, ...list.map(p => el("option", { value: p.isin }, p.name))];
}
function keepValue(sel, options) {
  const cur = sel.value;
  sel.replaceChildren(...options);
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

// ================= Nachrichten & Zahlen =================
let newsReq = 0;
async function loadNews(reason, force = false) {
  if (reason === "theme") return;
  keepValue($("#nSelect"), positionOptions("Alle Positionen"));
  const isin = $("#nSelect").value;
  const req = ++newsReq;
  $("#nHint").textContent = "Wird geladen …";
  $("#nFund").hidden = true;
  $("#nFundMsg").hidden = true;
  const q = `isin=${encodeURIComponent(isin)}&refresh=${force ? 1 : 0}`;
  try {
    const [news, fund] = await Promise.all([api("/api/news?" + q), isin ? api("/api/fundamentals?" + q) : null]);
    if (req !== newsReq) return;
    renderNews(news.items, !isin);
    if (fund) renderFund(fund);
    $("#nHint").textContent = isin ? "" : "Wähle eine Position, um ihre Geschäftszahlen zu sehen.";
  } catch (e) {
    if (req === newsReq) $("#nHint").textContent = "Laden fehlgeschlagen: " + e.message;
  }
}
function renderNews(items, showName) {
  const list = $("#nList");
  if (!items.length) { list.replaceChildren(el("li", { class: "muted" }, "Keine Nachrichten gefunden.")); return; }
  list.replaceChildren(...items.map(n => el("li", {},
    el("a", { href: n.url, target: "_blank", rel: "noopener noreferrer" }, n.title),
    el("div", { class: "meta" }, showName ? el("span", { class: "tag" }, n.name) : null,
      `${n.source} · ${deDateTime(n.date)}${n.lang === "en" ? " · englisch" : ""}`))));
}
function finTable(table, rows, currency, quarterly) {
  if (!rows.length) { table.replaceChildren(el("tbody", {}, el("tr", {}, el("td", { class: "left muted" }, "Keine Daten verfügbar.")))); return; }
  const label = p => { const [y, m] = p.split("-"); return quarterly ? `Q${Math.ceil(Number(m) / 3)} ${y}` : (m === "12" ? y : `${y} (bis ${m}/${y})`); };
  const line = (name, key, f) => el("tr", {}, el("td", { class: "left" }, name), ...rows.map(r => el("td", {}, r[key] == null ? "–" : f(r[key]))));
  table.replaceChildren(
    el("thead", {}, el("tr", {}, el("th", { class: "left" }, currency ? `in ${currency}` : ""), ...rows.map(r => el("th", {}, label(r.period))))),
    el("tbody", {},
      line("Umsatz", "revenue", v => bigMoney(v)),
      line("Operatives Ergebnis", "operating_income", v => bigMoney(v)),
      line("Gewinn", "net_income", v => bigMoney(v)),
      line("Gewinn je Aktie", "eps", v => fmt2.format(v))));
}
function renderFund(f) {
  if (!f.available) {
    $("#nFundMsg").hidden = false;
    $("#nFundMsg").textContent = f.reason;
    return;
  }
  const i = f.info || {}, cur = f.currency || "";
  const tile = (label, value, sub) => el("div", { class: "tile" }, el("span", { class: "label" }, label), el("span", { class: "big" }, value), el("span", { class: "sub" }, sub || ""));
  $("#nTiles").replaceChildren(
    tile("Marktkapitalisierung", bigMoney(i.marketCap, i.currency), i.industry || ""),
    tile("KGV", i.trailingPE == null ? "–" : fmt2.format(i.trailingPE), i.forwardPE == null ? "letzte 12 Monate" : `erwartet: ${fmt2.format(i.forwardPE)}`),
    tile("Gewinn je Aktie", i.trailingEps == null ? "–" : `${fmt2.format(i.trailingEps)} ${i.currency || ""}`, "letzte 12 Monate"),
    tile("Dividendenrendite", i.dividendYield == null ? "–" : pctPlain(i.dividendYield), i.dividendRate == null ? "" : `${fmt2.format(i.dividendRate)} ${i.currency || ""} je Aktie`));
  const terms = [];
  if (f.last_earnings) terms.push(`Zuletzt gemeldet am ${deDate(f.last_earnings.date)}: Gewinn je Aktie ${fmt2.format(f.last_earnings.reported)}` + (f.last_earnings.estimate != null ? ` (erwartet waren ${fmt2.format(f.last_earnings.estimate)})` : "") + ".");
  if (f.next_earnings) terms.push(`Nächste Zahlen voraussichtlich am ${deDate(f.next_earnings.date)}` + (f.next_earnings.estimate != null ? `, erwarteter Gewinn je Aktie ${fmt2.format(f.next_earnings.estimate)}` : "") + ".");
  $("#nTermCard").hidden = terms.length === 0;
  $("#nTerms").textContent = terms.join(" ");
  finTable($("#nAnnual"), f.annual, cur, false);
  finTable($("#nQuarter"), f.quarterly, cur, true);
  $("#nFundNote").textContent = "Quelle: Yahoo Finance. Umsatz und Gewinn in der Berichtswährung des Unternehmens" + (cur ? ` (${cur})` : "") + ".";
  $("#nFund").hidden = false;
}
$("#nSelect").addEventListener("change", () => loadNews("show"));
$("#nReload").addEventListener("click", () => loadNews("show", true));
TAB_HOOKS.news = loadNews;

// ================= Dividenden =================
let divData = null;
async function loadDividends(reason) {
  if (reason === "theme" && divData) { renderDivCharts(); return; }
  $("#dYear").textContent = "lädt …";
  try { divData = await api("/api/dividends"); } catch (e) { toast(e.message); return; }
  const d = divData;
  $("#dYear").textContent = eur(d.total_annual);
  $("#dMonth").textContent = eur(d.total_annual / 12);
  $("#dYield").textContent = pctPlain(d.yield_current);
  $("#dYoc").textContent = pctPlain(d.yield_cost);

  const up = d.upcoming.filter(u => (u.pay_date || u.ex_date) >= new Date().toISOString().slice(0, 10)).slice(0, 12);
  $("#divUpcoming tbody").replaceChildren(...(up.length ? up.map(u => el("tr", {},
    el("td", { class: "left" }, u.name),
    el("td", { class: "left" }, deDate(u.ex_date)),
    el("td", { class: "left" }, u.pay_date ? deDate(u.pay_date) + (u.pay_estimated ? " (geschätzt)" : "") : "nicht bekannt"),
    el("td", { class: "left" }, u.status === "angekündigt" ? "angekündigt" : "erwartet (Vorjahr)"),
    el("td", {}, eur(u.per_share_eur)), el("td", {}, eur(u.amount_eur))))
    : [el("tr", {}, el("td", { class: "left muted", colspan: 6 }, "Keine Dividendenzahlungen zu erwarten."))]));

  $("#divTable tbody").replaceChildren(...d.positions.map(p => el("tr", {},
    el("td", { class: "left" }, el("span", { class: "name" }, p.name), p.fx_missing ? el("span", { class: "ids" }, "Wechselkurs fehlt") : null),
    el("td", {}, fmtNum.format(p.quantity)),
    el("td", {}, p.dps_eur ? eur(p.dps_eur) : "–"),
    el("td", {}, p.payments_per_year || "–"),
    el("td", {}, p.annual_eur ? eur(p.annual_eur) : "–"),
    el("td", {}, p.annual_eur ? pctPlain(p.yield_current) : "–"),
    el("td", {}, p.annual_eur ? pctPlain(p.yield_cost) : "–"),
    el("td", { class: cls(p.growth5) }, p.growth5 == null ? "–" : arrow(p.growth5) + pct(p.growth5) + " p. a."))));

  const payers = d.positions.filter(p => p.annual_eur);
  keepValue($("#dpSelect"), [el("option", { value: "" }, "Gesamtes Depot"), ...payers.map(p => el("option", { value: p.isin }, p.name))]);
  renderDivCharts();
}
function chartColors() {
  return { bar: cssVar("--s1"), grid: cssVar("--grid"), ink: cssVar("--muted"), axis: cssVar("--axis") };
}
function barChart(id, labels, values, tooltipLines) {
  const c = chartColors();
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart($("#" + id), {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: c.bar, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 46 }] },
    options: {
      maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { displayColors: false, callbacks: { label: ctx => fmtEur.format(ctx.parsed.y), afterBody: items => (tooltipLines ? tooltipLines(items[0].dataIndex) : []) } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: c.axis }, ticks: { color: c.ink, maxRotation: 0 } },
        y: { beginAtZero: true, grid: { color: c.grid }, border: { display: false }, ticks: { color: c.ink, callback: v => fmtEur0.format(v) } },
      },
    },
  });
}
function renderDivCharts() {
  if (!divData) return;
  const m = divData.months;
  barChart("divMonths", m.map(x => { const [y, mo] = x.month.split("-"); return `${MONTHS_SHORT[Number(mo) - 1]} ${y.slice(2)}`; }), m.map(x => Math.round(x.total * 100) / 100),
    i => [...m[i].items].sort((a, b) => b.amount - a.amount).slice(0, 8).map(it => `${it.name}: ${fmtEur.format(it.amount)}`));
  renderProjection();
}
// Der Dividendenrechner (renderProjection) steht in sim.js, weil er den Simulationskern nutzt.
TAB_HOOKS.dividends = loadDividends;

// ================= Kalender =================
const KINDS = [["earnings", "Zahlen"], ["hv", "Hauptversammlung"], ["ex", "Ex-Dividende"], ["pay", "Dividendenzahlung"], ["other", "Sonstiges"]];
const cal = { data: null, mode: "month", month: null, hidden: new Set() };
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

$("#calKinds").replaceChildren(...KINDS.map(([k, label]) => {
  const box = el("input", { type: "checkbox", checked: "" });
  box.addEventListener("change", () => { box.checked ? cal.hidden.delete(k) : cal.hidden.add(k); renderCalendar(); });
  return el("label", { class: "k-" + k }, box, el("span", { class: "dot" }), label);
}));

async function loadCalendar(reason) {
  if (reason === "theme") return;
  $("#calTitle").textContent = "lädt …";
  try { cal.data = await api("/api/calendar"); } catch (e) { toast(e.message); return; }
  if (!cal.month) { const t = new Date(); cal.month = new Date(t.getFullYear(), t.getMonth(), 1); }
  keepValue($("#evIsin"), [el("option", { value: "" }, "Allgemein (ohne Position)"), ...cal.data.positions.map(p => el("option", { value: p.isin }, p.name))]);
  renderCalendar();
}
function eventText(e) { return e.kind === "other" && e.title ? e.title : e.label; }
function eventTitle(e) {
  return [`${e.label}: ${e.name}`, e.title, e.detail, e.estimated ? "Termin geschätzt" : null].filter(Boolean).join(" – ");
}
function renderCalendar() {
  if (!cal.data) return;
  const events = cal.data.events.filter(e => !cal.hidden.has(e.kind));
  const monthMode = cal.mode === "month";
  $("#calGrid").hidden = !monthMode;
  $("#calList").hidden = monthMode;
  $("#calNav").hidden = !monthMode;
  if (monthMode) {
    const y = cal.month.getFullYear(), m = cal.month.getMonth();
    $("#calTitle").textContent = `${MONTHS[m]} ${y}`;
    const first = new Date(y, m, 1);
    const start = new Date(y, m, 1 - ((first.getDay() + 6) % 7));
    const byDay = new Map();
    for (const e of events) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
    const cells = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map(w => el("div", { class: "wd" }, w));
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i >= 35 && d.getMonth() !== m) break;
      const iso = isoDay(d);
      cells.push(el("div", { class: "day" + (d.getMonth() !== m ? " out" : "") + (iso === cal.data.today ? " today" : "") },
        el("span", { class: "num" }, String(d.getDate())),
        ...(byDay.get(iso) || []).map(e => el("span", { class: `ev k-${e.kind}${e.estimated ? " est" : ""}`, title: eventTitle(e) }, el("b", {}, eventText(e)), " " + e.name))));
    }
    $("#calGrid").replaceChildren(...cells);
  } else {
    const today = cal.data.today;
    const from = isoDay(new Date(new Date().setDate(new Date().getDate() - 30)));
    const rows = events.filter(e => e.date >= from);
    $("#calTable tbody").replaceChildren(...(rows.length ? rows.map(e => el("tr", { class: e.date < today ? "past" : "" },
      el("td", { class: "left" }, deDate(e.date)),
      el("td", { class: "left" }, el("span", { class: "kindcell k-" + e.kind }, el("span", { class: "dot" }), eventText(e))),
      el("td", { class: "left" }, e.name),
      el("td", { class: "left" }, [e.title && e.kind !== "other" ? e.title : null, e.detail, e.estimated ? "geschätzt" : null].filter(Boolean).filter((v, i, a) => !(v === "geschätzt" && a.some(x => x !== v && x.includes("geschätzt")))).join(" · ")),
      el("td", {}, e.manual_id ? el("button", { class: "ghost danger", type: "button", onclick: async () => { await api("/api/events/" + e.manual_id, { method: "DELETE" }); loadCalendar("show"); } }, "Entfernen") : null)))
      : [el("tr", {}, el("td", { class: "left muted", colspan: 5 }, "Keine Termine."))]));
  }
}
$("#calMode").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  cal.mode = b.dataset.m;
  $$("#calMode button").forEach(x => x.classList.toggle("active", x === b));
  renderCalendar();
});
$("#calPrev").addEventListener("click", () => { cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() - 1, 1); renderCalendar(); });
$("#calNext").addEventListener("click", () => { cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + 1, 1); renderCalendar(); });
$("#calToday").addEventListener("click", () => { const t = new Date(); cal.month = new Date(t.getFullYear(), t.getMonth(), 1); renderCalendar(); });
$("#evForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await api("/api/events", { json: f });
    e.target.reset();
    toast("Termin eingetragen.");
    loadCalendar("show");
  } catch (err) { toast(err.message); }
});
TAB_HOOKS.calendar = loadCalendar;
