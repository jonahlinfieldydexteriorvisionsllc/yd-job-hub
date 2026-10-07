// Pricing: how a takeoff becomes a price -- Jonah's rules, worked out by code.
//
// The rules are his (the proposal build instructions he priced by with Claude
// before Job Hub could do it). This file is only their arithmetic, so every
// estimate is priced the same way and Claude never does sums:
//
//   order qty   = takeoff qty x (1 + waste %), rounded UP -- by the quarter
//                 ton for anything sold by the ton, to whole units otherwise
//   landed cost = supplier cost x (1 + sales tax %) x (1 + the supplier's
//                 processing fee %), to the cent, per unit
//   client $    = order qty x landed cost x (1 + markup %)
//
// plus what is added on every job by rule: one delivery per delivered
// material (by the job's town, a load per so many tons, a surcharge for
// pallets), fuel for both trucks and the loader for the days on site,
// dumpsters for the spoil, the planting package for every plant and tree, and
// the layout markers on paver, wall and edging jobs. Labour is crew-days x
// (the crew-day rate + the profit target for the day). The customer sees one
// materials total and the labour; never a markup, a crew-day or a cost.
//
// NONE OF THE NUMBERS ARE IN THIS FILE. The repository is public, and the
// markups, crew-day rate and profit targets are the business's own. They live
// in pricing/rules (readable by whoever may see jobs, changed by the owner),
// set on the Pricing rules screen below. Material costs live where they always
// have: Supplies (supplyPrices), each item with its own markup and waste
// when it differs from its category's.

