/* SiteTrackerPro — interactive demo
   Runs entirely in the browser with sample data. The calculations below mirror
   the production backend: cut & fill volumes and the three-factor delivery
   fraud score (price 75 / quantity 20 / timing 8, block threshold 70). */
(function () {
  "use strict";

  var D = window.STP_DATA;
  var LS = "stp-demo-v1";

  /* ---------------- utils ---------------- */
  function fmt(n, d) {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: d || 0,
      maximumFractionDigits: d || 0
    }).format(isFinite(n) ? n : 0);
  }
  function money(n) { return fmt(Math.round(n)) + " " + D.currency; }
  function r1(v) { return Math.round((isFinite(v) ? v : 0) * 10) / 10; }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function num(v, fallback) { var n = parseFloat(v); return isFinite(n) ? n : fallback; }
  function project() {
    return D.projects.filter(function (p) { return p.id === state.projectId; })[0] || D.projects[0];
  }

  /* ---------------- state ---------------- */
  function defaults() {
    return {
      screen: "dashboard",
      projectId: 1,
      rates: {},
      calcs: [],
      checks: [],
      progress: D.progress_history.slice(),
      ui: {
        footprint: 2400, depth: 2.5, fill: 10,
        area: 400, category: "All", search: "",
        fqty: 120, fexp: 120, fprice: 1450, fmarket: 1230,
        fdel: "2026-10-19", fexpd: "2026-10-12"
      }
    };
  }
  var state;
  try {
    var raw = localStorage.getItem(LS);
    state = raw ? JSON.parse(raw) : defaults();
    if (!state || !state.ui) state = defaults();
  } catch (e) { state = defaults(); }
  function persist() { try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) {} }

  /* ---------------- domain logic (mirrors backend) ---------------- */
  function earthworks(footprint, depth, fillNeeded) {
    var cut = footprint * depth;
    var fill = fillNeeded * footprint;
    return { cut: cut, fill: fill, net: fill - cut };
  }

  var FRAUD = {
    price: { label: "Unit price vs market price", cap: 75, tolerance: 5, saturation: 20, unit: "%" },
    quantity: { label: "Delivered quantity vs expected quantity", cap: 20, tolerance: 5, saturation: 25, unit: "%" },
    timing: { label: "Delivery date vs expected date", cap: 8, tolerance: 1, saturation: 5, unit: " wk" }
  };
  var BLOCK = 70, CEIL = 99, WEEK = 604800000;

  function ramp(mag, rule) {
    var span = rule.saturation - rule.tolerance;
    if (!isFinite(mag) || span <= 0) return 0;
    var ratio = (mag - rule.tolerance) / span;
    return rule.cap * Math.min(Math.max(ratio, 0), 1);
  }
  function factor(key, mag, rule, note) {
    var pts = ramp(mag, rule);
    var within = !(mag > rule.tolerance);
    return {
      key: key, label: rule.label, measured: r1(mag), unit: rule.unit,
      tolerance: rule.tolerance, saturation: rule.saturation, maxPoints: rule.cap,
      points: r1(pts), withinTolerance: within,
      explanation: note || (within
        ? "Inside the " + rule.tolerance + rule.unit + " tolerance — no points."
        : "Scores from " + rule.tolerance + rule.unit + "; reaches the full " + rule.cap +
          " points at " + rule.saturation + rule.unit + ".")
    };
  }
  function scoreFraud(v) {
    var qtyVar = (v.actualQty - v.expectedQty) / (v.expectedQty || 1);
    var priceVar = (v.actualPrice - v.marketPrice) / (v.marketPrice || 1);
    var days = Math.abs(v.delivered - v.expected) / WEEK;
    var over = Math.max(0, priceVar) * 100;

    var factors = [
      factor("price", over, FRAUD.price,
        priceVar < 0 ? "Invoiced below market price — no overcharge to flag." : null),
      factor("quantity", Math.abs(qtyVar) * 100, FRAUD.quantity),
      factor("timing", days, FRAUD.timing)
    ];
    var rawTotal = factors.reduce(function (s, f) { return s + f.points; }, 0);
    var score = r1(Math.min(rawTotal, CEIL));
    var blocked = score >= BLOCK;
    var excess = Math.max(0, v.actualQty * v.actualPrice - v.expectedQty * v.marketPrice);
    return {
      score: score, blocked: blocked, recommend: blocked ? "BLOCK_PAYMENT" : "APPROVE",
      factors: factors, raw: r1(rawTotal), excess: Math.round(excess * 100) / 100,
      capped: rawTotal > CEIL, weeks: r1(days)
    };
  }

  function rateFor(m) {
    var key = m.material_type + "|" + m.unit;
    return state.rates[key] !== undefined ? state.rates[key] : m.cost;
  }
  function bomRows(area) {
    return D.materials.map(function (m) {
      var qty = m.standard_quantity * area;
      var rate = rateFor(m);
      return { m: m, qty: qty, rate: rate, amount: qty * rate };
    });
  }

  /* ---------------- csv ---------------- */
  function escCsv(v) {
    var t = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function downloadCsv(name, rows) {
    var csv = rows.map(function (r) { return r.map(escCsv).join(","); }).join("\r\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  /* ---------------- icons ---------------- */
  var IC = {
    dash: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    proj: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h18M3 12h18M3 17h11"/></svg>',
    surv: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 20h20"/><path d="M4 20 12 4l8 16"/><path d="M8.5 13h7"/></svg>',
    mat: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8 12 3l8 5v8l-8 5-8-5Z"/><path d="M8 10.5h8M8 14h5"/></svg>',
    fraud: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 4v6c0 5-3.5 7.5-8 8-4.5-.5-8-3-8-8V7Z"/><path d="m9 12 2 2 4-4"/></svg>',
    prog: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20V8"/></svg>'
  };

  /* ---------------- shell ---------------- */
  var view = document.getElementById("view");
  var titleEl = document.getElementById("pageTitle");
  var subEl = document.getElementById("pageSub");
  var projSel = document.getElementById("projSel");

  var SCREENS = [
    { id: "dashboard", label: "Dashboard", title: "Dashboard", sub: "Portfolio health, alerts and recent activity", icon: IC.dash },
    { id: "projects", label: "Projects", title: "Projects", sub: "Every project and its current position", icon: IC.proj },
    { id: "surveying", label: "Surveying", title: "Surveying & earthworks", sub: "Cut and fill from footprint, depth and fill depth", icon: IC.surv },
    { id: "materials", label: "Materials & BOM", title: "Materials & bill of quantities", sub: "Standard rates per unit, quantities from floor area", icon: IC.mat },
    { id: "fraud", label: "Fraud check", title: "Delivery fraud check", sub: "Three-factor scoring with the arithmetic shown", icon: IC.fraud },
    { id: "progress", label: "Progress", title: "Progress history", sub: "Every update kept, never overwritten", icon: IC.prog }
  ];

  function buildNav() {
    document.getElementById("nav").innerHTML = SCREENS.map(function (s) {
      return '<button data-go="' + s.id + '" class="' + (state.screen === s.id ? "on" : "") + '" type="button">' +
        s.icon + '<span class="lbl">' + s.label + "</span></button>";
    }).join("");
  }

  function setScreen(id) {
    state.screen = id;
    persist();
    render();
  }

  function render() {
    var s = SCREENS.filter(function (x) { return x.id === state.screen; })[0] || SCREENS[0];
    titleEl.textContent = s.title;
    subEl.textContent = s.sub;
    projSel.value = String(state.projectId);
    buildNav();
    if (state.screen === "dashboard") renderDashboard();
    else if (state.screen === "projects") renderProjects();
    else if (state.screen === "surveying") renderSurveying();
    else if (state.screen === "materials") renderMaterials();
    else if (state.screen === "fraud") renderFraud();
    else renderProgress();
    view.scrollIntoView ? window.scrollTo({ top: 0 }) : null;
  }

  /* ---------------- dashboard ---------------- */
  function renderDashboard() {
    var p = project();
    var budget = D.projects.reduce(function (s, x) { return s + x.budget; }, 0);
    var avg = D.projects.reduce(function (s, x) { return s + x.progress; }, 0) / D.projects.length;
    var blocked = state.checks.filter(function (c) { return c.blocked; }).length;
    var alerts = state.checks.length;
    var lastCalc = state.calcs.filter(function (c) { return c.projectId === p.id; })[0];

    var html = notice() +
      '<div class="grid g4" style="margin-bottom:1rem">' +
        kpi("Active projects", D.projects.length, "in this workspace") +
        kpi("Portfolio budget", fmt(budget / 1000000, 1) + "M", D.currency, true) +
        kpi("Average progress", fmt(avg) + "%", "across all projects") +
        kpi("Payment blocks raised", blocked, alerts + " checks run") +
      "</div>" +
      '<div class="grid g2">' +
        '<div class="card">' +
          '<div class="card-t">Current project</div>' +
          '<h2 style="margin-bottom:.2rem">' + esc(p.name) + "</h2>" +
          '<p class="sm muted">' + esc(p.location) + " · " + esc(p.timeline) + " · " + money(p.budget) + "</p>" +
          '<p class="sm" style="margin-top:.6rem;color:#b9cbcf">' + esc(p.description) + "</p>" +
          '<div style="margin-top:1rem"><div class="tiny muted" style="display:flex;justify-content:space-between;margin-bottom:.35rem"><span>Progress</span><span>' + p.progress + "%</span></div>" +
            '<div class="bar"><i style="width:' + p.progress + '%"></i></div></div>' +
          '<div style="margin-top:.9rem"><div class="tiny muted" style="display:flex;justify-content:space-between;margin-bottom:.35rem"><span>Spend</span><span>' + money(p.spent) + "</span></div>" +
            '<div class="bar sand"><i style="width:' + Math.min(100, (p.spent / p.budget) * 100).toFixed(1) + '%"></i></div></div>' +
        "</div>" +
        '<div class="card">' +
          '<div class="card-t">Latest earthworks</div>' +
          (lastCalc
            ? '<div class="res" style="grid-template-columns:1fr 1fr 1fr;margin-top:.4rem">' +
                '<div><div class="tiny muted">Cut</div><div class="kpi" style="font-size:1.1rem">' + fmt(lastCalc.cut) + ' m³</div></div>' +
                '<div><div class="tiny muted">Fill</div><div class="kpi" style="font-size:1.1rem">' + fmt(lastCalc.fill) + ' m³</div></div>' +
                '<div><div class="tiny muted">Net import</div><div class="kpi" style="font-size:1.1rem;color:' + (lastCalc.net > 0 ? "var(--sand)" : "var(--accent)") + '">' + fmt(lastCalc.net) + ' m³</div></div>' +
              "</div>" +
              '<p class="tiny muted" style="margin-top:.8rem">Calculated on ' + esc(lastCalc.when) + " for " + esc(lastCalc.footprint) + " m² at " + esc(lastCalc.depth) + " m depth.</p>"
            : '<p class="sm muted" style="margin-top:.5rem">No calculation yet for this project. Open <b>Surveying</b> to run one.</p>') +
          '<div style="margin-top:1rem;display:flex;gap:.5rem;flex-wrap:wrap">' +
            '<button class="btn btn-g btn-sm" data-go="surveying" type="button">Run a cut &amp; fill</button>' +
            '<button class="btn btn-g btn-sm" data-go="fraud" type="button">Score a delivery</button>' +
          "</div>" +
        "</div>" +
      "</div>" +
      '<div class="card" style="margin-top:1rem">' +
        '<div class="card-t">Recent activity</div>' +
        activityList() +
      "</div>";

    view.innerHTML = html;
  }

  function activityList() {
    var items = [];
    state.progress.slice(-6).reverse().forEach(function (g) {
      items.push({ when: g.date, what: "Progress logged: " + g.progress_percent + "%", note: g.notes });
    });
    state.checks.slice(-4).reverse().forEach(function (c) {
      items.push({
        when: c.when,
        what: (c.blocked ? "Payment blocked — score " : "Delivery approved — score ") + c.score,
        note: c.material + " · " + money(c.excess)
      });
    });
    if (!items.length) return '<p class="sm muted">No activity yet.</p>';
    items.sort(function (a, b) { return a.when < b.when ? 1 : -1; });
    return '<table><tbody>' + items.slice(0, 7).map(function (i) {
      return "<tr><td style='width:110px;color:#7d949c;font-size:.78rem'>" + esc(i.when) + "</td><td>" +
        esc(i.what) + '<div class="tiny muted">' + esc(i.note || "") + "</div></td></tr>";
    }).join("") + "</tbody></table>";
  }

  function kpi(label, value, sub, raw) {
    return '<div class="card"><div class="card-t">' + esc(label) + '</div><div class="kpi">' +
      esc(value) + (raw ? "" : "") + "</div><div class=\"tiny muted\">" + esc(sub) + "</div></div>";
  }

  function notice() {
    return '<div class="notice"><span>◆</span><div><b>Demo workspace.</b> ' +
      "Sample Ethiopian projects and materials, running entirely in your browser — nothing is sent to a server, " +
      "and anything you enter stays on this device (use Reset to clear it).</div></div>";
  }

  /* ---------------- projects ---------------- */
  function renderProjects() {
    var html = notice() + '<div class="grid g3">' + D.projects.map(function (p) {
      var active = p.id === state.projectId;
      return '<div class="card" style="' + (active ? "border-color:rgba(57,217,138,.45)" : "") + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:start;gap:.6rem">' +
          '<h3>' + esc(p.name) + "</h3>" +
          (active ? '<span class="badge ok">Selected</span>' : "") +
        "</div>" +
        '<p class="sm muted" style="margin-top:.3rem">' + esc(p.location) + " · " + esc(p.timeline) + "</p>" +
        '<p class="tiny" style="margin-top:.6rem;color:#b9cbcf">' + esc(p.description) + "</p>" +
        '<div style="margin-top:.9rem"><div class="tiny muted" style="display:flex;justify-content:space-between;margin-bottom:.3rem"><span>' + money(p.budget) + "</span><span>" + p.progress + "%</span></div>" +
          '<div class="bar"><i style="width:' + p.progress + '%"></i></div></div>' +
        '<div style="margin-top:1rem;display:flex;gap:.5rem">' +
          '<button class="btn btn-g btn-sm" data-select="' + p.id + '" type="button">' + (active ? "Open surveying" : "Select project") + "</button>" +
        "</div>" +
      "</div>";
    }).join("") + "</div>";
    view.innerHTML = html;
  }

  /* ---------------- surveying ---------------- */
  function renderSurveying() {
    var u = state.ui;
    view.innerHTML = notice() +
      '<div class="grid g2">' +
        '<div class="card">' +
          '<div class="card-t">Earthworks input</div>' +
          '<div class="form" style="margin-top:.6rem">' +
            field("Building footprint (m²)", "footprint", u.footprint, "number") +
            field("Foundation depth (m)", "depth", u.depth, "number") +
            field("Fill depth required (m)", "fill", u.fill, "number") +
            '<p class="hint">Footprint and depth must be greater than zero. Fill may be zero on a level site, or negative where the site is cut-only.</p>' +
            '<div style="display:flex;gap:.5rem;flex-wrap:wrap">' +
              '<button class="btn btn-p" id="saveCalc" type="button">Save calculation</button>' +
              '<button class="btn btn-g" id="resetCalc" type="button">Reset inputs</button>' +
            "</div>" +
          "</div>" +
        "</div>" +
        '<div class="card"><div class="card-t">Result</div><div id="survOut"></div></div>' +
      "</div>" +
      '<div class="card" style="margin-top:1rem"><div class="card-t">Saved calculations</div><div id="calcList"></div></div>';

    ["footprint", "depth", "fill"].forEach(function (k) {
      document.getElementById("f_" + k).addEventListener("input", function (e) {
        state.ui[k] = e.target.value;
        persist();
        paintSurveying();
      });
    });
    document.getElementById("resetCalc").addEventListener("click", function () {
      state.ui.footprint = 2400; state.ui.depth = 2.5; state.ui.fill = 10;
      persist(); render();
    });
    document.getElementById("saveCalc").addEventListener("click", function () {
      var v = surveyValues();
      if (!v.ok) return;
      var p = project();
      state.calcs.unshift({
        projectId: p.id, projectName: p.name, footprint: v.footprint, depth: v.depth,
        fillNeeded: v.fill, cut: v.cut, fill: v.fillVol, net: v.net, when: today()
      });
      persist(); render();
    });
    paintSurveying();
  }

  function surveyValues() {
    var u = state.ui;
    var footprint = num(u.footprint, 0);
    var depth = num(u.depth, 0);
    var fillNeeded = num(u.fill, 0);
    var ok = footprint > 0 && depth > 0;
    var r = earthworks(footprint, depth, fillNeeded);
    return { ok: ok, footprint: footprint, depth: depth, fill: fillNeeded, cut: r.cut, fillVol: r.fill, net: r.net };
  }

  function paintSurveying() {
    var v = surveyValues();
    var out = document.getElementById("survOut");
    if (!v.ok) {
      out.innerHTML = '<p class="sm" style="color:var(--red);margin-top:.5rem">Footprint and foundation depth must both be greater than zero.</p>';
    } else {
      var max = Math.max(v.cut, v.fillVol, 1);
      var pctCut = (v.cut / max) * 100, pctFill = (v.fillVol / max) * 100;
      out.innerHTML =
        '<div class="res" style="margin-top:.5rem">' +
          resCard("Cut volume", fmt(v.cut) + " m³", "footprint × depth") +
          resCard("Fill volume", fmt(v.fillVol) + " m³", "fill depth × footprint") +
          resCard(v.net > 0 ? "Net import" : "Net surplus", fmt(Math.abs(v.net)) + " m³",
            (v.net > 0 ? "import to site" : "surplus to remove"), v.net > 0 ? "var(--sand)" : "var(--accent)") +
        "</div>" +
        '<div style="margin-top:1.1rem">' +
          '<div class="tiny muted" style="display:flex;justify-content:space-between;margin-bottom:.3rem"><span>Cut</span><span>' + fmt(v.cut) + ' m³</span></div>' +
          '<div class="bar" style="margin-bottom:.7rem"><i style="width:' + pctCut.toFixed(1) + '%"></i></div>' +
          '<div class="tiny muted" style="display:flex;justify-content:space-between;margin-bottom:.3rem"><span>Fill</span><span>' + fmt(v.fillVol) + ' m³</span></div>' +
          '<div class="bar sand"><i style="width:' + pctFill.toFixed(1) + '%"></i></div>' +
        "</div>" +
        '<p class="tiny muted" style="margin-top:1rem">Cut = footprint × foundation depth. Fill = fill depth × footprint. ' +
        "Net = fill − cut, so a positive figure is material brought to site.</p>";
    }
    var list = document.getElementById("calcList");
    if (!state.calcs.length) {
      list.innerHTML = '<p class="sm muted">Nothing saved yet. Calculations you save here appear in this list.</p>';
    } else {
      list.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Project</th><th class="num">Footprint</th><th class="num">Cut</th><th class="num">Fill</th><th class="num">Net</th></tr></thead><tbody>' +
        state.calcs.map(function (c) {
          return "<tr><td>" + esc(c.when) + "</td><td>" + esc(c.projectName) + '</td><td class="num">' + fmt(c.footprint) + ' m²</td><td class="num">' + fmt(c.cut) +
            ' m³</td><td class="num">' + fmt(c.fill) + ' m³</td><td class="num">' + fmt(c.net) + " m³</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
  }

  function resCard(label, value, sub, colour) {
    return '<div class="card"><div class="card-t">' + esc(label) + '</div><div class="kpi" style="' +
      (colour ? "color:" + colour : "") + '">' + esc(value) + '</div><div class="tiny muted">' + esc(sub) + "</div></div>";
  }

  /* ---------------- materials ---------------- */
  function renderMaterials() {
    var cats = ["All"].concat(D.materials.map(function (m) { return m.category; })
      .filter(function (c, i, a) { return a.indexOf(c) === i; }));
    view.innerHTML = notice() +
      '<div class="card" style="margin-bottom:1rem">' +
        '<div style="display:grid;grid-template-columns:1.2fr 1fr 1.4fr;gap:.8rem;align-items:end">' +
          '<div><label for="area">Floor area (m²)</label><input id="area" type="number" min="1" step="10" value="' + esc(state.ui.area) + '"></div>' +
          '<div><label for="cat">Category</label><select id="cat">' + cats.map(function (c) {
            return '<option' + (state.ui.category === c ? " selected" : "") + ">" + esc(c) + "</option>";
          }).join("") + "</select></div>" +
          '<div><label for="q">Find a material</label><input id="q" type="text" placeholder="Cement, rebar, cable…" value="' + esc(state.ui.search) + '"></div>' +
        "</div>" +
        '<div style="display:flex;gap:.5rem;margin-top:.9rem;flex-wrap:wrap;align-items:center">' +
          '<button class="btn btn-p btn-sm" id="exportBom" type="button">Export BOM (CSV)</button>' +
          '<span class="tiny muted" id="bomMeta"></span>' +
        "</div>" +
      "</div>" +
      '<div class="tbl-wrap"><table><thead><tr>' +
        "<th>Material</th><th>Category</th><th>Unit</th><th class=\"num\">Qty / m²</th>" +
        '<th class="num">Quantity</th><th class="num">Rate (' + D.currency + ")</th><th class=\"num\">Amount</th>" +
      '</tr></thead><tbody id="bomBody"></tbody><tfoot id="bomFoot"></tfoot></table></div>' +
      '<p class="hint" style="margin-top:.7rem">Standard quantities are the Ethiopian practice figures loaded with the platform. Rates are sample market rates, held per project and editable — change one and the line amount and total update.</p>';

    document.getElementById("area").addEventListener("input", function (e) {
      state.ui.area = e.target.value; persist(); paintBom();
    });
    document.getElementById("cat").addEventListener("change", function (e) {
      state.ui.category = e.target.value; persist(); paintBom();
    });
    document.getElementById("q").addEventListener("input", function (e) {
      state.ui.search = e.target.value; persist(); paintBom();
    });
    document.getElementById("bomBody").addEventListener("input", function (e) {
      if (!e.target.classList.contains("rate-in")) return;
      var key = e.target.getAttribute("data-key");
      state.rates[key] = num(e.target.value, 0);
      persist();
      var row = e.target.closest("tr");
      var amountCell = row.querySelector(".amt");
      var qty = parseFloat(row.getAttribute("data-qty"));
      amountCell.textContent = money(qty * state.rates[key]);
      paintTotal();
    });
    document.getElementById("exportBom").addEventListener("click", exportBom);
    paintBom();
  }

  function filteredBom() {
    var area = num(state.ui.area, 0);
    var cat = state.ui.category, q = (state.ui.search || "").toLowerCase();
    return bomRows(area).filter(function (r) {
      if (cat !== "All" && r.m.category !== cat) return false;
      if (q && (r.m.material_type + " " + r.m.notes).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function paintBom() {
    var rows = filteredBom();
    var body = document.getElementById("bomBody");
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No materials match that filter.</td></tr>';
      document.getElementById("bomFoot").innerHTML = "";
      document.getElementById("bomMeta").textContent = "";
      return;
    }
    body.innerHTML = rows.map(function (r) {
      var key = r.m.material_type + "|" + r.m.unit;
      return '<tr data-qty="' + r.qty + '">' +
        "<td>" + esc(r.m.material_type) + '<div class="tiny muted">' + esc(r.m.notes) + "</div></td>" +
        '<td class="tiny">' + esc(r.m.category) + "</td>" +
        '<td class="tiny">' + esc(r.m.unit) + "</td>" +
        '<td class="num tiny">' + fmt(r.m.standard_quantity, 2) + "</td>" +
        '<td class="num">' + fmt(r.qty, 1) + "</td>" +
        '<td class="num"><input class="rate-in" type="number" step="10" min="0" data-key="' + esc(key) + '" value="' + r.rate + '"></td>' +
        '<td class="num amt">' + money(r.amount) + "</td>" +
      "</tr>";
    }).join("");
    document.getElementById("bomMeta").textContent = rows.length + " of " + D.materials.length +
      " materials · floor area " + fmt(num(state.ui.area, 0)) + " m²";
    paintTotal();
  }

  function paintTotal() {
    var rows = filteredBom();
    var total = rows.reduce(function (s, r) {
      var key = r.m.material_type + "|" + r.m.unit;
      var rate = state.rates[key] !== undefined ? state.rates[key] : r.m.cost;
      return s + r.qty * rate;
    }, 0);
    document.getElementById("bomFoot").innerHTML =
      '<tr class="total-row"><td colspan="6">Estimated material cost</td><td class="num">' + money(total) + "</td></tr>";
  }

  function exportBom() {
    var rows = filteredBom();
    var out = [["Material", "Category", "Unit", "Qty per m2", "Quantity", "Rate " + D.currency, "Amount " + D.currency]];
    rows.forEach(function (r) {
      var key = r.m.material_type + "|" + r.m.unit;
      var rate = state.rates[key] !== undefined ? state.rates[key] : r.m.cost;
      out.push([r.m.material_type, r.m.category, r.m.unit, r.m.standard_quantity,
        Math.round(r.qty * 100) / 100, rate, Math.round(r.qty * rate * 100) / 100]);
    });
    var total = rows.reduce(function (s, r) {
      var key = r.m.material_type + "|" + r.m.unit;
      var rate = state.rates[key] !== undefined ? state.rates[key] : r.m.cost;
      return s + r.qty * rate;
    }, 0);
    out.push(["TOTAL", "", "", "", "", "", Math.round(total * 100) / 100]);
    downloadCsv("sitetrackerpro-bom-" + today() + ".csv", out);
  }

  /* ---------------- fraud ---------------- */
  function renderFraud() {
    var u = state.ui;
    view.innerHTML = notice() +
      '<div class="grid g2">' +
        '<div class="card">' +
          '<div class="card-t">Delivery being checked</div>' +
          '<div class="form" style="margin-top:.6rem">' +
            '<div><label for="fmat">Material</label><select id="fmat">' +
              ["Cement (Type I OPC)", "Rebar Steel (Y12)", "Coarse Aggregate (20mm)", "Structural Steel Beams", "Sand (Foundation Grade)"]
                .map(function (m) { return "<option>" + esc(m) + "</option>"; }).join("") +
            "</select></div>" +
            '<div class="row">' + field("Expected quantity", "fexp", u.fexp, "number") + field("Delivered quantity", "fqty", u.fqty, "number") + "</div>" +
            '<div class="row">' + field("Market price per unit", "fmarket", u.fmarket, "number") + field("Invoiced price per unit", "fprice", u.fprice, "number") + "</div>" +
            '<div class="row">' + dateField("Expected delivery", "fexpd", u.fexpd) + dateField("Actual delivery", "fdel", u.fdel) + "</div>" +
            '<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.2rem">' +
              '<button class="btn btn-g btn-sm" data-preset="clean" type="button">Clean delivery</button>' +
              '<button class="btn btn-g btn-sm" data-preset="over" type="button">20% overcharge</button>' +
              '<button class="btn btn-g btn-sm" data-preset="short" type="button">Short delivery</button>' +
              '<button class="btn btn-p btn-sm" id="saveCheck" type="button">Save check</button>' +
            "</div>" +
            '<p class="hint">Price carries 75 of the 100 points: an overcharge is where money leaves. Quantity carries 20, timing 8. A score of 70 or more blocks payment.</p>' +
          "</div>" +
        "</div>" +
        '<div class="card"><div class="card-t">Score</div><div id="fraudOut"></div></div>' +
      "</div>" +
      '<div class="card" style="margin-top:1rem"><div class="card-t">Checks saved in this session</div><div id="checkList"></div></div>';

    ["fexp", "fqty", "fmarket", "fprice", "fexpd", "fdel"].forEach(function (k) {
      document.getElementById("f_" + k).addEventListener("input", function (e) {
        state.ui[k] = e.target.value; persist(); paintFraud();
      });
    });
    document.querySelectorAll("[data-preset]").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = b.getAttribute("data-preset");
        if (p === "clean") {
          state.ui.fexp = 120; state.ui.fqty = 121; state.ui.fmarket = 1230;
          state.ui.fprice = 1245; state.ui.fexpd = "2026-10-12"; state.ui.fdel = "2026-10-13";
        } else if (p === "over") {
          state.ui.fexp = 120; state.ui.fqty = 120; state.ui.fmarket = 1230;
          state.ui.fprice = 1476; state.ui.fexpd = "2026-10-12"; state.ui.fdel = "2026-10-12";
        } else {
          state.ui.fexp = 120; state.ui.fqty = 92; state.ui.fmarket = 1230;
          state.ui.fprice = 1320; state.ui.fexpd = "2026-10-12"; state.ui.fdel = "2026-10-27";
        }
        persist(); render();
      });
    });
    document.getElementById("saveCheck").addEventListener("click", function () {
      var r = fraudResult();
      state.checks.unshift({
        when: today(), material: document.getElementById("fmat").value,
        score: r.score, blocked: r.blocked, excess: r.excess
      });
      persist(); render();
    });
    paintFraud();
  }

  function fraudResult() {
    var u = state.ui;
    var expected = new Date(u.fexpd + "T00:00:00").getTime();
    var delivered = new Date(u.fdel + "T00:00:00").getTime();
    return scoreFraud({
      expectedQty: num(u.fexp, 1), actualQty: num(u.fqty, 0),
      marketPrice: num(u.fmarket, 1), actualPrice: num(u.fprice, 0),
      expected: isFinite(expected) ? expected : Date.now(),
      delivered: isFinite(delivered) ? delivered : Date.now()
    });
  }

  function paintFraud() {
    var r = fraudResult();
    var colour = r.score >= BLOCK ? "var(--red)" : r.score >= 40 ? "var(--sand)" : "var(--accent)";
    var badge = r.blocked ? '<span class="badge block">Block payment</span>' : '<span class="badge ok">Approve</span>';
    var out = document.getElementById("fraudOut");

    out.innerHTML =
      '<div class="score" style="margin-top:.6rem">' +
        '<div class="gauge" style="--c:' + colour + ";--pcc:" + Math.min(100, r.score) + '"><b style="color:' + colour + '">' + r.score + "</b></div>" +
        "<div><div style=\"margin-bottom:.4rem\">" + badge + "</div>" +
          '<div class="tiny muted">Threshold ' + BLOCK + " · ceiling " + CEIL + "</div>" +
          '<div class="tiny muted">Excess claimed: <b style="color:var(--text)">' + money(r.excess) + "</b></div>" +
        "</div>" +
      "</div>" +
      '<div style="margin-top:1rem">' + r.factors.map(function (f) {
        var pct = (f.points / f.maxPoints) * 100;
        return '<div style="margin-bottom:.85rem">' +
          '<div class="tiny" style="display:flex;justify-content:space-between;gap:.6rem"><span>' + esc(f.label) + "</span>" +
            '<span style="color:' + (f.points > 0 ? "var(--sand)" : "var(--muted)") + '">' + f.points + " / " + f.maxPoints + " pts</span></div>" +
          '<div class="bar" style="margin:.3rem 0 .25rem"><i style="width:' + pct.toFixed(1) + "%;background:" +
            (f.points > 0 ? "linear-gradient(90deg,#ffb86b,#ffd9ae)" : "transparent") + '"></i></div>' +
          '<div class="tiny muted">' + f.measured + f.unit + " · " + esc(f.explanation) + "</div>" +
        "</div>";
      }).join("") + "</div>" +
      '<p class="tiny muted" style="border-top:1px solid var(--line);padding-top:.7rem">' +
        "Total " + r.raw + " points" + (r.capped ? " (capped at " + CEIL + ")" : "") +
        ". Every point traces back to one measured difference, so the result can be checked by hand.</p>";

    var list = document.getElementById("checkList");
    if (!state.checks.length) {
      list.innerHTML = '<p class="sm muted">No checks saved yet.</p>';
    } else {
      list.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Material</th><th class="num">Score</th><th>Decision</th><th class="num">Excess claimed</th></tr></thead><tbody>' +
        state.checks.map(function (c) {
          return "<tr><td>" + esc(c.when) + "</td><td>" + esc(c.material) + '</td><td class="num">' + c.score +
            '</td><td>' + (c.blocked ? '<span class="badge block">Block</span>' : '<span class="badge ok">Approve</span>') +
            '</td><td class="num">' + money(c.excess) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
  }

  /* ---------------- progress ---------------- */
  function renderProgress() {
    var p = project();
    var rows = state.progress.filter(function (g) { return g.project === p.id; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var maxPct = 100;

    view.innerHTML = notice() +
      '<div class="grid g2">' +
        '<div class="card">' +
          '<div class="card-t">Log progress — ' + esc(p.name) + "</div>" +
          '<div class="form" style="margin-top:.6rem">' +
            '<div class="row">' + field("Progress (%)", "pct", 70, "number") + field("Spend to date (" + D.currency + ")", "spend", 26800000, "number") + "</div>" +
            '<div><label for="f_notes">Notes</label><textarea id="f_notes" rows="2" placeholder="What was completed this period?"></textarea></div>' +
            '<div><button class="btn btn-p" id="addProgress" type="button">Add update</button></div>' +
            '<p class="hint">Updates are appended to history — an earlier entry is never overwritten, so the curve can always be rebuilt.</p>' +
          "</div>" +
        "</div>" +
        '<div class="card">' +
          '<div class="card-t">Progress trend</div>' +
          (rows.length
            ? '<div class="chart" style="margin-top:.8rem">' + rows.map(function (g) {
                return '<i style="height:' + Math.max(4, (g.progress_percent / maxPct) * 100) + '%" title="' +
                  g.progress_percent + "% on " + g.date + '"></i>';
              }).join("") + "</div>" +
              '<div class="tiny muted" style="display:flex;justify-content:space-between;margin-top:.5rem"><span>' + esc(rows[0].date) + "</span><span>" + esc(rows[rows.length - 1].date) + "</span></div>"
            : '<p class="sm muted" style="margin-top:.5rem">No progress logged for this project yet.</p>') +
        "</div>" +
      "</div>" +
      '<div class="card" style="margin-top:1rem"><div class="card-t">History</div><div id="progList"></div></div>';

    document.getElementById("addProgress").addEventListener("click", function () {
      var pct = num(document.getElementById("f_pct").value, NaN);
      var spend = num(document.getElementById("f_spend").value, 0);
      var notes = document.getElementById("f_notes").value.trim();
      if (!isFinite(pct) || pct < 0 || pct > 100) { alert("Progress must be between 0 and 100."); return; }
      state.progress.push({
        project: p.id, progress_percent: pct, budget_spent: spend,
        notes: notes || "Progress update", date: today()
      });
      var proj = D.projects.filter(function (x) { return x.id === p.id; })[0];
      if (proj) { proj.progress = pct; proj.spent = spend; }
      persist(); render();
    });

    var list = document.getElementById("progList");
    if (!rows.length) {
      list.innerHTML = '<p class="sm muted">Nothing logged yet.</p>';
    } else {
      list.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Date</th><th class="num">Progress</th><th class="num">Spend</th><th>Notes</th></tr></thead><tbody>' +
        rows.slice().reverse().map(function (g) {
          return "<tr><td>" + esc(g.date) + '</td><td class="num">' + fmt(g.progress_percent) +
            '%</td><td class="num">' + money(g.budget_spent) + "</td><td>" + esc(g.notes) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
  }

  /* ---------------- small components ---------------- */
  function field(label, key, value, type) {
    return '<div><label for="f_' + key + '">' + esc(label) + '</label><input id="f_' + key + '" type="' +
      (type || "text") + '" value="' + esc(value) + '"></div>';
  }
  function dateField(label, key, value) {
    return '<div><label for="f_' + key + '">' + esc(label) + '</label><input id="f_' + key + '" type="date" value="' + esc(value) + '"></div>';
  }

  /* ---------------- global events ---------------- */
  document.addEventListener("click", function (e) {
    var go = e.target.closest("[data-go]");
    if (go) { setScreen(go.getAttribute("data-go")); return; }
    var sel = e.target.closest("[data-select]");
    if (sel) {
      state.projectId = parseInt(sel.getAttribute("data-select"), 10);
      persist();
      setScreen(state.screen === "projects" ? "surveying" : state.screen);
    }
  });

  projSel.innerHTML = D.projects.map(function (p) {
    return '<option value="' + p.id + '">' + esc(p.name) + "</option>";
  }).join("");
  projSel.addEventListener("change", function (e) {
    state.projectId = parseInt(e.target.value, 10);
    persist(); render();
  });

  document.getElementById("resetDemo").addEventListener("click", function () {
    if (!confirm("Reset the demo? Saved calculations, checks and progress updates will be cleared.")) return;
    try { localStorage.removeItem(LS); } catch (e) {}
    state = defaults();
    D.projects.forEach(function (p) {
      var seed = window.STP_DATA.projects.filter(function (x) { return x.id === p.id; })[0];
      p.progress = seed.progress; p.spent = seed.spent;
    });
    persist(); render();
  });

  render();
})();
