"use strict";
/* Phase 3: Simulationskern, Sparplan-Tab, Dividendenrechner und Annahmen. Nutzt app.js und phase2.js. */

const sim = { settings: null, plan: null, base: null, loading: null };
const SCENARIOS = [["vorsichtig", "Vorsichtig"], ["mittel", "Mittel"], ["optimistisch", "Optimistisch"]];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const fmt1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

async function simLoad(force = false) {
  if (!force && sim.settings && sim.base) return;
  if (!sim.loading) {
    sim.loading = (async () => {
      const [s, base] = await Promise.all([api("/api/sim"), (typeof divData !== "undefined" && divData && !force) ? divData : api("/api/dividends")]);
      sim.settings = s.settings; sim.plan = s.plan; sim.base = base;
      // Noch keine Aufteilung gespeichert: Rate wie die heutigen Depotanteile verteilen
      if (!Object.keys(sim.plan.shares || {}).length) setShares("like", false);
    })().finally(() => { sim.loading = null; });
  }
  await sim.loading;
}

/* ---------- Rechenkern ----------
   Monatsweise Hochrechnung je Position:
   - Kurs wächst gleichmäßig mit g pro Jahr, die Sparrate wird monatlich zugekauft.
   - Die Dividende je Stück steigt im k-ten Jahr auf das (1+dg)^k-Fache von heute.
   - Steuer: Dividenden über dem Pauschbetrag werden im Jahr des Zuflusses besteuert.
   positions: [{isin, value0, cost0, yield0, isFund, g, dg, share}]  (g, dg, share als Anteile, nicht Prozent) */
function simulate(positions, o) {
  const tax = o.tax || { on: false };
  const st = positions.map(p => ({ p, value: p.value0, cost: p.cost0, pf: 1, gm: Math.pow(1 + p.g, 1 / 12) }));
  const exempt = p => (tax.on && tax.fundExemption && p.isFund ? 0.3 : 0);
  let invested = st.reduce((s, x) => s + x.value, 0), cash = 0;
  // Einzahlungen zusätzlich in heutiger Kaufkraft mitführen (jede Rate zum Zeitpunkt ihrer Zahlung abgezinst)
  const inflM = Math.pow(1 + (o.inflation || 0), 1 / 12);
  let investedReal = invested, defl = 1;

  // Jahr 0 = heute: Dividenden auf Basis des heutigen Bestands
  let allowance0 = tax.on ? tax.allowance : 0;
  const year0 = { k: 0, rate: 0, invested, investedReal, value: invested, cash: 0, divGross: 0, divNet: 0, per: {} };
  for (const x of st) {
    const gross = x.value * x.p.yield0;
    const taxable = gross * (1 - exempt(x.p));
    const free = Math.min(allowance0, taxable); allowance0 -= free;
    const net = gross - (tax.on ? (taxable - free) * tax.rate : 0);
    year0.divGross += gross; year0.divNet += net;
    year0.per[x.p.isin] = { value: x.value, divGross: gross, divNet: net };
  }
  const years = [year0];

  for (let k = 1; k <= o.years; k++) {
    const rate = o.rate * Math.pow(1 + o.dynamic, k - 1);
    let allowance = tax.on ? tax.allowance : 0;
    const rec = { k, rate, divGross: 0, divNet: 0, per: {} };
    for (const x of st) rec.per[x.p.isin] = { value: 0, divGross: 0, divNet: 0 };
    for (let m = 0; m < 12; m++) {
      defl *= inflM;
      for (const x of st) {
        x.value *= x.gm; x.pf *= x.gm;
        const buy = rate * x.p.share;
        x.value += buy; x.cost += buy; invested += buy; investedReal += buy / defl;
      }
      for (const x of st) {
        const gross = x.value * x.p.yield0 * Math.pow(1 + x.p.dg, k) / x.pf / 12;
        if (!gross) continue;
        const taxable = gross * (1 - exempt(x.p));
        const free = Math.min(allowance, taxable); allowance -= free;
        const net = gross - (tax.on ? (taxable - free) * tax.rate : 0);
        if (o.reinvest) { x.value += net; x.cost += net; } else cash += net;
        rec.divGross += gross; rec.divNet += net;
        rec.per[x.p.isin].divGross += gross; rec.per[x.p.isin].divNet += net;
      }
    }
    for (const x of st) rec.per[x.p.isin].value = x.value;
    rec.invested = invested; rec.investedReal = investedReal; rec.cash = cash;
    rec.value = st.reduce((s, x) => s + x.value, 0);
    years.push(rec);
  }
  // Steuer auf Kursgewinne, falls am Ende alles verkauft würde
  let saleTax = 0;
  if (tax.on) {
    const gains = st.reduce((s, x) => s + (x.value - x.cost) * (1 - exempt(x.p)), 0);
    saleTax = Math.max(0, gains - tax.allowance) * tax.rate;
  }
  return { years, saleTax };
}

