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

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
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
  function applyPrice(old, e) {
    const cur = Object.assign({ cents: null, per: '', year: null, asOf: '', priceNotes: '' }, old || {});
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
    return {
      cents: typeof cur.cents === 'number' ? cur.cents : null,
      per: cur.per || '',
      year: cur.year || e.year || thisYear(),
      asOf: cur.asOf || '',
      priceNotes: cur.priceNotes || '',
      history: history.sort((a, b) => b.year - a.year).slice(0, 15)
        .map(h => ({ year: h.year, cents: h.cents, per: h.per || '', asOf: h.asOf || '' })),
      updatedAt: new Date().toISOString(),
    };
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
        (isOwner() ? '<div class="field-actions sup-actions">' +
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

  function renderChips() {
    const box = el('supChips');
    if (!box) return;
    const count = {};
    Object.values(items).forEach(it => {
      const k = vendors[it.vendorId] ? it.vendorId : '-';
      count[k] = (count[k] || 0) + 1;
    });
    const vs = Object.values(vendors).sort(byName);
    if (shown && shown !== '-' && !vendors[shown]) shown = '';
    const chip = (id, label, n) =>
      '<button class="sup-chip' + (shown === id ? ' on' : '') + '" onclick="supFilter(\'' + safeId(id) + '\')">' +
        esc(label) + (n != null ? ' <span>' + n + '</span>' : '') + '</button>';
    box.innerHTML = vs.length
      ? chip('', 'All suppliers', Object.keys(items).length) +
        vs.map(v => chip(v.id, v.name, count[v.id] || 0)).join('') +
        (count['-'] ? chip('-', 'No supplier', count['-']) : '')
      : '';
  }

  function renderResults() {
    const box = el('supResults');
    if (!box) return;
    renderChips();
    const words = norm(search).split(/\s+/).filter(Boolean);
    const inShown = it => !shown || (shown === '-' ? !vendors[it.vendorId] : it.vendorId === shown);
    const list = Object.values(items)
      .filter(it => inShown(it) && (!words.length || matches(it, words)))
      .sort(byName);

    if (!Object.keys(items).length && !Object.keys(vendors).length) {
      box.innerHTML = '<p class="empty-msg">' + (isOwner()
        ? 'Nothing here yet. Add your suppliers first, then the things you buy from each — ' +
          'and where they are once you get there.'
        : 'Nothing has been added here yet.') + '</p>';
      return;
    }

    let html = '';
    // One supplier picked: its card first -- address, phone, hours, notes --
    // then everything bought there.
    const v = shown && shown !== '-' ? vendors[shown] : null;
    if (v) html += vendorCardHtml(v, list.length);

    if (!list.length) {
      html += '<p class="empty-msg">' + (words.length
        ? 'Nothing matches “' + esc(search) + '”' + (v ? ' at ' + esc(v.name) : '') + '.' +
          (isOwner() ? ' Add it with “+ Add an item”.' : ' Ask Jonah where to get it, and he can add it here.')
        : (v ? 'Nothing listed for ' + esc(v.name) + ' yet.' : 'Nothing here yet.') +
          // The first visit: suppliers in, nothing bought from them yet. Say
          // how the list gets filled rather than just that it is empty.
          (isOwner() && !Object.keys(items).length
            ? ' Add things one at a time with “+ Add an item”, or paste a whole price list ' +
              'in at once with “💲 Price list”.'
            : '')) + '</p>';
      box.innerHTML = html;
      return;
    }

    if (shown || words.length) {
      // A search shows each item with its supplier; inside one supplier the
      // supplier is already on the card above.
      html += list.map(it => itemHtml(it, !v)).join('');
    } else {
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
    return (map ? '<a class="btn btn-sm" href="' + map + '" target="_blank" rel="noopener">📍 Directions</a>' : '') +
      (tel ? '<a class="btn btn-sm" href="' + esc(tel) + '">📞 Call</a>' : '');
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
        (isOwner() ? '<button class="btn btn-sm sup-edit" onclick="supEdit(\'vendor\', \'' + safeId(v.id) + '\')">Edit supplier</button>' : '') +
      '</div>' +
      ([v.address, v.hours].filter(Boolean).length
        ? '<div class="sup-where">' + esc([v.address, v.hours].filter(Boolean).join(' · ')) + '</div>' : '') +
      (v.notes ? '<div class="sup-notes">' + esc(v.notes) + '</div>' : '') +
      '<div class="sup-links">' + linksHtml(v) +
        (isOwner() ? '<button class="btn btn-sm btn-filled" onclick="supEdit(\'item\', \'\', \'' + safeId(v.id) + '\')">+ Add an item here</button>' : '') +
      '</div>' +
    '</div>';
  }

  function priceHtml(id) {
    if (!isOwner()) return '';
    const p = prices[id];
    if (!p || typeof p.cents !== 'number') return '<div class="sup-price none">No price yet</div>';
    const prev = lastYears(p);
    return '<div class="sup-price"><b>' + fmtCents(p.cents) + '</b>' +
      (p.per ? ' <span class="sup-per">/ ' + esc(p.per) + '</span>' : '') +
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
        (isOwner() ? '<button class="btn btn-sm sup-edit" onclick="supEdit(\'item\', \'' + safeId(it.id) + '\')">Edit</button>' : '') +
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
    if (!isOwner()) return;
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
        '<div class="field"><span class="label">Notes</span><textarea id="svNotes" rows="2" ' +
          'placeholder="Account under YD Exterior, ask for Dave, yard entrance on the side road">' + esc(v.notes || '') + '</textarea></div>' +
        actions(id ? 'supRemove(\'vendor\', \'' + safeId(id) + '\')' : ''));
    } else {
      const it = id ? items[id] || {} : {};
      const p = (id && prices[id]) || {};
      const pick = it.vendorId || vendorId || (shown && shown !== '-' ? shown : '');
      const vs = Object.values(vendors).sort(byName);
      const priceShown = {
        price: typeof p.cents === 'number' ? (p.cents / 100).toFixed(2) : '',
        per: p.per || '', year: String(p.year || thisYear()), notes: p.priceNotes || '',
      };
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
        '<fieldset class="sup-pricebox"><legend>Price — only you see this</legend>' +
          '<div class="grid g3">' +
            field('Price ($)', 'spPrice', priceShown.price, 'e.g. 89.99', 'decimal') +
            field('Per', 'spPer', priceShown.per, it.unit || 'bag, yard, each') +
            field('For year', 'spYear', priceShown.year, String(thisYear()), 'numeric') +
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
    if (!isOwner() || !editing) return;
    const now = new Date().toISOString();
    if (editing.kind === 'vendor') {
      const name = val('svName');
      if (!name) { showToast('Give the supplier a name'); return; }
      const id = editing.id || newId('v');
      const rec = { name: name, address: val('svAddr'), phone: val('svPhone'), hours: val('svHours'),
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
    const typed = { price: val('spPrice'), per: val('spPer'), year: val('spYear'), notes: (el('spNotes').value || '').trim() };
    const priceTouched = typed.price !== s.price || typed.per !== s.per || typed.year !== s.year || typed.notes !== s.notes;
    const cents = parseCents(typed.price);
    if (priceTouched && Number.isNaN(cents)) { showToast('The price should look like 89.99'); return; }
    const year = validYear(typed.year);
    if (priceTouched && !year) { showToast('The year should look like ' + thisYear()); return; }

    const id = editing.id || newId('s');
    const rec = { name: name, also: val('siAlso'), vendorId: val('siVendor') || null, sku: val('siSku'),
                  where: val('siWhere'), unit: val('siUnit'), notes: (el('siNotes').value || '').trim(), updatedAt: now };
    items[id] = Object.assign({ id: id }, rec);
    write('supplies', id, rec);
    // Written only when the price box was actually changed. If this device
    // had not received the prices yet, an untouched (blank-looking) box must
    // not wipe the real price.
    if (priceTouched) {
      const next = applyPrice(prices[id], {
        cents: typed.price !== s.price || typed.year !== s.year ? cents : undefined,
        per: typed.per, year: year, priceNotes: typed.notes,
      });
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
  const COLUMNS = {
    id: ['id'],
    vendor: ['supplier', 'vendor', 'store', 'bought from'],
    name: ['item', 'name', 'what it is', 'product', 'description', 'material'],
    sku: ['item #', 'item#', 'item no', 'item number', 'sku', 'part #', 'part#', 'part number', 'product #', 'code'],
    unit: ['comes in', 'unit', 'size', 'uom', 'pack'],
    price: ['price', 'cost', 'unit price', 'price each', 'each', 'new price'],
    per: ['per', 'price per', 'price is per'],
    year: ['year', 'price year', 'for year'],
    notes: ['notes', 'crew notes', 'notes for the crew'],
    priceNotes: ['price notes', 'pricing notes', 'owner notes'],
    where: ['where', 'where at the supplier', 'location', 'aisle'],
    also: ['also called', 'also', 'other names', 'aka'],
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
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = first.indexOf('\t') !== -1 ? '\t'
      : (first.split(';').length > first.split(',').length ? ';' : ',');
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

  // Work out what an import would do, without doing any of it.
  function buildPlan(table, defaultYear) {
    if (table.length < 2) return { error: 'Paste the column names on the first line and at least one item below them.' };
    const head = table[0].map(headerKey);
    if (head.indexOf('name') === -1 && head.indexOf('id') === -1) {
      return { error: 'The first line needs an “Item” column (or the “id” column from a downloaded list). ' +
        'It reads: ' + table[0].slice(0, 6).join(', ') };
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
      const line = r + 1;
      const c = {};
      head.forEach((k, i) => { if (k && c[k] == null) c[k] = table[r][i] || ''; });

      const existingById = c.id && items[c.id] ? items[c.id] : null;
      let vendorId = existingById ? existingById.vendorId || null : null;
      if (c.vendor) {
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
      if (isNew && !c.name) { out.skipped.push('Line ' + line + ': no item name'); continue; }

      const cents = parseCents(c.price);
      if (Number.isNaN(cents)) { out.skipped.push('Line ' + line + ': the price “' + c.price + '” is not a number'); continue; }
      if (c.year && !validYear(c.year)) { out.skipped.push('Line ' + line + ': the year “' + c.year + '” is not a year'); continue; }
      const year = validYear(c.year) || defaultYear;

      if (isNew) {
        id = newId('s');
        remember(id, vendorId, c.name, c.sku);   // a second row for it updates this one
      }
      const old = prices[id] || null;
      const oldCents = old && typeof old.cents === 'number' ? old.cents : null;
      const row = {
        line: line, id: id, isNew: isNew, byId: byId, vendorId: vendorId, cells: c, cents: cents, year: year,
        oldCents: oldCents, oldYear: old ? old.year || null : null,
        kind: cents == null ? 'noprice' : oldCents == null ? 'first'
          : cents > oldCents ? 'up' : cents < oldCents ? 'down' : 'same',
      };
      if (rowAt[id] != null) { out.rows[rowAt[id]] = row; out.dupes++; }
      else { rowAt[id] = out.rows.length; out.rows.push(row); }
    }
    out.newVendors = Object.values(newVendors);
    return out;
  }

  window.supPriceList = function () {
    if (!isOwner()) return;
    plan = null;
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
      '<h3 class="sup-h">Update prices</h3>' +
      '<div class="hint">Paste a spreadsheet below: copied straight out of Excel or Google Sheets, or a CSV file. ' +
        'The first line must be the column names. Understood: <b>Supplier, Item, Price</b>, and optionally ' +
        'Per, Year, Comes in, Item #, Where, Also called, Notes, Price notes, id. ' +
        'Only the columns you include change; blank cells leave things as they are. ' +
        'A downloaded list keeps its id column, so each row goes back to exactly the item it came from.</div>' +
      '<div class="grid g2">' +
        field('These prices are for year (a Year column wins)', 'supImpYear', String(thisYear()), String(thisYear()), 'numeric') +
        '<div class="field"><span class="label">Or open a file</span>' +
          '<input type="file" id="supFile" accept=".csv,.tsv,.txt,text/csv,text/plain" onchange="supLoadFile(this)"></div>' +
      '</div>' +
      '<textarea id="supCsv" class="sup-csv" rows="7" spellcheck="false" ' +
        'placeholder="Supplier,Item,Price,Per&#10;MDS,Grass seed — sun &amp; shade,89.99,50 lb bag"></textarea>' +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="supCheckImport()">Check it</button>' +
        '<button class="btn btn-sm" onclick="closeSupModal()">Close</button>' +
      '</div>' +
      '<div id="supPreview"></div>');
  };

  window.supLoadFile = function (input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { const t = el('supCsv'); if (t) t.value = String(r.result || ''); };
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
    plan = buildPlan(parseTable(el('supCsv').value), year);
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
          '<button class="btn btn-sm" onclick="supPriceList()">Start over</button></div>'
        : '<p class="empty-msg">Nothing to save.</p>');
  };

  window.supApplyImport = function () {
    if (!isOwner() || !plan || !plan.rows.length) return;
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
      if (r.isNew) {
        ['name', 'also', 'sku', 'where', 'unit', 'notes'].forEach(k => { if (rec[k] == null) rec[k] = ''; });
        if (rec.vendorId == null) rec.vendorId = r.vendorId || null;
      }
      if (Object.keys(rec).length) {
        rec.updatedAt = now;
        items[r.id] = Object.assign({ id: r.id }, items[r.id] || {}, rec);
        writes.push(['supplies', r.id, rec]);
      }
      if (r.cents != null || c.per || c.priceNotes) {
        const next = applyPrice(prices[r.id], {
          cents: r.cents != null ? r.cents : undefined,
          per: c.per || null, year: r.year, priceNotes: c.priceNotes || null,
        });
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
  window.supExportCsv = function () {
    if (!isOwner()) return;
    const cell = (s, isText) => {
      let t = s == null ? '' : String(s);
      if (isText && /^[=+\-@]/.test(t)) t = "'" + t;   // never a formula in Excel
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const head = ['id', 'Supplier', 'Item', 'Item #', 'Comes in', 'Price', 'Per', 'Year',
                  'Previous price', 'Previous year', 'Change', 'Where', 'Also called', 'Notes', 'Price notes'];
    const vName = it => (vendors[it.vendorId] || {}).name || '';
    const rows = Object.values(items)
      .sort((a, b) => vName(a).localeCompare(vName(b)) || byName(a, b))
      .map(it => {
        const p = prices[it.id] || {};
        const prev = lastYears(p);
        const pct = prev ? change(p.cents, prev.cents) : null;
        return [cell(it.id), cell(vName(it), true), cell(it.name, true), cell(it.sku, true), cell(it.unit, true),
          typeof p.cents === 'number' ? (p.cents / 100).toFixed(2) : '', cell(p.per, true), p.year || '',
          prev ? (prev.cents / 100).toFixed(2) : '', prev ? prev.year : '',
          pct != null ? (pct > 0 ? '+' : '') + pct.toFixed(1) + '%' : '',
          cell(it.where, true), cell(it.also, true), cell(it.notes, true), cell(p.priceNotes, true)].join(',');
      });
    // A byte-order mark and CRLF line endings, so Excel opens it with the
    // dashes and accents intact.
    const blob = new Blob(['﻿' + [head.join(',')].concat(rows).join('\r\n') + '\r\n'],
      { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'YD supplies price list ' + localToday() + '.csv';
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
    };
    unsubs.push(window.YDDb.watch('supplies', take(items, true), () => redrawIfVisible()));
    unsubs.push(window.YDDb.watch('vendors', take(vendors, true), () => redrawIfVisible()));
    // Crew are refused the prices outright, so they never ask.
    if (isOwner()) unsubs.push(window.YDDb.watch('supplyPrices', take(prices, false), () => redrawIfVisible()));
  }

  window.YDSupplies = { render: render };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const tab = el('tabSupplies');
    if (tab) tab.hidden = !on;
    const k = on ? a.user.uid + ':' + a.role : null;
    if (k !== authKey) {
      authKey = k;
      if (on) start(); else stop();
      // The owner's buttons differ from the crew's, so redraw from scratch.
      const w = el('suppliesWrap'); if (w) w.innerHTML = '';
    }
    render();
  });
})();
