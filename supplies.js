// Supplies: what we buy, who we buy it from, where it is once you get there --
// and, for Jonah only, what it costs.
//
// The question this answers for the crew is the one asked from the truck:
// "where do I get seed?" -- and the answer they need is not just "MDS" but
// "MDS, the front building, ask at the counter". So every item says which
// supplier, and where at that supplier; every supplier carries its address
// (one tap to directions), phone (one tap to call) and hours.
//
// Three collections, because Firestore cannot hide one field of a document
// from the crew -- the same split as the snow accounts:
//   vendors/{id}       name, address, phone, hours, notes             everyone
//   supplies/{id}      name, also, vendorId, sku, where, unit, notes  everyone
//   supplyPrices/{id}  (same id as the item) cents, per, year, asOf,
//                      priceNotes, history [{year, cents, per, asOf}] owner only
//
// Estimates are priced from these (pricing.js). For that an item also says
// what kind of material it is (category -- which carries the default markup
// and waste), how a takeoff becomes a purchase (a roll of fabric "covers" 750
// sq ft: takeoffUnit 'sq ft', coverage 750), whether it comes on a pallet
// (a delivery surcharge) and whether it is a special order (non-returnable).
// Its price record may carry its own markupPct / wastePct, and clientCents
// for the odd thing sold to the customer at a fixed price each.
//
// Prices go up every year. A price entered for a NEW year moves the old one
// into the history, so "up 6% on last year" can be shown; a price changed
// within the same year is a correction and simply replaces it. The whole
// list goes out and comes back as a spreadsheet: download it, change the
// prices and the year, paste it back. A downloaded list carries each item's
// id, so every row comes back to exactly the item it left.