function taxOptions() {
  const s = sim.settings;
  return { on: !!s.tax_on, rate: num(s.tax_rate) / 100, allowance: num(s.allowance), fundExemption: !!s.fund_exemption_on };
}
const deflate = (v, k) => (sim.settings.inflation_on ? v / Math.pow(1 + num(sim.settings.inflation) / 100, k) : v);

/* Baut die Eingaben für den Rechenkern.
   mode: Szenarioname | "hist" | "fixed" (eigene Dividendensteigerung, Kurs wie Szenario mittel) */
function simPositions(mode, { includeDepot = true, withPlan = false, fixedDividend = 0 } = {}) {
  const sc = sim.settings.scenarios;
  const shares = withPlan ? normalizedShares() : {};
  return sim.base.positions.filter(p => p.value).map(p => {
    let g, dg;
    if (mode === "hist") {
      g = clamp(p.price_growth == null ? num(sc.mittel.price) : p.price_growth, 0, 12);
      dg = clamp(p.growth5 == null ? 0 : p.growth5, 0, 10);
    } else if (mode === "fixed") {
      g = num(sc.mittel.price); dg = fixedDividend;
    } else {
      g = num(sc[mode].price); dg = num(sc[mode].dividend);
    }
    return {
      isin: p.isin, name: p.name, isFund: p.is_fund,
      value0: includeDepot ? p.value : 0,
      cost0: includeDepot ? (p.purchase_value == null ? p.value : p.purchase_value) : 0,
      yield0: (p.annual_eur || 0) / p.value,
      g: g / 100, dg: dg / 100, share: shares[p.isin] || 0,
    };
  });
}
function normalizedShares() {
  const raw = sim.plan.shares || {};
  const valid = sim.base.positions.filter(p => p.value).map(p => p.isin);
  const total = valid.reduce((s, i) => s + Math.max(0, num(raw[i])), 0);
  const out = {};
  if (total > 0) for (const i of valid) out[i] = Math.max(0, num(raw[i])) / total;
  return out;
}
function assumptionText() {
  const s = sim.settings, parts = [];
  parts.push(s.tax_on ? `Nach Steuern (${fmtNum.format(num(s.tax_rate))} %, Pauschbetrag ${fmtEur0.format(num(s.allowance))})` : "Vor Steuern");
  parts.push(s.inflation_on ? `in heutiger Kaufkraft (${fmt1.format(num(s.inflation))} % Inflation herausgerechnet)` : "ohne Inflationsabzug");
  return parts.join(", ") + ".";
}

