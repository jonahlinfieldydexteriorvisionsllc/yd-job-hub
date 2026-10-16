// Who changed what -- the change history.
//
// Jonah (15 Oct 2026): "Record who and when for every price change, stage
// move and pricing rule ... dont want this to be messy needs to be easy to
// look through sortable by date and what kind of price was changed
// material/rental/labor etc."
//
// One record per change, changeLog/{id}:
//   at, atMs     when (ISO, and a number to sort by)
//   month        'YYYY-MM' -- what the history is asked for by (a month at a
//                time), so no special database index is ever needed
//   uid, by      who (their uid, and the name the app knows them by)
//   area         'price' | 'stage' | 'rule'
//   kind         what sort of thing: a material kind (pavers, stone...),
//                'rental', 'labor', 'service', 'snow', 'pay', 'delivery',
//                'fuel', 'tax', 'payments'..., or for stages 'bid' / 'work' /
//                'status'
//   access       whose business it is, which decides who may read it:
//                'supplies' | 'jobs' | 'snow' | 'owner' (pay: the owner only)
//   what         the thing that changed, in plain words ("MDS — Grey pavers")
//   field        which part of it ("Price", "Markup", "Bid stage")
//   before/after short text as it was shown ("$3.10 per sq ft"), or null
//   ref, refId   the record it is about ({path, id}), refId to ask for one
//                item's whole history
//   via          set when something other than a person's tap did it
//                ("QuickBooks", "Price list", "Receipt")
//
// Written by the device at the moment of the change, never awaited (a write
// only settles at the server -- see boards.js), and always in a write of its
// own: a refused history record must never take the change itself down with
// it. firestore.rules: read by the owner, or an admin who can see that area;
// written by whoever may change that area, as themselves; never edited.
//
// The screen: ⋯ menu → 🕘 Change history. Newest or oldest first, buttons for
// Prices / Stages / Pricing rules and for each kind, a search box, three
// months at a time with "Show older". A Supplies item's price box opens the
// same screen narrowed to that item.