(function () {
  'use strict';

  let items = {};
  let vendors = {};
  let prices = {};
  let pricesReady = false;  // the server has answered, not just this device's cache
  let unsubs = [];
  let search = '';
  let shown = '';           // supplier filter: '' everyone, '-' no supplier, else a vendor id
  let editing = null;       // { kind: 'item' | 'vendor', id, priceShown }
  let plan = null;          // a checked import waiting for "Save these changes"
  let planVendor = null;    // the supplier a price list is for, when opened from its card

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  // Prices: the owner, or an admin given Supplies. Adding and editing:
  // Supplies "change". Everyone signed in sees what we use and where.
  const seesPrices = () => ydCan('supplies', 'see');
  const edits = () => ydCan('supplies', 'change');
  const signedIn = () => !!(window.YDAuth && window.YDAuth.user && window.YDDb);
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const norm = s => String(s || '').toLowerCase();
  // For matching names typed slightly differently: "M.D.S.", "M D S" and
  // "mds" are one supplier; "Pavers - Holland" and "Pavers — Holland" one item.
  const key = s => norm(s).replace(/[^a-z0-9]+/g, '');
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  const thisYear = () => new Date().getFullYear();
  const two = n => (n < 10 ? '0' : '') + n;
  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, ''); }

  // ------------------------------------------------------------------ money

  // "$1,234.50", "45", " 89.99 " -> cents. Empty -> null (no price given);
  // anything else -> NaN, so a typo is refused instead of saved as $0.
  function parseCents(s) {
    const t = String(s == null ? '' : s).replace(/[$,\s]/g, '');
    if (!t) return null;
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
    return Math.round(parseFloat(t) * 100);
  }
  function fmtCents(c) {
    if (typeof c !== 'number' || !isFinite(c)) return '';
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function validYear(s) {
    const y = parseInt(s, 10);
    return y >= 2000 && y <= 2100 ? y : null;
  }
  // Percentage change, or null when there is nothing fair to compare with.
  function change(now, before) {
    if (typeof now !== 'number' || typeof before !== 'number' || !(before > 0)) return null;
    return (now - before) / before * 100;
  }
  function changeHtml(p) {
    if (p == null) return '';
    const r = Math.round(p * 10) / 10;
    if (r === 0) return '<span class="sup-chg same">same as last year</span>';
    return '<span class="sup-chg ' + (r > 0 ? 'up' : 'down') + '">' + (r > 0 ? '▲ ' : '▼ ') +
      Math.abs(r).toFixed(1) + '%</span>';
  }
  // The price this one replaced: the newest year in the history.
  const lastYears = p => (p && Array.isArray(p.history) && p.history.length ? p.history[0] : null);

  // What a price record becomes when a price for `e.year` arrives.
  //   e.cents: a number, null (price removed), or undefined (not given)
  // A newer year pushes the current price into the history; the same year
  // overwrites it (a correction); an OLDER year only fills in the history.
  // Every field is always written -- Firestore refuses a write containing
  // undefined anywhere.
  // The estimate's numbers on a price record ride along untouched unless e
  // gives them (null clears one).
  // A rental's half-day and week rates ride along the same way; its day rate
  // is the price itself (per day), which is what estimates use.
  const PRICING_KEYS = ['markupPct', 'wastePct', 'clientCents', 'halfDayCents', 'weekCents'];
  function applyPrice(old, e) {
    const cur = Object.assign({ cents: null, per: '', year: null, asOf: '', priceNotes: '' }, old || {});
    const extra = {};
    PRICING_KEYS.forEach(k => {
      const v = e[k] !== undefined ? e[k] : cur[k];
      extra[k] = typeof v === 'number' && isFinite(v) ? v : null;
    });
    let history = Array.isArray(cur.history) ? cur.history.slice() : [];
    const file = h => {
      history = history.filter(x => x.year !== h.year);
      if (typeof h.cents === 'number') history.push(h);
    };
    const today = localToday();
    if (e.cents !== undefined) {
      if (cur.cents != null && cur.year && e.year < cur.year) {
        file({ year: e.year, cents: e.cents, per: e.per || cur.per || '', asOf: today });
      } else {
        if (cur.cents != null && cur.year && e.year > cur.year) {
          file({ year: cur.year, cents: cur.cents, per: cur.per || '', asOf: cur.asOf || '' });
        }
        // This year's price is the current one, never also a history row.
        history = history.filter(x => x.year !== e.year);
        cur.cents = e.cents;
        cur.year = e.year;
        cur.asOf = today;
        if (e.per != null) cur.per = e.per;
      }
    } else if (e.per != null) {
      cur.per = e.per;
    }
    if (e.priceNotes != null) cur.priceNotes = e.priceNotes;
    return Object.assign(extra, {
      cents: typeof cur.cents === 'number' ? cur.cents : null,
      per: cur.per || '',
      year: cur.year || e.year || thisYear(),
      asOf: cur.asOf || '',
      priceNotes: cur.priceNotes || '',
      history: history.sort((a, b) => b.year - a.year).slice(0, 15)
        .map(h => ({ year: h.year, cents: h.cents, per: h.per || '', asOf: h.asOf || '' })),
      updatedAt: new Date().toISOString(),
    });
  }

  // The estimate fields, typed: '' -> null (use the category's), else a number.
  // NaN for something that is not a number, so it can be refused.
  function parsePct(s) {
    const t = String(s == null ? '' : s).replace(/[%\s]/g, '');
    if (!t) return null;
    return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
  }
  const categories = () => (window.YDPricing ? window.YDPricing.CATEGORIES : []);
  // "Pavers", "pavers", "PAVERS" and the id all name the same category.
  function categoryId(s) {
    const k = key(s);
    if (!k) return null;
    const hit = categories().find(([id, name]) => key(id) === k || key(name) === k);
    return hit ? hit[0] : undefined;
  }
  function yesNo(s) {
    const t = norm(s).trim();
    if (!t) return null;
    if (/^(y|yes|true|1|x|✓)$/.test(t)) return true;
    if (/^(n|no|false|0)$/.test(t)) return false;
    return undefined;
  }

  // ---------------------------------------------------------------- render

  // Every word typed has to appear somewhere in the item: its name, the other
  // names it goes by, the supplier, the item number, or the where. "grass
  // seed" finds "Seed -- sun & shade mix" listed with "grass" as another name.
  function matches(it, words) {
    const v = vendors[it.vendorId] || {};
    const hay = norm([it.name, it.also, it.sku, v.name, it.where, it.notes].join(' '));
    return words.every(w => hay.indexOf(w) !== -1);
  }

  function render() {
    const wrap = el('suppliesWrap');
    if (!wrap) return;
    if (!signedIn()) {
      wrap.innerHTML = '<p class="empty-msg">Loading…</p>';
      return;
    }
    // The search box is drawn once and kept; only the results are redrawn, so
    // the box never loses focus (or the keyboard) mid-word.
    if (!el('supSearch')) {
      wrap.innerHTML =
        '<input id="supSearch" class="sup-search" type="search" placeholder="What do you need? e.g. seed, pavers, salt" ' +
          'oninput="supSearch(this.value)" autocomplete="off">' +
        (edits() ? '<div class="field-actions sup-actions">' +
          '<button class="btn btn-sm btn-filled" onclick="supEdit(\'item\', \'\')">+ Add an item</button>' +
          '<button class="btn btn-sm" onclick="supEdit(\'vendor\', \'\')">+ Add a supplier</button>' +
          '<button class="btn btn-sm" onclick="supPriceList()">💲 Price list</button>' +
        '</div>' : '') +
        '<div id="supChips" class="sup-chips"></div>' +
        '<div id="supResults"></div>';
      el('supSearch').value = search;
    }
    renderResults();
  }

  // Rentals (Jonah, 5 Oct 2026): "a rental section within the supplies with
  // the locations and phone numbers for where we pick up certain rental
  // items". A rental is an item of the Rentals kind (or a dumpster); the
  // rental place is a supplier like any other.
  const RENTALS = 'rentals';
  const isRental = it => it.category === 'rental' || it.category === 'dumpster';

  function renderChips() {
    const box = el('supChips');
    if (!box) return;
    const count = {};
    let rentals = 0;
    Object.values(items).forEach(it => {
      const k = vendors[it.vendorId] ? it.vendorId : '-';
      count[k] = (count[k] || 0) + 1;
      if (isRental(it)) rentals++;
    });
    const vs = Object.values(vendors).sort(byName);
    if (shown && shown !== '-' && shown !== RENTALS && !vendors[shown]) shown = '';
    const chip = (id, label, n) =>
      '<button class="sup-chip' + (shown === id ? ' on' : '') + '" onclick="supFilter(\'' + safeId(id) + '\')">' +
        esc(label) + (n != null ? ' <span>' + n + '</span>' : '') + '</button>';
    box.innerHTML = vs.length
      ? chip('', 'All suppliers', Object.keys(items).length) +
        (rentals ? chip(RENTALS, '🚜 Rentals', rentals) : '') +
        vs.map(v => chip(v.id, v.name, count[v.id] || 0)).join('') +
        (count['-'] ? chip('-', 'No supplier', count['-']) : '')
      : '';
  }

  function renderResults() {
    const box = el('supResults');
    if (!box) return;
    renderChips();
    const words = norm(search).split(/\s+/).filter(Boolean);
    const inShown = it => !shown || (shown === RENTALS ? isRental(it) : shown === '-' ? !vendors[it.vendorId] : it.vendorId === shown);
    const list = Object.values(items)
      .filter(it => inShown(it) && (!words.length || matches(it, words)))
      .sort(byName);

    if (!Object.keys(items).length && !Object.keys(vendors).length) {
      box.innerHTML = '<p class="empty-msg">' + (edits()
        ? 'Nothing here yet. Add your suppliers first, then the things you buy from each — ' +
          'and where they are once you get there.'
        : 'Nothing has been added here yet.') + '</p>';
      return;
    }

    let html = '';
    // One supplier picked: its card first -- address, phone, hours, notes --
    // then everything bought there.
    const v = shown && shown !== '-' && shown !== RENTALS ? vendors[shown] : null;
    if (v) html += vendorCardHtml(v, list.length);
    if (shown === RENTALS) {
      html += '<div class="hint">What we rent and where to get it. Add one with “+ Add an item” and pick ' +
        '“Rentals” as its kind; the rental place is a supplier like any other.</div>';
    }

    if (!list.length) {
      html += '<p class="empty-msg">' + (words.length
        ? 'Nothing matches “' + esc(search) + '”' + (v ? ' at ' + esc(v.name) : '') + '.' +
          (edits() ? ' Add it with “+ Add an item”.' : ' Ask Jonah where to get it, and he can add it here.')
        : (v ? 'Nothing listed for ' + esc(v.name) + ' yet.' : 'Nothing here yet.') +
          // The first visit: suppliers in, nothing bought from them yet. Say
          // how the list gets filled rather than just that it is empty.
          (edits() && !Object.keys(items).length
            ? ' Add things one at a time with “+ Add an item”, or paste a whole price list ' +
              'in at once with “💲 Price list”.'
            : '')) + '</p>';
      box.innerHTML = html;
      return;
    }

    if ((shown && shown !== RENTALS) || words.length) {
      // A search shows each item with its supplier; inside one supplier the
      // supplier is already on the card above.
      html += list.map(it => itemHtml(it, !v)).join('');
    } else {
      // Everything (or every rental), grouped by where it comes from.
      // Everything, grouped by supplier -- the way the list is kept.
      const groups = {};
      list.forEach(it => {
        const k = vendors[it.vendorId] ? it.vendorId : '-';
        (groups[k] = groups[k] || []).push(it);
      });
      Object.values(vendors).sort(byName).forEach(g => {
        if (!groups[g.id]) return;
        html += groupHeadHtml(g, groups[g.id].length) + groups[g.id].map(it => itemHtml(it, false)).join('');
      });
      if (groups['-']) {
        html += '<div class="sup-group"><span class="sup-group-name">No supplier set</span>' +
          '<span class="sup-group-count">' + groups['-'].length + '</span></div>' +
          groups['-'].map(it => itemHtml(it, false)).join('');
      }
    }
    box.innerHTML = html;
  }

  function linksHtml(v) {
    const map = v.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.address) : '';
    const tel = v.phone ? 'tel:' + String(v.phone).replace(/[^0-9+]/g, '') : '';
    const mail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email || '') ? 'mailto:' + v.email : '';
    return (map ? '<a class="btn btn-sm" href="' + map + '" target="_blank" rel="noopener">📍 Directions</a>' : '') +
      (tel ? '<a class="btn btn-sm" href="' + esc(tel) + '">📞 Call</a>' : '') +
      (mail ? '<a class="btn btn-sm" href="' + esc(mail) + '">✉️ Email</a>' : '');
  }

  function groupHeadHtml(v, n) {
    return '<div class="sup-group">' +
      '<button class="sup-group-name" onclick="supFilter(\'' + safeId(v.id) + '\')">' + esc(v.name) + '</button>' +
      '<span class="sup-group-count">' + n + '</span>' +
      '<span class="sup-group-links">' + linksHtml(v) + '</span>' +
    '</div>';
  }

  function vendorCardHtml(v, n) {
    return '<div class="sup-vcard">' +
      '<div class="sup-top"><span class="sup-vname">' + esc(v.name) + '</span>' +
        '<span class="sup-unit">' + n + ' item' + (n === 1 ? '' : 's') + '</span>' +
        (edits() ? '<button class="btn btn-sm sup-edit" onclick="supEdit(\'vendor\', \'' + safeId(v.id) + '\')">Edit supplier</button>' : '') +
      '</div>' +
      ([v.address, v.hours].filter(Boolean).length
        ? '<div class="sup-where">' + esc([v.address, v.hours].filter(Boolean).join(' · ')) + '</div>' : '') +
      (v.notes ? '<div class="sup-notes">' + esc(v.notes) + '</div>' : '') +
      '<div class="sup-links">' + linksHtml(v) +
        (edits() ? '<button class="btn btn-sm btn-filled" onclick="supEdit(\'item\', \'\', \'' + safeId(v.id) + '\')">+ Add an item here</button>' : '') +
        // Their own price sheet, as it comes: an Excel file or a CSV, with no
        // Supplier column needed.
        (edits() ? '<button class="btn btn-sm btn-accent" onclick="supPriceList(\'' + safeId(v.id) + '\')">💲 Price list</button>' : '') +
      '</div>' +
    '</div>';
  }

  function priceHtml(id) {
    if (!seesPrices()) return '';
    const p = prices[id];
    if (!p || typeof p.cents !== 'number') return '<div class="sup-price none">No price yet</div>';
    const prev = lastYears(p);
    const rates = [typeof p.halfDayCents === 'number' ? 'half day ' + fmtCents(p.halfDayCents) : '',
                   typeof p.weekCents === 'number' ? 'week ' + fmtCents(p.weekCents) : ''].filter(Boolean);
    return '<div class="sup-price"><b>' + fmtCents(p.cents) + '</b>' +
      (p.per ? ' <span class="sup-per">/ ' + esc(p.per) + '</span>' : '') +
      (rates.length ? ' <span class="sup-per">· ' + rates.join(' · ') + '</span>' : '') +
      (p.year ? ' <span class="sup-year">' + p.year + ' price</span>' : '') +
      (prev ? ' ' + changeHtml(change(p.cents, prev.cents)) : '') +
      (p.priceNotes ? '<div class="sup-pnotes">' + esc(p.priceNotes) + '</div>' : '') +
    '</div>';
  }

  function itemHtml(it, withVendor) {
    const v = vendors[it.vendorId] || null;
    return '<div class="sup-item">' +
      '<div class="sup-top">' +
        '<span class="sup-name">' + esc(it.name) + '</span>' +
        (it.unit ? '<span class="sup-unit">' + esc(it.unit) + '</span>' : '') +
        (it.sku ? '<span class="sup-unit">#' + esc(it.sku) + '</span>' : '') +
        (edits() ? '<button class="btn btn-sm sup-edit" onclick="supEdit(\'item\', \'' + safeId(it.id) + '\')">Edit</button>' : '') +
      '</div>' +
      (withVendor || it.where
        ? '<div class="sup-where">' + (withVendor ? '<b>' + esc(v ? v.name : 'No supplier set') + '</b>' : '') +
            (it.where ? (withVendor ? ' — ' : '') + esc(it.where) : '') + '</div>'
        : '') +
      (it.notes ? '<div class="sup-notes">' + esc(it.notes) + '</div>' : '') +
      priceHtml(it.id) +
      (withVendor && v && (v.address || v.phone)
        ? '<div class="sup-links">' + linksHtml(v) + (v.hours ? '<span class="sup-hours">' + esc(v.hours) + '</span>' : '') + '</div>'
        : '') +
    '</div>';
  }

  window.supSearch = function (q) { search = q; renderResults(); };
  window.supFilter = function (id) {
    shown = shown === id ? '' : id;
    renderResults();
    const r = el('supChips');
    if (r) r.scrollIntoView({ block: 'nearest' });
  };

  // ----------------------------------------------------------------- editing

  window.supEdit = function (kind, id, vendorId) {
    if (!edits()) return;
    editing = { kind: kind, id: id };
    if (kind === 'vendor') {
      const v = id ? vendors[id] || {} : {};
      openModal(id ? 'Edit supplier' : 'Add a supplier',
        field('Name', 'svName', v.name, 'e.g. MDS') +
        field('Address', 'svAddr', v.address, 'Street, town — used for directions') +
        '<div class="grid g2">' +
          field('Phone', 'svPhone', v.phone, '608-…') +
          field('Hours', 'svHours', v.hours, 'e.g. Mon–Sat 7–5') +
        '</div>' +
        // Where an order goes: Materials to Order writes the email (app.js).
        field('Email for orders', 'svEmail', v.email, 'orders@…') +
        '<div class="field"><span class="label">Notes</span><textarea id="svNotes" rows="2" ' +
          'placeholder="Account under YD Exterior, ask for Dave, yard entrance on the side road">' + esc(v.notes || '') + '</textarea></div>' +
        actions(id ? 'supRemove(\'vendor\', \'' + safeId(id) + '\')' : ''));
    } else {
      const it = id ? items[id] || {} : {};
      const p = (id && prices[id]) || {};
      const pick = it.vendorId || vendorId || (shown && shown !== '-' ? shown : '');
      const vs = Object.values(vendors).sort(byName);
      const show = v => (typeof v === 'number' ? String(v) : '');
      const priceShown = {
        price: typeof p.cents === 'number' ? (p.cents / 100).toFixed(2) : '',
        per: p.per || '', year: String(p.year || thisYear()), notes: p.priceNotes || '',
        markup: show(p.markupPct), waste: show(p.wastePct),
        client: typeof p.clientCents === 'number' ? (p.clientCents / 100).toFixed(2) : '',
        halfDay: typeof p.halfDayCents === 'number' ? (p.halfDayCents / 100).toFixed(2) : '',
        week: typeof p.weekCents === 'number' ? (p.weekCents / 100).toFixed(2) : '',
      };
      const catRule = ((window.YDPricing && window.YDPricing.rules().categories) || {})[it.category] || {};
      editing.priceShown = priceShown;
      const hist = Array.isArray(p.history) ? p.history : [];
      openModal(id ? 'Edit item' : 'Add an item',
        field('What it is', 'siName', it.name, 'e.g. Grass seed — sun & shade') +
        '<div class="field"><span class="label">Supplier</span><select id="siVendor">' +
          '<option value="">— pick one —</option>' +
          vs.map(v => '<option value="' + esc(v.id) + '"' + (v.id === pick ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('') +
        '</select>' + (vs.length ? '' : '<div class="hint">Add a supplier first, with “+ Add a supplier”.</div>') + '</div>' +
        '<div class="grid g2">' +
          field('Comes in', 'siUnit', it.unit, 'e.g. 50 lb bag, pallet, yard') +
          field('Supplier’s item #', 'siSku', it.sku, 'optional') +
        '</div>' +
        field('Where at the supplier', 'siWhere', it.where, 'e.g. front building, by the counter') +
        field('Also called (helps the search)', 'siAlso', it.also, 'e.g. seed, lawn seed, overseed') +
        '<div class="field"><span class="label">Notes for the crew</span><textarea id="siNotes" rows="2" ' +
          'placeholder="Which one to get, how much per job, anything to watch for">' + esc(it.notes || '') + '</textarea></div>' +
        '<fieldset class="sup-pricebox"><legend>For estimates</legend>' +
          '<div class="field"><span class="label">Kind of material</span><select id="siCat" onchange="supCatPicked(this.value)">' +
            '<option value="">— pick one —</option>' +
            categories().map(([cid, cname]) => '<option value="' + cid + '"' + (cid === it.category ? ' selected' : '') + '>' + esc(cname) + '</option>').join('') +
          '</select></div>' +
          '<div class="grid g2">' +
            field('One of these covers', 'siCover', show(it.coverage), 'e.g. 750 — blank if bought as measured', 'decimal') +
            field('…of what (the takeoff unit)', 'siTakeoff', it.takeoffUnit, 'e.g. sq ft, LF, plants') +
          '</div>' +
          '<label class="chk"><input type="checkbox" id="siPallet"' + (it.pallet ? ' checked' : '') + '> Comes on a pallet (forklift delivery surcharge)</label>' +
          '<label class="chk"><input type="checkbox" id="siSpecial"' + (it.specialOrder ? ' checked' : '') + '> Special order (non-returnable — the estimate says so)</label>' +
        '</fieldset>' +
        '<fieldset class="sup-pricebox"><legend>Price — only you see this</legend>' +
          '<div class="grid g3">' +
            field('Price ($)', 'spPrice', priceShown.price, 'e.g. 89.99', 'decimal') +
            field('Per', 'spPer', priceShown.per, it.unit || 'bag, yard, each') +
            field('For year', 'spYear', priceShown.year, String(thisYear()), 'numeric') +
          '</div>' +
          '<div class="grid g3">' +
            field('Markup %', 'spMarkup', priceShown.markup, catRule.markupPct != null ? catRule.markupPct + ' (its kind)' : 'its kind’s', 'decimal') +
            field('Waste %', 'spWaste', priceShown.waste, catRule.wastePct != null ? catRule.wastePct + ' (its kind)' : 'its kind’s', 'decimal') +
            field('Or: customer price each ($)', 'spClient', priceShown.client, 'only for fixed-price items', 'decimal') +
          '</div>' +
          // A rental: the price above is the day rate ("Per: day").
          '<div class="grid g2" id="spRentalRow"' + (isRental(it) ? '' : ' hidden') + '>' +
            field('Rental: half day ($)', 'spHalfDay', priceShown.halfDay, 'optional', 'decimal') +
            field('Rental: week ($)', 'spWeek', priceShown.week, 'optional', 'decimal') +
          '</div>' +
          '<div class="field"><span class="label">Price notes</span><textarea id="spNotes" rows="2" ' +
            'placeholder="Contractor price, 10+ bags $79, delivery $65">' + esc(priceShown.notes) + '</textarea></div>' +
          (hist.length ? '<div class="sup-hist">Earlier: ' + hist.map(h =>
            '<span>' + h.year + ' ' + fmtCents(h.cents) + '</span>').join('') + '</div>' : '') +
          '<div class="hint">A price for a new year keeps the old one as history, so the change shows. ' +
            'Fixing a price within the same year just replaces it.</div>' +
        '</fieldset>' +
        actions(id ? 'supRemove(\'item\', \'' + safeId(id) + '\')' : ''));
    }
    const first = el(kind === 'vendor' ? 'svName' : 'siName');
    if (first && !id) first.focus();
  };

  // Picking Rentals (or Dumpsters) as the kind shows the half-day and week
  // rates, and a blank "Per" becomes "day".
  window.supCatPicked = function (cat) {
    const rental = isRental({ category: cat });
    const row = el('spRentalRow'); if (row) row.hidden = !rental;
    const per = el('spPer'); if (rental && per && !per.value.trim() && cat === 'rental') per.value = 'day';
  };

  function field(label, id, value, ph, mode) {
    return '<div class="field"><span class="label">' + label + '</span>' +
      '<input id="' + id + '" value="' + esc(value || '') + '" placeholder="' + esc(ph || '') + '"' +
      (mode ? ' inputmode="' + mode + '"' : '') + '></div>';
  }
  function actions(removeCall) {
    return '<div class="field-actions">' +
      '<button class="btn btn-filled" onclick="supSave()">Save</button>' +
      '<button class="btn btn-sm" onclick="closeSupModal()">Cancel</button>' +
      (removeCall ? '<button class="btn btn-sm sup-delete" onclick="' + removeCall + '">Delete</button>' : '') +
    '</div>';
  }

  window.supSave = function () {
    if (!edits() || !editing) return;
    const now = new Date().toISOString();
    if (editing.kind === 'vendor') {
      const name = val('svName');
      if (!name) { showToast('Give the supplier a name'); return; }
      const id = editing.id || newId('v');
      const rec = { name: name, address: val('svAddr'), phone: val('svPhone'), hours: val('svHours'),
                    email: val('svEmail').toLowerCase(),
                    notes: (el('svNotes').value || '').trim(), updatedAt: now };
      vendors[id] = Object.assign({ id: id }, rec);
      write('vendors', id, rec);
      showToast(name + ' saved');
      closeSupModal(); renderResults();
      return;
    }

    const name = val('siName');
    if (!name) { showToast('Say what the item is'); return; }
    // The price is checked before anything is saved, so a typo in it does not
    // leave the item saved and the price silently dropped.
    const s = editing.priceShown || {};
    const typed = { price: val('spPrice'), per: val('spPer'), year: val('spYear'), notes: (el('spNotes').value || '').trim(),
                    markup: val('spMarkup'), waste: val('spWaste'), client: val('spClient'),
                    halfDay: val('spHalfDay'), week: val('spWeek') };
    const pricingTouched = typed.markup !== s.markup || typed.waste !== s.waste || typed.client !== s.client ||
      typed.halfDay !== (s.halfDay || '') || typed.week !== (s.week || '');
    const priceTouched = typed.price !== s.price || typed.per !== s.per || typed.year !== s.year || typed.notes !== s.notes || pricingTouched;
    const cents = parseCents(typed.price);
    if (priceTouched && Number.isNaN(cents)) { showToast('The price should look like 89.99'); return; }
    const year = validYear(typed.year);
    if (priceTouched && !year) { showToast('The year should look like ' + thisYear()); return; }
    const markupPct = parsePct(typed.markup), wastePct = parsePct(typed.waste), clientCents = parseCents(typed.client);
    const halfDayCents = parseCents(typed.halfDay), weekCents = parseCents(typed.week);
    if ([markupPct, wastePct, clientCents, halfDayCents, weekCents].some(n => Number.isNaN(n))) {
      showToast('Markup, waste, customer price and rental rates should be numbers'); return;
    }
    const coverage = parsePct(val('siCover'));
    if (Number.isNaN(coverage) || coverage !== null && !(coverage > 0)) { showToast('“Covers” should be a number above 0, or blank'); return; }

    const id = editing.id || newId('s');
    const rec = { name: name, also: val('siAlso'), vendorId: val('siVendor') || null, sku: val('siSku'),
                  where: val('siWhere'), unit: val('siUnit'), notes: (el('siNotes').value || '').trim(),
                  category: val('siCat') || null, coverage: coverage, takeoffUnit: val('siTakeoff'),
                  pallet: !!(el('siPallet') && el('siPallet').checked),
                  specialOrder: !!(el('siSpecial') && el('siSpecial').checked), updatedAt: now };
    items[id] = Object.assign({ id: id }, rec);
    write('supplies', id, rec);
    // Written only when the price box was actually changed. If this device
    // had not received the prices yet, an untouched (blank-looking) box must
    // not wipe the real price.
    if (priceTouched) {
      const next = applyPrice(prices[id], Object.assign({
        cents: typed.price !== s.price || typed.year !== s.year ? cents : undefined,
        per: typed.per, year: year, priceNotes: typed.notes,
      }, pricingTouched ? { markupPct: markupPct, wastePct: wastePct, clientCents: clientCents,
                            halfDayCents: halfDayCents, weekCents: weekCents } : {}));
      prices[id] = next;
      write('supplyPrices', id, next);
    }
    showToast(name + ' saved');
    closeSupModal(); renderResults();
  };

  window.supRemove = function (kind, id) {
    if (kind === 'vendor') {
      const v = vendors[id];
      const using = Object.values(items).filter(it => it.vendorId === id).length;
      if (!v || !confirm('Delete ' + v.name + '?' + (using ? '\n\n' + using + ' item(s) will show “No supplier set” until you pick another.' : ''))) return;
      delete vendors[id];
      if (shown === id) shown = '';
      remove([['vendors', id]]);
    } else {
      const it = items[id];
      if (!it || !confirm('Delete ' + it.name + '?')) return;
      delete items[id];
      delete prices[id];
      // The item and its price go together, or a price would be left behind
      // for an item nobody can see.
      remove([['supplies', id], ['supplyPrices', id]]);
    }
    closeSupModal(); renderResults();
  };

  // -------------------------------------------------------------- price list

  // Columns a pasted sheet may use. Matching ignores case and punctuation,
  // so "Item #", "item#" and "ITEM #" are all the item number.
  // Suppliers' own sheets name their columns every which way, so the common
  // ones are all here.
  const COLUMNS = {
    id: ['id'],
    vendor: ['supplier', 'vendor', 'store', 'bought from'],
    name: ['item', 'name', 'what it is', 'product', 'description', 'material', 'item description',
           'product description', 'item name', 'product name', 'desc'],
    sku: ['item #', 'item#', 'item no', 'item number', 'sku', 'part #', 'part#', 'part number', 'product #', 'code',
          'item code', 'product code', 'part', 'part no', 'catalog #', 'cat #', 'model', 'model #', 'style', 'style #'],
    unit: ['comes in', 'unit', 'size', 'uom', 'pack', 'u m', 'unit of measure', 'pkg', 'package'],
    price: ['price', 'cost', 'unit price', 'price each', 'each', 'new price', 'list price', 'net price', 'your price',
            'contractor price', 'dealer price', 'sale price', 'unit cost', 'cost each', 'price ea', 'price unit',
            'price per unit', 'retail', 'retail price'],
    per: ['per', 'price per', 'price is per'],
    year: ['year', 'price year', 'for year'],
    notes: ['notes', 'crew notes', 'notes for the crew'],
    priceNotes: ['price notes', 'pricing notes', 'owner notes'],
    where: ['where', 'where at the supplier', 'location', 'aisle'],
    also: ['also called', 'also', 'other names', 'aka'],
    // For estimates (pricing.js). Names as they read once "%" and the like
    // are taken out of the header.
    category: ['category', 'kind of material'],
    coverage: ['covers', 'one covers', 'coverage'],
    takeoffUnit: ['takeoff unit', 'covers what', 'of what'],
    pallet: ['pallet', 'on a pallet', 'palletized', 'comes on a pallet'],
    specialOrder: ['special order'],
    markupPct: ['markup', 'markup pct'],
    wastePct: ['waste', 'waste pct'],
    clientEach: ['customer price each', 'customer price', 'client price each'],
  };
  function headerKey(h) {
    const t = norm(h).replace(/[^a-z0-9#]+/g, ' ').trim();
    for (const k in COLUMNS) if (COLUMNS[k].indexOf(t) !== -1) return k;
    return null;
  }

  // CSV from a file or Excel/Sheets, or tab-separated text pasted straight out
  // of a spreadsheet. Quoted cells may hold commas, quotes and line breaks.
  function parseTable(text) {
    text = String(text || '').replace(/^﻿/, '');
    // Judged on the first thirty lines, not the first: a supplier's sheet
    // opens with a title line that has no separators in it at all.
    const sample = text.split(/\r?\n/, 30).join('\n');
    const count = ch => sample.split(ch).length - 1;
    const delim = count('\t') ? '\t' : (count(';') > count(',') ? ';' : ',');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += c;
      } else if (c === '"' && cell === '') {
        quoted = true;
      } else if (c === delim) {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // A downloaded list guards text that starts with = + - @ with an
    // apostrophe, so a spreadsheet cannot run it as a formula; take it off.
    return rows
      .map(r => r.map(c => c.trim().replace(/^'(?=[=+\-@])/, '')))
      .filter(r => r.some(c => c !== ''));
  }

  // A supplier's sheet often opens with its name, address and "Prices
  // effective…" before the column names. The line with the column names is
  // the first that has an item (or item number) column -- preferably one with
  // a price column too -- within the first 25.
  function findHeader(table) {
    let firstNamed = -1;
    for (let i = 0; i < Math.min(table.length, 25); i++) {
      const keys = table[i].map(headerKey);
      const named = keys.indexOf('name') !== -1 || keys.indexOf('id') !== -1 || keys.indexOf('sku') !== -1;
      if (named && keys.indexOf('price') !== -1) return i;
      if (named && firstNamed < 0) firstNamed = i;
    }
    return firstNamed < 0 ? 0 : firstNamed;
  }

  // Work out what an import would do, without doing any of it. With a
  // supplier given (the price list opened from its card), every row is that
  // supplier's: no Supplier column is needed, and rows are matched only
  // against what is already bought there.
  function buildPlan(table, defaultYear, forcedVendor) {
    // Line numbers in messages are the sheet's own, title lines included.
    const skippedLines = findHeader(table);
    table = table.slice(skippedLines);
    if (table.length < 2) return { error: 'Paste the column names on the first line and at least one item below them.' };
    const head = table[0].map(headerKey);
    if (head.indexOf('name') === -1 && head.indexOf('id') === -1 && !(forcedVendor && head.indexOf('sku') !== -1)) {
      return { error: 'No line with an “Item” (or “Description”) column was found. ' +
        'The first line reads: ' + table[0].slice(0, 6).join(', ') };
    }
    const vendorByKey = {};
    Object.values(vendors).forEach(v => { vendorByKey[key(v.name)] = v.id; });
    const itemByKey = {};
    const remember = (id, vendorId, name, sku) => {
      if (name) itemByKey[(vendorId || '') + '|' + key(name)] = id;
      if (sku) itemByKey[(vendorId || '') + '#' + key(sku)] = id;
    };
    Object.values(items).forEach(it => remember(it.id, it.vendorId, it.name, it.sku));

    const out = { rows: [], newVendors: [], skipped: [], dupes: 0, defaultYear: defaultYear };
    const newVendors = {};
    const rowAt = {};
    for (let r = 1; r < table.length; r++) {
      const line = r + 1 + skippedLines;
      const c = {};
      head.forEach((k, i) => { if (k && c[k] == null) c[k] = table[r][i] || ''; });
      // On a supplier's sheet "Unit" is what the price is per ("sq ft",
      // "bag"), unless the sheet says that separately.
      if (forcedVendor && !c.per && c.unit) c.per = c.unit;

      const existingById = c.id && items[c.id] ? items[c.id] : null;
      let vendorId = existingById ? existingById.vendorId || null : null;
      if (forcedVendor) {
        // A row from our own downloaded list that belongs to someone else
        // is not this supplier's to change.
        if (existingById && existingById.vendorId && existingById.vendorId !== forcedVendor) {
          out.skipped.push('Line ' + line + ': “' + existingById.name + '” is bought from ' +
            ((vendors[existingById.vendorId] || {}).name || 'another supplier'));
          continue;
        }
        vendorId = forcedVendor;
      } else if (c.vendor) {
        const vk = key(c.vendor);
        vendorId = vendorByKey[vk] || null;
        if (!vendorId) {
          if (!newVendors[vk]) newVendors[vk] = { id: newId('v'), name: c.vendor };
          vendorId = newVendors[vk].id;
        }
      }
      let id = existingById ? c.id : null;
      const byId = !!id;
      if (!id && c.sku) id = itemByKey[(vendorId || '') + '#' + key(c.sku)] || null;
      if (!id && c.name) id = itemByKey[(vendorId || '') + '|' + key(c.name)] || null;
      const isNew = !id;
      // A sheet's section headings ("PAVERS") and filler rows carry no price.
      // On a supplier's own sheet a line we do not know with no price is not
      // an item to add -- there is nothing on it worth saving.
      if (isNew && forcedVendor && !c.price) continue;
      if (isNew && !c.name) { out.skipped.push('Line ' + line + ': no item name'); continue; }

      const cents = parseCents(c.price);
      if (Number.isNaN(cents)) { out.skipped.push('Line ' + line + ': the price “' + c.price + '” is not a number'); continue; }
      if (c.year && !validYear(c.year)) { out.skipped.push('Line ' + line + ': the year “' + c.year + '” is not a year'); continue; }
      const year = validYear(c.year) || defaultYear;
      // The estimate columns: blank leaves a value as it is.
      const extra = {}, pricing = {};
      let bad = null;
      if (c.category) { const cat = categoryId(c.category); if (cat === undefined) bad = 'the kind “' + c.category + '” is not one Job Hub knows'; else extra.category = cat; }
      if (c.coverage) { const n = parsePct(c.coverage); if (!(n > 0)) bad = '“covers” should be a number above 0'; else extra.coverage = n; }
      if (c.takeoffUnit) extra.takeoffUnit = c.takeoffUnit;
      [['pallet', 'pallet'], ['specialOrder', 'special order']].forEach(([k, label]) => {
        if (!c[k]) return;
        const yn = yesNo(c[k]);
        if (yn === undefined) bad = label + ' should be yes or no'; else extra[k] = yn;
      });
      [['markupPct', 'markup'], ['wastePct', 'waste']].forEach(([k, label]) => {
        if (!c[k]) return;
        const n = parsePct(c[k]);
        if (Number.isNaN(n)) bad = 'the ' + label + ' “' + c[k] + '” is not a number'; else pricing[k] = n;
      });
      if (c.clientEach) {
        const n = parseCents(c.clientEach);
        if (Number.isNaN(n)) bad = 'the customer price “' + c.clientEach + '” is not a number'; else pricing.clientCents = n;
      }
      if (bad) { out.skipped.push('Line ' + line + ': ' + bad); continue; }

      if (isNew) {
        id = newId('s');
        remember(id, vendorId, c.name, c.sku);   // a second row for it updates this one
      }
      const old = prices[id] || null;
      const oldCents = old && typeof old.cents === 'number' ? old.cents : null;
      const row = {
        line: line, id: id, isNew: isNew, byId: byId, vendorId: vendorId, cells: c, cents: cents, year: year,
        extra: extra, pricing: pricing,
        oldCents: oldCents, oldYear: old ? old.year || null : null,
        kind: cents == null ? 'noprice' : oldCents == null ? 'first'
          : cents > oldCents ? 'up' : cents < oldCents ? 'down' : 'same',
      };
      if (rowAt[id] != null) { out.rows[rowAt[id]] = row; out.dupes++; }
      else { rowAt[id] = out.rows.length; out.rows.push(row); }
    }
    out.newVendors = Object.values(newVendors);
    // What this supplier sells that the sheet left out -- discontinued, or
    // just on another page. Their prices stay as they are.
    if (forcedVendor) {
      const inSheet = new Set(out.rows.map(r => r.id));
      out.missing = Object.values(items).filter(it => it.vendorId === forcedVendor && !inSheet.has(it.id))
        .sort(byName);
    }
    return out;
  }

  window.supPriceList = function (vendorId) {
    if (!edits()) return;
    plan = null;
    const v = vendorId && vendors[vendorId] ? vendors[vendorId] : null;
    planVendor = v ? v.id : null;
    if (v) { vendorPriceList(v); return; }
    const priced = Object.keys(items).filter(id => prices[id] && typeof prices[id].cents === 'number');
    const years = {};
    priced.forEach(id => { years[prices[id].year] = (years[prices[id].year] || 0) + 1; });
    const moves = priced.map(id => {
      const p = prices[id], prev = lastYears(p);
      return prev ? change(p.cents, prev.cents) : null;
    }).filter(x => x != null);
    const avg = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
    openModal('Price list',
      '<div class="sup-stat">' +
        '<b>' + priced.length + '</b> of ' + Object.keys(items).length + ' items have a price' +
        (Object.keys(years).length ? ' (' + Object.keys(years).sort().map(y => years[y] + ' from ' + y).join(', ') + ')' : '') + '.' +
        (avg != null ? '<br>Compared with the year before: ' + changeHtml(avg) + ' on average, across ' + moves.length + ' items.' : '') +
      '</div>' +
      '<div class="field-actions"><button class="btn btn-filled" onclick="supExportCsv()">⬇ Download the price list</button></div>' +
      '<div class="hint">For one supplier’s own price sheet, open that supplier and use its 💲 Price list button — no Supplier column needed.</div>' +
      '<h3 class="sup-h">Update prices</h3>' +
      '<div class="hint">Paste a spreadsheet below: copied straight out of Excel or Google Sheets, or a CSV file. ' +
        'The first line must be the column names. Understood: <b>Supplier, Item, Price</b>, and optionally ' +
        'Per, Year, Comes in, Item #, Where, Also called, Notes, Price notes, id — and for estimates ' +
        'Category, Covers, Takeoff unit, Pallet, Special order, Markup %, Waste %, Customer price each. ' +
        'Only the columns you include change; blank cells leave things as they are. ' +
        'A downloaded list keeps its id column, so each row goes back to exactly the item it came from.</div>' +
      '<div class="grid g2">' +
        field('These prices are for year (a Year column wins)', 'supImpYear', String(thisYear()), String(thisYear()), 'numeric') +
        '<div class="field"><span class="label">Or open a file</span>' +
          '<input type="file" id="supFile" accept="' + FILE_TYPES + '" onchange="supLoadFile(this)"></div>' +
      '</div>' +
      '<textarea id="supCsv" class="sup-csv" rows="7" spellcheck="false" ' +
        'placeholder="Supplier,Item,Price,Per&#10;MDS,Grass seed — sun &amp; shade,89.99,50 lb bag"></textarea>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="supCheckImport()">Check it</button>' +
        '<button class="btn btn-sm" onclick="closeSupModal()">Close</button>' +
      '</div>' +
      '<div id="supPreview"></div>');
  };

  const FILE_TYPES = '.csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods,text/csv,text/plain,' +
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,' +
    '.pdf,application/pdf,image/*';

  // A PDF quote or a photo of a price sheet: Claude reads it on the server
  // (sheets.py) into rows, which land in the box below as if pasted, to be
  // checked like any sheet. Photos are shrunk first -- a phone photo is
  // bigger than Claude takes, and the words read just as well at 2000 px.
  function shrinkPhoto(file) {
    return new Promise((ok, fail) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        ok({ mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.88).split(',')[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('That photo could not be opened')); };
      img.src = url;
    });
  }
  function asBase64(file) {
    return new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok({ mediaType: 'application/pdf', data: String(r.result || '').split(',')[1] || '' });
      r.onerror = () => fail(new Error('That file could not be read'));
      r.readAsDataURL(file);
    });
  }
  let reading = false;
  async function readSheet(f) {
    if (reading) return;
    if (!window.YDClaude || !window.YDClaude.available()) { showToast('Reading a PDF or photo needs a connection and sign-in'); return; }
    if (f.size > 20 * 1024 * 1024) { showToast('That file is over 20 MB — send fewer pages'); return; }
    const box = el('supPreview');
    const v = planVendor ? vendors[planVendor] : null;
    // Whose prices they are has to be known: a supplier's own Price list.
    if (!v) { showToast('Open the supplier on Supplies and use its own 💲 Price list to read a PDF or photo'); return; }
    reading = true;
    if (box) box.innerHTML = '<p class="empty-msg">Claude is reading “' + esc(f.name) + '” — a page takes about a minute…</p>';
    try {
      const file = /^image\//.test(f.type) ? await shrinkPhoto(f) : await asBase64(f);
      const known = Object.values(items).filter(it => it.vendorId === v.id).map(it => it.name);
      const r = await window.YDClaude.post('/supplies/read-sheet', Object.assign({ vendor: v.name, known: known, fileName: f.name }, file));
      if (planVendor !== v.id) return;      // the window was closed or moved on meanwhile
      const cell = s => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
      const head = ['Item #', 'Item', 'Comes in', 'Price', 'Per', 'Category', 'Notes', 'Price notes'];
      const rows = (r.rows || []).map(x => [cell(x.itemNo), cell(x.item), cell(x.comesIn),
        String(x.price), cell(x.per), cell(x.category), cell(x.notes), cell(x.priceNotes)].join('\t'));
      const t = el('supCsv'); if (t) t.value = [head.join('\t')].concat(rows).join('\n');
      if (box) box.innerHTML = '<div class="sup-stat">Claude read <b>' + rows.length + '</b> priced row' + (rows.length === 1 ? '' : 's') +
        ' from “' + esc(f.name) + '”. Look them over in the box above, then press <b>Check it</b> — nothing is saved until you do.' +
        (r.notes ? '<br><span class="muted">' + esc(r.notes) + '</span>' : '') +
        ((r.unreadable || []).length ? '<br><b>Could not read:</b> ' + r.unreadable.map(esc).join('; ') : '') + '</div>';
    } catch (e) {
      if (box) box.innerHTML = '<p class="empty-msg">' + esc(e.message || String(e)) + '</p>';
    } finally {
      reading = false;
    }
  }

  // One supplier's own price sheet, from that supplier's card.
  function vendorPriceList(v) {
    const mine = Object.values(items).filter(it => it.vendorId === v.id);
    const priced = mine.filter(it => prices[it.id] && typeof prices[it.id].cents === 'number');
    openModal('Price list — ' + v.name,
      '<div class="sup-stat"><b>' + priced.length + '</b> of ' + mine.length + ' ' + esc(v.name) +
        ' item' + (mine.length === 1 ? '' : 's') + ' have a price.</div>' +
      '<div class="hint">Upload ' + esc(v.name) + '’s price sheet as it comes — their Excel file or a CSV, or a PDF quote ' +
        'or a photo of a price sheet (Claude reads those, a few pages at a time) — or ' +
        'paste it straight out of a spreadsheet. No Supplier column needed: everything in it is taken as ' +
        esc(v.name) + '’s. Title lines at the top are skipped; the line with the column names is found by itself ' +
        '(an Item or Description column, and Price — optionally Item #, Per, Comes in, Year). ' +
        'Rows are matched to what you already buy here by item number, then by name; anything new is listed ' +
        'before anything is saved.</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Their file</span>' +
          '<input type="file" id="supFile" accept="' + FILE_TYPES + '" onchange="supLoadFile(this)"></div>' +
        field('These prices are for year (a Year column wins)', 'supImpYear', String(thisYear()), String(thisYear()), 'numeric') +
      '</div>' +
      '<textarea id="supCsv" class="sup-csv" rows="7" spellcheck="false" ' +
        'placeholder="Item #,Description,Price,Unit&#10;HP-60,Holland paver 60mm charcoal,4.15,sq ft"></textarea>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="supCheckImport()">Check it</button>' +
        '<button class="btn btn-sm" onclick="supExportCsv(\'' + safeId(v.id) + '\')">⬇ Download ' + esc(v.name) + '’s list</button>' +
        '<button class="btn btn-sm" onclick="closeSupModal()">Close</button>' +
      '</div>' +
      '<div id="supPreview"></div>');
  }

  // Excel files are read with SheetJS, fetched only when one is opened. The
  // copy is pinned to one version and checked against the hash cdnjs
  // publishes for it, so a changed file is refused rather than run.
  const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const XLSX_SRI = 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==';
  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = XLSX_SRC;
      s.integrity = XLSX_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.XLSX ? ok(window.XLSX) : fail(new Error('not loaded')));
      s.onerror = () => { xlsxLoading = null; fail(new Error('could not load')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  window.supLoadFile = function (input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    const put = text => { const t = el('supCsv'); if (t) t.value = text; };
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf' || /^image\//.test(f.type)) {
      readSheet(f);
      return;
    }
    if (/\.(xlsx|xlsm|xls|ods)$/i.test(f.name)) {
      showToast('Reading ' + f.name + '…');
      const r = new FileReader();
      r.onerror = () => showToast('That file could not be read');
      r.onload = () => {
        loadXlsx().then(XLSX => {
          const wb = XLSX.read(new Uint8Array(r.result), { type: 'array' });
          // The sheet with the most rows is the price list; a workbook often
          // has a cover sheet or a notes sheet besides.
          let best = null, bestRows = -1;
          wb.SheetNames.forEach(n => {
            const ws = wb.Sheets[n];
            const rows = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).e.r + 1 : 0;
            if (rows > bestRows) { best = n; bestRows = rows; }
          });
          // Tab-separated, so commas inside names and prices stay put.
          put(XLSX.utils.sheet_to_csv(wb.Sheets[best], { FS: '\t', blankrows: false }));
          showToast('Read “' + best + '”' + (wb.SheetNames.length > 1 ? ' (the biggest of ' + wb.SheetNames.length + ' sheets)' : '') +
            ' — now press Check it');
        }).catch(() => showToast('Excel files need a connection the first time — or save it as CSV and open that'));
      };
      r.readAsArrayBuffer(f);
      return;
    }
    const r = new FileReader();
    r.onload = () => put(String(r.result || ''));
    r.onerror = () => showToast('That file could not be read');
    r.readAsText(f);
  };

  window.supCheckImport = function () {
    const box = el('supPreview');
    if (!box) return;
    // History is built from the prices already saved. Working from a device
    // that has not heard from the server yet could file last year's price
    // under the wrong year -- or drop it.
    if (!pricesReady) {
      box.innerHTML = '<p class="empty-msg">Still loading the current prices from the cloud — try again in a moment. ' +
        '(This needs a connection.)</p>';
      return;
    }
    const year = validYear(val('supImpYear'));
    if (!year) { showToast('The year should look like ' + thisYear()); return; }
    plan = buildPlan(parseTable(el('supCsv').value), year, planVendor);
    if (plan.error) { box.innerHTML = '<p class="empty-msg">' + esc(plan.error) + '</p>'; plan = null; return; }

    const n = k => plan.rows.filter(r => r.kind === k).length;
    const added = plan.rows.filter(r => r.isNew).length;
    const nameOf = r => r.cells.name || (items[r.id] || {}).name || '';
    const vendorName = r => (vendors[r.vendorId] || plan.newVendors.find(v => v.id === r.vendorId) || {}).name || '—';
    const listed = plan.rows.filter(r => r.kind !== 'same' && r.kind !== 'noprice' || r.isNew)
      .sort((a, b) => vendorName(a).localeCompare(vendorName(b)) || nameOf(a).localeCompare(nameOf(b)));
    const same = plan.rows.length - listed.length;
    box.innerHTML =
      '<div class="sup-plan">' +
        [[n('up'), 'going up', 'up'], [n('down'), 'going down', 'down'], [n('same'), 'unchanged', ''],
         [n('first'), 'first price', ''], [added, 'new items', ''], [plan.newVendors.length, 'new suppliers', ''],
         [plan.skipped.length, 'skipped', 'warn']]
          .filter(x => x[0]).map(x => '<span class="sup-pill ' + x[2] + '"><b>' + x[0] + '</b> ' + x[1] + '</span>').join('') +
      '</div>' +
      (plan.newVendors.length ? '<div class="hint">New suppliers will be added: ' +
        plan.newVendors.map(v => '<b>' + esc(v.name) + '</b>').join(', ') +
        '. If one is a supplier you already have under another name, change the name in the sheet to match and check again.</div>' : '') +
      (plan.skipped.length ? '<div class="sup-skip">' + plan.skipped.map(esc).join('<br>') + '</div>' : '') +
      (plan.dupes ? '<div class="hint">' + plan.dupes + ' item(s) appear twice; the lower line wins.</div>' : '') +
      (plan.missing && plan.missing.length
        ? '<details class="sup-missing"><summary>' + plan.missing.length + ' of your ' +
            esc((vendors[planVendor] || {}).name || '') + ' items ' + (plan.missing.length === 1 ? 'is' : 'are') +
            ' not in this sheet — ' + (plan.missing.length === 1 ? 'its price stays' : 'their prices stay') +
            ' as ' + (plan.missing.length === 1 ? 'it is' : 'they are') + '</summary>' +
            plan.missing.map(it => esc(it.name) + (it.sku ? ' <small>#' + esc(it.sku) + '</small>' : '')).join('<br>') +
          '</details>' : '') +
      (listed.length ? '<div class="sup-table-wrap"><table class="sup-table"><thead><tr>' +
          '<th>Supplier</th><th>Item</th><th>Was</th><th>Now</th><th></th></tr></thead><tbody>' +
          listed.slice(0, 400).map(r => '<tr>' +
            '<td>' + esc(vendorName(r)) + '</td>' +
            '<td>' + esc(nameOf(r)) + (r.isNew ? ' <span class="sup-new">new</span>' : '') + '</td>' +
            '<td>' + (r.oldCents != null ? fmtCents(r.oldCents) + (r.oldYear && r.oldYear !== r.year ? ' <small>' + r.oldYear + '</small>' : '') : '—') + '</td>' +
            '<td>' + (r.cents != null ? '<b>' + fmtCents(r.cents) + '</b> <small>' + r.year + '</small>' : '—') + '</td>' +
            '<td>' + (r.kind === 'up' || r.kind === 'down' ? changeHtml(change(r.cents, r.oldCents)) : '') + '</td>' +
          '</tr>').join('') +
        '</tbody></table></div>' +
        (listed.length > 400 ? '<div class="hint">…and ' + (listed.length - 400) + ' more.</div>' : '') : '') +
      (same ? '<div class="hint">' + same + ' row(s) with no price change are not listed (any other details in them are still saved).</div>' : '') +
      (plan.rows.length
        ? '<div class="field-actions"><button class="btn btn-filled" onclick="supApplyImport()">Save these changes</button>' +
          '<button class="btn btn-sm" onclick="supPriceList(\'' + safeId(planVendor || '') + '\')">Start over</button></div>'
        : '<p class="empty-msg">Nothing to save.</p>');
  };

  window.supApplyImport = function () {
    if (!edits() || !plan || !plan.rows.length) return;
    const now = new Date().toISOString();
    const writes = [];
    plan.newVendors.forEach(v => {
      const rec = { name: v.name, address: '', phone: '', hours: '', notes: '', updatedAt: now };
      vendors[v.id] = Object.assign({ id: v.id }, rec);
      writes.push(['vendors', v.id, rec]);
    });
    plan.rows.forEach(r => {
      const c = r.cells;
      // Only what the sheet fills in changes, so a sheet of just names and
      // prices leaves every location, note and item number alone.
      const rec = {};
      ['name', 'also', 'sku', 'where', 'unit', 'notes'].forEach(k => { if (c[k]) rec[k] = c[k]; });
      // A supplier's own sheet spells things its own way ("Pavers - Holland"
      // for "Pavers — Holland"). Matching by name must not rename the item
      // every year; only our own downloaded list (matched by id) renames.
      if (!r.isNew && !r.byId) delete rec.name;
      if (c.vendor && r.vendorId) rec.vendorId = r.vendorId;
      Object.assign(rec, r.extra || {});
      if (r.isNew) {
        ['name', 'also', 'sku', 'where', 'unit', 'notes'].forEach(k => { if (rec[k] == null) rec[k] = ''; });
        if (rec.vendorId == null) rec.vendorId = r.vendorId || null;
      }
      if (Object.keys(rec).length) {
        rec.updatedAt = now;
        items[r.id] = Object.assign({ id: r.id }, items[r.id] || {}, rec);
        writes.push(['supplies', r.id, rec]);
      }
      const pricing = r.pricing || {};
      if (r.cents != null || c.per || c.priceNotes || Object.keys(pricing).length) {
        const next = applyPrice(prices[r.id], Object.assign({
          cents: r.cents != null ? r.cents : undefined,
          per: c.per || null, year: r.year, priceNotes: c.priceNotes || null,
        }, pricing));
        prices[r.id] = next;
        writes.push(['supplyPrices', r.id, next]);
      }
    });
    const count = plan.rows.length;
    plan = null;
    Promise.resolve(window.YDDb.putMany(writes)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[supplies] import not yet on the server:', (e && e.code) || e);
    });
    showToast(count + ' item' + (count === 1 ? '' : 's') + ' updated');
    closeSupModal(); renderResults();
  };

  // The whole list as a spreadsheet, one row per item, with the id that
  // brings each row back to its item when the sheet is pasted in again.
  window.supExportCsv = function (vendorId) {
    if (!seesPrices()) return;
    const only = vendorId && vendors[vendorId] ? vendors[vendorId] : null;
    const cell = (s, isText) => {
      let t = s == null ? '' : String(s);
      if (isText && /^[=+\-@]/.test(t)) t = "'" + t;   // never a formula in Excel
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const head = ['id', 'Supplier', 'Item', 'Item #', 'Comes in', 'Price', 'Per', 'Year',
                  'Previous price', 'Previous year', 'Change', 'Where', 'Also called', 'Notes', 'Price notes',
                  'Category', 'Covers', 'Takeoff unit', 'Pallet', 'Special order', 'Markup %', 'Waste %', 'Customer price each'];
    const catName = id => ((categories().find(c => c[0] === id) || [])[1]) || '';
    const yn = b => (b ? 'yes' : '');
    const n = v => (typeof v === 'number' ? String(v) : '');
    const vName = it => (vendors[it.vendorId] || {}).name || '';
    const rows = Object.values(items)
      .filter(it => !only || it.vendorId === only.id)
      .sort((a, b) => vName(a).localeCompare(vName(b)) || byName(a, b))
      .map(it => {
        const p = prices[it.id] || {};
        const prev = lastYears(p);
        const pct = prev ? change(p.cents, prev.cents) : null;
        return [cell(it.id), cell(vName(it), true), cell(it.name, true), cell(it.sku, true), cell(it.unit, true),
          typeof p.cents === 'number' ? (p.cents / 100).toFixed(2) : '', cell(p.per, true), p.year || '',
          prev ? (prev.cents / 100).toFixed(2) : '', prev ? prev.year : '',
          pct != null ? (pct > 0 ? '+' : '') + pct.toFixed(1) + '%' : '',
          cell(it.where, true), cell(it.also, true), cell(it.notes, true), cell(p.priceNotes, true),
          cell(catName(it.category), true), n(it.coverage), cell(it.takeoffUnit, true), yn(it.pallet), yn(it.specialOrder),
          n(p.markupPct), n(p.wastePct), typeof p.clientCents === 'number' ? (p.clientCents / 100).toFixed(2) : ''].join(',');
      });
    // A byte-order mark and CRLF line endings, so Excel opens it with the
    // dashes and accents intact.
    const blob = new Blob(['﻿' + [head.join(',')].concat(rows).join('\r\n') + '\r\n'],
      { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (only ? only.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' price list ' : 'YD supplies price list ') +
      localToday() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Some browsers have not started the download when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast(rows.length + ' items downloaded');
  };

  // ---------------------------------------------------------------- plumbing

  function openModal(title, html) {
    const m = el('supModal'), t = el('supModalTitle'), b = el('supModalBody');
    if (!m || !b) return;
    if (t) t.textContent = title;
    b.innerHTML = html;
    m.classList.add('active');
    b.scrollTop = 0;
  }
  window.closeSupModal = function () {
    const m = el('supModal');
    if (m) m.classList.remove('active');
    editing = null;
    plan = null;
  };

  // Not awaited -- see the note in boards.js.
  function write(path, id, data) {
    Promise.resolve(window.YDDb.put(path, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[supplies] not yet on the server:', (e && e.code) || e);
    });
  }
  function remove(entries) {
    Promise.resolve(window.YDDb.removeMany(entries)).catch(e => console.warn('[supplies] not removed:', (e && e.code) || e));
  }

  function redrawIfVisible() {
    const p = el('panel-supplies');
    if (p && p.classList.contains('active')) renderResults();
  }

  // Estimates re-price when Supplies changes; a burst of snapshots (the
  // first load) is told once.
  let announceTimer = null;
  function announce() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => document.dispatchEvent(new CustomEvent('yd-supplies')), 150);
  }

  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; items = {}; vendors = {}; prices = {}; pricesReady = false; shown = '';
  }
  function start() {
    stop();
    const take = (store, withId) => (changes, meta) => {
      changes.forEach(c => {
        if (c.type === 'removed') delete store[c.id];
        else store[c.id] = withId ? Object.assign({ id: c.id }, c.data) : c.data;
      });
      if (store === prices && meta && meta.fromCache === false) pricesReady = true;
      redrawIfVisible();
      announce();
    };
    unsubs.push(window.YDDb.watch('supplies', take(items, true), () => redrawIfVisible()));
    unsubs.push(window.YDDb.watch('vendors', take(vendors, true), () => redrawIfVisible()));
    // Crew are refused the prices outright, so they never ask.
    if (seesPrices()) unsubs.push(window.YDDb.watch('supplyPrices', take(prices, false), () => redrawIfVisible()));
  }

  // parseTable is shared with the estimate price book (estimate.js), which
  // takes the same pasted-from-Excel sheets. catalog() is what estimates are
  // priced from (pricing.js); 'yd-supplies' says it changed.
  // A receipt's supplier among ours: the same name, one name inside the
  // other ("The Home Depot"), or the initials ("Midwest Decorative Stone" is
  // MDS). Then its item: by the supplier's item number, else by name (or an
  // "also called" name), punctuation ignored. With no known supplier nothing
  // is matched -- a name alone is too loose to price by. (receipts.js)
  function vendorFor(name) {
    const k = key(name);
    if (!k) return null;
    const words = norm(name).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
      .filter(w => w && ['the', 'inc', 'llc', 'co', 'company', 'corp'].indexOf(w) === -1);
    const initials = words.map(w => w[0]).join('');
    const vs = Object.values(vendors);
    return vs.find(v => key(v.name) === k) ||
      vs.find(v => { const vk = key(v.name); return vk.length >= 4 && (k.indexOf(vk) !== -1 || vk.indexOf(k) !== -1); }) ||
      (initials.length >= 2 ? vs.find(v => key(v.name) === initials) : null) || null;
  }
  function findSupply(vendorName, sku, name) {
    const v = vendorFor(vendorName);
    if (!v) return null;
    const list = Object.values(items).filter(it => it.vendorId === v.id);
    const names = it => [it.name].concat(String(it.also || '').split(/[;,]/)).map(key).filter(Boolean);
    return (sku && list.find(it => it.sku && key(it.sku) === key(sku))) ||
      (name && list.find(it => names(it).indexOf(key(name)) !== -1)) || null;
  }
  // A new price for one item, filed the way the price list files it (a
  // newer year moves the old price into its history). Not awaited.
  function setPrice(id, cents, year) {
    const rec = applyPrice(prices[id], { cents: cents, year: year || thisYear() });
    prices[id] = rec;
    announce();
    return Promise.resolve(window.YDDb.put('supplyPrices', id, rec));
  }

  // A material from an estimate -- a price found for it ("Source it") or an
  // item typed onto a bid ("Add typed-in items to Supplies"), estimate.js:
  // the item under its supplier -- the one already here, or added -- with
  // its price (when there is one) and where it came from in its price notes,
  // so the next bid finds it in Supplies. Returns the item's id. Not awaited.
  // One unit however it is written ("sq. ft" = "sf", "Tons" = "ton"), so a
  // price per box is never filed on an item bought by the piece.
  function unitWord(u) {
    const s = norm(u).replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const table = [[/^(each|ea|pc|pcs|piece|pieces|unit|units)$/, 'each'], [/^(sq ?ft|sf|square f(ee|oo)t)$/, 'sqft'],
      [/^(lf|lin ?ft|linear f(ee|oo)t|ft|feet|foot)$/, 'lf'], [/^(tons?|t)$/, 'ton'],
      [/^(yards?|yds?|cu ?yds?|cubic yards?)$/, 'yd'], [/^(cu ?ft|cubic f(ee|oo)t)$/, 'cuft'], [/^(gal|gallons?)$/, 'gal']];
    const hit = table.find(([re]) => re.test(s));
    return hit ? hit[1] : s.replace(/s$/, '');
  }
  // A supplier by its name, strictly: the same name, or one name inside the
  // other ("Home Depot" / "The Home Depot") -- never by initials, which could
  // file a new supplier's items under the wrong one.
  function vendorNamed(name) {
    const k = key(name);
    if (!k) return null;
    const vs = Object.values(vendors);
    return vs.find(v => key(v.name) === k) ||
      vs.find(v => { const vk = key(v.name); return vk.length >= 4 && k.length >= 4 && (k.indexOf(vk) !== -1 || vk.indexOf(k) !== -1); }) || null;
  }
  function addSourced(o) {
    if (!edits() || !o || !String(o.vendor || '').trim() || !String(o.name || '').trim()) return null;
    if (o.cents != null && !(o.cents > 0)) return null;
    const now = new Date().toISOString(), writes = [];
    let v = (o.vendorId && vendors[o.vendorId]) || vendorNamed(o.vendor);
    if (!v) {
      const id = newId('v');
      const rec = { name: String(o.vendor).trim().slice(0, 80), address: '', phone: '', hours: '',
                    notes: 'Added when sourcing an estimate', updatedAt: now };
      vendors[id] = Object.assign({ id: id }, rec);
      v = vendors[id];
      writes.push(['vendors', id, rec]);
    }
    // The line's own item, when the price is from its supplier (an MDS item
    // with no price, priced from MDS's page) -- not a second copy of it.
    const inVendor = (sku, name) => {
      const list = Object.values(items).filter(x => x.vendorId === v.id);
      const names = x => [x.name].concat(String(x.also || '').split(/[;,]/)).map(key).filter(Boolean);
      return (sku && list.find(x => x.sku && key(x.sku) === key(sku))) || list.find(x => names(x).indexOf(key(name)) !== -1) || null;
    };
    const per = String(o.per || '').trim();
    // An item already here takes the price only when it is sold the same way;
    // "Fabric" at $90 a roll is not re-priced at 12 cents a sq ft. Otherwise
    // the product goes in as its own item, named with how it is sold.
    const fits = x => { const was = (prices[x.id] || {}).per || x.unit; return !per || !was || unitWord(was) === unitWord(per); };
    let it = o.into && items[o.into] && items[o.into].vendorId === v.id ? items[o.into] : inVendor(o.sku || '', o.name);
    let name = String(o.name).trim();
    if (it && !fits(it)) {
      name = name + ' (per ' + per + ')';
      it = inVendor('', name);
    }
    // Sold by the bag/roll/box but measured in sq ft (or LF...): how much
    // one covers, so the estimate orders whole packages.
    const covers = Number(o.coverage) > 0 && String(o.takeoffUnit || '').trim();
    if (it && covers && !(Number(it.coverage) > 0)) {
      const patch = { coverage: Number(o.coverage), takeoffUnit: String(o.takeoffUnit).trim().slice(0, 30), updatedAt: now };
      Object.assign(it, patch);
      writes.push(['supplies', it.id, patch]);
    }
    if (!it) {
      const id = newId('s');
      const rec = { name: name.slice(0, 120), also: '', sku: String(o.sku || '').trim().slice(0, 40),
                    where: '', notes: String(o.notes || '').trim().slice(0, 300),
                    unit: String(o.per || o.unit || '').trim().slice(0, 30), vendorId: v.id,
                    category: categoryId(o.category) || null,
                    coverage: covers ? Number(o.coverage) : null,
                    takeoffUnit: covers ? String(o.takeoffUnit).trim().slice(0, 30) : '', updatedAt: now };
      items[id] = Object.assign({ id: id }, rec);
      it = items[id];
      writes.push(['supplies', id, rec]);
    }
    if (o.cents > 0) {
      const next = applyPrice(prices[it.id], { cents: Math.round(o.cents), per: per || null,
                                               year: thisYear(), priceNotes: String(o.note || '').slice(0, 300) || null });
      prices[it.id] = next;
      writes.push(['supplyPrices', it.id, next]);
    }
    if (!writes.length) return it.id;
    Promise.resolve(window.YDDb.putMany(writes)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[supplies] sourced price not yet on the server:', (e && e.code) || e);
    });
    announce();
    return it.id;
  }

  window.YDSupplies = {
    render: render, parseTable: parseTable, parseCents: parseCents,
    catalog: () => ({ items: items, prices: prices, vendors: vendors, pricesReady: pricesReady }),
    findSupply: findSupply, setPrice: setPrice, addSourced: addSourced,
    shrinkPhoto: shrinkPhoto,     // receipts.js, for a receipt photo
  };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const tab = el('tabSupplies');
    if (tab) tab.hidden = !on;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== authKey) {
      authKey = k;
      if (on) start(); else stop();
      // The owner's buttons differ from the crew's, so redraw from scratch.
      const w = el('suppliesWrap'); if (w) w.innerHTML = '';
    }
    render();
  });
})();