// ================= Sparplan =================
let planSaveTimer;
function savePlanSoon() {
  clearTimeout(planSaveTimer);
  planSaveTimer = setTimeout(() => api("/api/sim/plan", { method: "PUT", json: sim.plan }).catch(() => {}), 600);
}
async function loadPlan(reason) {
  try { await simLoad(reason === "data"); } catch (e) {
    $("#spAssume").textContent = "Der Sparplan konnte nicht geladen werden (" + e.message + "). Falls oben ein Hinweis auf eine Aktualisierung steht, starte das Programm bitte neu.";
    return;
  }
  if (reason !== "theme") {
    const p = sim.plan;
    $("#spRate").value = p.rate; $("#spYears").value = p.years; $("#spDyn").value = p.dynamic;
    $("#spMode").value = p.growth_mode; $("#spScenario").value = p.scenario;
    $("#spDepot").checked = !!p.include_depot; $("#spReinvest").checked = !!p.reinvest;
    if (!Object.keys(p.shares || {}).length) setShares("like", false);
  }
  renderPlan();
}
function setShares(kind, save = true) {
  const list = sim.base.positions.filter(p => p.value);
  const total = list.reduce((s, p) => s + p.value, 0);
  sim.plan.shares = {};
  for (const p of list) {
    sim.plan.shares[p.isin] = kind === "zero" ? 0 : kind === "even" ? Math.round(1000 / list.length) / 10 : Math.round(p.value / total * 1000) / 10;
  }
  if (save) { savePlanSoon(); renderPlan(); }
}
function readPlanInputs() {
  const p = sim.plan;
  p.rate = Math.max(0, num($("#spRate").value));
  p.years = clamp(Math.round(num($("#spYears").value, 15)), 1, 40);
  p.dynamic = clamp(num($("#spDyn").value), 0, 20);
  p.growth_mode = $("#spMode").value; p.scenario = $("#spScenario").value;
  p.include_depot = $("#spDepot").checked; p.reinvest = $("#spReinvest").checked;
}
function runPlan(mode) {
  const p = sim.plan;
  return simulate(simPositions(mode, { includeDepot: p.include_depot, withPlan: true }),
    { years: p.years, rate: p.rate, dynamic: p.dynamic / 100, reinvest: p.reinvest, tax: taxOptions(),
      inflation: sim.settings.inflation_on ? num(sim.settings.inflation) / 100 : 0 });
}
const paidOf = y => (sim.settings.inflation_on ? y.investedReal : y.invested);
function renderPlan(keepTable = false) {
  if (!sim.base || !sim.settings) return;
  const p = sim.plan, hist = p.growth_mode === "hist";
  $("#spScLabel").hidden = hist;
  const list = sim.base.positions.filter(x => x.value);
  if (!list.length) { $("#spAssume").textContent = "Noch keine Positionen mit Kurs vorhanden."; return; }

  const runs = hist ? { hist: runPlan("hist") } : Object.fromEntries(SCENARIOS.map(([k]) => [k, runPlan(k)]));
  const mainKey = hist ? "hist" : p.scenario;
  const main = runs[mainKey], last = main.years[p.years];
  const shares = normalizedShares();
  const shareSum = list.reduce((s, x) => s + Math.max(0, num((p.shares || {})[x.isin])), 0);
  const sc = sim.settings.scenarios;

  $("#spAssume").textContent = (hist
    ? "Jede Position wächst wie im Durchschnitt der letzten Jahre (begrenzt auf 0 bis 12 % pro Jahr; ohne ausreichende Historie gilt das mittlere Szenario). "
    : `Szenarien: vorsichtig ${fmt1.format(num(sc.vorsichtig.price))} %, mittel ${fmt1.format(num(sc.mittel.price))} %, optimistisch ${fmt1.format(num(sc.optimistisch.price))} % Kurswachstum pro Jahr. `)
    + assumptionText();

  const endValue = deflate(last.value, p.years), paid = paidOf(last), cashOut = deflate(last.cash, p.years);
  $("#spEnd").textContent = eur(endValue);
  $("#spEndSub").textContent = (p.reinvest ? "" : `plus ${eur(cashOut)} ausgezahlte Dividenden · `) +
    (sim.settings.tax_on ? `nach Verkauf und Steuer: ${eur(deflate(last.value - main.saleTax, p.years))}` : (hist ? "historisches Wachstum" : "Szenario " + p.scenario));
  $("#spPaid").textContent = eur(paid);
  $("#spPaidSub").textContent = p.include_depot ? `davon heutiger Depotwert ${eur(main.years[0].value)}` : "nur Sparraten";
  const gain = endValue + (p.reinvest ? 0 : cashOut) - paid;
  $("#spGain").textContent = (gain > 0 ? "+" : "") + eur(gain);
  $("#spGain").className = "big " + cls(gain);
  $("#spGainSub").textContent = paid ? `${fmtPct.format(gain / paid * 100)} % auf das eingezahlte Kapital` : "";
  const divKey = sim.settings.tax_on ? "divNet" : "divGross";
  $("#spDiv").textContent = eur(deflate(last[divKey], p.years));
  $("#spDivSub").textContent = `heute: ${eur(main.years[0][divKey])} · ${sim.settings.tax_on ? "netto" : "brutto"}`;

  // Diagramm
  const year0 = new Date().getFullYear();
  const labels = main.years.map(y => (y.k === 0 ? "heute" : String(year0 + y.k)));
  const colors = { vorsichtig: cssVar("--s1"), mittel: cssVar("--s2"), optimistisch: cssVar("--s3"), hist: cssVar("--s1") };
  const names = { vorsichtig: "Vorsichtig", mittel: "Mittel", optimistisch: "Optimistisch", hist: "Wie bisher" };
  const datasets = Object.entries(runs).map(([k, r]) => ({
    label: names[k], data: r.years.map(y => Math.round(deflate(y.value, y.k))), borderColor: colors[k], backgroundColor: colors[k],
    borderWidth: k === mainKey ? 3 : 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.15,
  }));
  datasets.push({ label: "Eingezahlt", data: main.years.map(y => Math.round(paidOf(y))), borderColor: cssVar("--muted"), backgroundColor: cssVar("--muted"), borderWidth: 2, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 4, tension: 0 });
  const ink = cssVar("--muted");
  if (state.charts.spChart) state.charts.spChart.destroy();
  state.charts.spChart = new Chart($("#spChart"), {
    type: "line", data: { labels, datasets },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: cssVar("--text"), usePointStyle: true, pointStyle: "line", boxWidth: 28 } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmtEur0.format(c.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: cssVar("--axis") }, ticks: { color: ink, maxRotation: 0, autoSkipPadding: 16 } },
        y: { beginAtZero: true, grid: { color: cssVar("--grid") }, border: { display: false }, ticks: { color: ink, callback: v => fmtEur0.format(v) } },
      },
    },
  });

  // Aufteilung
  $("#spShareSum").textContent = shareSum > 0
    ? (Math.abs(shareSum - 100) < 0.5 ? "Summe: 100 %" : `Summe: ${fmt1.format(shareSum)} % – wird auf 100 % umgerechnet`)
    : "Keine Aufteilung gewählt – die Rate wird nicht angelegt.";
  const inputs = simPositions(mainKey, { includeDepot: p.include_depot, withPlan: true });
  if (!keepTable) {   // beim Tippen in ein Anteilsfeld bleibt die Tabelle stehen, nur die Zahlen werden aktualisiert
    $("#spTable tbody").replaceChildren(...list.map(x => {
      const inp = el("input", { type: "number", min: "0", max: "100", step: "1", value: num((p.shares || {})[x.isin]) });
      inp.addEventListener("input", () => { sim.plan.shares[x.isin] = Math.max(0, num(inp.value)); savePlanSoon(); renderPlan(true); });
      return el("tr", { "data-isin": x.isin },
        el("td", { class: "left" }, el("span", { class: "name" }, x.name)),
        el("td", {}, inp), el("td", { "data-c": "rate" }), el("td", { "data-c": "g" }),
        el("td", {}, eur(x.value)), el("td", { "data-c": "end" }));
    }));
  }
  for (const tr of $$("#spTable tbody tr")) {
    const isin = tr.dataset.isin, si = inputs.find(i => i.isin === isin);
    if (!si) continue;
    $('[data-c="rate"]', tr).textContent = eur(p.rate * (shares[isin] || 0));
    $('[data-c="g"]', tr).textContent = fmt1.format(si.g * 100) + " %";
    $('[data-c="end"]', tr).textContent = eur(deflate(last.per[isin].value, p.years));
  }

  $("#spYearsTable tbody").replaceChildren(...main.years.map(y => el("tr", {},
    el("td", { class: "left" }, y.k === 0 ? "heute" : String(year0 + y.k)),
    el("td", {}, y.k === 0 ? "–" : eur(y.rate)),
    el("td", {}, eur(paidOf(y))),
    el("td", {}, eur(deflate(y.value, y.k))),
    el("td", {}, eur(deflate(y[divKey], y.k))))));
}
["#spRate", "#spYears", "#spDyn"].forEach(s => $(s).addEventListener("input", () => { readPlanInputs(); savePlanSoon(); renderPlan(); }));
["#spMode", "#spScenario", "#spDepot", "#spReinvest"].forEach(s => $(s).addEventListener("change", () => { readPlanInputs(); savePlanSoon(); renderPlan(); }));
$("#spEven").addEventListener("click", () => setShares("even"));
$("#spLike").addEventListener("click", () => setShares("like"));
$("#spZero").addEventListener("click", () => setShares("zero"));
TAB_HOOKS.plan = loadPlan;

