// Supplies: what we use, where to buy it, and where it is once you get there.
//
// The question this answers is the one a crew member asks from the truck:
// "where do I get seed?" -- and the answer they need is not just "MDS" but
// "MDS, the front building, ask at the counter". So every item says which
// supplier, and where at that supplier; every supplier carries its address
// (one tap to directions), phone (one tap to call) and hours.
//
// Two collections, because a supplier is shared by many items:
//   vendors/{id}    name, address, phone, hours, notes
//   supplies/{id}   name, other names it goes by, vendorId, where, unit, notes
//
// No prices here on purpose. Everyone signed in can read this -- that is the
// point of it -- and Firestore cannot hide one field of a document from crew.
// Prices stay in the jobs, which crew cannot read.

(function () {
  'use strict';

  let items = {};
  let vendors = {};
  let unsubs = [];
  let search = '';
  let editing = null;       // { kind: 'item' | 'vendor', id }

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const signedIn = () => !!(window.YDAuth && window.YDAuth.user && window.YDDb);
  const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const norm = s => String(s || '').toLowerCase();

  // Every word typed has to appear somewhere in the item: its name, the other
  // names it goes by, the supplier, or the where. "grass seed" finds "Seed --
  // sun & shade mix" listed with "grass" as another name.
  function matches(it, words) {
    const v = vendors[it.vendorId] || {};
    const hay = norm([it.name, it.also, v.name, it.where, it.notes].join(' '));
    return words.every(w => hay.indexOf(w) !== -1);
  }

  // ---------------------------------------------------------------- render

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
          '<button class="btn btn-sm" onclick="supVendors()">Suppliers</button>' +
        '</div>' : '') +
        '<div id="supResults"></div>';
      el('supSearch').value = search;
    }
    renderResults();
  }

  function renderResults() {
    const box = el('supResults');
    if (!box) return;
    const words = norm(search).split(/\s+/).filter(Boolean);
    const list = Object.values(items)
      .filter(it => !words.length || matches(it, words))
      .sort((a, b) => String(a.name).localeCompare(b.name));

    if (!Object.keys(items).length) {
      box.innerHTML = '<p class="empty-msg">' + (isOwner()
        ? 'Nothing here yet. Add your suppliers first, then the things you buy from each — ' +
          'and where they are once you get there.'
        : 'Nothing has been added here yet.') + '</p>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<p class="empty-msg">Nothing matches “' + esc(search) + '”.' +
        (isOwner() ? ' Add it with “+ Add an item”.' : ' Ask Jonah where to get it, and he can add it here.') + '</p>';
      return;
    }
    box.innerHTML = list.map(itemHtml).join('');
  }

  function itemHtml(it) {
    const v = vendors[it.vendorId] || null;
    const map = v && v.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.address) : '';
    const tel = v && v.phone ? 'tel:' + String(v.phone).replace(/[^0-9+]/g, '') : '';
    return '<div class="sup-item">' +
      '<div class="sup-top">' +
        '<span class="sup-name">' + esc(it.name) + '</span>' +
        (it.unit ? '<span class="sup-unit">' + esc(it.unit) + '</span>' : '') +
        (isOwner() ? '<button class="btn btn-sm sup-edit" onclick="supEdit(\'item\', \'' + safeId(it.id) + '\')">Edit</button>' : '') +
      '</div>' +
      '<div class="sup-where"><b>' + esc(v ? v.name : 'No supplier set') + '</b>' +
        (it.where ? ' — ' + esc(it.where) : '') + '</div>' +
      (it.notes ? '<div class="sup-notes">' + esc(it.notes) + '</div>' : '') +
      (v ? '<div class="sup-links">' +
        (map ? '<a class="btn btn-sm" href="' + map + '" target="_blank" rel="noopener">📍 Directions</a>' : '') +
        (tel ? '<a class="btn btn-sm" href="' + esc(tel) + '">📞 Call</a>' : '') +
        (v.hours ? '<span class="sup-hours">' + esc(v.hours) + '</span>' : '') +
      '</div>' : '') +
    '</div>';
  }

  function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, ''); }

  window.supSearch = function (q) { search = q; renderResults(); };

  // ----------------------------------------------------------------- editing

  window.supVendors = function () {
    const list = Object.values(vendors).sort((a, b) => String(a.name).localeCompare(b.name));
    openModal('Suppliers',
      (list.length ? list.map(v => '<div class="sup-vendor">' +
          '<div><b>' + esc(v.name) + '</b><div class="muted">' + esc([v.address, v.phone].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="btn btn-sm" onclick="supEdit(\'vendor\', \'' + safeId(v.id) + '\')">Edit</button>' +
        '</div>').join('') : '<p class="empty-msg">No suppliers yet.</p>') +
      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="supEdit(\'vendor\', \'\')">+ Add a supplier</button>' +
        '<button class="btn btn-sm" onclick="closeSupModal()">Done</button>' +
      '</div>');
  };

  window.supEdit = function (kind, id) {
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
      const vs = Object.values(vendors).sort((a, b) => String(a.name).localeCompare(b.name));
      openModal(id ? 'Edit item' : 'Add an item',
        field('What it is', 'siName', it.name, 'e.g. Grass seed — sun & shade') +
        field('Also called (helps the search)', 'siAlso', it.also, 'e.g. seed, lawn seed, overseed') +
        '<div class="field"><span class="label">Supplier</span><select id="siVendor">' +
          '<option value="">— pick one —</option>' +
          vs.map(v => '<option value="' + esc(v.id) + '"' + (v.id === it.vendorId ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('') +
        '</select>' + (vs.length ? '' : '<div class="hint">Add a supplier first, with “+ Add a supplier”.</div>') + '</div>' +
        field('Where at the supplier', 'siWhere', it.where, 'e.g. front building, by the counter') +
        field('Comes in', 'siUnit', it.unit, 'e.g. 50 lb bag, pallet, yard') +
        '<div class="field"><span class="label">Notes</span><textarea id="siNotes" rows="2" ' +
          'placeholder="Which one to get, how much per job, anything to watch for">' + esc(it.notes || '') + '</textarea></div>' +
        actions(id ? 'supRemove(\'item\', \'' + safeId(id) + '\')' : ''));
    }
    const first = el(kind === 'vendor' ? 'svName' : 'siName');
    if (first && !id) first.focus();
  };

  function field(label, id, value, ph) {
    return '<div class="field"><span class="label">' + label + '</span>' +
      '<input id="' + id + '" value="' + esc(value || '') + '" placeholder="' + esc(ph || '') + '"></div>';
  }
  function actions(removeCall) {
    return '<div class="field-actions">' +
      '<button class="btn btn-filled" onclick="supSave()">Save</button>' +
      '<button class="btn btn-sm" onclick="closeSupModal()">Cancel</button>' +
      (removeCall ? '<button class="btn btn-sm" onclick="' + removeCall + '">Delete</button>' : '') +
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
    } else {
      const name = val('siName');
      if (!name) { showToast('Say what the item is'); return; }
      const id = editing.id || newId('s');
      const rec = { name: name, also: val('siAlso'), vendorId: val('siVendor') || null, where: val('siWhere'),
                    unit: val('siUnit'), notes: (el('siNotes').value || '').trim(), updatedAt: now };
      items[id] = Object.assign({ id: id }, rec);
      write('supplies', id, rec);
      showToast(name + ' saved');
      closeSupModal(); renderResults();
    }
  };

  window.supRemove = function (kind, id) {
    if (kind === 'vendor') {
      const v = vendors[id];
      const using = Object.values(items).filter(it => it.vendorId === id).length;
      if (!v || !confirm('Delete ' + v.name + '?' + (using ? '\n\n' + using + ' item(s) will show “No supplier set” until you pick another.' : ''))) return;
      delete vendors[id];
      remove('vendors', id);
    } else {
      const it = items[id];
      if (!it || !confirm('Delete ' + it.name + '?')) return;
      delete items[id];
      remove('supplies', id);
    }
    closeSupModal(); renderResults();
  };

  // ---------------------------------------------------------------- plumbing

  function openModal(title, html) {
    const m = el('supModal'), t = el('supModalTitle'), b = el('supModalBody');
    if (!m || !b) return;
    if (t) t.textContent = title;
    b.innerHTML = html;
    m.classList.add('active');
  }
  window.closeSupModal = function () {
    const m = el('supModal');
    if (m) m.classList.remove('active');
    editing = null;
  };

  // Not awaited -- see the note in boards.js.
  function write(path, id, data) {
    Promise.resolve(window.YDDb.put(path, id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[supplies] not yet on the server:', (e && e.code) || e);
    });
  }
  function remove(path, id) {
    Promise.resolve(window.YDDb.remove(path, id)).catch(e => console.warn('[supplies] not removed:', (e && e.code) || e));
  }

  function redrawIfVisible() {
    const p = el('panel-supplies');
    if (p && p.classList.contains('active')) renderResults();
  }

  function stop() {
    unsubs.forEach(u => { try { u(); } catch (e) {} });
    unsubs = []; items = {}; vendors = {};
  }
  function start() {
    stop();
    const take = store => changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete store[c.id];
        else store[c.id] = Object.assign({ id: c.id }, c.data);
      });
      redrawIfVisible();
    };
    unsubs.push(window.YDDb.watch('supplies', take(items), () => redrawIfVisible()));
    unsubs.push(window.YDDb.watch('vendors', take(vendors), () => redrawIfVisible()));
  }

  window.YDSupplies = { render: render };

  let authKey = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const tab = el('tabSupplies');
    if (tab) tab.hidden = !on;
    const key = on ? a.user.uid + ':' + a.role : null;
    if (key !== authKey) {
      authKey = key;
      if (on) start(); else stop();
      // The owner's buttons differ from the crew's, so redraw from scratch.
      const w = el('suppliesWrap'); if (w) w.innerHTML = '';
    }
    render();
  });
})();