(function () {
  'use strict';

  // ------------------------------------------------------------------ shape

  // Every material belongs to one category; the category carries the default
  // markup and waste. Ids are stored on supplies -- never rename one.
  const CATEGORIES = [
    ['soil', 'Soil (bulk)'], ['fill', 'Fill dirt'], ['mulch', 'Mulch'],
    ['stone', 'Stone, gravel & sand'], ['pavers', 'Pavers'], ['wall', 'Wall block & caps'],
    ['natural', 'Natural stone, flagstone & boulders'], ['edging', 'Edging'],
    ['hardscape', 'Fabric, restraint, geogrid & other hardscape'], ['adhesive', 'Adhesives & sealers'],
    ['drainage', 'Drainage & concrete'], ['seed', 'Seed & erosion control'], ['bagged', 'Bagged goods'],
    ['planting', 'Planting package'], ['plant', 'Plants'], ['dumpster', 'Dumpsters'],
    ['hardware', 'Hardware'], ['rental', 'Rentals'], ['tools', 'Tools & equipment'], ['other', 'Other'],
  ];
  // Things we buy to work with, not to install: kept in Supplies (where to
  // get one) but never on an estimate, and never in the list Claude reads.
  const NOT_FOR_ESTIMATES = ['tools'];
  const CATEGORY_NAME = {};
  CATEGORIES.forEach(([id, name]) => { CATEGORY_NAME[id] = name; });
  // A job with any of these gets the layout markers.
  const MARKER_CATEGORIES = ['pavers', 'wall', 'edging'];

  const PROFIT_TIERS = [['floor', 'Floor'], ['aim', 'Aim'], ['great', 'Great day']];

  // What an empty pricing/rules looks like. Everything a price needs is
  // missing until it is set, and an estimate says so rather than guessing.
  function blankRules() {
    return {
      taxPct: null,
      crewDayCents: null,
      profitCents: { floor: null, aim: null, great: null },
      defaultProfit: 'aim',
      categories: {},              // id -> { markupPct, wastePct }
      vendors: {},                 // vendor id -> { processingPct, cityDelivery }
      delivery: { rates: {}, palletCents: null, loadTons: null, markupPct: null },
      fuel: { mpg: [], bobcatGalPerDay: null, markupPct: null },
      dumpster: { supplyId: null, maxCuYd: null },
      markers: { supplyId: null, count: null },
      planting: { perPlant: [], perSingleTree: [], perMultiTree: [] },
      payments: { splitAboveCents: null, twoText: '', threeText: '', warranty: '' },
      shop: { address: '', lat: null, lng: null },
      // Claude starts an estimate by itself when the site-visit notes are
      // written (estimate.js). On unless switched off.
      autoDraft: null,
    };
  }

  // ---------------------------------------------------------------- numbers

  // A number, or null for "not given" (blank, text, NaN). Zero is a number.
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%\s]/g, ''));
    return isFinite(n) ? n : null;
  }
  const first = (...vs) => { for (const v of vs) { const n = num(v); if (n !== null) return n; } return null; };
  const pct = p => (num(p) || 0) / 100;
  // Floating point makes 5 x 1.2 come out as 6.000000000000001, and a plain
  // ceil would then order 7. Trim to a millionth before rounding up.
  const trim = x => Math.round(x * 1e6) / 1e6;
  const isTon = unit => /^\s*(ton|tons|t)\s*$/i.test(String(unit || ''));
  // Sold loose by the ton or the yard -- the stuff a delivery truck dumps.
  const isBulk = unit => isTon(unit) || /^\s*(yard|yards|yd|yds|cu ?yd|cubic yards?)\s*$/i.test(String(unit || ''));

  // Order quantities: by the quarter ton for tons, whole units otherwise.
  function roundUp(q, unit) {
    if (!(q > 0)) return 0;
    return isTon(unit) ? Math.ceil(trim(q * 4)) / 4 : Math.ceil(trim(q));
  }

  // "Madison — west" and "madison west" are the same place.
  const placeKey = s => String(s || '').toLowerCase().replace(/\btown of\b/g, 'town of').replace(/[^a-z0-9]+/g, ' ').trim();

  // -------------------------------------------------------------- materials
  //
  // One line of the takeoff: {supplyId, name, qty, unit, plant, tree,
  // costCents (only for things not in Supplies -- plants mostly), markupPct /
  // wastePct (overrides), delivery: 'auto' | 'pickup' | 'rides'}.
  // ctx: {rules, items, prices} (items/prices from Supplies).

  function materialLine(m, ctx) {
    const r = ctx.rules;
    const it = m.supplyId ? ctx.items[m.supplyId] || null : null;
    const pr = m.supplyId ? ctx.prices[m.supplyId] || null : null;
    const cat = m.plant ? 'plant' : (it && it.category) || m.category || 'other';
    const catRule = (r.categories || {})[cat] || {};
    const per = String((pr && pr.per) || (it && it.unit) || m.unit || '').trim();
    const coverage = it && num(it.coverage) > 0 ? num(it.coverage) : null;
    const takeoffUnit = coverage ? String(it.takeoffUnit || '').trim() : per;
    const markupPct = first(m.markupPct, pr && pr.markupPct, catRule.markupPct);
    const wastePct = m.plant ? 0 : first(m.wastePct, pr && pr.wastePct, catRule.wastePct, 0);
    const qty = Math.max(0, num(m.qty) || 0);
    const withWaste = qty * (1 + wastePct / 100);
    const orderQty = roundUp(coverage ? withWaste / coverage : withWaste, per);

    const costCents = it ? (pr && typeof pr.cents === 'number' ? pr.cents : null) : num(m.costCents);
    const vendorRule = it && it.vendorId ? (r.vendors || {})[it.vendorId] || {} : {};
    const fixedEach = pr && num(pr.clientCents) > 0 ? num(pr.clientCents) : null;
    const out = {
      id: m.id, supplyId: m.supplyId || null, name: m.name || (it && it.name) || '', category: cat,
      qty: qty, takeoffUnit: takeoffUnit, orderQty: orderQty, per: per,
      wastePct: wastePct, markupPct: markupPct, costCents: costCents,
      landedEachCents: null, clientCents: 0, problems: [],
      vendorId: it ? it.vendorId || null : null, cityDelivery: !!vendorRule.cityDelivery,
      pallet: !!(it && it.pallet), specialOrder: !!(it && it.specialOrder),
      delivery: m.delivery || 'auto', listed: m.listed !== false, auto: m.auto || null,
    };
    if (m.supplyId && !it) out.problems.push('no longer in Supplies');
    if (!qty) return out;
    if (fixedEach !== null) {                   // priced to the customer per piece (the markers)
      out.clientCents = Math.round(orderQty * fixedEach);
      return out;
    }
    if (costCents === null) { out.problems.push(it ? 'no price in Supplies' : 'no cost'); return out; }
    if (markupPct === null) { out.problems.push('no markup set for ' + (CATEGORY_NAME[cat] || cat)); return out; }
    if (num(r.taxPct) === null) { out.problems.push('sales tax % not set'); return out; }
    // A category can be set as not taxed when bought (a rental, say).
    const tax = catRule.noTax ? 0 : pct(r.taxPct);
    out.landedEachCents = Math.round(costCents * (1 + tax) * (1 + pct(vendorRule.processingPct)));
    out.clientCents = Math.round(orderQty * out.landedEachCents * (1 + markupPct / 100));
    return out;
  }

  // -------------------------------------------------------- what the rules add

  // Lines added by rule, in the same shape as a takeoff line so they are
  // priced the same way: dumpsters for the spoil, the planting package, the
  // layout markers. `off` names any the estimate has switched off.
  function ruleLines(est, lines, ctx) {
    const r = ctx.rules, off = est.off || {}, out = [];
    const add = (supplyId, qty, auto, listed) => {
      if (supplyId && qty > 0) out.push({ id: 'auto-' + auto + '-' + supplyId, supplyId, qty, auto, listed });
    };
    // Dumpsters: never more soil in a box than it takes.
    const spoil = num(est.spoilCuYd);
    if (!off.dumpsters && spoil > 0 && r.dumpster && r.dumpster.supplyId && num(r.dumpster.maxCuYd) > 0 &&
        !lines.some(l => l.category === 'dumpster')) {
      add(r.dumpster.supplyId, Math.ceil(trim(spoil / num(r.dumpster.maxCuYd))), 'dumpsters', true);
    }
    // Planting package: so much per plant, a watering bag per single-trunk
    // tree, a ring per multi-trunk or evergreen.
    const plants = lines.filter(l => l.category === 'plant').reduce((s, l) => s + l.orderQty, 0);
    const singles = lines.filter(l => l.category === 'plant' && l.tree === 'single').reduce((s, l) => s + l.orderQty, 0);
    const multis = lines.filter(l => l.category === 'plant' && l.tree === 'multi').reduce((s, l) => s + l.orderQty, 0);
    const p = r.planting || {};
    if (!off.planting) {
      (p.perPlant || []).forEach(id => add(id, plants, 'planting', true));
      (p.perSingleTree || []).forEach(id => add(id, singles, 'planting', true));
      (p.perMultiTree || []).forEach(id => add(id, multis, 'planting', true));
    }
    // Layout markers on paver, wall and edging jobs. Not listed: a few
    // dollars, there to be on hand.
    if (!off.markers && r.markers && r.markers.supplyId && num(r.markers.count) > 0 &&
        lines.some(l => MARKER_CATEGORIES.indexOf(l.category) !== -1)) {
      add(r.markers.supplyId, num(r.markers.count), 'markers', false);
    }
    return out;
  }

  // One delivery per delivered material: a material is one truck however
  // little of it there is, and another truck for every so many tons of it.
  function deliveries(lines, est, ctx) {
    const r = ctx.rules, d = r.delivery || {}, out = { lines: [], clientCents: 0, problems: [] };
    if ((est.off || {}).delivery) return out;
    // A delivery is a truck of bulk material or a pallet. Small things --
    // fabric, restraint, nails, a few bags of poly sand -- ride along or are
    // picked up and never carry a delivery of their own (Jonah, 6 Oct 2026),
    // and neither does what the rules add (markers, the planting package).
    const want = lines.filter(l => l.cityDelivery && l.orderQty > 0 && !l.auto && (isBulk(l.per) || l.pallet) &&
      l.delivery !== 'pickup' && l.delivery !== 'rides');
    if (!want.length) return out;
    const town = est.deliveryTown || ctx.city || '';
    const rates = d.rates || {};
    // A town taken off the list is stored as null (saves merge, so a key
    // left out would stay).
    const key = Object.keys(rates).find(k => num(rates[k]) !== null && placeKey(k) === placeKey(town));
    if (!key) {
      out.problems.push(town ? 'no delivery rate for ' + town + ' — pick the town on the estimate, or get a quote'
        : 'no town on the job, so no delivery rate');
    }
    const rate = key ? num(rates[key]) : null;
    const byMaterial = {};
    want.forEach(l => {
      const k = l.supplyId || l.id;
      (byMaterial[k] = byMaterial[k] || { name: l.name, per: l.per, qty: 0, pallet: l.pallet }).qty += l.orderQty;
    });
    Object.keys(byMaterial).forEach(k => {
      const m = byMaterial[k];
      const loads = isTon(m.per) && num(d.loadTons) > 0 ? Math.max(1, Math.ceil(trim(m.qty / num(d.loadTons)))) : 1;
      const cost = rate === null ? 0 : loads * (rate + (m.pallet ? num(d.palletCents) || 0 : 0));
      const client = Math.round(cost * (1 + pct(d.markupPct)));
      out.lines.push({ supplyId: k, name: m.name, loads: loads, pallet: m.pallet, costCents: cost, clientCents: client });
      out.clientCents += client;
    });
    if (num(d.markupPct) === null) out.problems.push('delivery markup % not set');
    return out;
  }

  // Fuel: both trucks there and back every day on site, the loader's diesel
  // for the days it runs, marked up. Miles are one way, by road.
  function fuel(est, ctx, autoDays) {
    const r = ctx.rules, f = est.fuel || {}, rf = r.fuel || {}, prices = ctx.fuel || {};
    const out = { clientCents: 0, problems: [], miles: num(f.miles), days: first(f.jobDays, autoDays),
                  bobcatDays: null, gasCents: first(f.gasCents, prices.gasCents),
                  dieselCents: first(f.dieselCents, prices.dieselCents), gallonsPerDay: 0 };
    out.bobcatDays = first(f.bobcatDays, out.days);
    if ((est.off || {}).fuel) return out;
    if (out.miles === null) { out.problems.push('miles to the job not known yet'); return out; }
    if (!(out.days > 0)) { out.problems.push('no days on site yet (set the crew-days)'); return out; }
    if (out.gasCents === null) { out.problems.push('no gas price'); return out; }
    const mpg = (rf.mpg || []).map(num).filter(n => n > 0);
    if (!mpg.length) { out.problems.push('truck mpg not set'); return out; }
    const rt = out.miles * 2;
    out.gallonsPerDay = mpg.reduce((s, m) => s + rt / m, 0);
    let cents = out.gallonsPerDay * out.gasCents * out.days;
    const bob = num(rf.bobcatGalPerDay);
    if (bob > 0 && out.bobcatDays > 0) {
      if (out.dieselCents === null) out.problems.push('no diesel price');
      else cents += bob * out.bobcatDays * out.dieselCents;
    }
    if (num(rf.markupPct) === null) out.problems.push('fuel markup % not set');
    out.clientCents = Math.round(cents * (1 + pct(rf.markupPct)));
    return out;
  }

  // ------------------------------------------------------------------ labour
  //
  // A work line is what the customer reads as one line of labour:
  //   crew:   crew-days x (crew-day rate + the profit target for the day)
  //   flat:   qty x a flat rate from the price book (gutters by the foot)
  //   amount: a figure typed in
  function workLine(w, ctx) {
    const r = ctx.rules, out = { id: w.id, cents: 0, problems: [] };
    if (w.kind === 'flat') {
      const q = num(w.qty), rate = num(w.rateCents);
      if (q === null || rate === null) out.problems.push('needs a quantity and a rate');
      else out.cents = Math.round(q * rate);
    } else if (w.kind === 'amount') {
      const a = num(w.amountCents);
      if (a === null) out.problems.push('needs an amount'); else out.cents = Math.round(a);
    } else {
      const days = num(w.crewDays);
      const tier = w.profit || r.defaultProfit || 'aim';
      const target = typeof tier === 'number' ? tier : num((r.profitCents || {})[tier]);
      if (!(days > 0)) out.problems.push('how many crew-days?');
      else if (num(r.crewDayCents) === null || target === null) out.problems.push('crew-day rate or profit target not set');
      else out.cents = Math.round(days * (num(r.crewDayCents) + target));
    }
    return out;
  }

  // ---------------------------------------------------------------- payments

  // Deposit rounded up to the cent; the last payment takes up the penny.
  function payments(totalCents, rules) {
    const above = num(((rules || {}).payments || {}).splitAboveCents);
    if (!(totalCents > 0)) return [];
    if (above !== null && totalCents > above) {
      const dep = Math.ceil(totalCents / 2), mid = Math.ceil(totalCents / 4);
      return [{ label: 'Deposit (50%)', cents: dep }, { label: 'Progress (25%)', cents: mid },
              { label: 'Final (25%)', cents: totalCents - dep - mid }];
    }
    const dep = Math.ceil(totalCents / 2);
    return [{ label: 'Deposit (50%)', cents: dep }, { label: 'On completion (50%)', cents: totalCents - dep }];
  }

  // --------------------------------------------------------------- the lot

  // est: the estimate on the job; ctx: {rules, items, prices, fuel, city}.
  function price(est, ctx) {
    est = est || {};
    const takeoff = (est.materials || []).map(m => Object.assign(materialLine(m, ctx), { tree: m.tree || null }));
    const added = ruleLines(est, takeoff, ctx).map(m => materialLine(m, ctx));
    const all = takeoff.concat(added);
    const work = (est.work || []).map(w => workLine(w, ctx));
    const crewDays = (est.work || []).filter(w => (w.kind || 'crew') === 'crew')
      .reduce((s, w) => s + (num(w.crewDays) || 0), 0);
    const del = deliveries(all, est, ctx);
    const fu = fuel(est, ctx, crewDays > 0 ? Math.ceil(trim(crewDays)) : null);
    const materialsCents = all.reduce((s, l) => s + l.clientCents, 0) + del.clientCents + fu.clientCents;
    const laborCents = work.reduce((s, w) => s + w.cents, 0);
    const totalCents = materialsCents + laborCents;
    const problems = [];
    all.forEach(l => l.problems.forEach(p => problems.push((l.name || 'A material') + ': ' + p)));
    (est.work || []).forEach((w, i) => work[i].problems.forEach(p => problems.push((w.title || 'Labour line') + ': ' + p)));
    del.problems.forEach(p => problems.push('Delivery: ' + p));
    fu.problems.forEach(p => problems.push('Fuel: ' + p));
    return {
      takeoff, added, work, delivery: del, fuel: fu, crewDays,
      materialsCents, laborCents, totalCents,
      payments: payments(totalCents, ctx.rules),
      specialOrder: all.filter(l => l.specialOrder && l.orderQty > 0).map(l => l.name),
      problems,
    };
  }

  // What the customer reads in the materials line: every listed material and
  // how much of it -- never a price.
  function fmtQty(q) { return String(Math.round(q * 100) / 100); }
  // "8 yards", "3.75 tons", "23 bags", "120 sq ft", "2" (each).
  function qtyText(q, unit) {
    const u = String(unit || '').trim(), n = fmtQty(q);
    if (!u || /^(each|ea)$/i.test(u)) return n;
    const plural = q !== 1 && /^[a-z]+$/i.test(u) && !/s$/i.test(u) && !/^(lb|ft|sf|lf|sq|cu|yd|gal|oz)$/i.test(u)
      ? u + (/(x|ch|sh)$/i.test(u) ? 'es' : 's') : u;
    return n + ' ' + plural;
  }
  function materialsList(result) {
    return result.takeoff.concat(result.added)
      .filter(l => l.listed && l.orderQty > 0)
      .map(l => l.name + ': ' + qtyText(l.orderQty, l.per));
  }

  // ------------------------------------------------------------- the rules doc

  let rules = blankRules();
  let fuelPrices = {};            // pricing/fuel: {gasCents, dieselCents, asOf, source}
  let claudeText = null;          // pricing/claude: the owner's takeoff rules, as Claude reads them
  let ready = false;
  let unsubs = [];

  function merged(d) {
    const b = blankRules();
    if (!d || typeof d !== 'object') return b;
    Object.keys(b).forEach(k => {
      if (d[k] === undefined) return;
      b[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && d[k] && typeof d[k] === 'object')
        ? Object.assign(b[k], d[k]) : d[k];
    });
    return b;
  }

  function changed() {
    document.dispatchEvent(new CustomEvent('yd-pricing'));
    const m = document.getElementById('prModal');
    if (m && m.classList.contains('active') && !typingIn(m)) renderRules();
  }
  function typingIn(m) {
    const a = document.activeElement;
    return !!(a && m.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName));
  }

  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; rules = blankRules(); fuelPrices = {}; claudeText = null; ready = false;
  }
  function start() {
    stop();
    if (!ydCan('jobs', 'see') || !window.YDDb) return;
    unsubs.push(window.YDDb.watch('pricing', list => {
      list.forEach(c => {
        if (c.id === 'rules') { rules = c.type === 'removed' ? blankRules() : merged(c.data); ready = true; }
        if (c.id === 'fuel') fuelPrices = c.type === 'removed' ? {} : (c.data || {});
        if (c.id === 'claude') claudeText = c.type === 'removed' ? '' : String((c.data || {}).text || '');
      });
      changed();
    }, () => {}));
  }

  // Not awaited: a write only settles when the server answers.
  function save(patch) {
    rules = merged(Object.assign({}, rules, patch));
    Promise.resolve(window.YDDb.put('pricing', 'rules', patch)).catch(e => {
      showToast(e && e.code === 'permission-denied' ? 'Only the owner changes the pricing rules' : 'Not saved yet — will retry');
    });
    changed();
  }

  // ------------------------------------------------------- Pricing rules screen
  //
  // Owner only. Plain boxes for every number, saved as each one changes.

  const el = id => document.getElementById(id);
  const owner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const dollars = c => num(c) === null ? '' : (num(c) / 100).toFixed(2);
  const cents = v => { const n = num(v); return n === null ? null : Math.round(n * 100); };

  window.openPricingRules = function () {
    const m = el('prModal');
    if (!m) return;
    m.classList.add('active');
    renderRules();
  };
  window.closePricingRules = function () { const m = el('prModal'); if (m) m.classList.remove('active'); };

  function box(label, value, onchange, hint, attrs) {
    return '<label class="pr-field"><span>' + esc(label) + '</span><input inputmode="decimal" value="' + esc(value == null ? '' : value) + '"' +
      (owner() ? '' : ' disabled') + ' onchange="' + onchange + '"' + (attrs || '') + '>' +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
  }

  function supplyOptions(selected, filter) {
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {} };
    const list = Object.values(cat.items).filter(i => !filter || filter(i)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return '<option value="">— none —</option>' + list.map(i => '<option value="' + esc(i.id) + '"' +
      (i.id === selected ? ' selected' : '') + '>' + esc(i.name) + '</option>').join('');
  }
  function supplyName(id) {
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { items: {} };
    return (cat.items[id] || {}).name || '(gone from Supplies)';
  }

  function renderRules() {
    const body = el('prBody');
    if (!body) return;
    const r = rules, ro = !owner();
    const cat = window.YDSupplies && window.YDSupplies.catalog ? window.YDSupplies.catalog() : { vendors: {} };
    const vendors = Object.values(cat.vendors || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const rates = r.delivery.rates || {};
    const towns = shownTowns = Object.keys(rates).filter(t => num(rates[t]) !== null).sort((a, b) => a.localeCompare(b));
    const fp = fuelPrices || {};
    const pick = (path, sel, filter) => '<select ' + (ro ? 'disabled ' : '') + 'onchange="prSet(\'' + path + '\', this.value, \'id\')">' + supplyOptions(sel, filter) + '</select>';
    const listPick = key => '<div class="pr-chips">' + ((r.planting[key] || []).map(id =>
        '<span class="pr-chip">' + esc(supplyName(id)) + (ro ? '' : ' <button class="link-btn" onclick="prListRemove(\'' + key + '\', \'' + esc(id) + '\')">✕</button>') + '</span>').join('') || '<span class="muted">none</span>') +
      (ro ? '' : ' <select onchange="prListAdd(\'' + key + '\', this.value)">' + supplyOptions('') + '</select>') + '</div>';

    body.innerHTML =
      '<p class="hint">How every estimate is priced. Change a number here and every estimate worked out from now on uses it; estimates already sent keep their prices. ' +
        'Only you see this screen, and the customer never sees any of it.' + (ro ? ' <b>Only the owner can change these.</b>' : '') + '</p>' +

      '<h3 class="pr-h">Labour</h3><div class="pr-grid">' +
        box('Crew-day rate ($)', dollars(r.crewDayCents), "prSet('crewDayCents', this.value, 'cents')", 'what a crew-day costs, for estimating') +
        PROFIT_TIERS.map(([id, name]) => box('Profit target — ' + name + ' ($/day)', dollars(r.profitCents[id]), "prSet('profitCents." + id + "', this.value, 'cents')")).join('') +
        '<label class="pr-field"><span>Quote at</span><select ' + (ro ? 'disabled ' : '') + 'onchange="prSet(\'defaultProfit\', this.value, \'text\')">' +
          PROFIT_TIERS.map(([id, name]) => '<option value="' + id + '"' + (r.defaultProfit === id ? ' selected' : '') + '>' + name + '</option>').join('') + '</select></label>' +
      '</div>' +

      '<h3 class="pr-h">Materials</h3><div class="pr-grid">' +
        box('Sales tax on purchases (%)', r.taxPct, "prSet('taxPct', this.value, 'num')", 'added to every material cost before markup') +
      '</div>' +
      '<table class="pr-table"><thead><tr><th>Category</th><th>Markup %</th><th>Waste %</th><th>No tax</th></tr></thead><tbody>' +
        CATEGORIES.map(([id, name]) => {
          const c = r.categories[id] || {};
          const cell = (k, v) => '<td><input inputmode="decimal" value="' + esc(v == null ? '' : v) + '"' + (ro ? ' disabled' : '') +
            ' onchange="prCat(\'' + id + '\', \'' + k + '\', this.value)"></td>';
          return '<tr><td>' + esc(name) + '</td>' + cell('markupPct', c.markupPct) + cell('wastePct', c.wastePct) +
            '<td><input type="checkbox"' + (c.noTax ? ' checked' : '') + (ro ? ' disabled' : '') +
            ' onchange="prCat(\'' + id + '\', \'noTax\', this.checked)"></td></tr>';
        }).join('') + '</tbody></table>' +
      '<p class="hint">An item in Supplies can have its own markup or waste; these are for everything else in the category. ' +
        '“No tax” leaves the sales tax off that kind of thing (a rental, say).</p>' +

      '<h3 class="pr-h">Suppliers</h3>' +
      (vendors.length ? '<table class="pr-table"><thead><tr><th>Supplier</th><th>Card/processing fee %</th><th>Delivers by town (one load per material)</th></tr></thead><tbody>' +
        vendors.map(v => {
          const vr = r.vendors[v.id] || {};
          return '<tr><td>' + esc(v.name || '') + '</td><td><input inputmode="decimal" value="' + esc(vr.processingPct == null ? '' : vr.processingPct) + '"' +
            (ro ? ' disabled' : '') + ' onchange="prVendor(\'' + esc(v.id) + '\', \'processingPct\', this.value)"></td>' +
            '<td><input type="checkbox"' + (vr.cityDelivery ? ' checked' : '') + (ro ? ' disabled' : '') +
            ' onchange="prVendor(\'' + esc(v.id) + '\', \'cityDelivery\', this.checked)"></td></tr>';
        }).join('') + '</tbody></table>' : '<p class="muted">No suppliers in Supplies yet.</p>') +

      '<h3 class="pr-h">Delivery</h3><div class="pr-grid">' +
        box('Pallet / boulder surcharge per load ($)', dollars(r.delivery.palletCents), "prSet('delivery.palletCents', this.value, 'cents')") +
        box('Most tons in one load', r.delivery.loadTons, "prSet('delivery.loadTons', this.value, 'num')") +
        box('Markup on delivery (%)', r.delivery.markupPct, "prSet('delivery.markupPct', this.value, 'num')") +
      '</div>' +
      '<details class="pr-towns"><summary>Delivery rate by town (' + towns.length + ')</summary>' +
        '<div class="pr-town-list">' + towns.map((t, i) => '<label><span>' + esc(t) + '</span><input inputmode="decimal" value="' + dollars(rates[t]) + '"' +
          (ro ? ' disabled' : '') + ' onchange="prTownAt(' + i + ', this.value)"></label>').join('') + '</div>' +
        (ro ? '' : '<div class="field-actions"><button class="btn btn-sm" onclick="prTownAdd()">+ Add a town</button></div>') +
      '</details>' +

      '<h3 class="pr-h">Fuel</h3><div class="pr-grid">' +
        box('Truck mpg (each truck, comma between)', (r.fuel.mpg || []).join(', '), "prSet('fuel.mpg', this.value, 'list')", 'every truck makes the round trip every day') +
        box('Loader diesel (gallons a day)', r.fuel.bobcatGalPerDay, "prSet('fuel.bobcatGalPerDay', this.value, 'num')") +
        box('Markup on fuel (%)', r.fuel.markupPct, "prSet('fuel.markupPct', this.value, 'num')") +
        box('Shop address (where trips start)', r.shop.address || '', "prSet('shop.address', this.value, 'text')", '', ' inputmode="text"') +
      '</div>' +
      '<p class="hint">Gas ' + (num(fp.gasCents) !== null ? '$' + (num(fp.gasCents) / 100).toFixed(3) : '—') +
        ' · diesel ' + (num(fp.dieselCents) !== null ? '$' + (num(fp.dieselCents) / 100).toFixed(3) : '—') +
        (fp.asOf ? ' a gallon, week of ' + esc(fp.asOf) : '') + (fp.source ? ' (' + esc(fp.source) + ')' : '') +
        '. Fetched once a week; an estimate can use a different price.</p>' +

      '<h3 class="pr-h">Added by rule</h3>' +
      '<div class="pr-grid">' +
        '<label class="pr-field"><span>Dumpster (from Supplies)</span>' + pick('dumpster.supplyId', r.dumpster.supplyId, i => i.category === 'dumpster') + '</label>' +
        box('Most cubic yards of spoil in one', r.dumpster.maxCuYd, "prSet('dumpster.maxCuYd', this.value, 'num')") +
        '<label class="pr-field"><span>Layout markers (from Supplies)</span>' + pick('markers.supplyId', r.markers.supplyId) + '</label>' +
        box('Markers per paver / wall / edging job', r.markers.count, "prSet('markers.count', this.value, 'num')") +
      '</div>' +
      '<div class="pr-field wide"><span>Planting package — for every plant (set each item’s “covers” in Supplies, e.g. soil 0.5 plants a bag)</span>' + listPick('perPlant') + '</div>' +
      '<div class="pr-field wide"><span>For every single-trunk tree</span>' + listPick('perSingleTree') + '</div>' +
      '<div class="pr-field wide"><span>For every multi-trunk or evergreen tree</span>' + listPick('perMultiTree') + '</div>' +

      '<h3 class="pr-h">Payments & the message on the estimate</h3><div class="pr-grid">' +
        box('Three payments above ($)', dollars(r.payments.splitAboveCents), "prSet('payments.splitAboveCents', this.value, 'cents')", '50/50 up to this total; 50/25/25 above it') +
      '</div>' +
      ['twoText', 'threeText', 'warranty'].map(k => '<label class="pr-field wide"><span>' +
        ({ twoText: 'Payment terms — two payments', threeText: 'Payment terms — three payments', warranty: 'Warranty' })[k] +
        '</span><textarea rows="3"' + (ro ? ' disabled' : '') + ' onchange="prSet(\'payments.' + k + '\', this.value, \'text\')">' +
        esc(r.payments[k] || '') + '</textarea></label>').join('') +

      '<h3 class="pr-h">Claude</h3>' +
      '<label class="est-switch"><input type="checkbox"' + (r.autoDraft !== false ? ' checked' : '') + (ro ? ' disabled' : '') +
        ' onchange="prSet(\'autoDraft\', this.checked, \'bool\')"> Start the estimate by itself when I finish my site-visit notes</label>' +
      '<p class="hint">Each estimate Claude builds costs a little (cents, not dollars). Off, it waits for “Build the estimate from my notes”.</p>' +
      '<h3 class="pr-h">What Claude knows about takeoff</h3>' +
      '<p class="hint">Your rules for laying out an estimate — base depths, conversions, install standards, how a scope is written, the clauses every estimate carries. ' +
        'Claude reads all of this with every message about an estimate. Prices and markups don’t belong here; the app works those out.</p>' +
      '<textarea class="pr-claude" rows="18"' + (ro ? ' disabled' : '') + ' onchange="prClaude(this.value)">' + esc(claudeText || '') + '</textarea>';
  }

  window.prClaude = function (v) {
    if (!owner()) return;
    claudeText = String(v || '');
    Promise.resolve(window.YDDb.put('pricing', 'claude', { text: claudeText, updatedAt: new Date().toISOString() })).catch(e => {
      showToast(e && e.code === 'permission-denied' ? 'Only the owner changes the pricing rules' : 'Not saved yet — will retry');
    });
    showToast('Saved — Claude reads this from the next message');
  };

  // path like 'delivery.markupPct'; kind: num | cents | text | id | list | bool
  window.prSet = function (path, v, kind) {
    if (!owner()) return;
    let val;
    if (kind === 'bool') val = !!v;
    else if (kind === 'cents') val = cents(v);
    else if (kind === 'num') val = num(v);
    else if (kind === 'list') val = String(v || '').split(/[,\s]+/).map(num).filter(n => n !== null);
    else if (kind === 'id') val = v || null;
    else val = String(v || '').trim();
    if ((kind === 'cents' || kind === 'num') && String(v).trim() !== '' && val === null) {
      showToast('That isn’t a number'); renderRules(); return;
    }
    const [head, sub] = path.split('.');
    if (sub) save({ [head]: Object.assign({}, rules[head], { [sub]: val }) });
    else save({ [head]: val });
  };
  window.prCat = function (id, k, v) {
    if (!owner()) return;
    if (k === 'noTax') {
      const cats = Object.assign({}, rules.categories);
      cats[id] = Object.assign({}, cats[id], { noTax: !!v });
      save({ categories: cats });
      return;
    }
    const n = num(v);
    if (String(v).trim() !== '' && n === null) { showToast('That isn’t a number'); renderRules(); return; }
    const cats = Object.assign({}, rules.categories);
    cats[id] = Object.assign({}, cats[id], { [k]: n });
    save({ categories: cats });
  };
  window.prVendor = function (id, k, v) {
    if (!owner()) return;
    const vs = Object.assign({}, rules.vendors);
    vs[id] = Object.assign({}, vs[id], { [k]: k === 'cityDelivery' ? !!v : num(v) });
    save({ vendors: vs });
  };
  // Blank takes the town off (null: see deliveries()).
  function setTown(town, v) {
    if (!owner()) return;
    const rates = Object.assign({}, rules.delivery.rates);
    rates[town] = String(v).trim() === '' ? null : cents(v);
    save({ delivery: Object.assign({}, rules.delivery, { rates }) });
  }
  let shownTowns = [];
  window.prTownAt = function (i, v) { if (shownTowns[i]) setTown(shownTowns[i], v); };
  window.prTownAdd = function () {
    const t = prompt('Town name (as the job’s city is written)');
    if (!t || !t.trim()) return;
    const v = prompt('Delivery rate per load to ' + t.trim() + ' ($)');
    if (v == null || num(v) === null) return;
    setTown(t.trim(), v);
    renderRules();
  };
  window.prListAdd = function (key, id) {
    if (!owner() || !id) return;
    const p = Object.assign({}, rules.planting);
    p[key] = (p[key] || []).filter(x => x !== id).concat([id]);
    save({ planting: p });
  };
  window.prListRemove = function (key, id) {
    if (!owner()) return;
    const p = Object.assign({}, rules.planting);
    p[key] = (p[key] || []).filter(x => x !== id);
    save({ planting: p });
  };

  // ------------------------------------------------------------- start/stop

  window.YDPricing = {
    CATEGORIES, CATEGORY_NAME, PROFIT_TIERS, NOT_FOR_ESTIMATES,
    rules: () => rules, fuelPrices: () => fuelPrices, ready: () => ready,
    price, materialsList, qtyText, payments, roundUp, num, placeKey, isBulk,
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) { authKey = k; if (on) start(); else stop(); }
  });
  // The rules screen names suppliers and items; redraw it when they arrive.
  document.addEventListener('yd-supplies', () => {
    const m = el('prModal');
    if (m && m.classList.contains('active') && !typingIn(m)) renderRules();
  });
})();
