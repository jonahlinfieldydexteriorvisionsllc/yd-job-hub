// Machines and vehicles, and what has been done to them.
//
// The problem this solves is remembering. A mower's last oil change lives in
// somebody's head or on a receipt in a truck door, and gets recalled only when
// something seizes in the middle of a job. Written down and totalled up, it
// turns into a list of what is overdue -- which is the only form of this
// information that prevents anything.
//
// Two decisions shape the file.
//
// WHAT IS DUE IS NOT ALWAYS A DATE. A mower wears by running hours, a truck by
// miles, and a filter by months. Each machine says which of the three it is
// measured in, and any combination can be set. Forcing everything into a date
// would mean either servicing a mower that has not run, or not servicing one
// that has run all season.
//
// THE SERVICE LOG LIVES ON THE RECORD ITSELF, not in a subcollection. A machine
// accumulates a few entries a year, so the whole history is small, and keeping
// it in one document means one read, no separate security rules, and a history
// that cannot half-load.

(function () {
  'use strict';

  const KINDS = { machine: 'Machine', vehicle: 'Vehicle' };

  // How close to due counts as "coming up". Different units, same idea.
  const SOON = { days: 30, hours: 10, miles: 500 };

  let gear = {};
  let unsub = null;
  let openId = null;      // the machine whose history is on screen
  let editingId = null;   // the machine being edited, '' for a new one
  let filter = 'all';

  const el = id => document.getElementById(id);
  const val = id => ((el(id) || {}).value || '').trim();
  const num = id => { const n = parseFloat(val(id).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);

  // ------------------------------------------------------------ what is due

  const last = g => (g.service || []).slice().sort((a, b) =>
    String(b.at || '').localeCompare(String(a.at || '')))[0] || null;

  // Returns { state, text } where state is overdue | soon | ok | none.
  // Whichever measure is closest to running out is the one reported, because
  // that is the one that decides whether the machine gets serviced.
  function due(g) {
    const bits = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);

    if (g.dueDate) {
      const d = new Date(g.dueDate + 'T00:00:00');
      const days = Math.round((d - today) / 864e5);
      bits.push({
        rank: days <= 0 ? 0 : days <= SOON.days ? 1 : 2,
        sort: days,
        text: days < 0 ? Math.abs(days) + ' days overdue'
          : days === 0 ? 'due today'
          : 'due in ' + days + ' day' + (days === 1 ? '' : 's'),
      });
    }
    if (g.dueHours != null && g.hours != null) {
      const left = g.dueHours - g.hours;
      bits.push({
        rank: left <= 0 ? 0 : left <= SOON.hours ? 1 : 2,
        sort: left,
        text: left < 0 ? Math.abs(round1(left)) + ' hours past due'
          : 'due in ' + round1(left) + ' hours',
      });
    }
    if (g.dueMiles != null && g.miles != null) {
      const left = g.dueMiles - g.miles;
      bits.push({
        rank: left <= 0 ? 0 : left <= SOON.miles ? 1 : 2,
        sort: left,
        text: left < 0 ? fmtNum(Math.abs(left)) + ' miles past due'
          : 'due in ' + fmtNum(left) + ' miles',
      });
    }
    if (!bits.length) return { state: 'none', text: 'nothing scheduled' };
    bits.sort((a, b) => a.rank - b.rank || a.sort - b.sort);
    const worst = bits[0];
    return { state: worst.rank === 0 ? 'overdue' : worst.rank === 1 ? 'soon' : 'ok', text: worst.text };
  }

  const round1 = n => Math.round(n * 10) / 10;
  const fmtNum = n => Math.round(n).toLocaleString('en-US');
  const money = c => '$' + (c / 100).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US',
      { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------------------------------------------------------------- the list

  window.renderEquipment = function () {
    const wrap = el('eqWrap');
    if (!wrap) return;

    const all = Object.values(gear);
    const overdue = all.filter(g => due(g).state === 'overdue');
    const soon = all.filter(g => due(g).state === 'soon');

    const badge = el('eqBadge');
    if (badge) {
      badge.textContent = overdue.length ? overdue.length + ' overdue'
        : soon.length ? soon.length + ' coming up' : '';
      badge.className = 'section-badge' + (overdue.length ? ' accent' : '');
    }

    const list = all
      .filter(g => filter === 'all' || g.kind === filter)
      .sort((a, b) => {
        const order = { overdue: 0, soon: 1, ok: 2, none: 3 };
        return order[due(a).state] - order[due(b).state] ||
               String(a.name || '').localeCompare(b.name || '');
      });

    wrap.innerHTML =
      '<div class="filter-bar">' +
        ['all', 'machine', 'vehicle'].map(f =>
          '<button class="btn btn-sm' + (filter === f ? ' btn-filled' : '') +
          '" onclick="filterEquipment(\'' + f + '\')">' +
          (f === 'all' ? 'Everything' : KINDS[f] + 's') + '</button>').join('') +
        '<button class="btn btn-sm btn-accent" onclick="editEquipment(\'\')">+ Add</button>' +
      '</div>' +
      (list.length
        ? list.map(card).join('')
        : '<p class="empty-msg">Nothing here yet. Add a machine or a truck and start ' +
          'writing down what gets done to it.</p>');
  };

  window.filterEquipment = function (f) { filter = f; renderEquipment(); };

  function card(g) {
    const d = due(g);
    const l = last(g);
    return '<div class="eq eq-' + d.state + '" onclick="openEquipment(\'' + g.id + '\')">' +
      '<div class="eq-top">' +
        '<span class="eq-name">' + esc(g.name) + '</span>' +
        '<span class="eq-kind">' + (KINDS[g.kind] || '') + '</span>' +
        '<span class="eq-due ' + d.state + '">' + d.text + '</span>' +
      '</div>' +
      (g.make || g.model || g.year
        ? '<div class="eq-what">' + esc([g.year, g.make, g.model].filter(Boolean).join(' ')) + '</div>'
        : '') +
      '<div class="eq-last">' +
        (l ? 'Last: ' + shortDate(l.at) + ' — ' + esc(l.what)
           : 'Nothing logged yet') +
      '</div>' +
      (g.hours != null || g.miles != null
        ? '<div class="eq-reading">' +
            (g.hours != null ? round1(g.hours) + ' hours' : '') +
            (g.hours != null && g.miles != null ? ' · ' : '') +
            (g.miles != null ? fmtNum(g.miles) + ' miles' : '') +
          '</div>'
        : '') +
    '</div>';
  }

  // -------------------------------------------------------------- the detail

  window.openEquipment = function (id) {
    openId = id;
    const m = el('eqModal');
    if (m) m.classList.add('active');
    renderDetail();
  };
  window.closeEquipment = function () {
    openId = null; editingId = null;
    const m = el('eqModal');
    if (m) m.classList.remove('active');
  };

  function renderDetail() {
    const body = el('eqBody');
    const g = gear[openId];
    if (!body || !g) return;
    const title = el('eqTitle');
    if (title) title.textContent = g.name || 'Machine';

    const d = due(g);
    const log = (g.service || []).slice().sort((a, b) =>
      String(b.at || '').localeCompare(String(a.at || '')));
    const spent = log.reduce((s, e) => s + (e.costCents || 0), 0);

    body.innerHTML =
      '<div class="eq-head">' +
        '<div>' +
          '<div class="eq-sub">' + (KINDS[g.kind] || '') +
            (g.year || g.make || g.model
              ? ' · ' + esc([g.year, g.make, g.model].filter(Boolean).join(' ')) : '') +
          '</div>' +
          (g.serial ? '<div class="eq-serial">' +
            (g.kind === 'vehicle' ? 'VIN ' : 'Serial ') + esc(g.serial) + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-sm" onclick="editEquipment(\'' + g.id + '\')">Edit</button>' +
      '</div>' +

      '<div class="eq-cards">' +
        eqCard('Next service', d.text, d.state) +
        eqCard('Hours', g.hours != null ? round1(g.hours) : '—', '') +
        eqCard('Miles', g.miles != null ? fmtNum(g.miles) : '—', '') +
        eqCard('Spent on it', spent ? money(spent) : '—', '') +
      '</div>' +

      (g.notes ? '<div class="eq-notes">' + esc(g.notes) + '</div>' : '') +

      '<div class="eq-loghead">Service history' +
        '<button class="btn btn-sm btn-filled" onclick="addService()">+ Log a service</button>' +
      '</div>' +
      (log.length
        ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>What was done</th>' +
          '<th>Reading</th><th>Cost</th><th>By</th><th></th></tr></thead><tbody>' +
          log.map(e =>
            '<tr><td>' + shortDate(e.at) + '</td>' +
            '<td class="bold">' + esc(e.what) + '</td>' +
            '<td>' + [e.hours != null ? round1(e.hours) + ' hrs' : '',
                      e.miles != null ? fmtNum(e.miles) + ' mi' : '']
                      .filter(Boolean).join(' · ') + '</td>' +
            '<td>' + (e.costCents ? money(e.costCents) : '—') + '</td>' +
            '<td>' + esc(e.by || '') + '</td>' +
            '<td><button class="remove-btn" onclick="removeService(\'' + e.id + '\')" ' +
              'title="Remove">&times;</button></td></tr>').join('') +
          '</tbody></table></div>'
        : '<p class="empty-msg">Nothing logged yet.</p>');
  }

  function eqCard(label, value, state) {
    return '<div class="eq-card' + (state ? ' ' + state : '') + '">' +
      '<div class="eq-card-label">' + label + '</div>' +
      '<div class="eq-card-value">' + esc(String(value)) + '</div></div>';
  }

  // ------------------------------------------------------------ logging work

  window.addService = function () {
    const g = gear[openId];
    if (!g) return;
    const body = el('eqBody');
    const today = new Date();
    const iso = today.getFullYear() + '-' + two(today.getMonth() + 1) + '-' + two(today.getDate());

    body.insertAdjacentHTML('afterbegin',
      '<div class="add-area" id="eqServiceForm">' +
        '<div class="add-label">What was done to ' + esc(g.name) + '</div>' +
        '<div class="grid g2">' +
          '<div class="field"><span class="label">When</span>' +
            '<input type="date" id="svAt" value="' + iso + '" max="' + iso + '"></div>' +
          '<div class="field"><span class="label">Cost</span>' +
            '<input id="svCost" inputmode="decimal" placeholder="$"></div>' +
        '</div>' +
        '<div class="field"><span class="label">What was done</span>' +
          '<input id="svWhat" placeholder="e.g. oil and filter, new blades"></div>' +
        '<div class="grid g3">' +
          '<div class="field"><span class="label">Hours now</span>' +
            '<input id="svHours" inputmode="decimal" placeholder="' +
            (g.hours != null ? round1(g.hours) : 'optional') + '"></div>' +
          '<div class="field"><span class="label">Miles now</span>' +
            '<input id="svMiles" inputmode="numeric" placeholder="' +
            (g.miles != null ? fmtNum(g.miles) : 'optional') + '"></div>' +
          '<div class="field"><span class="label">Who did it</span>' +
            '<input id="svBy" placeholder="you, or the shop"></div>' +
        '</div>' +
        '<div class="hint">Putting the hours or miles in is what lets the next service ' +
          'be worked out. Leave them blank if this machine goes by date.</div>' +
        '<div class="field-actions">' +
          '<button class="btn btn-filled" onclick="saveService()">Save</button>' +
          '<button class="btn btn-sm" onclick="renderDetail2()">Cancel</button>' +
        '</div>' +
      '</div>');
    const w = el('svWhat'); if (w) w.focus();
  };

  window.renderDetail2 = function () { renderDetail(); };

  window.saveService = function () {
    const g = gear[openId];
    if (!g) return;
    const what = val('svWhat');
    if (!what) { showToast('Say what was done'); return; }

    const entry = {
      id: 'sv' + Date.now().toString(36),
      at: val('svAt') || new Date().toISOString().slice(0, 10),
      what: what,
      costCents: num('svCost') != null ? Math.round(num('svCost') * 100) : null,
      hours: num('svHours'),
      miles: num('svMiles'),
      by: val('svBy'),
    };

    const service = (g.service || []).concat([entry]);
    const patch = { service: service };

    // A reading taken during a service is the machine's current reading, and
    // moves the next service along with it. Without this the hours would have
    // to be typed twice and would drift apart.
    if (entry.hours != null) {
      patch.hours = entry.hours;
      if (g.intervalHours) patch.dueHours = round1(entry.hours + g.intervalHours);
    }
    if (entry.miles != null) {
      patch.miles = entry.miles;
      if (g.intervalMiles) patch.dueMiles = Math.round(entry.miles + g.intervalMiles);
    }
    if (g.intervalDays) {
      const base = new Date(entry.at + 'T00:00:00');
      base.setDate(base.getDate() + g.intervalDays);
      patch.dueDate = base.getFullYear() + '-' + two(base.getMonth() + 1) + '-' + two(base.getDate());
    }

    Object.assign(g, patch);
    renderDetail(); renderEquipment();
    write(g.id, patch, 'logging a service');
    showToast('Logged — ' + what);
  };

  window.removeService = function (entryId) {
    const g = gear[openId];
    if (!g) return;
    const entry = (g.service || []).find(e => e.id === entryId);
    if (!entry || !confirm('Remove "' + entry.what + '" from the history?')) return;
    g.service = (g.service || []).filter(e => e.id !== entryId);
    renderDetail(); renderEquipment();
    write(g.id, { service: g.service }, 'removing a service entry');
  };

  // ------------------------------------------------------------- the record

  window.editEquipment = function (id) {
    editingId = id;
    const g = id ? gear[id] : {};
    const body = el('eqBody');
    const m = el('eqModal');
    if (m) m.classList.add('active');
    const title = el('eqTitle');
    if (title) title.textContent = id ? 'Edit ' + (g.name || '') : 'Add a machine or vehicle';
    if (!body) return;

    body.innerHTML =
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Name</span>' +
          '<input id="eqName" value="' + esc(g.name || '') + '" placeholder="e.g. Toro 60\" or the F-250"></div>' +
        '<div class="field"><span class="label">What is it</span>' +
          '<select id="eqKind">' +
            Object.keys(KINDS).map(k => '<option value="' + k + '"' +
              ((g.kind || 'machine') === k ? ' selected' : '') + '>' + KINDS[k] + '</option>').join('') +
          '</select></div>' +
      '</div>' +
      '<div class="grid g3">' +
        '<div class="field"><span class="label">Year</span><input id="eqYear" inputmode="numeric" value="' + esc(g.year || '') + '"></div>' +
        '<div class="field"><span class="label">Make</span><input id="eqMake" value="' + esc(g.make || '') + '"></div>' +
        '<div class="field"><span class="label">Model</span><input id="eqModel" value="' + esc(g.model || '') + '"></div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Serial or VIN</span><input id="eqSerial" value="' + esc(g.serial || '') + '"></div>' +
        '<div class="field"><span class="label">Bought for</span><input id="eqPrice" inputmode="decimal" value="' +
          (g.priceCents != null ? (g.priceCents / 100) : '') + '" placeholder="$"></div>' +
      '</div>' +
      '<div class="grid g2">' +
        '<div class="field"><span class="label">Hours now</span><input id="eqHours" inputmode="decimal" value="' +
          (g.hours != null ? g.hours : '') + '" placeholder="leave blank if it has no hour meter"></div>' +
        '<div class="field"><span class="label">Miles now</span><input id="eqMiles" inputmode="numeric" value="' +
          (g.miles != null ? g.miles : '') + '" placeholder="vehicles only"></div>' +
      '</div>' +

      '<div class="eq-loghead">How often it needs servicing</div>' +
      '<div class="grid g3">' +
        '<div class="field"><span class="label">Every X hours</span><input id="eqIntHours" inputmode="decimal" value="' +
          (g.intervalHours != null ? g.intervalHours : '') + '" placeholder="e.g. 50"></div>' +
        '<div class="field"><span class="label">Every X miles</span><input id="eqIntMiles" inputmode="numeric" value="' +
          (g.intervalMiles != null ? g.intervalMiles : '') + '" placeholder="e.g. 5000"></div>' +
        '<div class="field"><span class="label">Every X days</span><input id="eqIntDays" inputmode="numeric" value="' +
          (g.intervalDays != null ? g.intervalDays : '') + '" placeholder="e.g. 180"></div>' +
      '</div>' +
      '<div class="hint">Fill in whichever fits. A mower wears by hours, a truck by miles, ' +
        'a filter by months — set any or all of them and the next service works itself out ' +
        'each time you log one.</div>' +

      '<div class="field"><span class="label">Notes</span>' +
        '<textarea id="eqNotes" rows="2" placeholder="anything worth remembering about it">' +
        esc(g.notes || '') + '</textarea></div>' +

      '<div class="field-actions">' +
        '<button class="btn btn-filled" onclick="saveEquipment()">Save</button>' +
        '<button class="btn btn-sm" onclick="cancelEquipmentEdit()">Cancel</button>' +
        (id ? '<button class="btn btn-sm" onclick="removeEquipment(\'' + id + '\')">Remove</button>' : '') +
      '</div>';
    const n = el('eqName'); if (n) n.focus();
  };

  window.cancelEquipmentEdit = function () {
    editingId = null;
    if (openId && gear[openId]) renderDetail();
    else closeEquipment();
  };

  window.saveEquipment = function () {
    const name = val('eqName');
    if (!name) { showToast('Give it a name'); return; }
    const id = editingId || ('eq' + Date.now().toString(36));
    const was = gear[id] || {};

    const rec = {
      name: name,
      kind: val('eqKind') || 'machine',
      year: val('eqYear'), make: val('eqMake'), model: val('eqModel'),
      serial: val('eqSerial'),
      priceCents: num('eqPrice') != null ? Math.round(num('eqPrice') * 100) : null,
      hours: num('eqHours'), miles: num('eqMiles'),
      intervalHours: num('eqIntHours'), intervalMiles: num('eqIntMiles'),
      intervalDays: num('eqIntDays'),
      notes: val('eqNotes'),
      service: was.service || [],
      addedAt: was.addedAt || new Date().toISOString(),
    };

    // A machine added with a reading and an interval already knows when it is
    // next due, rather than looking like nothing is scheduled until the first
    // service is logged.
    if (rec.hours != null && rec.intervalHours) rec.dueHours = round1(rec.hours + rec.intervalHours);
    else if (was.dueHours != null) rec.dueHours = was.dueHours;
    if (rec.miles != null && rec.intervalMiles) rec.dueMiles = Math.round(rec.miles + rec.intervalMiles);
    else if (was.dueMiles != null) rec.dueMiles = was.dueMiles;
    if (was.dueDate) rec.dueDate = was.dueDate;

    gear[id] = Object.assign({ id: id }, rec);
    editingId = null; openId = id;
    renderDetail(); renderEquipment();
    write(id, rec, 'saving ' + name);
    showToast(name + ' saved');
  };

  window.removeEquipment = function (id) {
    const g = gear[id];
    if (!g || !confirm('Remove ' + g.name + ' and its whole service history?')) return;
    delete gear[id];
    closeEquipment(); renderEquipment();
    if (!window.YDDb) return;
    Promise.resolve(window.YDDb.remove('equipment', id))
      .catch(e => console.warn('[equipment] not removed:', e.code || e.message));
  };

  const two = n => String(n).padStart(2, '0');

  function write(id, data, what) {
    if (!window.YDDb) { showToast('Not saved — still connecting'); return; }
    Promise.resolve(window.YDDb.put('equipment', id, data)).catch(e => {
      if (e && e.code === 'permission-denied') showToast('Not saved — not allowed');
      else console.warn('[equipment] ' + what + ' not yet on the server:', (e && e.code) || e);
    });
  }

  // ---------------------------------------------------------------- loading

  function start() {
    if (unsub || !window.YDDb) return;
    unsub = window.YDDb.watch('equipment', changes => {
      changes.forEach(c => {
        if (c.type === 'removed') delete gear[c.id];
        else gear[c.id] = Object.assign({ id: c.id }, c.data);
      });
      renderEquipment();
      if (openId && gear[openId] && !editingId) renderDetail();
    }, () => renderEquipment());
  }

  window.YDEquipment = {
    all: () => gear,
    overdue: () => Object.values(gear).filter(g => due(g).state === 'overdue'),
    render: () => renderEquipment(),
  };

  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const owner = a.isOwner === true;
    const tab = el('tabEquipment');
    if (tab) tab.hidden = !owner;
    if (a.mode === 'cloud' && a.user && owner) start();
  });

  function boot() { renderEquipment(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