// ================= Dividendenrechner =================
let projection = null;
async function renderProjection() {
  if (!divData) return;
  sim.base = divData;
  if (!sim.settings) { try { await simLoad(); } catch (e) { toast(e.message); return; } sim.base = divData; }
  const isin = $("#dpSelect").value, mode = $("#dpMode").value, withPlan = $("#dpPlan").checked;
  const years = clamp(Math.round(num($("#dpYears").value, 10)), 1, 40);
  $("#dpRateLabel").hidden = mode !== "fixed";
  const s = sim.settings, plan = sim.plan;
  const positions = simPositions(mode, { includeDepot: true, withPlan, fixedDividend: num($("#dpRate").value) });
  const run = simulate(positions, {
    years, rate: withPlan ? plan.rate : 0, dynamic: withPlan ? plan.dynamic / 100 : 0,
    reinvest: withPlan ? plan.reinvest : false, tax: taxOptions(),
  });
  const key = s.tax_on ? "divNet" : "divGross";
  const pick = y => deflate(isin ? (y.per[isin] ? y.per[isin][key] : 0) : y[key], y.k);
  const year0 = new Date().getFullYear();
  const values = run.years.map(y => Math.round(pick(y) * 100) / 100);
  projection = { run, key, isin, year0 };
  barChart("divProj", run.years.map(y => (y.k === 0 ? "heute" : String(year0 + y.k))), values);

  const sc = s.scenarios;
  $("#exScen").textContent = `Alle Dividenden steigen jedes Jahr um denselben Prozentsatz: vorsichtig ${fmt1.format(num(sc.vorsichtig.dividend))} %, mittel ${fmt1.format(num(sc.mittel.dividend))} %, optimistisch ${fmt1.format(num(sc.optimistisch.dividend))} %. Die Sätze kannst du in den Einstellungen ändern.`;
  const modeText = mode === "hist" ? "Jede Position steigert ihre Dividende wie im Schnitt der letzten 5 Jahre (0 bis 10 %, ohne Historie 0 %)."
    : mode === "fixed" ? `Alle Dividenden steigen um ${fmt1.format(num($("#dpRate").value))} % pro Jahr.`
    : `Alle Dividenden steigen um ${fmt1.format(num(sc[mode].dividend))} % pro Jahr.`;
  $("#dpAssume").textContent = "Gerechnet wird gerade so: " + modeText + " " +
    (withPlan ? `Mit Sparplan: ${eur(plan.rate)} pro Monat${plan.reinvest ? ", Dividenden werden wieder angelegt" : ""}. ` : "Bestand bleibt gleich. ") + assumptionText();

  const total = values.slice(1).reduce((a, b) => a + b, 0);
  $("#dpSummary").textContent = values[0] || values[years]
    ? `Heute rund ${eur(values[0])} pro Jahr, in ${years} Jahren rund ${eur(values[years])} pro Jahr. Summe über ${years} Jahre: rund ${eur(total)}.`
    : "Für diese Auswahl werden keine Dividenden erwartet.";

  const sel = $("#dpYearSel"), cur = sel.value;
  sel.replaceChildren(...run.years.slice(1).map(y => el("option", { value: y.k }, String(year0 + y.k))));
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : "1";
  renderProjectionMonths();
}
function renderProjectionMonths() {
  if (!projection) return;
  const { run, key, isin } = projection;
  const k = clamp(num($("#dpYearSel").value, 1), 1, run.years.length - 1), rec = run.years[k];
  // Zahlungsmuster je Position: Anteil je Kalendermonat aus den erwarteten Zahlungen der nächsten 12 Monate
  const months = Array.from({ length: 12 }, () => ({ total: 0, items: [] }));
  const pattern = {};
  for (const u of divData.upcoming) {
    if (u.extra) continue;
    const m = Number((u.pay_date || u.ex_date).slice(5, 7)) - 1;
    (pattern[u.isin] = pattern[u.isin] || new Array(12).fill(0))[m] += u.amount_eur;
  }
  for (const p of divData.positions) {
    if (isin && p.isin !== isin) continue;
    const pat = pattern[p.isin], per = rec.per[p.isin];
    if (!pat || !per) continue;
    const sum = pat.reduce((a, b) => a + b, 0);
    if (!sum) continue;
    pat.forEach((w, m) => {
      if (!w) return;
      const amount = deflate(per[key] * w / sum, k);
      months[m].total += amount; months[m].items.push({ name: p.name, amount });
    });
  }
  barChart("divProjMonths", MONTHS_SHORT, months.map(m => Math.round(m.total * 100) / 100),
    i => [...months[i].items].sort((a, b) => b.amount - a.amount).slice(0, 8).map(it => `${it.name}: ${fmtEur.format(it.amount)}`));
}
["#dpSelect", "#dpMode", "#dpPlan"].forEach(s => $(s).addEventListener("change", renderProjection));
["#dpYears", "#dpRate"].forEach(s => $(s).addEventListener("input", renderProjection));
$("#dpYearSel").addEventListener("change", renderProjectionMonths);