(function () {
  'use strict';

  const PAGE_MONTHS = 3;          // months fetched per "Show older"
  const FIRST_MONTHS = 4;         // this month and the three before: 90+ days
  const SHOW_MAX = 400;           // rows drawn at once (more behind "Show more")
  const ACCESS = ['supplies', 'jobs', 'snow'];   // areas an admin may be given

  const AREAS = [['price', 'Prices'], ['stage', 'Stages'], ['rule', 'Pricing rules']];
  const KIND_NAMES = {
    material: 'Materials', rental: 'Rentals', labor: 'Labor', service: 'Services', snow: 'Snow', pay: 'Pay',
    delivery: 'Delivery', fuel: 'Fuel', tax: 'Tax', payments: 'Payments', supplier: 'Supplier charges',
    dumpster: 'Dumpsters', markers: 'Markers', planting: 'Planting', terms: 'Estimate end lines',
    claude: 'Claude’s rules', import: 'Price list imports', other: 'Other',
    bid: 'Bid stage', work: 'Job stage', status: 'Job status',
  };
  // The Bids and Jobs boards' columns (boards.js), and the job statuses.
  const STAGE_NAMES = {
    siteVisit: 'Site visit', toSend: 'Bid to send', sent: 'Sent — waiting', followUp: 'Follow up', won: 'Won', lost: 'Lost',
    scheduled: 'Scheduled', inProgress: 'In progress', punchList: 'Punch list', toInvoice: 'Ready to invoice',
    invoiced: 'Invoiced', paid: 'Paid',
  };

  const el = id => document.getElementById(id);
  const me = () => (window.YDAuth && window.YDAuth.user) || null;
  const isOwner = () => !!(window.YDAuth && window.YDAuth.isOwner);
  const can = (area, level) => (typeof ydCan === 'function' ? ydCan(area, level) : isOwner());
  const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '');
  const pad = n => String(n).padStart(2, '0');
  const monthOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1);
  const newId = () => 'cl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function myName() {
    const own = window.YDRemind && YDRemind.me && YDRemind.me();
    const u = me();
    return (own && own.name) || (u && (u.displayName || u.email)) || 'Someone';
  }

  // $3.10 -- never "NaN": anything that is not a number reads as blank.
  function money(c) {
    if (typeof c !== 'number' || !isFinite(c)) return '—';
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function kindName(k) {
    if (!k) return 'Other';
    if (KIND_NAMES[k]) return KIND_NAMES[k];
    const P = window.YDPricing;
    return (P && P.kindName ? P.kindName(k) : '') || k;
  }

  // ------------------------------------------------------------- writing

  // The record for one change, ready to write; null when it says nothing.
  function record(e, now) {
    const u = me();
    if (!u || !e || !e.area || !e.what) return null;
    const area = AREAS.some(([a]) => a === e.area) ? e.area : null;
    const access = ACCESS.concat(['owner']).indexOf(e.access) !== -1 ? e.access : null;
    if (!area || !access) return null;
    const txt = v => (v == null || v === '' ? null : clip(v, 200));
    const ref = e.ref && e.ref.id ? { path: clip(e.ref.path, 80), id: clip(e.ref.id, 120) } : null;
    return {
      at: now.toISOString(), atMs: now.getTime(), month: monthOf(now),
      uid: u.uid, by: clip(myName(), 80),
      area: area, kind: clip(e.kind || 'other', 60), access: access,
      what: clip(e.what, 300), field: txt(e.field) ? clip(e.field, 80) : null,
      before: txt(e.before), after: txt(e.after),
      ref: ref, refId: ref ? ref.id : null,
      via: e.via ? clip(e.via, 60) : null,
    };
  }
  // Any number of changes, in their own write (never the change's own batch,
  // so a refusal here -- rules not published yet, say -- costs nothing but
  // the history). Not awaited.
  function add(list) {
    list = (Array.isArray(list) ? list : [list]).filter(Boolean);
    if (!list.length || !window.YDDb || !me()) return 0;
    const now = new Date();
    const writes = [];
    list.forEach((e, i) => {
      // The same millisecond for a whole import, but each its own id and an
      // order kept by atMs + i.
      const at = new Date(now.getTime() + i);
      const rec = record(e, at);
      if (rec) writes.push(['changeLog', newId(), rec]);
    });
    if (!writes.length) return 0;
    const send = writes.length === 1 ? window.YDDb.put(writes[0][0], writes[0][1], writes[0][2]) : window.YDDb.putMany(writes);
    Promise.resolve(send).catch(err => console.warn('[changelog] not recorded:', (err && err.code) || err));
    // An open history screen shows it at once.
    if (loaded) {
      writes.forEach(([, id, rec]) => { rows[id] = Object.assign({ id: id }, rec); });
      if (shown()) draw();
    }
    return writes.length;
  }

  // A job's stage moved (sync.js patchJob, app.js persistJob): one record for
  // the move, however many of its fields changed with it -- booking a bid
  // changes its bid stage, its status and its job stage at once.
  function stageName(s) { return s ? (STAGE_NAMES[s] || s) : '—'; }
  function statusName(s) { return s ? (typeof statusLabel === 'function' ? statusLabel(s) : s) : '—'; }
  function jobMoved(id, was, now, via) {
    if (!id || !now || !was) return;           // a brand-new job is not a move
    // [label, before, after, kind]; 'active' and 'booked' both read Booked --
    // a rename, not a move, so a part that reads the same is left out.
    const changed = k => (was[k] || null) !== (now[k] || null);
    const parts = [
      changed('jobStatus') && ['Status', statusName(was.jobStatus), statusName(now.jobStatus), 'status'],
      changed('bidStage') && ['Bid stage', stageName(was.bidStage), stageName(now.bidStage), 'bid'],
      changed('workStage') && ['Job stage', stageName(was.workStage), stageName(now.workStage), 'work'],
    ].filter(p => p && p[1] !== p[2]);
    if (!parts.length) return;
    const kind = parts[0][3];
    const name = [now.customerName || was.customerName || 'A job'].concat(now.estimateNumber ? ['#' + now.estimateNumber] : []).join(' ');
    add({
      area: 'stage', kind: kind, access: 'jobs', what: name,
      field: parts.map(p => p[0]).join(' + '),
      before: parts.map(p => (parts.length > 1 ? p[0] + ': ' : '') + p[1]).join('; '),
      after: parts.map(p => (parts.length > 1 ? p[0] + ': ' : '') + p[2]).join('; '),
      ref: { path: 'jobs', id: id }, via: via || null,
    });
  }

  // ------------------------------------------------------------- reading

  let rows = {};              // id -> record, everything fetched this time
  let loaded = false;
  let monthsBack = 0;         // how many months (from this one) are fetched
  let loading = false;
  let emptyRun = 0;           // months in a row that came back empty
  let only = null;            // { refId, name } -- one item's history
  let view = { order: 'new', area: '', kind: '', q: '', max: SHOW_MAX };

  // The areas this person may read (the rules refuse anything wider).
  function readable() {
    if (isOwner()) return null;               // everything
    return ACCESS.filter(a => can(a, 'see'));
  }
  function mayOpen() { return !!me() && (isOwner() || readable().length > 0); }

  // Months from `from` (0 = this month) for `n` months, as 'YYYY-MM'.
  function monthKeys(from, n) {
    const d = new Date(); d.setDate(1);
    d.setMonth(d.getMonth() - from);
    const out = [];
    for (let i = 0; i < n; i++) { out.push(monthOf(d)); d.setMonth(d.getMonth() - 1); }
    return out;
  }
  // One look at the records for these months (or one item), as the rules
  // allow: the owner asks for all; an admin asks once per area they see.
  function fetch(months) {
    const db = window.YDDb;
    const ask = conds => (db.listMatching ? db.listMatching('changeLog', conds)
      : db.listWhere('changeLog', conds[conds.length - 1][0], conds[conds.length - 1][1], conds[conds.length - 1][2]));
    const last = only ? ['refId', '==', only.refId] : ['month', 'in', months];
    const areas = readable();
    if (!areas) return ask([last]);
    return Promise.all(areas.map(a => ask([['access', '==', a], last]).catch(err => {
      // Should two conditions ever need an index the database does not have,
      // ask by area alone and keep the months wanted here.
      if (!err || err.code !== 'failed-precondition') throw err;
      return db.listWhere('changeLog', 'access', '==', a).then(all => {
        const keep = {};
        Object.keys(all).forEach(id => {
          const r = all[id];
          if (only ? r.refId === only.refId : months.indexOf(r.month) !== -1) keep[id] = r;
        });
        return keep;
      });
    }))).then(list => Object.assign({}, ...list));
  }
  function loadMore() {
    if (loading || !window.YDDb) return;
    loading = true;
    const n = monthsBack ? PAGE_MONTHS : FIRST_MONTHS;
    const months = monthKeys(monthsBack, n);
    draw();
    fetch(months).then(got => {
      const ids = Object.keys(got);
      ids.forEach(id => { rows[id] = Object.assign({ id: id }, got[id]); });
      monthsBack += n;
      emptyRun = ids.length ? 0 : emptyRun + n;
      loaded = true;
    }).catch(err => {
      console.warn('[changelog] could not read:', (err && err.code) || err);
      showToast(err && err.code === 'permission-denied' ? 'The change history isn’t open to you' : 'Could not load the history — try again with signal');
      loaded = true;
    }).then(() => { loading = false; draw(); });
  }

  // ------------------------------------------------------------- the screen

  function modal() {
    let m = el('clModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal-overlay';
      m.id = 'clModal';
      m.onclick = ev => { if (ev.target === m) closeChangeLog(); };
      m.innerHTML = '<div class="modal cl-modal"><div class="modal-head"><h2>🕘 Change history</h2>' +
        '<button class="modal-close" onclick="closeChangeLog()">&times;</button></div><div class="modal-body" id="clBody"></div></div>';
      document.body.appendChild(m);
    }
    return m;
  }
  const shown = () => { const m = el('clModal'); return !!(m && m.classList.contains('active')); };

  // opts: { refId, name } for one item's history.
  window.openChangeLog = function (refId, name) {
    if (!mayOpen()) return;
    const want = refId ? { refId: String(refId), name: String(name || '') } : null;
    const same = (want && only && want.refId === only.refId) || (!want && !only);
    if (!same || !loaded) { rows = {}; loaded = false; monthsBack = 0; emptyRun = 0; only = want; }
    view = { order: view.order, area: '', kind: '', q: '', max: SHOW_MAX };
    modal().classList.add('active');
    draw();
    if (!loaded) loadMore();
  };
  window.closeChangeLog = function () { const m = el('clModal'); if (m) m.classList.remove('active'); };
  window.clAll = function () { only = null; rows = {}; loaded = false; monthsBack = 0; emptyRun = 0; draw(); loadMore(); };
  window.clOlder = function () { loadMore(); };
  window.clOrder = function (o) { view.order = o === 'old' ? 'old' : 'new'; draw(); };
  window.clArea = function (a) { view.area = a || ''; view.kind = ''; view.max = SHOW_MAX; draw(); };
  window.clKind = function (k) { view.kind = view.kind === k ? '' : (k || ''); view.max = SHOW_MAX; draw(); };
  window.clMore = function () { view.max += SHOW_MAX; draw(); };
  let typingTimer = null;
  window.clSearch = function (v) {
    view.q = String(v || '');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { view.max = SHOW_MAX; drawList(); }, 150);
  };
  window.clOpenJob = async function (id) {
    if (typeof loadJob !== 'function') return;
    if (!(await ydLeaveUnsavedJob())) return;
    closeChangeLog();
    loadJob(id);
    if (typeof switchTab === 'function') switchTab('job');
  };

  const words = s => String(s || '').toLowerCase().split(/\s+/).filter(Boolean);
  function matches(r) {
    if (view.area && r.area !== view.area) return false;
    if (view.kind && (r.kind || 'other') !== view.kind) return false;
    const q = words(view.q);
    if (!q.length) return true;
    const hay = [r.what, r.field, r.before, r.after, r.by, r.via, kindName(r.kind)].join(' ').toLowerCase();
    return q.every(w => hay.indexOf(w) !== -1);
  }
  function chip(label, on, call, count) {
    return '<button class="srch-chip' + (on ? ' on' : '') + '" onclick="' + call + '">' + esc(label) +
      (count != null ? ' <b>' + count + '</b>' : '') + '</button>';
  }
  function dayName(ms) {
    const d = new Date(ms), t = new Date();
    const key = x => x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate();
    const y = new Date(t); y.setDate(t.getDate() - 1);
    if (key(d) === key(t)) return 'Today';
    if (key(d) === key(y)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
  }
  const timeOf = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  function draw() {
    const m = el('clModal');
    if (!m || !m.classList.contains('active')) return;
    const body = el('clBody');
    const all = Object.values(rows);
    const inArea = all.filter(r => !view.area || r.area === view.area);
    const areaCount = a => all.filter(r => r.area === a).length;
    const kinds = {};
    inArea.forEach(r => { const k = r.kind || 'other'; kinds[k] = (kinds[k] || 0) + 1; });
    const kindList = Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a] || kindName(a).localeCompare(kindName(b)));
    // The search box is drawn once and kept, so typing in it is never lost.
    const hadSearch = el('clSearch');
    const typed = hadSearch ? hadSearch.value : view.q;
    body.innerHTML =
      (only ? '<div class="cl-only">History of <b>' + esc(only.name || 'this item') + '</b> — all time' +
        ' <button class="link-btn" onclick="clAll()">See everything</button></div>' : '') +
      '<div class="cl-tools">' +
        '<input id="clSearch" type="search" placeholder="Search — item, job, person, $ amount…" value="' + esc(typed) + '" oninput="clSearch(this.value)">' +
        '<div class="cl-chips" role="group" aria-label="Order">' +
          chip('Newest first', view.order === 'new', "clOrder('new')") + chip('Oldest first', view.order === 'old', "clOrder('old')") +
        '</div>' +
        '<div class="cl-chips" role="group" aria-label="What changed">' +
          chip('Everything', !view.area, "clArea('')", all.length) +
          AREAS.map(([a, n]) => chip(n, view.area === a, "clArea('" + a + "')", areaCount(a))).join('') +
        '</div>' +
        (kindList.length > 1 ? '<div class="cl-chips" role="group" aria-label="Kind">' +
          kindList.map(k => chip(kindName(k), view.kind === k, "clKind('" + safe(k) + "')", kinds[k])).join('') +
        '</div>' : '') +
      '</div>' +
      '<div id="clList"></div>';
    drawList();
  }
  function drawList() {
    const box = el('clList');
    if (!box) return;
    const list = Object.values(rows).filter(matches)
      .sort((a, b) => view.order === 'old' ? (a.atMs || 0) - (b.atMs || 0) : (b.atMs || 0) - (a.atMs || 0));
    let html = '';
    let lastDay = '';
    list.slice(0, view.max).forEach(r => {
      const day = dayName(r.atMs || 0);
      if (day !== lastDay) { html += '<div class="cl-day">' + esc(day) + '</div>'; lastDay = day; }
      const job = r.ref && r.ref.path === 'jobs' && can('jobs', 'see');
      html += '<div class="cl-row' + (r.area === 'stage' ? ' cl-stage-row' : '') + '">' +
        '<div class="cl-when">' + esc(timeOf(r.atMs || 0)) + '</div>' +
        '<div class="cl-main">' +
          '<div class="cl-what"><span class="cl-kind cl-' + esc(r.area) + '">' + esc(kindName(r.kind)) + '</span> ' +
            '<b>' + esc(r.what || '') + '</b>' + (r.field ? ' <span class="muted">· ' + esc(r.field) + '</span>' : '') + '</div>' +
          ((r.before != null || r.after != null) ? '<div class="cl-change">' +
            // Nothing before (a summary line): just what it came to.
            (r.before == null ? '' : '<span class="cl-before">' + esc(r.before) + '</span> <span class="cl-arrow">→</span> ') +
            '<span class="cl-after">' + esc(r.after == null ? '—' : r.after) + '</span></div>' : '') +
          '<div class="cl-who">' + esc(r.by || 'Someone') + (r.via ? ' · via ' + esc(r.via) : '') +
            (job ? ' · <button class="link-btn" onclick="clOpenJob(\'' + safe(r.ref.id) + '\')">Open the job</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    });
    const more = list.length > view.max
      ? '<div class="field-actions"><button class="btn btn-sm" onclick="clMore()">Show ' + Math.min(SHOW_MAX, list.length - view.max) + ' more</button></div>' : '';
    const from = monthKeys(Math.max(0, monthsBack - 1), 1)[0];
    const older = only ? '' : loading ? '<p class="hint">Loading…</p>'
      : emptyRun >= 12 ? '<p class="hint">Nothing older than this.</p>'
      : '<div class="field-actions"><button class="btn btn-sm" onclick="clOlder()">Show older (before ' +
        esc(new Date(from + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })) + ')</button></div>';
    box.innerHTML = (list.length ? '<div class="hint cl-count">' + list.length + ' change' + (list.length === 1 ? '' : 's') +
        (only ? '' : ' since ' + esc(new Date(from + '-01T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))) + '</div>' + html
      : (loading && !loaded ? '' : '<p class="empty-msg">' + (Object.keys(rows).length ? 'Nothing matches.' : 'No changes recorded' + (only ? ' for this yet.' : ' in these months.')) + '</p>')) +
      more + older;
  }

  // ------------------------------------------------------------- wiring

  let key = null;
  document.addEventListener('yd-auth', e => {
    const a = e.detail || {};
    const on = a.mode === 'cloud' && !!a.user;
    const k = on ? (a.key || a.user.uid + ':' + a.role) : null;
    if (k !== key) { key = k; rows = {}; loaded = false; monthsBack = 0; emptyRun = 0; only = null; closeChangeLog(); }
    const item = el('menuChangeLog');
    if (item) item.hidden = !(on && mayOpen());
  });

  window.YDChangeLog = { add: add, jobMoved: jobMoved, money: money, kindName: kindName, open: window.openChangeLog };
})();