// ================= Annahmen (Einstellungen) =================
function fillSimForm() {
  const f = $("#simForm"), s = sim.settings;
  for (const [name] of SCENARIOS) {
    f.elements[`${name}.price`].value = s.scenarios[name].price;
    f.elements[`${name}.dividend`].value = s.scenarios[name].dividend;
  }
  for (const k of ["inflation", "tax_rate", "allowance"]) f.elements[k].value = s[k];
  for (const k of ["inflation_on", "tax_on", "fund_exemption_on"]) f.elements[k].checked = !!s[k];
}
async function loadSimSettings(reason) {
  if (reason === "theme") return;
  try { const r = await api("/api/sim"); sim.settings = r.settings; sim.plan = sim.plan || r.plan; fillSimForm(); } catch (e) { toast(e.message); }
}
async function saveSimSettings(body) {
  sim.settings = await api("/api/sim/settings", { method: "PUT", json: body });
  fillSimForm();
}
$("#simForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, body = { scenarios: {} };
  for (const [name] of SCENARIOS) body.scenarios[name] = { price: num(f.elements[`${name}.price`].value), dividend: num(f.elements[`${name}.dividend`].value) };
  for (const k of ["inflation", "tax_rate", "allowance"]) body[k] = num(f.elements[k].value);
  for (const k of ["inflation_on", "tax_on", "fund_exemption_on"]) body[k] = f.elements[k].checked;
  try { await saveSimSettings(body); toast("Annahmen gespeichert."); } catch (err) { toast(err.message); }
});
$("#simReset").addEventListener("click", async () => {
  try { await saveSimSettings({}); toast("Standardwerte wiederhergestellt."); } catch (err) { toast(err.message); }
});
TAB_HOOKS.settings = loadSimSettings;
